# 人数分类改用人体检测 实现计划（Phase 3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"单人照/多人合照/无人物场景"三类的人数判定权威从数人脸（YuNet）换成数人体（MediaPipe ObjectDetector），根治婚礼背对/侧脸/遮脸导致的人脸漏检误判。

**Architecture:** 新增 `engine/person.py::PersonDetector`，复用已冻结跑通的 mediapipe 运行时（`ObjectDetector` + `efficientdet_lite0` COCO .tflite，Apache-2.0，零新依赖、不碰 torch）；`detect()` 用它数出 `person_count` 作为三类人数分类权威，模型缺失或"判 0 但人脸/躯干存在"时逐字回落到现有 `face_count` 分支（零回归）。人脸维度（闭眼/斜眼/半截头/狰狞）完全不动。

**Tech Stack:** Python (mediapipe Tasks / OpenCV / numpy)，PyInstaller 冻结引擎，Node 构建脚本，GitHub Actions 三平台 CI 自检。

**Spec:** `docs/superpowers/specs/2026-10-09-person-count-body-detection-design.md`（本计划依此论证；执行时先读 spec）

## Global Constraints

- **严禁引入 PyTorch / ultralytics**；只复用已冻结的 `mediapipe` 运行时（`mediapipe.tasks.python.vision`）。
- **人体模型资产必须入库**（`git add -f`）+ **构建硬校验**（缺失 `process.exit(1)`），对齐 yunet/face_landmarker 模式，不依赖 CI 联网下载。
- **零回归硬约束**：不得修改 `faces` 的数量/顺序/内容，不得修改 `face_count`、`upper`、`eye_bgr` 的任何计算；`person_count` 是并行新增独立信号，只喂人数分类分支。
- **模型路径必须走 `_ascii_model_path()`**（中文安装目录坑）。
- **本机无 Python**：验证基座 = 冻结 `selfcheck --selfcheck` + CI 三平台单行 JSON，**无本地 pytest**；每个红/绿循环 = 一次"发布 → 读 CI 字段"。
- **CI 回归闸**：每次人体改动必须同时重跑 Phase 2 闭眼字段（`mount_closed_ok`、`closed_enhanced>=1`、`closed_has_mp`、`closed_conf_closed > closed_conf_open`、reason 含 `[mediapipe]`）并保持 PASS；任一闭眼/半截头字段相对基线回退 = 本任务判 FAIL、不合入。
- **隐私红线**：真实客户照片严禁入库；验证只用 AI 生成的合成 fixture。
- 分类维度 key 不变（`single_person`/`group_photo`/`no_person`），前端 UI/TS 无需改动。

---

### Task 1: 人体模型资产入库 + 构建硬校验（打包闸门）

**Files:**
- Create: `ai-engine/models/efficientdet_lite0.tflite`（从稳定 URL 下载后入库）
- Modify: `ai-engine/engine/models.py`（新增 `person_model_path()`）
- Modify: `app/scripts/build-engine.mjs:124-148`（复制 `.tflite` + 硬校验）
- Modify: `ai-engine/models/README.md`（记录来源/授权）

**Interfaces:**
- Consumes: 无
- Produces: `models.person_model_path() -> Optional[str]`（找到 `efficientdet*.tflite`/`person_*.tflite` 返回路径，否则 None）；冻结包 `models/` 内存在人体 .tflite。

- [ ] **Step 1: 下载模型并核对授权/体积**

从稳定 Google storage URL 下载 EfficientDet-Lite0（float32）：
`https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite`
放置为 `ai-engine/models/efficientdet_lite0.tflite`。核对：体积 ~4MB、Apache-2.0（Google）、COCO 80 类含 `person`。
（本机用浏览器/curl 下载文件，不进 CI 联网步骤。）

- [ ] **Step 2: 入库模型（覆盖 .gitignore）**

```bash
git add -f ai-engine/models/efficientdet_lite0.tflite
```

- [ ] **Step 3: models.py 新增寻址函数**

在 `ai-engine/engine/models.py` 的 `mediapipe_task_path()` 之后追加：

```python
def person_model_path():
    """人体检测 MediaPipe 模型（efficientdet_lite0.tflite，已随仓库入库）。"""
    return find_model("efficientdet*.tflite", "person_*.tflite", "*.tflite")
```

- [ ] **Step 4: build-engine.mjs 复制 .tflite**

