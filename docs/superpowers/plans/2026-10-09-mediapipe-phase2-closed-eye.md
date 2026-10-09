# MediaPipe 闭眼增强（Phase 2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让闭眼检测消费 Phase 1 挂载的 `face["mp"]`——用 478 点算 EAR（Soukupova & Cech）+ `eyeBlinkLeft/Right` blendshape 双指标判闭合，达到 spec G1（v1 水平）；mediapipe 不可用/该脸未匹配到 mp 时，逐脸回落到现有启发式/OCEC 路径，行为零劣化。

**Architecture:** 只改 `engine/eyes.py` 的 `closed_eye`——在逐脸循环开头插入"有 mp 走 `_mp_closed_prob`（EAR+blink 取大），否则走原 `eye_rois`+`_eye_stats`/OCEC"的分叉，两条路径并存。为闭合 Phase 1 遗留的"IoU 挂载未正向验证"缺口，新增两张 **AI 生成的无版权人脸 fixture**（睁眼/闭眼各一），由 CI 在 selfcheck 前复制到引擎目录旁，selfcheck 增加"真实脸挂载 + 闭眼信号"正向字段。半截头（Phase 3）不在本计划。

**Tech Stack:** Python 3.11、mediapipe FaceLandmarker（Phase 1 已接入）、opencv-contrib、PyInstaller、GitHub Actions 三平台、ImageGen（生成 fixture）。

**Spec:** `docs/superpowers/specs/2026-10-09-mediapipe-face-landmarker-design.md` §3.3 闭眼、§7 Phase 2；前置 Phase 1 已 PASS：`docs/superpowers/plans/2026-10-09-mediapipe-phase1-results.md`

## Global Constraints

- **YuNet 计数权威不变**：本计划完全不碰 `face.py`/`__init__.py` 的检测与计数，只改 `eyes.py` 消费方式。
- **优雅降级不可破**：某脸无 `mp`（未匹配/mediapipe 缺失/Intel Mac 回落）→ 该脸走现有启发式/OCEC，闭眼维度绝不崩、绝不因缺 mp 报错。`closed_eye` 对"全部脸都无 mp"的输入，输出必须与 Phase 1 之前逐字节一致。
- **消费的是实际契约，非 spec 设想**：Phase 1 落地的是嵌套 `face["mp"]={landmarks(像素坐标 list), blend(dict), bbox(像素[x,y,w,h]), matrix, score}`，**不是** spec §3.2 的扁平 `lm478_norm`/`face_bbox`。EAR 是比值→尺度无关，像素坐标直接算；`blend` 键名 `eyeBlinkLeft`/`eyeBlinkRight`。
- **阈值先用 spec 初值，校准靠真实照**：`EAR_CLOSED=0.18`、`BLINK_CLOSED=0.60` 为 spec 起点；绝对阈值最终由用户用新娘照过软件人工校准（本机无 Python、CI 用相对信号验证，见判定标准）。
- **fixture 必须是 AI 生成/无版权**：真实客户照片严禁入库/入安装包（隐私 + 随包分发）。
- **ASCII 安全 & 可选依赖不阻断构建**：延续既有约束（selfcheck 全 append 错误、各段 try 隔离；不新增中文 print 到构建路径）。
- **验证基座 = 冻结引擎 `--selfcheck`（CI 三平台）**：本机无 Python/无 pytest。selfcheck 新增字段：`mount_faces`、`mount_enhanced`、`mount_ok`、`eye_mp_used`、`closed_conf_open`、`closed_conf_closed`、`mount_closed_ok`。
- 继续在 `main` 分支开发，不开 worktree。

---

### Task 1: eyes.py 闭眼 MediaPipe 路径（EAR + eyeBlink，带逐脸回落）

**Files:**
- Modify: `ai-engine/engine/eyes.py`

**Interfaces:**
- Consumes: `face["mp"]["landmarks"]`（478×像素坐标 list）、`face["mp"]["blend"]`（dict，含 `eyeBlinkLeft/Right`）。
- Produces: `eyes.closed_eye(bgr, faces)` 签名与返回 `(confidence, reason)` 不变；新增模块级 `_mp_closed_prob(face) -> (float, str) | None`、`_eye_ear(lms, idx) -> float | None`。

- [ ] **Step 1: 加常量与 EAR/闭合概率工具（放在 `from .face import eye_rois` 之后、`_eye_stats` 之前）**

