# -*- coding: utf-8 -*-
"""
筛图大师 AI 引擎 PyInstaller 打包规范（onedir 模式）

用途：把 ai-engine（main.py + engine 包 + OpenCV/numpy/onnxruntime 依赖 + Haar 级联数据）
打成自包含可执行文件 `screener-engine`，随安装包分发，实现「每台设备（含 mac）免安装
Python 即自动升级为完整 12 维检测」。用户无需在目标电脑装 Python。

构建（在装有 Python 3.9+ 的机器 / CI 上运行，勿在本机 Electron 里跑）：
    pip install -r requirements.txt pyinstaller
    pyinstaller engine.spec --noconfirm
产物：dist/screener-engine/screener-engine(.exe) + _internal/
再由 app/scripts/build-engine.mjs 复制到 app/engine-dist/<platform>/，
并把 models/ 放在 exe 同目录，终端用户放入 ONNX 权重即可进一步提升精度（无需重新打包）。

说明：
- console=True 必须保留：引擎通过 stdio 换行 JSON 与主进程通信。
- models 不打包进二进制内部，而是作为外部目录随附，方便放权重与热更新。
"""
import os
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

block_cipher = None
ROOT = os.path.dirname(os.path.abspath(SPEC))  # noqa: F821

# OpenCV 自带 Haar 级联（闭眼/人脸/上半身等 .xml）与动态库
datas = collect_data_files("cv2")
binaries = collect_dynamic_libs("cv2")
# Pillow / pillow-heif 的插件与元数据（HEIC 解码）
try:
    datas += collect_data_files("PIL")
except Exception:  # noqa: BLE001
    pass
try:
    datas += collect_data_files("pillow_heif")
    binaries += collect_dynamic_libs("pillow_heif")
except Exception:  # noqa: BLE001
    pass
# pillow-avif-plugin 的原生 _avif 库（AVIF 解码）
try:
    datas += collect_data_files("pillow_avif")
    binaries += collect_dynamic_libs("pillow_avif")
except Exception:  # noqa: BLE001
    pass
# MediaPipe（可选）：收集其原生库、graph 配置与隐藏导入。未安装则跳过（引擎回落 yunet）。
_HAS_MP = False
try:
    import mediapipe  # noqa: F401
    _HAS_MP = True
    datas += collect_data_files("mediapipe")
    binaries += collect_dynamic_libs("mediapipe")
except Exception as _e:  # noqa: BLE001
    print(f"[engine.spec] mediapipe not collected, fallback to yunet: {_e}")

hiddenimports = [
    "numpy",
    "cv2",
    "PIL",
    "PIL.Image",
    # 可选依赖：缺失时引擎自动降级，不影响打包
    "onnxruntime",
    "rawpy",
    "pillow_heif",
    "pillow_avif",
    "imageio",
    "mediapipe",
    "google.protobuf",
]

# matplotlib 是 mediapipe 的运行时依赖（`import mediapipe` 会连带导入它，否则冻结
# exe 内报 ModuleNotFoundError）；仅当 mediapipe 可用时才需打包，否则维持排除以瘦身。
# 【修正】之前无条件排除 matplotlib 导致三平台 selfcheck 均卡在 import mediapipe 失败。
excludes = ["tkinter", "matplotlib", "PyQt5", "PySide2"]
if _HAS_MP:
    excludes.remove("matplotlib")
    datas += collect_data_files("matplotlib")
    hiddenimports.append("matplotlib")

a = Analysis(
    [os.path.join(ROOT, "main.py")],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="screener-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,  # stdio JSON-RPC 需要控制台管道
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="screener-engine",
)
