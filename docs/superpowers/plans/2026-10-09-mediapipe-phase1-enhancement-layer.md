# MediaPipe 增强层（Phase 1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留 YuNet 做人脸检测与计数的前提下，加入 MediaPipe FaceLandmarker 增强层——对全图跑一次推理，把 478 关键点 + blendshape 系数 + landmark 包围盒按 IoU 匹配回 YuNet 的脸并附加到 `face["mp"]`，同时确保 opencv 与 mediapipe 在冻结引擎里共存不冲突。

**Architecture:** 新增 `engine/landmarks.py`（`FaceLandmarkEnhancer`：加载 `.task` → 推理 → IoU 匹配 → 附加字段），`DetectEngine.detect()` 在 YuNet `detect()` 之后、各维度分析之前调用一次增强（全程 try/except 兜底，失败即回落原启发式路径）。opencv 依赖统一为 `opencv-contrib-python`（单一 cv2 提供方，mediapipe 亦依赖它，其为其超集，`FaceDetectorYN`/haarcascade 均可用）。

**Tech Stack:** Python 3.11、mediapipe（Tasks API FaceLandmarker）、opencv-contrib-python、PyInstaller、GitHub Actions 三平台。

**Spec:** `docs/superpowers/specs/2026-10-09-mediapipe-face-landmarker-design.md`（§3.1 拆分架构、§5 数据契约）；前置 spike 已 GO：`docs/superpowers/plans/2026-10-09-mediapipe-spike-results.md`

## Global Constraints

- **YuNet 仍是人脸计数唯一权威**：`face_count`/single/two/group 维度继续来自 `FaceDetector.detect()`，增强层不得增删人脸数量（`num_faces=6` 仅限制被增强的脸数，不影响计数）。
- **优雅降级不可破**：mediapipe 缺失、加载失败、推理异常时，`face` 列表与所有维度输出必须与"接入前"完全一致（增强字段缺省即走原路径）。任何增强异常**绝不能**让 `detect()` 抛错或漏维度。
- **opencv 单一提供方**：全项目只装 `opencv-contrib-python`，禁止 opencv-python 与 opencv-contrib-python 并存（双装会导致 cv2 损坏）。
- **非 ASCII 路径**：交给 `BaseOptions(model_asset_path=...)` 的 `.task` 路径必须经 `face.py:_ascii_model_path`。
- **可选依赖绝不阻断构建**：延续 spike 的 best-effort 安装 + engine.spec try/except（已实现，勿回退）。
- **本 Phase 不改** `eyes.closed_eye` / `quality.half_head_score` 的判定逻辑（Phase 2/3 的事），只负责把增强字段挂到 `face` 上并跑通。
- **验证基座 = 冻结引擎 `--selfcheck`（CI 三平台）**：本机无 Python、引擎无 pytest 套件；每个可交付的验证步骤是"扩展 selfcheck → 提交 → 一键发布触发 CI → 读 selfcheck JSON"。selfcheck 新增字段：`yunet_backend`、`yunet_ok`、`landmarker_available`、`enhance_smoke_ok`、`enhanced_faces`、`error`。
- 继续在 `main` 分支开发（与既有 trunk-based 一键发布流一致，不开 worktree）。

---

### Task 1: 统一 OpenCV 为 contrib + selfcheck 增加 yunet 共存闸门

**Files:**
- Modify: `ai-engine/requirements.txt`（`opencv-python` → `opencv-contrib-python`）
- Modify: `ai-engine/engine/selfcheck.py`（新增 YuNet 共存冒烟）

**Interfaces:**
- Produces: selfcheck JSON 新增 `"yunet_backend":str|"none"`、`"yunet_ok":bool`（冻结引擎内 `FaceDetectorYN` 可创建并对合成图跑一次 `detect()` 不抛异常）。后续任务依赖此证 cv2 与 mediapipe 共存安全。

- [ ] **Step 1: 换 opencv 包名**

`ai-engine/requirements.txt` 把：

```
opencv-python>=4.9.0
```

改为：

```
opencv-contrib-python>=4.9.0
```

