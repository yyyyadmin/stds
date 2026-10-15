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
  RMDir /r "$COMMONAPPDATA\screener-engine-models"
  ReadEnvStr $ScreenerSysDrive SYSTEMDRIVE
  RMDir /r "$ScreenerSysDrive\screener-engine-models"
!macroend

; ---------------------------------------------------------------------------
; ScreenerCleanAll：当前目录名 + 历史遗留目录名一次清完
;   产品改过名（ai-photo-screener -> AI筛图助手 -> screener-master），老机器上
;   三个目录都可能躺着残留，逐个点名清；不写通配符遍历，避免误删其它软件的数据。
;   中文名 "AI筛图助手" 写成 Unicode 转义，本文件因此保持纯 ASCII。
;   "AI筛图助手" = "AI$\u7B5B\u56FE\u52A9\u624B"
; ---------------------------------------------------------------------------
!macro ScreenerCleanAll
  !insertmacro ScreenerCleanCacheRoot "screener-master"
  !insertmacro ScreenerCleanCacheRoot "ai-photo-screener"
  !insertmacro ScreenerCleanCacheRoot "AI$\u7B5B\u56FE\u52A9\u624B"
  ; 旧目录名只有 4 个文件，缓存子项删完后顺手把空壳目录也带走（非空时 NSIS 自动跳过）
  RMDir "$APPDATA\ai-photo-screener"
  RMDir "$APPDATA\AI$\u7B5B\u56FE\u52A9\u624B"
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
