# finish-cleanup.ps1 — 彻底清除误导入的 E:\下载 记录（需在关闭「AI智能筛图助手」后运行）
# 用法：先把应用完全退出（本脚本会检测并等待），然后执行：
#   powershell -ExecutionPolicy Bypass -File finish-cleanup.ps1
$ErrorActionPreference = "Stop"
$AppDir = "D:\师兄筛图\app"
$Data = Join-Path $env:APPDATA "ai-photo-screener\data"
$Db = Join-Path $Data "screener.db"

Write-Host "等待应用进程退出…" -ForegroundColor Cyan
$waited = 0
while (Get-Process -Name electron -ErrorAction SilentlyContinue) {
    Start-Sleep 2
    $waited += 2
    if ($waited -gt 120) { Write-Host "超时：应用仍在运行，请先退出应用再执行本脚本" -ForegroundColor Red; exit 1 }
}
Start-Sleep 2  # 等待退出时的最后一次落盘

# 备份当前库
if (Test-Path $Db) { Copy-Item $Db "$Db.as-recovered.bak" -Force }

Write-Host "开始清理…" -ForegroundColor Cyan
Push-Location $AppDir
node scripts\cleanup-wrong-import.js
Pop-Location

Write-Host "清理完成。现在可以重新打开应用（npm run dev 或已打包版本），修复均已生效。" -ForegroundColor Green