在 `app/scripts/build-engine.mjs` 复制 `.task` 的循环（约 L124-127）之后，加一段复制 `.tflite`：

```javascript
// 复制仓库里的 MediaPipe 人体模型（.tflite），随 models/ 分发
for (const f of existsSync(srcModels) ? readdirSync(srcModels) : []) {
  if (f.toLowerCase().endsWith('.tflite')) cpSync(join(srcModels, f), join(outModels, f))
}
```

- [ ] **Step 5: build-engine.mjs 硬校验人体模型**

参照 L139-148 的 `face_landmarker.task` 校验块，在其后追加人体模型缺失即 `exit(1)`：

```javascript
// 硬校验：人体检测模型必须随包（已入库）。缺失拒绝打包，避免人数分类静默退化。
const hasPerson = existsSync(outModels) && readdirSync(outModels).some((f) => /efficientdet.*\.tflite$|person_.*\.tflite$/i.test(f))
if (!hasPerson) {
  console.error(
    `\n❌ 引擎缺少人体检测模型（efficientdet*.tflite），实际 models/ 内容：` +
      `${existsSync(outModels) ? readdirSync(outModels).join(', ') : '(目录不存在)'}\n` +
      '该文件已随仓库提交，若仍缺失请确认构建机拉到了完整仓库。拒绝打包残缺引擎。'
  )
  process.exit(1)
}
```

- [ ] **Step 6: README 记录来源与授权**

在 `ai-engine/models/README.md` 增加：`efficientdet_lite0.tflite`（Apache-2.0, Google, COCO, ObjectDetector 用）来源 URL 与"已入库、勿删"说明。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat(engine): 入库 efficientdet_lite0.tflite 人体模型 + 构建硬校验"
```

---

### Task 2: `engine/person.py` PersonDetector（ObjectDetector + 背景过滤）

**Files:**
- Create: `ai-engine/engine/person.py`
- Test: `ai-engine/engine/selfcheck.py`（Task 4 接入，此处先本地结构自检靠 CI）

**Interfaces:**
- Consumes: `models.person_model_path()`（Task 1）、`face._ascii_model_path`
- Produces: `PersonDetector(log=None)`，属性 `available: bool`；方法 `count(bgr) -> (person_count:int, bodies:list[dict])`，`bodies[i]={"box":[x,y,w,h],"score":float,"h_ratio":float,"area_ratio":float}`。异常/模型缺失 → `available=False`、`count` 返回 `(None, [])`。

- [ ] **Step 1: 写 PersonDetector**

创建 `ai-engine/engine/person.py`：

```python
# -*- coding: utf-8 -*-
"""人体检测：MediaPipe ObjectDetector（复用已冻结 mediapipe 运行时，零新依赖、不碰 torch）。
仅用于"单人/多人/无人物"人数分类，不影响人脸维度。模型缺失/异常 → available=False，调用方回落人脸计数。"""
import numpy as np

from .models import person_model_path

# 背景路人过滤（婚礼实测：主角占图高通常 ≥30%，远景宾客约 3-6%）：二者任一不达标即剔除。
# CI 合成图起点值，待真实婚礼照校准。
_BODY_MIN_H_RATIO = 0.10
_BODY_MIN_AREA_RATIO = 0.006
_SCORE_MIN = 0.35       # ObjectDetector 置信下限（人体框）
_PERSON_LABEL = "person"  # COCO class 0


