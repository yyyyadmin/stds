# -*- coding: utf-8 -*-
"""Spike 自检：验证 mediapipe 能否在（冻结）引擎内 import + 加载 .task + 跑一次 detect。
不触碰检测业务逻辑；仅证明打包链路可用。输出单行 JSON 供 CI 解析。"""
import json
import os
import sys

import numpy as np


def _find_task():
    from .models import find_model
    return find_model("face_landmarker.task", "*.task")


def _synthetic_png():
    import cv2
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_selfcheck_synth.png")
    img = np.full((240, 240, 3), 120, dtype=np.uint8)
    if not cv2.imwrite(p, img):
        # 模块目录不可写（只读冻结包）时退回系统临时目录，保证 e2e 拿得到真实可读文件
        import tempfile
        p = os.path.join(tempfile.gettempdir(), "screener_selfcheck_synth.png")
        cv2.imwrite(p, img)
    return p


def _fixture_named(name):
    """在冻结引擎目录旁或源码 ai-engine/tests/fixtures 找具名 fixture；无则 None。"""
    from . import models as M
    cands = [os.path.join(M.BASE_DIR, "tests", "fixtures")]
    cands.append(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests", "fixtures"))
    for d in cands:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    return None


def _fixture_or_synthetic():
    """优先用真实脸 fixture（face_open.jpg）做端到端验证；不存在则用合成图占位。"""
    p = _fixture_named("face_open.jpg")
    return p if p else _synthetic_png()


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
        "e2e_ok": False,
        "e2e_dims": [],
        "out_landmarker_cap": False,
        "mount_faces": 0,
        "mount_enhanced": 0,
        "mount_ok": False,
        "eye_mp_used": False,
        "closed_conf_open": None,
        "closed_conf_closed": None,
        "mount_closed_ok": False,
        "closed_faces": 0,
        "closed_enhanced": 0,
        "closed_has_mp": False,
        "open_reason": "",
        "closed_reason": "",
        "open_ml": None,
        "open_ious": None,
        "closed_ml": None,
        "closed_ious": None,
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
            out["error"] = (out["error"] or "") + " |mp: face_landmarker.task not found"
        else:
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
        out["error"] = (out["error"] or "") + " |mp: %s: %s" % (type(e).__name__, e)
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
    # --- 端到端：完整 DetectEngine.detect() 在冻结引擎里跑通、维度不缺失 ---
    try:
        from . import DetectEngine
        eng = DetectEngine(log=lambda *a, **k: None)
        r = eng.detect(_fixture_or_synthetic())
        out["e2e_ok"] = bool(r) and "dims" in r and "faces" in r
        out["e2e_dims"] = sorted((r.get("dims") or {}).keys())
        out["out_landmarker_cap"] = bool(eng.capabilities().get("landmarker"))
    except Exception as _de:  # noqa: BLE001
        out["e2e_ok"] = False
        out["error"] = (out["error"] or "") + " |e2e: %s: %s" % (type(_de).__name__, _de)
    # --- 真实脸挂载 + 闭眼信号正向验证（CI 需先把 tests/fixtures/*.jpg 复制到引擎目录旁）---
    try:
        from .imaging import load_work_image
        from .face import FaceDetector
        from .landmarks import FaceLandmarkEnhancer
        from .eyes import EyesAnalyzer
        fd = FaceDetector()
        enr = FaceLandmarkEnhancer()
        ea = EyesAnalyzer()

        def _probe(name):
            p = _fixture_named(name)
            if not p:
                return None
            bgr, _sc = load_work_image(p)
            faces = fd.detect(bgr)
            n = enr.enhance(bgr, faces)
            diag = dict(enr.last_diag or {})
            conf, reason = ea.closed_eye(bgr, faces)
            return {"faces": len(faces), "enhanced": int(n),
                    "has_mp": any("mp" in f for f in faces),
                    "conf": round(float(conf), 3), "reason": (reason or "")[:180],
                    "ml": diag.get("ml"), "ious": diag.get("ious")}

        op = _probe("face_open.jpg")
        cl = _probe("face_closed.jpg")
        if op:
            out["mount_faces"] = op["faces"]
            out["mount_enhanced"] = op["enhanced"]
            out["mount_ok"] = bool(op["faces"] >= 1 and op["enhanced"] >= 1)
            out["eye_mp_used"] = bool(op["has_mp"])
            out["closed_conf_open"] = op["conf"]
            out["open_reason"] = op["reason"]
            out["open_ml"] = op["ml"]
            out["open_ious"] = op["ious"]
        if cl:
            out["closed_conf_closed"] = cl["conf"]
            out["mount_closed_ok"] = bool(cl["enhanced"] >= 1)
            out["closed_faces"] = cl["faces"]
            out["closed_enhanced"] = cl["enhanced"]
            out["closed_has_mp"] = bool(cl["has_mp"])
            out["closed_reason"] = cl["reason"]
            out["closed_ml"] = cl["ml"]
            out["closed_ious"] = cl["ious"]
    except Exception as _me:  # noqa: BLE001
        out["error"] = (out["error"] or "") + " |mount: %s: %s" % (type(_me).__name__, _me)
    return out


def main():
    result = run()
    sys.stdout.write(json.dumps(result, ensure_ascii=True) + "\n")
    sys.stdout.flush()
    # detect_ok 为真即 spike 通过
    return 0 if result["detect_ok"] else 1