```python
# MediaPipe FaceLandmarker 478 点：左右眼各 6 点（Soukupova & Cech EAR 变体，索引对应 FaceLandmarker 拓扑）
_EYE_L = [33, 160, 158, 133, 153, 144]
_EYE_R = [362, 385, 387, 263, 374, 380]
_EAR_CLOSED = 0.18    # EAR 低于此视为几何全闭（spec 起点，待真实照校准）
_BLINK_CLOSED = 0.60  # eyeBlink blendshape 概率达到此视为闭合


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _eye_ear(lms, idx):
    """6 点 EAR = (|p1-p5| + |p2-p4|) / (2|p0-p3|)。像素坐标即可（比值尺度无关）。异常/点不足返回 None。"""
    try:
        p = [lms[i] for i in idx]
    except Exception:  # noqa: BLE001
        return None
    h = _dist(p[0], p[3])
    if h <= 1e-6:
        return None
    return (_dist(p[1], p[5]) + _dist(p[2], p[4])) / (2.0 * h)


def _mp_closed_prob(face):
    """有 mp 时返回 (闭合概率, 诊断串)；无 mp / 数据不足返回 None（交调用方回落启发式）。
    单眼闭合度 = max(EAR 几何闭合度, eyeBlink blendshape 概率)；取两眼较大——任一闭合即计，偏召回。"""
    mpd = face.get("mp")
    if not mpd:
        return None
    lms = mpd.get("landmarks")
    blend = mpd.get("blend") or {}
    if not lms or len(lms) < 478:
        return None
    best = None
    diag = []
    for idx, blink_key in ((_EYE_L, "eyeBlinkLeft"), (_EYE_R, "eyeBlinkRight")):
        ear = _eye_ear(lms, idx)
        p_ear = None if ear is None else max(0.0, min(1.0, 1.0 - ear / _EAR_CLOSED))
        blink = blend.get(blink_key)
        p_blink = None if blink is None else max(0.0, min(1.0, float(blink) / _BLINK_CLOSED))
        cand = [x for x in (p_ear, p_blink) if x is not None]
        if not cand:
            continue
        pe = max(cand)
        best = pe if best is None else max(best, pe)
        diag.append("%s(ear=%s blink=%s)" % (
            "L" if blink_key.endswith("Left") else "R",
            ("%.3f" % ear) if ear is not None else "NA",
            ("%.2f" % blink) if blink is not None else "NA"))
    if best is None:
        return None
    return float(best), "mp:%.2f[%s]" % (best, " ".join(diag))
```

- [ ] **Step 2: 在 `closed_eye` 逐脸循环开头插入 mp 分叉（保留原启发式为 else 分支）**

把 `closed_eye` 内 `parts = []` 之后到循环体改为：

```python
        worst = 0.0
        worst_detail = None
        parts = []
        used_mp = False
        for face in faces[:6]:
            mp = _mp_closed_prob(face)
            if mp is not None:
                prob, d = mp
                used_mp = True
                parts.append(d)
                worst = max(worst, prob)
                continue
            for roi in eye_rois(face, bgr):
                side, x, y, w, h, _, _ = roi
                patch = bgr[y:y + h, x:x + w]
                prob = self._ocec_prob(patch) if self.ocec.available else None
                if prob is None:
                    open_score, _, dd = _eye_stats(bgr, roi)
                    prob = 1.0 - open_score
                    parts.append("%s:%.2f" % (side, prob))
                    if prob >= worst:
                        worst_detail = dd
                else:
                    parts.append("%s:ocec%.2f" % (side, prob))
                worst = max(worst, prob)
        method = "mediapipe" if used_mp else ("ocec" if self.ocec.available else "heuristic")
```

> 说明：`method` 仅在**至少一张脸走了 mp**时标 `mediapipe`；混合场景（部分脸有 mp 部分没有）worst 取所有脸的最大值，召回不降。原 `reason` 拼接与 `worst_detail` 诊断段（vv/dyn/rp）保持不动。

- [ ] **Step 3: 静态语法自检（本机无 Python 则跳过，交 CI build 暴露）**

Run: `python -c "import ast; ast.parse(open('ai-engine/engine/eyes.py',encoding='utf-8').read()); print('ok')"`

- [ ] **Step 4: Commit**

```bash
git add ai-engine/engine/eyes.py
git commit -m "feat(eyes): closed-eye via MediaPipe EAR+eyeBlink with per-face heuristic fallback"
```

---

### Task 2: AI 人脸 fixture + selfcheck 挂载/闭眼正向验证字段

**Files:**
- Create: `ai-engine/tests/fixtures/face_open.jpg`（ImageGen 生成，睁眼正脸）
- Create: `ai-engine/tests/fixtures/face_closed.jpg`（ImageGen 生成，闭眼正脸）
- Modify: `ai-engine/engine/selfcheck.py`