class PersonDetector:
    def __init__(self, log=None):
        self.log = log or (lambda *a, **k: None)
        self.available = False
        self._det = None
        self._mp = None
        try:
            import mediapipe as mp
            from mediapipe.tasks import python as mp_python
            from mediapipe.tasks.python import vision
            model = person_model_path()
            if not model:
                self.log("person: efficientdet model not found, body-count off")
                return
            from .face import _ascii_model_path
            ascii_model = _ascii_model_path(model)
            opts = vision.ObjectDetectorOptions(
                base_options=mp_python.BaseOptions(model_asset_path=ascii_model),
                running_mode=vision.RunningMode.IMAGE,
                score_threshold=_SCORE_MIN,
                max_results=0,  # 0 = 返回全部（内部已 NMS）
            )
            self._mp = mp
            self._det = vision.ObjectDetector.create_from_options(opts)
            self.available = True
            self.log("person: mediapipe ObjectDetector ready")
        except Exception as e:  # noqa: BLE001
            self.available = False
            self._det = None
            self.log("person off (%s: %s)" % (type(e).__name__, e))

    def count(self, bgr):
        """返回 (过滤后人体数, 人体框详情)。不可用/异常返回 (None, []) 让调用方回落。"""
        if not self.available or self._det is None:
            return None, []
        try:
            H, W = bgr.shape[:2]
            area = float(H * W) or 1.0
            rgb = np.ascontiguousarray(bgr[:, :, ::-1])
            mp_img = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
            res = self._det.detect(mp_img)
            bodies = []
            for d in (res.detections or []):
                cats = d.categories or []
                if not cats or (cats[0].category_name or "") != _PERSON_LABEL:
                    continue
                bb = d.bounding_box
                bw, bh = float(bb.width), float(bb.height)
                h_ratio = bh / H
                area_ratio = (bw * bh) / area
                if h_ratio < _BODY_MIN_H_RATIO or area_ratio < _BODY_MIN_AREA_RATIO:
                    continue  # 背景路人/碎框
                bodies.append({
                    "box": [int(bb.origin_x), int(bb.origin_y), int(bw), int(bh)],
                    "score": round(float(cats[0].score), 3),
                    "h_ratio": round(h_ratio, 3),
                    "area_ratio": round(area_ratio, 4),
                })
            return len(bodies), bodies
        except Exception as e:  # noqa: BLE001
            self.log("person detect failed (%s)" % e)
            return None, []
```

- [ ] **Step 2: 提交**

```bash
git add ai-engine/engine/person.py
git commit -m "feat(engine): PersonDetector(MediaPipe ObjectDetector + 背景过滤)"
```

---

### Task 3: 接入 `engine/__init__.py` 人数分类（body-count 权威 + 零回归回落）

**Files:**
- Modify: `ai-engine/engine/__init__.py`（imports、`__init__`、`detect` 人数分支 L100-113、`capabilities`）

**Interfaces:**
- Consumes: `PersonDetector.count(bgr)`（Task 2）
- Produces: dims 的 `single_person`/`group_photo`/`no_person` 在人体可用时 `method="body-count"`；capabilities 加 `personDetector`、`personModel`。

- [ ] **Step 1: 实例化 PersonDetector**

`ai-engine/engine/__init__.py` 顶部 import 段加 `from .person import PersonDetector`；`__init__` 里 `self.landmarker = ...` 之后加：

```python
self.person = PersonDetector(log=self.log)
```

启动 log 串尾追加 `person=%s` % self.person.available。

- [ ] **Step 2: capabilities 加人体字段**

`capabilities()` 返回字典加：

```python
"personDetector": self.person.available,
"personModel": bool(person_model_path()),
```

并在文件顶部 `from .models import detect_device, _HAS_ORT` 后加 `from .models import person_model_path`。

- [ ] **Step 3: 计算 person_count（并行、不碰人脸链路）**

在 `detect()` 内，`upper = ...`（L59）之后、`dims = {}` 之前，加**独立**人体计数（异常安全由 PersonDetector 内部处理）：

```python
person_count, bodies = (None, [])
if self.person.available:
    person_count, bodies = self.person.count(bgr)
