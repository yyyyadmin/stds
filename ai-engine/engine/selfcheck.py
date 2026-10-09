# -*- coding: utf-8 -*-
"""Spike 自检：验证 mediapipe 能否在（冻结）引擎内 import + 加载 .task + 跑一次 detect。
不触碰检测业务逻辑；仅证明打包链路可用。输出单行 JSON 供 CI 解析。"""
import json
import sys

import numpy as np


def _find_task():
    from .models import find_model
    return find_model("face_landmarker.task", "*.task")


def run():
    out = {
        "mediapipe_import": False,
        "task_found": False,
        "task_ascii_path_ok": False,
        "detect_ok": False,
        "num_faces": 0,
        "blend_keys": 0,
        "yunet_backend": "none",
        "yunet_ok": False,
        "landmarker_available": False,
        "enhance_smoke_ok": False,
        "enhanced_faces": 0,
        "error": None,
    }
    # --- yunet 共存冒烟（独立 try，先跑）：证明 cv2 与 mediapipe 在同一冻结引擎里都能用（Phase1 头号风险）---
    try:
        from .face import FaceDetector
        fd = FaceDetector()
        out["yunet_backend"] = fd.backend
        if fd.backend == "yunet":
            probe = np.full((320, 320, 3), 120, dtype=np.uint8)
            _ = fd.detect(probe)  # 能建 FaceDetectorYN 并对图跑通即证明 cv2 完好
            out["yunet_ok"] = True
    except Exception as _ye:  # noqa: BLE001
        out["yunet_ok"] = False
        out["error"] = (out["error"] or "") + " |yunet: %s: %s" % (type(_ye).__name__, _ye)
    try:
        import mediapipe as mp  # noqa: F401
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
        out["mediapipe_import"] = True

        task = _find_task()
        out["task_found"] = bool(task)
        if not task:
            out["error"] = "face_landmarker.task not found"
            return out

        from .face import _ascii_model_path
        ascii_task = _ascii_model_path(task)
        out["task_ascii_path_ok"] = bool(ascii_task) and ascii_task.endswith(".task")

        opts = vision.FaceLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=ascii_task),
            running_mode=vision.RunningMode.IMAGE,
            num_faces=6,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
        )
        lm = vision.FaceLandmarker.create_from_options(opts)
        # 合成一张 64x64 灰度图（无脸也应返回空结果而非抛异常）
        img = np.full((64, 64, 3), 128, dtype=np.uint8)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=img)
        res = lm.detect(mp_img)
        out["detect_ok"] = True
        out["num_faces"] = len(res.face_landmarks) if res.face_landmarks else 0
        if res.face_blendshapes and len(res.face_blendshapes) > 0:
            out["blend_keys"] = len(res.face_blendshapes[0])
    except Exception as e:  # noqa: BLE001
        out["error"] = "%s: %s" % (type(e).__name__, e)
    # --- 增强层冒烟：能实例化 + 对合成图跑 enhance() 不崩（无脸应返回 0）---
    try:
        from .landmarks import FaceLandmarkEnhancer
        enr = FaceLandmarkEnhancer()
        out["landmarker_available"] = bool(enr.available)
        fake = [{"box": [10, 10, 100, 100], "score": 0.9, "landmarks5": [(0, 0)] * 5}]
        n = enr.enhance(np.full((200, 200, 3), 128, dtype=np.uint8), fake)
        out["enhance_smoke_ok"] = True
        out["enhanced_faces"] = int(n)
    except Exception as _ee:  # noqa: BLE001
        out["enhance_smoke_ok"] = False
        out["error"] = (out["error"] or "") + " |enhance: %s: %s" % (type(_ee).__name__, _ee)
    return out


def main():
    result = run()
    sys.stdout.write(json.dumps(result, ensure_ascii=True) + "\n")
    sys.stdout.flush()
    # detect_ok 为真即 spike 通过
    return 0 if result["detect_ok"] else 1
