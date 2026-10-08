#Requires -Version 5.1
<#
 筛图大师 · 一键发布脚本
 流程：提交本地改动 → 版本号自动 +1（patch）→ 更新 app/package.json 与 lock
       → git commit + tag → 推送 GitHub → 自动触发三平台安装包云构建
 用法：双击桌面「一键发布筛图大师」快捷方式
       或命令行：powershell -ExecutionPolicy Bypass -File auto-release.ps1 [-DryRun]
       -DryRun 只显示将要发布的版本号，不做任何改动
#>
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

# 刚装完 Git 的会话可能 PATH 未刷新，这里主动补一次
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Pause-Exit([int]$code) {
  if (-not $DryRun -and [Environment]::UserInteractive) {
    Write-Host ''
    Read-Host '按回车键关闭窗口' | Out-Null
  }
  exit $code
}

try {
  # 仓库根 = 本脚本所在 scripts 目录的上一级
  $repoRoot = Split-Path -Parent $PSScriptRoot
  Set-Location $repoRoot
  Say '=== 筛图大师 · 一键发布 ===' 'Cyan'
  Say "仓库：$repoRoot"

  # ---------- 1. 有改动先提交 ----------
  $dirty = git status --porcelain 2>$null
  if ($null -eq (Get-Command git -ErrorAction SilentlyContinue)) {
    Say '未找到 git，请先安装 Git for Windows 后重试。' 'Red'; Pause-Exit 1
  }
  if ($dirty) {
    Say '检测到文件改动，正在自动提交…' 'Yellow'
    git add -A
    git commit -m 'chore: update before release' | Out-Null
    if ($LASTEXITCODE -ne 0) { Say 'git commit 失败，请查看上方输出。' 'Red'; Pause-Exit 1 }
  } else {
    Say '工作区无改动（将只发布版本号更新）。'
  }

  # ---------- 2. 计算新版本号：max(package.json, 最新tag) 的 patch + 1 ----------
  $pkgPath = Join-Path $repoRoot 'app\package.json'
  $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $base = [Version]$pkg.version
  $lastTag = (git describe --tags --abbrev=0 2>$null)
  if ($lastTag -and $lastTag -match '^v?(\d+\.\d+\.\d+)') {
    $tagVer = [Version]$Matches[1]
    if ($tagVer -gt $base) { $base = $tagVer }
  }
  $next = '{0}.{1}.{2}' -f $base.Major, $base.Minor, ($base.Build + 1)
  Say "当前版本：$base   →   本次发布：v$next" 'Green'

  if ($DryRun) { Say 'DryRun 模式：未做任何改动。' 'Yellow'; Pause-Exit 0 }

  # ---------- 3. 同步版本号到 package.json + package-lock.json（CI 的 npm ci 要求两者一致） ----------
  Push-Location (Join-Path $repoRoot 'app')
  npm.cmd version $next --no-git-tag-version
  $npmOk = $LASTEXITCODE
  Pop-Location
  if ($npmOk -ne 0) { Say 'npm version 失败，请确认已安装 Node.js。' 'Red'; Pause-Exit 1 }

  # ---------- 4. 提交版本变更并打 tag ----------
  git add app/package.json app/package-lock.json
  git commit -m "chore: release v$next" | Out-Null
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1) { Say 'git commit 失败。' 'Red'; Pause-Exit 1 }
  git tag "v$next"
  if ($LASTEXITCODE -ne 0) { Say "创建标签 v$next 失败。" 'Red'; Pause-Exit 1 }
  Say "已创建版本标签 v$next"

  # ---------- 5. 推送（首次会弹浏览器要求登录 GitHub，请完成授权） ----------
  Say '正在推送到 GitHub（若弹出浏览器登录窗口请完成授权）…' 'Yellow'
  git push origin HEAD
  if ($LASTEXITCODE -ne 0) {
    Say '代码推送失败：网络不通或未授权。本地提交与标签已保留，恢复网络后再次双击即可（会重新自增版本号）。' 'Red'
    Pause-Exit 1
  }
  git push origin "v$next"
  if ($LASTEXITCODE -ne 0) {
    Say '标签推送失败：代码已推上去，但云构建未触发。恢复网络后再双击一次即可。' 'Red'
    Pause-Exit 1
  }

  # ---------- 6. 结果指引 ----------
  $remote = (git remote get-url origin) -replace '\.git$', '' -replace '^https://github\.com/', ''
  Say ''
  Say "✅ v$next 发布成功！GitHub 云端已开始自动打包（约 5~15 分钟）：" 'Green'
  Say "   构建进度：https://github.com/$remote/actions" 'Green'
  Say "   下载成品：https://github.com/$remote/releases （找 v$next）" 'Green'
  Pause-Exit 0
} catch {
  Say "发生错误：$($_.Exception.Message)" 'Red'
  Pause-Exit 1
}
