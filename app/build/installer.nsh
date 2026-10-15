; 筛片大师 —— Windows 安装 / 卸载自定义脚本（electron-builder 自动 include 本文件）
;
; 要解决的事：用户在另一台机器上装过又卸掉，回来发现磁盘上还留着日志、照片缓存、
; AI 模型缓存、Electron 缓存+数据。装新版本时这些旧缓存会被直接复用，
; 表现就是"更新了却看不到新功能"。
;
; 所以两个时机都清一遍：
;   customInstall   —— 安装 / 覆盖安装 / 重装（对应"更新重装也要清"）
;   customUnInstall —— 卸载
;
; 铁律（和 src/main/services/cleanup.ts 保持同一份清单，改这边必须改那边）：
;   只删"关掉软件还能自己长回来"的东西。
;   绝不删：data\screener.db（图库+AI 检测结果）、auth.json（登录状态）、
;           Local Storage（用户的界面偏好）、settings 表。
;   卸载后图库还在，重新安装导入同一批照片，历史结果直接接得上。

; 系统盘根：模型副本的第三顺位落点。用命名变量而非 $9 之类寄存器，
; 免得和 electron-builder 自己的脚本抢占同一个寄存器。
Var ScreenerSysDrive
; 「AI筛图助手」运行时拼装结果与临时寄存（见 ScreenerBuildCnName）
Var ScreenerCnName
Var ScreenerTmp

; ---------------------------------------------------------------------------
; ScreenerCleanCacheRoot：清理一个 userData 目录下的全部可再生缓存
;   用法：!insertmacro ScreenerCleanCacheRoot "screener-master"
;   目录名可能含中文，调用方用 NSIS 的 Unicode 转义写法（$\uXXXX），
;   这样本文件保持纯 ASCII，不受编译器源码编码影响。
; ---------------------------------------------------------------------------
!macro ScreenerCleanCacheRoot ROOT
  ; 1) 图片缓存三件套：缩略图 / RAW-HEIC 大图预览 / 引擎归一化中间图
  RMDir /r "$APPDATA\${ROOT}\data\thumbs"
  RMDir /r "$APPDATA\${ROOT}\data\big"
  RMDir /r "$APPDATA\${ROOT}\data\engine-input"

  ; 2) 日志：userData 下的回退位置 + 历史上用过的复数写法
  RMDir /r "$APPDATA\${ROOT}\log"
  RMDir /r "$APPDATA\${ROOT}\logs"

  ; 3) Electron 自带缓存与运行数据（渲染层缓存、GPU 缓存、blob 等）
  RMDir /r "$APPDATA\${ROOT}\Cache"
  RMDir /r "$APPDATA\${ROOT}\Code Cache"
  RMDir /r "$APPDATA\${ROOT}\GPUCache"
  RMDir /r "$APPDATA\${ROOT}\ShaderCache"
  RMDir /r "$APPDATA\${ROOT}\DawnCache"
  RMDir /r "$APPDATA\${ROOT}\DawnGraphsCache"
  RMDir /r "$APPDATA\${ROOT}\blob_storage"
  RMDir /r "$APPDATA\${ROOT}\Crashpad"
  RMDir /r "$APPDATA\${ROOT}\CrashpadMetrics-active.pma"
  RMDir /r "$APPDATA\${ROOT}\Network\Temporal Cache"
  ; Default 子档（Electron 换了 user-data 布局时会出现在这里）
  RMDir /r "$APPDATA\${ROOT}\Default\Cache"
  RMDir /r "$APPDATA\${ROOT}\Default\Code Cache"
  RMDir /r "$APPDATA\${ROOT}\Default\GPUCache"
  RMDir /r "$APPDATA\${ROOT}\Default\blob_storage"

  ; 4) 安装目录同级的运行日志（日志优先写在 exe 旁边，卸载器删安装目录时可能因
  ;    权限或时序留下空壳，这里再兜一次）
  RMDir /r "$INSTDIR\log"
  RMDir /r "$INSTDIR\logs"
!macroend

