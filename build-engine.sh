#!/usr/bin/env bash
# build-engine.sh — macOS: 将 ai-engine 打包为独立可执行文件（免用户安装 Python）
# 用法：bash build-engine.sh
# 前提：本机已安装 Python 3.9+（brew install python@3.12）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$ROOT/ai-engine"

echo "=== AI 引擎打包 (macOS / PyInstaller) ==="

# 1. 虚拟环境
VENV="$ENGINE/.venv"
if [ ! -d "$VENV" ]; then
  echo "[1/3] 创建虚拟环境…"
  python3 -m venv "$VENV"
fi
PY="$VENV/bin/python"

# 2. 安装依赖
echo "[2/3] 安装依赖（onnxruntime-coreml 可选，安装后启用 CoreML 加速）…"
"$PY" -m pip install --upgrade pip
"$PY" -m pip install -r "$ENGINE/requirements.txt"
"$PY" -m pip install pyinstaller

# 3. 打包
echo "[3/3] PyInstaller 打包…"
cd "$ENGINE"
"$PY" -m PyInstaller --noconfirm --name ai-engine \
  --collect-all cv2 --collect-data cv2 \
  --hidden-import numpy --hidden-import scipy \
  --paths "$ENGINE" main.py

OUT="$ENGINE/dist/ai-engine/ai-engine"
if [ -f "$OUT" ]; then
  echo ""
  echo "打包成功：$OUT"
  echo "分发方式："
  echo "  a) 将 dist/ai-engine 目录随 DMG 附带，用户解压后设置 AI_ENGINE_PYTHON 指向该文件；"
  echo "  b) 或在 electron-builder.yml 的 extraResources 增加该目录映射，重新执行 npm run dist:mac。"
  echo "注意：macOS 未签名二进制需 xattr -dr com.apple.quarantine 或本地 ad-hoc 签名（codesign --force --sign - ai-engine）。"
else
  echo "打包失败，请检查上方日志" >&2
  exit 1
fi
