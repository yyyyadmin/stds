/**
 * electron-builder afterPack 钩子：Mac 未签名分发阶段的整包 ad-hoc 补签（10-18 Mac 引擎被 M 芯片处死问题的根治）
 *
 * 背景：CI 没配置 Apple 开发者证书时 electron-builder 对产物不做任何签名，
 * 而 Apple Silicon 对无有效签名的可执行文件一律 SIGKILL——不只是 App 本体，
 * resources/engine 里的内置 AI 引擎（PyInstaller 产物）和散装 .dylib/.so 全中招。
 * 表现为：客户能打开软件，但引擎启动失败退回 node 基础引擎（人物分类 0、瑕疵 0）。
 *
 * 本钩子在 .app 组装完毕、DMG 封装之前触发，把所有 Mach-O 递归 ad-hoc 签名并校验，
 * 校验不过直接中断构建——宁可不发，绝不发出去一个引擎跑不起来的包。
 * 配置了 Developer ID（CSC_LINK 存在，或自动发现开着）时原样跳过，不干扰正式签名+公证。
 */
const { execFileSync } = require('child_process')
const { readdirSync } = require('fs')
const { join } = require('path')

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return
  const hasDevId = !!process.env.CSC_LINK || process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false'
  if (hasDevId) {
    console.log('[afterPack] 已配置 Developer ID 签名，跳过 ad-hoc 补签')
    return
  }
  const appPath = readdirSync(context.appOutDir).filter((f) => f.endsWith('.app')).map((f) => join(context.appOutDir, f))[0]
  if (!appPath) throw new Error('[afterPack] 在 ' + context.appOutDir + ' 里找不到 .app，无法补签，中断发包')
  console.log(`[afterPack] 未签名分发模式，整包 ad-hoc 补签: ${appPath}`)
  // 签名前先清掉 bundle 里"已失效"或"指向包外绝对路径"的符号链接：PyInstaller 在构建机上
  // 常残留指向 /Library/... 的绝对软链，客户机上既失效又越界，codesign --deep 一遇就报
  // "invalid destination for symbolic link in bundle" 直接失败。包内相对软链（framework 的
  // Current->A 那种）一律保留，只删真坏/真越界的。清理本身失败也不打断，交给后面签名校验兑底。
  try {
    execFileSync(
      'bash',
      [
        '-c',
        [
          'APP="$1"',
          'find "$APP" -type l | while IFS= read -r l; do',
          '  if [ ! -e "$l" ]; then rm -f "$l"; continue; fi',
          '  t=$(readlink "$l")',
          '  case "$t" in',
          '    /*) case "$t" in "$APP"/*) : ;; *) rm -f "$l" ;; esac ;;',
          '  esac',
          'done',
        ].join('\n'),
        'after-pack-mac',
        appPath,
      ],
      { stdio: 'inherit' },
    )
  } catch (e) {
    console.log('[afterPack] 软链清理跳过（不影响后续签名校验）：' + String(e).slice(0, 120))
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' })
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
    console.log('[afterPack] 签名校验通过')
  } catch (e) {
    throw new Error('[afterPack] ad-hoc 签名校验失败，中断发包——这样的包客户机上 AI 引擎起不来: ' + String(e).slice(0, 200))
  }
}