（原因：mediapipe 依赖 opencv-contrib-python；若与 opencv-python 并存会双份 cv2.pyd 冲突。contrib 是 base 超集，`cv2.FaceDetectorYN`、`cv2.data.haarcascades` 均照常可用。）

- [ ] **Step 2: selfcheck 增加 yunet 冒烟**

在 `ai-engine/engine/selfcheck.py` 的 `run()` 内、`return out` 之前（成功路径与异常兜底都能覆盖），补一段**独立 try**（不能因 yunet 段异常吞掉已成功的 mediapipe 结果）：

```python
        # --- yunet 共存冒烟：证明 cv2 与 mediapipe 在同一冻结引擎内都能用（Phase1 头号风险）---
        try:
            from .face import FaceDetector
            fd = FaceDetector()
            out["yunet_backend"] = fd.backend
            if fd.backend == "yunet":
                probe = np.full((320, 320, 3), 120, dtype=np.uint8)
                _ = fd.detect(probe)  # 能建 FaceDetectorYN 并对图跑通即证明 cv2 完好
                out["yunet_ok"] = True
            else:
                out["yunet_ok"] = False
        except Exception as _ye:  # noqa: BLE001
            out["yunet_ok"] = False
            out["error"] = (out["error"] or "") + " |yunet: %s: %s" % (type(_ye).__name__, _ye)
```

并在 `out` 初始化字典里加两个默认键：

```python
        "yunet_backend": "none",
        "yunet_ok": False,
```

- [ ] **Step 3: 本地静态自检（无 Python 则跳过，交 CI）**

Run: `python -c "import ast; ast.parse(open('ai-engine/engine/selfcheck.py',encoding='utf-8').read()); print('ok')"`
Expected: `ok`（本机无 Python 时此步跳过，由 CI 的 build:engine 暴露语法错误）。

- [ ] **Step 4: Commit**

```bash
git add ai-engine/requirements.txt ai-engine/engine/selfcheck.py
git commit -m "feat(engine): unify opencv to contrib + gate mediapipe/yunet coexistence in selfcheck"
```

- [ ] **Step 5: 触发 CI 验证共存（关键 gate）**

推送后一键发布；读三平台 selfcheck JSON，确认 `mediapipe_import:true` **且** `yunet_backend:"yunet"` **且** `yunet_ok:true`、`detect_ok:true`、`error:null`。
- 若 `yunet_ok:false` 或 `build:engine` 因 opencv 变化失败 → **停，回报**：说明 contrib 切换有副作用，需回到 opencv 冲突评估，不得继续 Task 2。

---

### Task 2: 新增 FaceLandmarkEnhancer（加载 .task + 推理 + IoU 匹配 + 附加字段）

**Files:**
- Modify: `ai-engine/engine/models.py`（新增 `mediapipe_task_path()`）
- Create: `ai-engine/engine/landmarks.py`
- Modify: `ai-engine/engine/selfcheck.py`（实例化增强器 + 增强冒烟；可选 face fixture 断言）

**Interfaces:**
- Consumes: `models.find_model` / `models.MODELS_DIR`；`face._ascii_model_path`。
- Produces:
  - `models.mediapipe_task_path() -> str|None`
  - `landmarks.FaceLandmarkEnhancer`：
    - `.available: bool`（mediapipe 可 import 且 `.task` 加载成功）
    - `.enhance(bgr, faces) -> int`：对全图跑 FaceLandmarker，按 IoU 把结果匹配进 `faces`，为匹配到的脸设 `face["mp"]`，返回被增强的脸数；`available==False` 或未检脸时返回 0 且不改动 `faces`。
  - `face["mp"]` 结构（Phase 2/3 消费契约）：
    ```python
    {
      "landmarks": [(x_px, y_px), ...],   # 478 个工作图像素坐标（有序，与 MediaPipe 索引一致）
      "blend": {name: score, ...},        # 52 个 blendshape 名 -> 概率，含 eyeBlinkLeft/eyeBlinkRight
      "bbox": [x, y, w, h],               # 由 478 点 extent 得到的像素框
      "matrix": [[...4],[...4],[...4],[...4]],  # 4x4 面部变换矩阵（Phase 4 姿态用）
      "score": float,                     # mediapipe 无显式置信度，用与 yunet box 的 IoU 代替
    }
    ```