```

- [ ] **Step 4: 人数分类分支改为 body 优先 + 零回归回落**

把现有 L100-113 的人数分类块替换为：

```python
        # --- 人数分类（中性维度）：人体计数为权威，缺失/假阴性回落人脸计数 ---
        # 零回归护栏：人体判 0 但有明确人脸/躯干 → 视为人体假阴性，此单张回落 face-count，
        # 绝不把"有脸/有躯干的图"改判成无人物（避免 Phase3 引入新的漏判）。
        override_face = person_count is not None and person_count == 0 and (face_count > 0 or len(upper) > 0)
        if person_count is not None and not override_face:
            if person_count == 0:
                if bright < 25:
                    dims["no_person"] = {"confidence": 0.70, "reason": "未检出人体，画面偏暗(亮度%.0f)，可能漏检" % bright, "method": "body-count"}
                else:
                    dims["no_person"] = {"confidence": 0.95, "reason": "未检出人体", "method": "body-count"}
            elif person_count == 1:
                b = bodies[0]
                scene = min(0.99, 0.88 + b["h_ratio"] * 0.4 + b["score"] * 0.05)
                dims["single_person"] = {"confidence": round(scene, 4), "reason": "检出 1 个人体", "method": "body-count"}
            else:
                avg = sum(x["score"] for x in bodies) / len(bodies)
                dims["group_photo"] = {"confidence": round(min(0.98, 0.88 + avg * 0.1), 4), "reason": "检出 %d 个人体" % person_count, "method": "body-count"}
        elif person_count is None:
            # 人体检测不可用：完全保留原 face-count 逻辑（逐字，零回归）
            if face_count == 0:
                if bright < 25:
                    dims["no_person"] = {"confidence": 0.55, "reason": "未检出人脸（检出 %d 躯干），但画面偏暗(亮度%.0f)，可能漏检" % (len(upper), bright), "method": "face-count"}
                else:
                    dims["no_person"] = {"confidence": 0.97 if not upper else 0.80, "reason": "未检出人脸（检出 %d 躯干）" % len(upper), "method": "face-count"}
            elif face_count == 1:
                dims["single_person"] = {"confidence": 0.985, "reason": "检出 1 张人脸", "method": "face-count"}
            else:
                dims["group_photo"] = {"confidence": 0.975, "reason": "检出 %d 张人脸" % face_count, "method": "face-count"}
        else:
            # override_face：人体判 0 但人脸/躯干存在 → 按 face_count 处理这单张
            if face_count == 0:
                dims["no_person"] = {"confidence": 0.97 if not upper else 0.80, "reason": "未检出人脸（检出 %d 躯干）" % len(upper), "method": "face-count"}
            elif face_count == 1:
                dims["single_person"] = {"confidence": 0.985, "reason": "检出 1 张人脸(人体回落)", "method": "face-count"}
            else:
                dims["group_photo"] = {"confidence": 0.975, "reason": "检出 %d 张人脸(人体回落)" % face_count, "method": "face-count"}
```

- [ ] **Step 5: 提交**

```bash
git add ai-engine/engine/__init__.py
git commit -m "feat(engine): 人数分类以人体计数为权威，含零回归回落护栏"
```

---

### Task 4: selfcheck 人体字段 + 合成 fixture + Phase 2 回归闸

**Files:**
- Create: `ai-engine/tests/fixtures/people_single.jpg`、`ai-engine/tests/fixtures/people_multi.jpg`（AI 生成写实质感）
- Modify: `ai-engine/engine/selfcheck.py`（新增人体段 + 顶层回归判定字段）

**Interfaces:**
- Consumes: `PersonDetector`、`DetectEngine.detect`
- Produces: CI JSON 字段 `person_model_found`、`person_detector_available`、`person_smoke_ok`、`person_single_count`、`person_multi_count`、`person_gate_ok`、`phase2_regression_ok`。

- [ ] **Step 1: 生成两张写实人体 fixture（非真实客户照）**

用 ImageGen 生成两张**写实风格**人物图（写实才能被 COCO 检测器识别，参照 Phase 2 写实脸经验）：
- `people_single.jpg`：一名站立的人，占画面高度约 60%，正面或侧身。
- `people_multi.jpg`：三名站立的人（并排、彼此分离，占图高各 ≥30%）。
保存到 `ai-engine/tests/fixtures/`。
（生成命令由执行者用 ImageGen 工具产出后落盘。）

- [ ] **Step 2: selfcheck 默认字段初始化**

`selfcheck.py` `run()` 的 `out` 字典里，`"error": None,` 之前追加默认键：

```python
        "person_model_found": False,
        "person_detector_available": False,
        "person_smoke_ok": False,
        "person_single_count": None,
        "person_multi_count": None,
        "person_gate_ok": False,
        "phase2_regression_ok": False,
```

- [ ] **Step 3: selfcheck 人体检测段（独立 try+append）**

在 mount 段（L193 的 `except ... |mount` 之后、`return out` 之前）加**独立 try**（遵循"多段验证必须独立 try+append 避免吞错"）：

```python
    # --- 人体检测冒烟 + 人数分类正向验证（CI 需复制 tests/fixtures/people_*.jpg 到引擎目录旁）---
    try:
        from .person import PersonDetector
        from .models import person_model_path
        out["person_model_found"] = bool(person_model_path())
        pd = PersonDetector()
        out["person_detector_available"] = bool(pd.available)
        if pd.available:
            # 合成灰度图冒烟：无人体也不得抛异常
            c0, _ = pd.count(np.full((200, 200, 3), 128, dtype=np.uint8))
            out["person_smoke_ok"] = (c0 is not None)
            sp = _fixture_named("people_single.jpg")
            mp_ = _fixture_named("people_multi.jpg")
            if sp:
                from .imaging import load_work_image
                bgr1, _s1 = load_work_image(sp)
                out["person_single_count"] = pd.count(bgr1)[0]
            if mp_:
                from .imaging import load_work_image
                bgr2, _s2 = load_work_image(mp_)
                out["person_multi_count"] = pd.count(bgr2)[0]
            out["person_gate_ok"] = bool(
                out["person_smoke_ok"]
                and (out["person_multi_count"] or 0) >= 2
                and (out["person_single_count"] or 0) >= 1
            )
    except Exception as _pe:  # noqa: BLE001
        out["person_smoke_ok"] = False
        out["error"] = (out["error"] or "") + " |person: %s: %s" % (type(_pe).__name__, _pe)