**Interfaces:**
- Consumes: `imaging.load_work_image`、`face.FaceDetector`、`landmarks.FaceLandmarkEnhancer`、`eyes.EyesAnalyzer`、`models.BASE_DIR`。
- Produces: selfcheck JSON 新增 `mount_faces:int`、`mount_enhanced:int`、`mount_ok:bool`、`eye_mp_used:bool`、`closed_conf_open:float|null`、`closed_conf_closed:float|null`、`mount_closed_ok:bool`。

- [ ] **Step 1: 用 ImageGen 生成两张无版权真实感人脸**

- `face_open`：prompt = "Photorealistic studio headshot of a single adult facing the camera directly, both eyes OPEN looking into the lens, neutral calm expression, even soft frontal lighting, plain light-gray background, sharp focus on the face, head centered and fully visible, natural skin, no glasses, no hats"，size 768x1024。
- `face_closed`：同上，仅把 "both eyes OPEN looking into the lens" 换成 "both eyes gently CLOSED, relaxed face"。

要求：正脸、单人脸、脸在画面占比大、五官清晰——保证 YuNet 与 FaceLandmarker 都能稳定检出。

- [ ] **Step 2: 落盘到 fixtures（ImageGen 产物路径 → 目标，扩展名对加载无影响，imread_any 按内容解码）**

```powershell
New-Item -ItemType Directory -Force ai-engine/tests/fixtures | Out-Null
Copy-Item <face_open 生成路径> ai-engine/tests/fixtures/face_open.jpg -Force
Copy-Item <face_closed 生成路径> ai-engine/tests/fixtures/face_closed.jpg -Force
```

确认 `git check-ignore ai-engine/tests/fixtures/face_open.jpg` 无输出（不被忽略）；若被忽略则 `git add -f`。

- [ ] **Step 3: selfcheck 顶部加 fixture 定位 helper，并让 `_fixture_or_synthetic` 优先用真实脸**

在 `_synthetic_png` 之后加：

```python
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
```

把现有 `_fixture_or_synthetic` 改为：

```python
def _fixture_or_synthetic():
    p = _fixture_named("face_open.jpg")
    return p if p else _synthetic_png()
```

- [ ] **Step 4: selfcheck `out` 初始化加默认键**

在 `"out_landmarker_cap": False,` 之后加：

```python
        "mount_faces": 0,
        "mount_enhanced": 0,
        "mount_ok": False,
        "eye_mp_used": False,
        "closed_conf_open": None,
        "closed_conf_closed": None,
        "mount_closed_ok": False,
```

- [ ] **Step 5: e2e 段之后、`return out` 之前，加"真实脸挂载 + 闭眼信号"独立 try 段**

```python
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
            conf, _r = ea.closed_eye(bgr, faces)
            return {"faces": len(faces), "enhanced": int(n),
                    "has_mp": any("mp" in f for f in faces), "conf": round(float(conf), 3)}

        op = _probe("face_open.jpg")
        cl = _probe("face_closed.jpg")
        if op:
            out["mount_faces"] = op["faces"]
            out["mount_enhanced"] = op["enhanced"]
            out["mount_ok"] = bool(op["faces"] >= 1 and op["enhanced"] >= 1)
            out["eye_mp_used"] = bool(op["has_mp"])
            out["closed_conf_open"] = op["conf"]
        if cl:
            out["closed_conf_closed"] = cl["conf"]
            out["mount_closed_ok"] = bool(cl["enhanced"] >= 1)
    except Exception as _me:  # noqa: BLE001
        out["error"] = (out["error"] or "") + " |mount: %s: %s" % (type(_me).__name__, _me)
    return out
```

- [ ] **Step 6: Commit**

```bash
git add ai-engine/tests/fixtures/face_open.jpg ai-engine/tests/fixtures/face_closed.jpg ai-engine/engine/selfcheck.py
git commit -m "test(engine): AI face fixtures + selfcheck mount/eye-signal positive fields"
```

---

### Task 3: CI selfcheck 步前复制 fixture（三平台，生产安装包零污染）

**Files:**
- Modify: `.github/workflows/release.yml`（三平台 selfcheck 步的 `run`）

**Interfaces:**
- Consumes: 仓库内 `ai-engine/tests/fixtures/*.jpg`；`defaults.working-directory: app`（故 ai-engine 相对路径为 `../ai-engine`）。
- Produces: 冻结引擎运行前，`engine-dist/<plat>/tests/fixtures/*.jpg` 就位，selfcheck 的 `_fixture_named` 命中真实脸。

- [ ] **Step 1: 先读 release.yml 定位三处 selfcheck 步的精确文本**

Run: `grep -n "selfcheck" .github/workflows/release.yml`（用 Read/Grep 工具核实当前 `run:` 行与 shell）。

- [ ] **Step 2: Windows selfcheck 步 run 改为先复制再执行**