- [ ] **Step 1: models.py 增加 .task 路径助手**

在 `ai-engine/engine/models.py` 末尾（`yunet_path()` 之后）加：

```python
def mediapipe_task_path():
    """MediaPipe FaceLandmarker 权重（face_landmarker.task，已随仓库入库）。"""
    return find_model("face_landmarker.task", "*.task")
```

- [ ] **Step 2: 写增强器模块**

Create `ai-engine/engine/landmarks.py`：

```python
# -*- coding: utf-8 -*-
"""MediaPipe FaceLandmarker 增强层：不改 YuNet 计数，仅把 478 点/blendshape 按 IoU
匹配回 YuNet 脸并附加到 face["mp"]。mediapipe 缺失或异常时 available=False，全流程回落。"""
import numpy as np

from .models import mediapipe_task_path


def _iou(a, b):
    """a,b=[x,y,w,h]。返回交并比。"""
    ax1, ay1, aw, ah = a
    bx1, by1, bw, bh = b
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh
    ix = max(0, min(ax2, bx2) - max(ax1, bx1))
    iy = max(0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


class FaceLandmarkEnhancer:
    def __init__(self, log=None):
        self.log = log or (lambda *a, **k: None)
        self.available = False
        self._lm = None
        self._mp = None
        try:
            import mediapipe as mp
            from mediapipe.tasks import python as mp_python
            from mediapipe.tasks.python import vision
            task = mediapipe_task_path()
            if not task:
                self.log("landmarker: face_landmarker.task not found, enhancement off")
                return
            from .face import _ascii_model_path
            ascii_task = _ascii_model_path(task)
            opts = vision.FaceLandmarkerOptions(
                base_options=mp_python.BaseOptions(model_asset_path=ascii_task),
                running_mode=vision.RunningMode.IMAGE,
                num_faces=6,
                output_face_blendshapes=True,
                output_facial_transformation_matrixes=True,
            )
            self._mp = mp
            self._vision = vision
            self._lm = vision.FaceLandmarker.create_from_options(opts)
            self.available = True
            self.log("landmarker: mediapipe FaceLandmarker ready")
        except Exception as e:  # noqa: BLE001
            self.available = False
            self.log("landmarker off (%s: %s)" % (type(e).__name__, e))

    def enhance(self, bgr, faces):
        """对全图跑一次，按 IoU 匹配到 YuNet 脸并附加 face['mp']。返回增强脸数。"""
        if not self.available or not faces:
            return 0
        H, W = bgr.shape[:2]
        try:
            rgb = np.ascontiguousarray(bgr[:, :, ::-1])
            mp_img = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
            res = self._lm.detect(mp_img)
        except Exception as e:  # noqa: BLE001
            self.log("landmarker detect failed (%s)" % e)
            return 0
        ml = res.face_landmarks or []
        mb = res.face_blendshapes or []
        mm = res.facial_transformation_matrixes or []
        cands = []  # (mp_bbox, landmarks_px, blend_dict, matrix_list)
        for i, lms in enumerate(ml):
            pts = [(lm.x * W, lm.y * H) for lm in lms]
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            x0, x1 = min(xs), max(xs)
            y0, y1 = min(ys), max(ys)
            mp_bbox = [x0, y0, max(1, x1 - x0), max(1, y1 - y0)]
            blend = {}
            if i < len(mb) and mb[i]:
                blend = {c.category_name: float(c.score) for c in mb[i]}
            matrix = None
            if i < len(mm):
                try:
                    matrix = np.array(mm[i]).reshape(4, 4).tolist()
                except Exception:  # noqa: BLE001
                    matrix = None
            cands.append((mp_bbox, pts, blend, matrix))
        enhanced = 0
        used = set()
        for face in faces:
            best_j, best_iou = -1, 0.0
            for j, (mp_bbox, _pts, _blend, _m) in enumerate(cands):
                if j in used:
                    continue
                v = _iou(face["box"], mp_bbox)
                if v > best_iou:
                    best_iou, best_j = v, j
            if best_j >= 0 and best_iou >= 0.30:
                _bbox, pts, blend, matrix = cands[best_j]
                used.add(best_j)
                face["mp"] = {
                    "landmarks": pts,
                    "blend": blend,
                    "bbox": [int(round(v)) for v in _bbox],
                    "matrix": matrix,
                    "score": round(best_iou, 3),
                }
                enhanced += 1
        return enhanced
```

