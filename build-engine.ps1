# build-engine.ps1 — Windows: 将 ai-engine 打包为独立 exe（免用户安装 Python）
# 用法：在 PowerShell 中执行  powershell -ExecutionPolicy Bypass -File build-engine.ps1
# 前提：本机已安装 Python 3.9+
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$engine = Join-Path $root "ai-engine"

Write-Host "=== AI 引擎打包 (Windows / PyInstaller) ===" -ForegroundColor Cyan

# 1. 虚拟环境
$venv = Join-Path $engine ".venv"
if (-not (Test-Path $venv)) {
    Write-Host "[1/3] 创建虚拟环境…"
    python -m venv $venv
}
$py = Join-Path $venv "Scripts\python.exe"

# 2. 安装依赖 + PyInstaller
Write-Host "[2/3] 安装依赖（onnxruntime 可选，安装后启用深度学习模型）…"
& $py -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
& $py -m pip install -r (Join-Path $engine "requirements.txt") -i https://pypi.tuna.tsinghua.edu.cn/simple
& $py -m pip install pyinstaller -i https://pypi.tuna.tsinghua.edu.cn/simple

# 3. 打包（--onedir 启动快于 --onefile；--collect-data 收 Haar 级联文件）
Write-Host "[3/3] PyInstaller 打包…"
Push-Location $engine
& $py -m PyInstaller --noconfirm --name ai-engine `
    --collect-all cv2 --collect-data cv2 `
    --hidden-import numpy --hidden-import scipy `
    --paths $engine main.py
Pop-Location

$out = Join-Path $engine "dist\ai-engine\ai-engine.exe"
if (Test-Path $out) {
    Write-Host "`n打包成功：$out" -ForegroundColor Green
    Write-Host "分发方式："
    Write-Host "  a) 将 dist\ai-engine 整个目录放到 app\resources\ai-engine-exe\，重新打安装包；"
    Write-Host "  b) 或设置环境变量 AI_ENGINE_PYTHON 指向该 exe，软件会自动优先使用它。"
} else {
    Write-Host "打包失败，请检查上方日志" -ForegroundColor Red
    exit 1
}