```yaml
        run: |
          mkdir -p engine-dist/win/tests/fixtures
          cp ../ai-engine/tests/fixtures/*.jpg engine-dist/win/tests/fixtures/ 2>/dev/null || true
          ./engine-dist/win/screener-engine.exe --selfcheck
```

- [ ] **Step 3: macOS arm64 与 Intel 两处 selfcheck 步同理**

```yaml
        run: |
          mkdir -p engine-dist/mac/tests/fixtures
          cp ../ai-engine/tests/fixtures/*.jpg engine-dist/mac/tests/fixtures/ 2>/dev/null || true
          ./engine-dist/mac/screener-engine --selfcheck
```

> `|| true` 保证即使复制失败（如某平台无 wheel 本就要回落），selfcheck 仍运行、只是 mount 字段为 0——不阻断，符合 continue-on-error。

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: copy face fixtures beside engine before selfcheck (positive mount/eye gate)"
```

---

### Task 4: CodeReview 评审闸 + 一轮 CI 验证 + Phase 2 结果与校准文档

**Files:**
- Create: `docs/superpowers/plans/2026-10-09-mediapipe-phase2-results.md`

- [ ] **Step 1: 生成 Task 1..3 提交区间的 diff 包，派 CodeReview subagent**

核对项：
- `closed_eye` 的 mp 分叉是否**逐脸回落**（无 mp 脸仍走启发式，全空输入输出与 Phase 1 前一致）；
- `_eye_ear`/`_mp_closed_prob` 对 `landmarks` 越界、`blend` 缺键、`h<=0` 是否安全（返回 None 而非抛）；
- 是否误改 `__init__.py`/`face.py` 计数（本计划不应触碰）；
- selfcheck 新段是否独立 try、错误 append、不吞前段；
- yml 路径（`../ai-engine`、`engine-dist/<plat>`）与实际产物布局一致；
- fixture 是否确为 AI 生成（非真实人脸）。

- [ ] **Step 2: 修评审 Critical/Important，提交**

- [ ] **Step 3: 推送 + 一键发布触发 CI（或仓库已公开，直接 push 后 Re-run/新 tag）**

- [ ] **Step 4: 读三平台 selfcheck JSON，按判定标准核对**

**Phase 2 CI 判定标准：**
- 回归不破：`yunet_ok/detect_ok/landmarker_available/enhance_smoke_ok/e2e_ok` 仍全 true，`error:null`。
- 挂载正向（闭合 Phase 1 缺口）：`mount_ok:true`（≥1 真实脸拿到 mp）、`eye_mp_used:true`（closed_eye 走了 mp 路径）。
- 闭眼信号有效（相对判据，避开未校准绝对阈值）：`closed_conf_closed > closed_conf_open`——证明 EAR+eyeBlink 确实把闭眼图和睁眼图区分开。
- 若 `mount_faces:0`（YuNet 没检到 AI 脸）→ fixture 不够"真实感"，重新生成更写实的人脸再来（非代码问题）。

- [ ] **Step 5: 写结果文档**

`docs/superpowers/plans/2026-10-09-mediapipe-phase2-results.md`：三平台 selfcheck 全字段、`mount_ok/eye_mp_used/closed_conf_*` 实测值、fixture 说明（AI 生成）、**真实照校准回路**（用户用新娘睁眼/闭眼照过软件，读 reason 里 `mp:x.xx[L(ear=.. blink=..)]` 诊断，据此定 `EAR_CLOSED/BLINK_CLOSED` 终值）、遗留（半截头 Phase 3）。

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-mediapipe-phase2-results.md
git commit -m "docs: record mediapipe phase2 closed-eye enhancement results + calibration loop"
```

---

## Self-Review（对 spec §3.3 闭眼 / §7 Phase 2 的覆盖）

- **EAR + eyeBlink 双指标（G1）** → Task 1 `_mp_closed_prob` 取 `max(1-ear/EAR_CLOSED, blink/BLINK_CLOSED)`，两眼取大。✅
- **回落启发式** → Task 1 逐脸 `if mp is None` 走原 `_eye_stats`/OCEC；Global Constraints 锁死"全空输入输出不变"。✅
- **消费实际嵌套 `face["mp"]`（非 spec 扁平字段）** → 计划显式说明并据此取 `landmarks`/`blend`。✅
- **计数权威不变** → 不改 `face.py`/`__init__.py`。✅
- **正向验证挂载（闭合 Phase 1 遗留）** → Task 2/3 fixture + `mount_ok`。✅
- **绝对阈值待校准** → 判定用相对信号 `closed_conf_closed>closed_conf_open`；Task 4 文档给真实照校准回路。✅
- **隐私红线** → fixture 强制 AI 生成，真实照片仅走软件人工验收、不入库。✅
- **半截头不在本期** → 明确 Phase 3。✅