- [ ] **Step 3: selfcheck 增加增强器实例化 + 冒烟**

在 `ai-engine/engine/selfcheck.py` 的 `run()` 中，yunet 冒烟段之后再加一段独立 try：

```python
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
```

并在 `out` 初始化里加默认键：

```python
        "landmarker_available": False,
        "enhance_smoke_ok": False,
        "enhanced_faces": 0,
```

- [ ] **Step 4: Commit**

```bash
git add ai-engine/engine/models.py ai-engine/engine/landmarks.py ai-engine/engine/selfcheck.py
git commit -m "feat(engine): add FaceLandmarkEnhancer (478+blendshapes IoU-matched onto yunet faces)"
```

---

### Task 3: 把增强层接入 DetectEngine + 能力上报

**Files:**
- Modify: `ai-engine/engine/__init__.py`（实例化增强器；`detect()` 内调用；`capabilities()` 上报）

**Interfaces:**
- Consumes: `landmarks.FaceLandmarkEnhancer`（Task 2）
- Produces: 每个真实运行经 `detect()` 的 `face` 可能带 `face["mp"]`；`capabilities()["landmarker"]:bool`；`faceBackend` 在 yunet+mediapipe 时为 `"yunet+mediapipe"`。

- [ ] **Step 1: 实例化增强器**

`ai-engine/engine/__init__.py` 顶部 import 增加：

```python
from .landmarks import FaceLandmarkEnhancer
```

`DetectEngine.__init__` 内、`self.expr = ExpressionAnalyzer()` 之后加：

```python
        self.landmarker = FaceLandmarkEnhancer(log=self.log)
```

并在其 `self.log("engine ready: ...")` 那一行末尾追加 `+ " landmarker=%s" % self.landmarker.available`（保持单行）。

- [ ] **Step 2: detect() 调用增强（guarded，位置：YuNet 之后、眼睛/画质分析之前）**

`ai-engine/engine/__init__.py` 的 `detect()`，在 `faces = self.faces.detect(bgr)` 之后、`face_count = len(faces)` 之前插入：

```python
        # MediaPipe 增强：把 478 点/blendshape 挂到 YuNet 脸上供后续维度消费。
        # 绝不改变 faces 数量/顺序（计数仍归 YuNet）；任何异常内部吞掉、回落启发式。
        try:
            if self.landmarker.available and faces:
                self.landmarker.enhance(bgr, faces)
        except Exception:  # noqa: BLE001
            self.log("landmarker enhance skipped (guarded)", level="warn")
```

> 说明：增强失败时 `face` 不带 `mp`，Phase 1 里闭眼/半截头本就不读 `mp`，行为零变化；Phase 2/3 消费时会 `face.get("mp")` 判缺省回落。

- [ ] **Step 3: capabilities 上报**

`ai-engine/engine/__init__.py` 的 `capabilities()` 返回字典里加一行，并让 `faceBackend` 反映增强：

```python
            "landmarker": self.landmarker.available,
```

把现有 `"faceBackend": self.faces.backend,` 改为：

```python
            "faceBackend": (self.faces.backend + "+mediapipe") if self.landmarker.available else self.faces.backend,
```

- [ ] **Step 4: selfcheck 端到端（回归门：走完整 DetectEngine.detect 不崩）**

`ai-engine/engine/selfcheck.py` 增强冒烟段之后再加一段：

```python
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
```

在 selfcheck.py 顶部加一个取测试图的小helper（有真实脸 fixture 用之，无则合成图）：

```python
def _fixture_or_synthetic():
    """优先用仓库里的 tests/fixtures/face.jpg 做端到端真实脸验证；不存在则用合成图占位。"""
    p = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests", "fixtures", "face.jpg")
    return p if os.path.exists(p) else _synthetic_png()


def _synthetic_png():
    import cv2
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_selfcheck_synth.png")
    img = np.full((240, 240, 3), 120, dtype=np.uint8)
    cv2.imwrite(p, img)
    return p
```