; ---------------------------------------------------------------------------
; ScreenerCleanModelCopies：清理 AI 引擎复制到 ASCII 目录的模型副本
;   安装路径含中文时，OpenCV 读不了 ONNX / 级联文件，引擎会把模型复制到
;   %TEMP% / %PROGRAMDATA% / 系统盘根 下的 screener-engine-models（见
;   ai-engine/engine/face.py 的 _ascii_model_path）。换版本后旧副本没人认领，
;   整份模型体积白占着——这就是用户看到的"AI 模型缓存"。
; ---------------------------------------------------------------------------
!macro ScreenerCleanModelCopies
  RMDir /r "$TEMP\screener-engine-models"
  ; NSIS 没有 $COMMONAPPDATA 这个内置常量（本机用云端同款编译器实测抓到 warning 6000；
  ; 云端 v2.0.86 只是在它前面先死在了另一处）。所有用户共用的 ProgramData 只能
  ; 从 PROGRAMDATA 环境变量读——和下面 SYSTEMDRIVE 同一个套路。
  ReadEnvStr $ScreenerTmp PROGRAMDATA
  RMDir /r "$ScreenerTmp\screener-engine-models"
  ReadEnvStr $ScreenerSysDrive SYSTEMDRIVE
  RMDir /r "$ScreenerSysDrive\screener-engine-models"
!macroend

; ---------------------------------------------------------------------------
; ScreenerBuildCnName：把历史中文目录名「AI筛图助手」拼进 $ScreenerCnName
;   本文件必须保持纯 ASCII：云端编译器按本机 ANSI 代码页读源文件，直接写中文
;   会变乱码；而 $\uXXXX 这种转义 NSIS 根本不支持（v2.0.86 云端打包实测
;   warning 6000 unknown variable/constant，警告被当错误直接中断）。所以唯一的
;   编码无关写法是运行时按 Unicode 码点逐字拼：AI + 筛(7B5B) 图(56FE) 助(52A9) 手(624B)
; ---------------------------------------------------------------------------
!macro ScreenerBuildCnName
  IntFmt $ScreenerCnName "%c" 0x7B5B
  IntFmt $ScreenerTmp "%c" 0x56FE
  StrCpy $ScreenerCnName "$ScreenerCnName$ScreenerTmp"
  IntFmt $ScreenerTmp "%c" 0x52A9
  StrCpy $ScreenerCnName "$ScreenerCnName$ScreenerTmp"
  IntFmt $ScreenerTmp "%c" 0x624B
  StrCpy $ScreenerCnName "$ScreenerCnName$ScreenerTmp"
  StrCpy $ScreenerCnName "AI$ScreenerCnName"
!macroend

; ---------------------------------------------------------------------------
; ScreenerCleanAll：当前目录名 + 历史遗留目录名一次清完
;   产品改过名（ai-photo-screener -> AI筛图助手 -> screener-master），老机器上
;   三个目录都可能躺着残留，逐个点名清；不写通配符遍历，避免误删其它软件的数据。
;   中文名「AI筛图助手」由 ScreenerBuildCnName 运行时拼装（为何不直写见该宏注释）。
; ---------------------------------------------------------------------------
!macro ScreenerCleanAll
  !insertmacro ScreenerBuildCnName
  !insertmacro ScreenerCleanCacheRoot "screener-master"
  !insertmacro ScreenerCleanCacheRoot "ai-photo-screener"
  !insertmacro ScreenerCleanCacheRoot $ScreenerCnName
  ; 旧目录名只有 4 个文件，缓存子项删完后顺手把空壳目录也带走（非空时 NSIS 自动跳过）
  RMDir "$APPDATA\ai-photo-screener"
  RMDir "$APPDATA\$ScreenerCnName"
  !insertmacro ScreenerCleanModelCopies
!macroend

; 安装 / 覆盖安装 / 重装完成后执行。用户要的"更新后看不到新功能"就是这一步根治的：
; 装完新版，旧缓存和旧模型副本已经不在，第一次启动必然按新逻辑重建。
!macro customInstall
  !insertmacro ScreenerCleanAll
!macroend

; 卸载完成后执行。刻意不做"整包删用户数据"（deleteAppDataOnUninstall 保持 false），
; 图库与登录态留下，只带走缓存和日志。
!macro customUnInstall
  !insertmacro ScreenerCleanAll
!macroend
