# -*- coding: utf-8 -*-
"""模型与运行时管理：ONNX Runtime（可选）+ OpenCV 自带级联 + CUDA 自动检测"""
import os
import sys
import glob


def _runtime_base():
    """兼容 PyInstaller 打包：优先使用随分发的外部 models/（与可执行文件同目录），
    这样终端用户无需重新打包即可放入 ONNX 权重提升精度。"""
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(sys.executable)
        ext_models = os.path.join(exe_dir, "models")
        if os.path.isdir(ext_models):
            return exe_dir
        # 退回包内解压目录
        return getattr(sys, "_MEIPASS", exe_dir)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


BASE_DIR = _runtime_base()
MODELS_DIR = os.path.join(BASE_DIR, "models")
# 源码运行时的仓库内 models 目录（作为回退搜索路径）
_SRC_MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models")

try:
    import cv2
except ImportError:  # pragma: no cover
    cv2 = None

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

_HAS_ORT = False
try:
    import onnxruntime as ort
    _HAS_ORT = True
except ImportError:  # pragma: no cover
    ort = None


def find_model(*patterns):
    """在 models/ 目录按通配符寻找 ONNX 权重；不存在返回 None。
    依次搜索：运行时 models/ -> 源码仓库 models/（兼容打包与开发两种形态）。"""
    search_dirs = [MODELS_DIR]
    if os.path.abspath(_SRC_MODELS_DIR) != os.path.abspath(MODELS_DIR):
        search_dirs.append(_SRC_MODELS_DIR)
    for base in search_dirs:
        for pat in patterns:
            hits = sorted(glob.glob(os.path.join(base, pat)))
            if hits:
                return hits[0]
            hits = sorted(glob.glob(os.path.join(base, "**", pat), recursive=True))
            if hits:
                return hits[0]
    return None


def detect_device(preference="auto"):
    """GPU/CPU 模式自动检测切换（第九章 9.1）"""
    if not _HAS_ORT or preference == "cpu":
        return "cpu"
    try:
        providers = ort.get_available_providers()
    except Exception:  # noqa: BLE001
        return "cpu"
    if preference == "cuda" or ("CUDAExecutionProvider" in providers and preference == "auto"):
        return "cuda" if "CUDAExecutionProvider" in providers else "cpu"
    return "cpu"


class OnnxSession:
    """轻量 ONNX 会话封装：模型缺失时 is_available() == False，检测器自动降级为规则算法"""

    def __init__(self, patterns, input_size=None):
        self.path = find_model(*patterns) if patterns else None
        self.input_size = input_size
        self.session = None
        self.providers = ["CPUExecutionProvider"]
        if self.path and _HAS_ORT:
            try:
                self.providers = _pick_providers()
                self.session = ort.InferenceSession(self.path, providers=self.providers)
            except Exception:  # noqa: BLE001
                self.session = None

    @property
    def available(self):
        return self.session is not None

    def run(self, blob):
        inp = self.session.get_inputs()[0]
        return self.session.run(None, {inp.name: blob})[0]


def _pick_providers():
    avail = ort.get_available_providers()
    order = []
    if "CUDAExecutionProvider" in avail:
        order.append("CUDAExecutionProvider")
    if "CoreMLExecutionProvider" in avail:  # Apple Silicon
        order.append("CoreMLExecutionProvider")
    order.append("CPUExecutionProvider")
    return order


def haar_path(name):
    """OpenCV 自带 Haarcascade（opencv-python 内置 data 模块）"""
    if cv2 is None:
        return None
    p = os.path.join(cv2.data.haarcascades, name)
    return p if os.path.exists(p) else None


def mediapipe_task_path():
    """MediaPipe FaceLandmarker 权重（face_landmarker.task，已随仓库入库）。"""
    return find_model("face_landmarker.task", "*.task")


def yunet_path():
    """YuNet 人脸检测权重（可选放置于 models/）"""
    return find_model("face_detection_yunet*.onnx", "scrfd*.onnx", "retinaface*.onnx", "ufadd*.onnx")