并在 `out` 初始化加：`"e2e_ok": False, "e2e_dims": [], "out_landmarker_cap": False,`，同时文件顶部需要 `import os`（本 Phase 起 selfcheck 会用到 os，恢复之）。

- [ ] **Step 5: Commit**

```bash
git add ai-engine/engine/__init__.py ai-engine/engine/selfcheck.py
git commit -m "feat(engine): wire FaceLandmarkEnhancer into detect pipeline + report landmarker capability"
```

- [ ] **Step 6: 触发 CI 验证 Phase 1 收口**

一键发布触发三平台构建；读 selfcheck JSON，确认（有 fixture 时最佳）：
- `detect_ok:true`、`yunet_ok:true`、`landmarker_available:true`、`enhance_smoke_ok:true`、`e2e_ok:true`、`out_landmarker_cap:true`、`error:null`
- 若提供了 `face.jpg`：`enhanced_faces>=1`（真实脸被挂上 `mp`）。
- 任一 `build:engine`/前端 `npm run build` 失败 → 说明 opencv-contrib 切换影响主进程或引擎，回报并回退评估。

---

### Task 4: CodeReview 评审闸 + 记录 Phase 1 结果

**Files:**
- Create: `docs/superpowers/plans/2026-10-09-mediapipe-phase1-results.md`

- [ ] **Step 1: 生成整批 diff 并派 CodeReview subagent**

评审范围：Task 1..3 的提交区间。核对项：
- 增强层异常是否被全路径兜住（`enhance()` 内层 try + `detect()` 外层 guard），绝不因 mediapipe 崩主检测；
- faces 数量/顺序是否未被增强层改动（计数仍归 YuNet）；
- opencv-contrib 切换是否影响 `face.py`/`quality.py` 用到的 cv2 API（`FaceDetectorYN`、`data.haarcascades`、`dct` 等）；
- `face["mp"]` 字段契约是否与 Phase 2/3 消费预期一致（键名、坐标空间=工作图像素）；
- selfcheck 各段 try 是否彼此隔离（一段失败不吞掉前段成功结果）。

- [ ] **Step 2: 修评审发现（Critical/Important），提交**

- [ ] **Step 3: 写结果文档**

`docs/superpowers/plans/2026-10-09-mediapipe-phase1-results.md`：三平台 selfcheck 全字段、`face["mp"]` 契约、已知的 opencv-contrib 体积/行为影响、是否提供 face fixture、下一步（Phase 2 闭眼 EAR+eyeBlink 消费 `mp`）。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-mediapipe-phase1-results.md
git commit -m "docs: record mediapipe phase1 enhancement-layer results"
```

---

## Self-Review（本计划对 spec §3.1/§5 的覆盖）

- **拆分架构（YuNet 计数 + MediaPipe 增强）** → Task 3 明确"增强不改数量/顺序"，Task 1 先证 cv2 共存。✅
- **数据契约 `face["mp"]`（478 点/blend/bbox/matrix）** → Task 2 定义并产出，Task 4 复核与 Phase 2/3 一致。✅
- **优雅降级不可破** → 增强器 `available=False` + 双层 try；Task 4 专项核查。✅
- **非 ASCII 路径** → Task 2 走 `_ascii_model_path`。✅
- **可选依赖不阻断构建** → 延续 spike 既有 best-effort，本计划未回退。✅
- **验证基座 = 冻结 selfcheck** → 每个 gate 任务以 selfcheck 扩展字段为验收；本机无 Python 的约束已显式处理（无虚构 pytest）。✅
- **不改闭眼/半截头逻辑** → Task 3 仅挂字段、Phase 2/3 才消费；`eyes.py`/`quality.py` 未在本计划被触碰。✅
- **已知代价（opencv-contrib 体积/行为、Intel Mac 回落）** → Task 1 Step 5 / Task 3 Step 6 的 CI gate 兜住；结果文档记录。✅