```

- [ ] **Step 4: Phase 2 回归闸字段**

在 person 段之后（`return out` 前）加：

```python
    # --- Phase2 闭眼回归闸：人体改动绝不允许让闭眼/挂载字段相对基线回退 ---
    try:
        out["phase2_regression_ok"] = bool(
            out.get("mount_closed_ok") and out.get("closed_enhanced", 0) >= 1
            and out.get("closed_has_mp") and (out.get("closed_conf_closed") or 0) > (out.get("closed_conf_open") or 0)
            and "mediapipe" in (out.get("closed_reason") or "")
        )
    except Exception:  # noqa: BLE001
        out["phase2_regression_ok"] = False
```

- [ ] **Step 5: 提交**

```bash
git add ai-engine/engine/selfcheck.py ai-engine/tests/fixtures/people_single.jpg ai-engine/tests/fixtures/people_multi.jpg
git commit -m "test(engine): selfcheck 人体检测字段 + 合成 fixture + Phase2 闭眼回归闸"
```

---

### Task 5: 发布 → CI 三平台核对（红/绿循环，本机无 Python）

**Files:** 无（发布触发 CI，读 JSON 核对）

**Interfaces:** Consumes: 前四任务产物。

- [ ] **Step 1: 用户一键发布**（生成 tag 触发 win + mac-arm + mac-x64 三平台 CI）

- [ ] **Step 2: 读三平台 selfcheck JSON，逐字段核对**

必须全绿（win 与 mac 各字段一致）：
- `person_model_found: true`、`person_detector_available: true`、`person_smoke_ok: true`
- `person_multi_count >= 2`、`person_single_count >= 1`、`person_gate_ok: true`
- `phase2_regression_ok: true`，且 `mount_closed_ok`/`closed_conf_closed>closed_conf_open`/reason 含 `[mediapipe]` 与 Phase 2 v2.0.57 基线一致
- `error: null`

- [ ] **Step 3: 若人体 fixture 未被 COCO 检出（person_multi_count<2）**

说明生成图不够写实 → 重新生成更照片质感的 fixture（真实人体比例/光照），重发核对。若反复失败，退回 spec 记录的 ONNX(NanoDet/PicoDet) 路线（仅改 `person.py`），记入账本。

- [ ] **Step 4: 写结果文档并账本收尾**

`docs/superpowers/plans/2026-10-09-person-count-body-detection-results.md`：记录三平台字段、body-count vs face-count 分类对比、遗留真实照校准项。

---

### Task 6: 真实照校准（用户在软件里做）

- [ ] **Step 1:** 用户用装好的人体检测版本跑真实婚礼文件夹，读每张分类标签 reason 的"检出 N 个人体"。
- [ ] **Step 2:** 若远景宾客仍被计入（N 偏大）→ 调高 `person.py` 的 `_BODY_MIN_H_RATIO`/`_BODY_MIN_AREA_RATIO`；若主角被误过滤（N 偏小）→ 调低。重发验证。
- [ ] **Step 3:** 记录落定的阈值回 spec/账本。

---

## Self-Review 结论

- **Spec 覆盖**：技术选型(Task1-2)/打包硬校验(Task1)/集成点与零回归(Task3)/背景过滤(Task2)/验证基座与回归闸(Task4-5)/真实照校准(Task6)——spec 各节均有对应任务，无缺口。
- **占位符**：无 TBD；模型 URL、阈值、代码、CI 字段均为具体值。
- **类型一致**：`person_model_path()`、`PersonDetector.count -> (int|None, list)`、`bodies[i].h_ratio/score`、`person_gate_ok`/`phase2_regression_ok` 字段名跨任务一致；维度 key 不变。
