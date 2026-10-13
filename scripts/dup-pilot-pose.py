"""
重复/连拍姿态门试点：只跑 159 张表态相关图，拿真姿态数据验证可分性（不写库）

流程：
  1 读 app/scripts/_pilot_list.json（dup-pilot-list.js 产出）
  2 逐张走引擎内部管线：YuNet 脸框 -> MediaPipe enhance（yaw/pitch/roll + blendshape）
     -> person.count 人体框 -> phash
  3 同目录且汉明<=9 的图对 = "AI 现在会判为重复"的配对，按你的表态打标签：
     任一端是 rej  -> NOT_DUP（你说这不是重复）
     任一端是 ok/add -> DUP（你说这是重复）
     两端都有表态且冲突 -> 丢弃
  4 对每个特征算 DUP 与 NOT_DUP 两群的分布 + 一致性比例（AUC，0.5 = 完全没用）

用法（用真实解释器，PATH 上的 python 是商店存根）：
  & "C:\\Users\\windows\\AppData\\Local\\Programs\\Python\\Python311\\python.exe" scripts\\dup-pilot-pose.py
"""
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
ENGINE_DIR = os.path.join(REPO, "ai-engine")
sys.path.insert(0, ENGINE_DIR)

import numpy as np  # noqa: E402

from engine import DetectEngine  # noqa: E402
from engine.imaging import load_work_image, LoadError  # noqa: E402
from engine import quality as Q  # noqa: E402

LIST = os.path.join(REPO, "app", "scripts", "_pilot_list.json")
HAM_MAX = 9


def ham(a, b):
    n = 0
    for x, y in zip(a, b):
        v = int(x, 16) ^ int(y, 16)
        while v:
            n += v & 1
            v >>= 1
    return n


def euler(matrix):
    """MediaPipe 4x4 -> (yaw, pitch, roll) 度。取不出返回 (0,0,0)。"""
    if not matrix:
        return 0.0, 0.0, 0.0
    try:
        R = np.array(matrix, dtype=float)[:3, :3]
        yaw = math.degrees(math.atan2(-R[2, 0], max(1e-6, math.hypot(R[0, 0], R[1, 0]))))
        pitch = math.degrees(math.atan2(R[2, 1], R[2, 2]))
        roll = math.degrees(math.atan2(R[1, 0], R[0, 0]))
        return float(yaw), float(pitch), float(roll)
    except Exception:  # noqa: BLE001
        return 0.0, 0.0, 0.0


def main():
    items = json.load(open(LIST, encoding="utf-8"))
    print("pilot list: %d images" % len(items))
    eng = DetectEngine(device="cpu", log=lambda *a, **k: None)
    feats = []
    t_all = time.time()
    for k, it in enumerate(items, 1):
        t0 = time.time()
        rec = {"id": it["id"], "filename": it["filename"], "label": it["label"],
               "dir": os.path.dirname(it["path"]), "phash": None, "faces": [], "bodies": []}
        try:
            bgr, scale = load_work_image(it["path"])
        except LoadError as e:
            rec["error"] = str(e)
            feats.append(rec)
            continue
        faces = eng.faces.detect(bgr)
        try:
            if eng.landmarker.available and faces:
                eng.landmarker.enhance(bgr, faces)
        except Exception as e:  # noqa: BLE001
            rec["mp_err"] = str(e)
        for f in faces:
            bx = f["box"]
            mp = f.get("mp") or {}
            yaw, pitch, roll = euler(mp.get("matrix"))
            b = mp.get("blend") or {}
            rec["faces"].append({
                "box": [round(float(v) / max(scale, 1e-6), 1) for v in bx],
                "yaw": round(yaw, 1), "pitch": round(pitch, 1), "roll": round(roll, 1),
                "blink": round(max(b.get("eyeBlinkLeft", 0.0), b.get("eyeBlinkRight", 0.0)), 3),
                "squint": round((b.get("eyeSquintLeft", 0.0) + b.get("eyeSquintRight", 0.0)) / 2.0, 3),
                "mouth": round((b.get("jawOpen", 0.0)), 3),
                "hasMp": bool(mp),
            })
        rec["faces"].sort(key=lambda x: -(x["box"][2] * x["box"][3]))
        try:
            pc, bodies = eng.person.count(bgr)
            for b in (bodies or []):
                bb = b.get("box") or b.get("bbox")
                if not bb:
                    continue
                rec["bodies"].append({
                    "box": [round(float(v) / max(scale, 1e-6), 1) for v in bb],
                    "score": round(float(b.get("score", 0.0)), 3),
                    "filtered": bool(b.get("filtered", True)),
                })
        except Exception as e:  # noqa: BLE001
            rec["body_err"] = str(e)
        rec["phash"] = Q.phash(bgr)
        rec["ms"] = round((time.time() - t0) * 1000)
        feats.append(rec)
        if k % 20 == 0 or k == len(items):
            el = time.time() - t_all
            print("  %d/%d  %.1fs elapsed, avg %.2fs/img" % (k, len(items), el, el / k))

    out = os.path.join(REPO, "app", "scripts", "_pilot_pose.json")
    json.dump(feats, open(out, "w", encoding="utf-8"), ensure_ascii=False)
    nmp = sum(1 for f in feats if any(x["hasMp"] for x in f["faces"]))
    nbody = sum(1 for f in feats if f["bodies"])
    print("done: %d 张 · 拿到逐脸姿态 %d 张 · 拿到人体框 %d 张 · 总耗时 %.1fs" % (len(feats), nmp, nbody, time.time() - t_all))


if __name__ == "__main__":
    main()
