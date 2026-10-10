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
        "person_model_found": False,
        "person_available": False,
        "person_count_run_ok": False,
        "person_count_synth": None,
        "person_count_open": None,
        "person_count_multi": None,
        "person_count_empty": None,
        "e2e_person_dim": None,
        "e2e_person_method": None,
        "e2e_person_conf": None,
        "merge_guard_ok": False,
        "merge_detail": "",
        "skin_run_ok": False,
        "skin_gray_ok": False,
        "skin_blob_ok": False,
        "skin_detail": "",
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
    # --- Phase 3 人体计数冒烟：证明 ObjectDetector 能在冻结引擎里加载 .tflite 并跑 count()。
    # 人数分类新权威；任何异常不阻断（模型缺失时 available=False，引擎自动回落人脸计数）。---
    try:
        from .person import PersonDetector
        from .models import person_model_path
        from .imaging import load_work_image
        out["person_model_found"] = bool(person_model_path())
        pd = PersonDetector(log=lambda *a, **k: None)
        out["person_available"] = bool(pd.available)
        if pd.available:
            # 合成灰图：无人体 -> count()==0（验证不崩 + 背景过滤不误触发）
            c0, _b0 = pd.count(np.full((320, 320, 3), 120, dtype=np.uint8))
            out["person_count_synth"] = c0
            # 具名 fixture：单人脸 / 多人 / 无人（存在则跑）
            for key, name in (("person_count_open", "face_open.jpg"),
                              ("person_count_multi", "person_multi.jpg"),
                              ("person_count_empty", "no_person.jpg")):
                p = _fixture_named(name)
                if p:
                    cc, _bb = pd.count(load_work_image(p)[0])
                    out[key] = cc
            out["person_count_run_ok"] = out["person_count_synth"] is not None
        # 端到端：完整 detect() 里人数维度走 body-count 还是 face-count（模型可用时应为 body-count）
        try:
            from . import DetectEngine
            eng2 = DetectEngine(log=lambda *a, **k: None)
            rr = eng2.detect(_fixture_or_synthetic())
            dd = rr.get("dims") or {}
            for dim in ("single_person", "group_photo", "no_person"):
                if dim in dd:
                    out["e2e_person_dim"] = dim
                    out["e2e_person_method"] = (dd[dim] or {}).get("method")
                    out["e2e_person_conf"] = round(float((dd[dim] or {}).get("confidence") or 0), 4)
                    break
        except Exception as _e2:  # noqa: BLE001
            out["error"] = (out["error"] or "") + " |person-e2e: %s: %s" % (type(_e2).__name__, _e2)
    except Exception as _pe:  # noqa: BLE001
        out["person_count_run_ok"] = False
        out["error"] = (out["error"] or "") + " |person: %s: %s" % (type(_pe).__name__, _pe)
    # --- v2.0.64 人数误判两处修复的无模型单测（纯几何 / 纯颜色，不依赖 fixture 与网络）---
    # 1) 合并同列护栏：拦下"两人框重叠被合成一个人"（多人照→单人照头号成因），同时保证
    #    真正的上下半身拆框仍能合并（否则反向新增"单人照→多人"）。
    try:
        from .person import merge_overlaps
        # 同一人拆框：小框整体落进大框（包含度 1.0）且同列（cx 均为 100）→ 应合为 1
        split_pair = [
            {"box": [0, 40, 200, 300], "score": 0.7, "h_ratio": 0.9, "area_ratio": 0.26},
            {"box": [45, 120, 110, 200], "score": 0.6, "h_ratio": 0.6, "area_ratio": 0.11},
        ]
        kept_split = len(merge_overlaps(split_pair))
        # 两个人：小框同样被大框包住（包含度 0.9），但横向分列（cx 差 55 > 0.35×110）→ 必须不合
        two_people = [
            {"box": [0, 40, 200, 300], "score": 0.7, "h_ratio": 0.9, "area_ratio": 0.26},
            {"box": [100, 120, 110, 200], "score": 0.6, "h_ratio": 0.6, "area_ratio": 0.11},
        ]
        kept_two = len(merge_overlaps(two_people))
        out["merge_detail"] = "split->%d two->%d" % (kept_split, kept_two)
        out["merge_guard_ok"] = bool(kept_split == 1 and kept_two == 2)
    except Exception as _mg:  # noqa: BLE001
        out["error"] = (out["error"] or "") + " |merge: %s: %s" % (type(_mg).__name__, _mg)
    # 2) 肤色连通块：灰图必须不触发（否则全库无人物都将被拉进待确认），
    #    人工皮肤色椭圆必须触发（证明兜底链路真的在工作）。
    try:
        import cv2
        from . import quality as Q2
        gray_ok, gray_why = Q2.skin_person_score(np.full((320, 320, 3), 120, dtype=np.uint8))
        blob = np.full((320, 320, 3), 120, dtype=np.uint8)
        cv2.ellipse(blob, (160, 160), (60, 80), 0, 0, 360, (130, 160, 200), -1)  # BGR≈RGB(200,160,130) 典型肤色
        blob_ok, blob_why = Q2.skin_person_score(blob)
        out["skin_run_ok"] = True
        out["skin_gray_ok"] = bool(not gray_ok)
        out["skin_blob_ok"] = bool(blob_ok)
        out["skin_detail"] = "gray:%s blob:%s" % ((gray_why or "")[:40], (blob_why or "")[:40])
    except Exception as _sk:  # noqa: BLE001
        out["error"] = (out["error"] or "") + " |skin: %s: %s" % (type(_sk).__name__, _sk)
    return out


def main():
    result = run()
    sys.stdout.write(json.dumps(result, ensure_ascii=True) + "\n")
    sys.stdout.flush()
    # detect_ok 为真即 spike 通过
    return 0 if result["detect_ok"] else 1
