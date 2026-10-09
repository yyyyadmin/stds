# MediaPipe 打包可行性 Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 验证 `mediapipe`（FaceLandmarker）能否被 PyInstaller 打进 Windows / macOS arm64 / macOS Intel 三平台冻结引擎，并在冻结 exe 内成功加载 `face_landmarker.task` 跑通一次 `detect()`。

**Architecture:** 在引擎加一个 `--selfcheck` 入口（导入 mediapipe → ASCII 路径加载 `.task` → 对合成图跑一次推理 → 输出结构化 JSON 状态），把 `.task` 提交进仓库并加构建硬校验，mediapipe 以"best-effort 可选安装、装不上不阻断构建"方式引入，CI 在三平台构建后各跑一次 selfcheck 并把结果打印到构建日志。

**Tech Stack:** Python 3.11、mediapipe（Tasks API）、PyInstaller、OpenCV、GitHub Actions（windows-latest / macos-14 / macos-15-intel）。

**Spec:** `docs/superpowers/specs/2026-10-09-mediapipe-face-landmarker-design.md`（本 spike 实现其 §7 Phase 0；通过后才启动 Phase 1-4 的后续计划）

## Global Constraints

- Python 版本固定 **3.11**（CI `actions/setup-python@v5` 已用 3.11；mediapipe 支持 3.9–3.12）。
- **可选依赖绝不阻断构建**：mediapipe 安装/打包失败时，构建继续、引擎回落 YuNet；但 `.task` 模型文件缺失必须**硬失败**（对齐既有 yunet 硬校验）。
- **非 ASCII 路径**：任何交给 mediapipe `BaseOptions(model_asset_path=...)` 的路径必须是 ASCII；中文安装目录下须复用 `face.py:_ascii_model_path` 复制到临时目录。
- **模型入库不下载**：`face_landmarker.task` 提交进仓库（`git add -f`），不走 CI 网络下载（规避 ONNX 死链导致构建失败的历史坑）。
- 本 spike **不改** `eyes.py`/`quality.py`/`__init__.py` 的检测逻辑（那是 Phase 2-3）；只验证打包链路。
- 验证方式：本机无 Python，**通过推送触发 CI、读三平台构建日志**判定；有 Python 3.11+mediapipe 的开发机可本地 `npm run build:engine` 后直接跑 selfcheck 加速。

---

## 关键前置：需要 `face_landmarker.task` 文件

本 spike 无法在代码里"生成"模型。Google 官方权重（float16，~3.7MB）：
`https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`

**由用户手动下载后放入 `ai-engine/models/face_landmarker.task`**（不纳入自动化下载）。Task 1 负责把它入库 + 校验。

---

### Task 1: 提交 face_landmarker.task 并加构建硬校验

**Files:**
- Add: `ai-engine/models/face_landmarker.task`（用户放入后 `git add -f`）
- Modify: `app/scripts/build-engine.mjs`（在现有 yunet 硬校验后追加 `.task` 校验与复制）

**Interfaces:**
- Produces: 冻结引擎 `models/face_landmarker.task` 存在；后续 Task 4 的 selfcheck 从该路径加载。

- [ ] **Step 1: 确认模型文件已在仓库工作区**

用户已将 `face_landmarker.task` 放到 `ai-engine/models/`。执行：

```bash
ls -la ai-engine/models/face_landmarker.task
```

Expected: 文件存在且大小 ≈ 3.5–4.0MB（若 <10KB 说明拿到的是错误页/指针，停止并报告）。

- [ ] **Step 2: 强制纳入版本控制（models 被 .gitignore）**

```bash
git add -f ai-engine/models/face_landmarker.task
git commit -m "chore(engine): vendor face_landmarker.task for MediaPipe spike"
```

- [ ] **Step 3: 在 build-engine.mjs 复制 `.task` 并硬校验**

在现有"复制仓库 onnx"循环（`build-engine.mjs` 约 114-117 行）之后、yunet 硬校验（约 120 行）附近，追加 `.task` 复制：

```js
// 复制仓库里的 MediaPipe 权重（.task），随 models/ 分发
for (const f of existsSync(srcModels) ? readdirSync(srcModels) : []) {
  if (f.toLowerCase().endsWith('.task')) cpSync(join(srcModels, f), join(outModels, f))
}
```

在 yunet 的 `hasYunet` 校验块之后，追加 `.task` 硬校验：

```js
// 硬校验：face_landmarker.task 必须随包（已入库）。缺失说明构建未取到仓库文件。
const hasTask = existsSync(outModels) && readdirSync(outModels).some((f) => /face_landmarker.*\.task$/i.test(f))
if (!hasTask) {
  console.error(
    `\n❌ 引擎缺少 MediaPipe 权重（face_landmarker.task），实际 models/ 内容：` +
      `${existsSync(outModels) ? readdirSync(outModels).join(', ') : '(目录不存在)'}\n` +
      '该文件已随仓库提交，若仍缺失请确认构建机拉到了完整仓库。拒绝打包残缺引擎。'
  )
  process.exit(1)
}
```

- [ ] **Step 4: 本地静态校验脚本无语法错误**

Run: `node --check app/scripts/build-engine.mjs`
Expected: 无输出（退出码 0）。

- [ ] **Step 5: Commit**

```bash
git add app/scripts/build-engine.mjs
git commit -m "feat(engine): hard-check face_landmarker.task is bundled"
```

---

### Task 2: 以 best-effort 方式引入 mediapipe 依赖

**Files:**
- Modify: `ai-engine/requirements.txt`（加注释说明 mediapipe 为可选，不放进必装项）
- Create: `ai-engine/requirements-optional.txt`
- Modify: `app/scripts/build-engine.mjs`（新增非致命安装步骤）

**Interfaces:**
- Produces: 构建机上尽力安装 mediapipe；装不上仅告警。后续 selfcheck 据此报告 mediapipe 是否可用。

- [ ] **Step 1: 创建可选依赖清单**

Create `ai-engine/requirements-optional.txt`:

```
# 可选增强：MediaPipe FaceLandmarker（478 点 + eyeBlink blendshape）
# 装不上（如某平台无 wheel）时引擎自动回落 YuNet，构建不失败。
mediapipe>=0.10.14
```

- [ ] **Step 2: 在 requirements.txt 顶部注释区标注 mediapipe 属可选**

Modify `ai-engine/requirements.txt` 第 7-8 行的可选增强注释，追加一行说明：

```
# MediaPipe FaceLandmarker 见 requirements-optional.txt（best-effort，构建脚本单独非致命安装）
```

- [ ] **Step 3: build-engine.mjs 增加非致命安装**

在现有 `run(P, ['-m', 'pip', 'install', '-r', join(ENGINE_SRC, 'requirements.txt')])`（约 89 行）之后，插入**不 `process.exit` 的**可选安装：

```js
// 可选：尽力安装 mediapipe（失败仅告警，不阻断构建——引擎回落 YuNet）
console.log('尝试安装可选依赖 mediapipe（失败可忽略，将回落 YuNet）…')
const mp = spawnSync(P, ['-m', 'pip', 'install', '-r', join(ENGINE_SRC, 'requirements-optional.txt')], { stdio: 'inherit', env: process.env })
if (mp.status !== 0) {
  console.warn('⚠️ mediapipe 安装失败：本平台将回落 YuNet（不影响构建成功）。')
}
```

- [ ] **Step 4: 静态校验**

Run: `node --check app/scripts/build-engine.mjs`
Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add ai-engine/requirements.txt ai-engine/requirements-optional.txt app/scripts/build-engine.mjs
git commit -m "feat(engine): best-effort optional mediapipe install without breaking build"
```

---

### Task 3: engine.spec 收集 mediapipe 数据/动态库/隐藏导入

**Files:**
- Modify: `ai-engine/engine.spec`

**Interfaces:**
- Produces: 冻结引擎内含 mediapipe 原生库与 graph 配置；selfcheck 能在 exe 内 `import mediapipe` 成功。

- [ ] **Step 1: 增加 mediapipe 收集（仅在已安装时）**

在 `engine.spec` 的 `datas = collect_data_files("cv2")` 之后、`hiddenimports = [...]` 之前，插入：

```python
# MediaPipe（可选）：收集其原生库、graph 配置与隐藏导入。未安装则跳过（引擎回落 yunet）。
try:
    import mediapipe  # noqa: F401
    datas += collect_data_files("mediapipe")
    binaries += collect_dynamic_libs("mediapipe")
except Exception as _e:  # noqa: BLE001
    print(f"[engine.spec] mediapipe 未收集（将回落 yunet）：{_e}")
```

- [ ] **Step 2: hiddenimports 追加 mediapipe 相关**

Modify `hiddenimports` 列表，在 `"imageio",` 之后加入：

```python
    "mediapipe",
    "google.protobuf",
```

- [ ] **Step 3: 静态语法校验（spec 是 Python）**

Run: `python -m py_compile ai-engine/engine.spec`（仅在有 Python 的开发机；无则跳过，交由 CI 在构建时暴露语法错误）
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add ai-engine/engine.spec
git commit -m "build(engine): collect mediapipe data/binaries/hiddenimports in PyInstaller spec"
```

---

### Task 4: 引擎新增 `--selfcheck` 入口

**Files:**
- Modify: `ai-engine/main.py`（在参数解析处新增 selfcheck 分支）
- Create: `ai-engine/engine/selfcheck.py`

**Interfaces:**
- Consumes: `models.py` 的模型目录解析、`face.py:_ascii_model_path`。
- Produces: 一行 JSON 到 stdout：`{"mediapipe_import":bool,"task_found":bool,"task_ascii_path_ok":bool,"detect_ok":bool,"num_faces":int,"blend_keys":int,"error":str|null}`。CI 与本地据此判定 spike 成败。

- [ ] **Step 1: 写 selfcheck 模块**

Create `ai-engine/engine/selfcheck.py`:

```python
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


def run():
    out = {
        "mediapipe_import": False,
        "task_found": False,
        "task_ascii_path_ok": False,
        "detect_ok": False,
        "num_faces": 0,
        "blend_keys": 0,
        "error": None,
    }
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
    return out


def main():
    result = run()
    sys.stdout.write(json.dumps(result, ensure_ascii=True) + "\n")
    sys.stdout.flush()
    # detect_ok 为真即 spike 通过
    return 0 if result["detect_ok"] else 1
```

- [ ] **Step 2: main.py 接 selfcheck 子命令**

在 `main.py` 的参数入口（`if __name__ == "__main__":` 附近，早于进入 stdio JSON-RPC 循环处）加入：

```python
if "--selfcheck" in sys.argv:
    from engine.selfcheck import main as _selfcheck_main
    sys.exit(_selfcheck_main())
```

- [ ] **Step 3: 本地跑一次（有 Python+mediapipe 的开发机）**

Run: `cd ai-engine && python main.py --selfcheck`
Expected: 打印一行 JSON，`"detect_ok": true`、`"blend_keys": 52`（或 >0），退出码 0。
（本机无 Python → 跳过，由 Task 5 的 CI 执行。）

- [ ] **Step 4: Commit**

```bash
git add ai-engine/engine/selfcheck.py ai-engine/main.py
git commit -m "feat(engine): add --selfcheck entrypoint to verify mediapipe bundling"
```

---

### Task 5: CI 三平台构建后运行 selfcheck 并打印结果

**Files:**
- Modify: `.github/workflows/release.yml`（三个 job 各加一步 selfcheck）

**Interfaces:**
- Consumes: `engine-dist/<platform>/screener-engine(.exe)`（build:engine 产物）。
- Produces: 构建日志中的 selfcheck JSON 行。

- [ ] **Step 1: 在 windows job 的 build:engine 之后加 selfcheck 步**

在 windows job `npm run build:engine`（约 58-59 行）之后插入：

```yaml
      - name: 引擎自检（验证 mediapipe 打包，失败仅告警不阻断 spike 记录）
        continue-on-error: true
        run: node engine-dist/win/screener-engine.exe --selfcheck 2>&1 || ./engine-dist/win/screener-engine.exe --selfcheck 2>&1
```

注：exe 路径为 `app/engine-dist/win/screener-engine.exe`（working-directory 已是 `app`）。用 `--selfcheck` 直接跑冻结引擎。

- [ ] **Step 2: 在 macos-arm64 job 加同样步骤**

在 macos-arm64 `npm run build:engine` 之后插入：

```yaml
      - name: 引擎自检（mediapipe 打包）
        continue-on-error: true
        run: ./engine-dist/mac/screener-engine --selfcheck
```

- [ ] **Step 3: 在 macos-x64 job 加同样步骤**

在 macos-x64 `npm run build:engine` 之后插入：

```yaml
      - name: 引擎自检（mediapipe 打包）
        continue-on-error: true
        run: ./engine-dist/mac/screener-engine --selfcheck
```

- [ ] **Step 4: 校验 workflow YAML**

Run: `node -e "const fs=require('fs');const y=require('./app/node_modules/yaml');y.parse(fs.readFileSync('.github/workflows/release.yml','utf8'));console.log('yaml ok')"`
Expected: `yaml ok`。
（若仓库未装 yaml 包，改用在线 YAML lint 或跳过，CI 本身会暴露语法错误。）

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: run engine mediapipe selfcheck on all three platform builds"
```

---

### Task 6: 触发 CI、收集三平台结果、给出 go/no-go 结论

**Files:**
- Create: `docs/superpowers/plans/2026-10-09-mediapipe-spike-results.md`

**Interfaces:**
- Consumes: 三平台 Actions 构建日志中的 selfcheck JSON。
- Produces: 明确推荐（进入 Phase 1 / 或走 §6 R1 回退方案）。

- [ ] **Step 1: 推送触发 CI**

```bash
git push
```

到 GitHub Actions 手动触发 `Build Release Installers`（workflow_dispatch），或推 tag。

- [ ] **Step 2: 读三平台 selfcheck 日志**

在 windows / macos-arm64 / macos-x64 三个 job 的"引擎自检"步日志里，各抓一行 JSON。记录：`mediapipe_import`、`detect_ok`、`blend_keys`、`num_faces`、`error`。

- [ ] **Step 3: 判定**

- **PASS（三平台或至少 win+arm 均 `detect_ok:true`）** → spike 通过，启动 Phase 1-4 详细计划。
- **某平台 `mediapipe_import:false`**（如 Intel Mac 无 wheel）→ 该平台回落 yunet，符合设计，不算失败。
- **全平台 `detect_ok:false` 且 `error` 指向 import/DLL/protobuf** → PyInstaller×mediapipe 打包受阻（R1），进入回退评估（换 68 点 landmark 模型 / 或仅本地用）。

- [ ] **Step 4: 写结果文档**

Create `docs/superpowers/plans/2026-10-09-mediapipe-spike-results.md`，含三平台 JSON、判定、下一步推荐。

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-mediapipe-spike-results.md
git commit -m "docs: record mediapipe packaging spike results and go/no-go"
```

---

## Self-Review（本计划对 spec §7 Phase 0 的覆盖）

- **Phase 0 目标"mediapipe 能否打进三平台包并跑通一次推理"** → Task 3（打包）+ Task 4（推理自检）+ Task 5（三平台 CI 执行）+ Task 6（结论）。✅
- **G3 构建不因 mediapipe 失败** → Task 2 best-effort 安装 + Task 5 `continue-on-error`。✅
- **G4 模型入库不下载** → Task 1 提交 + 硬校验。✅
- **R5 中文路径** → Task 4 selfcheck 走 `_ascii_model_path`。✅
- **占位符扫描**：无 TBD/TODO；关键代码（selfcheck、spec 收集、CI 步）均给出实际内容。✅
- **类型一致性**：selfcheck JSON 字段在 Task 4 定义、Task 5/6 消费，字段名一致。✅
- **注意**：Task 1 Step 1 依赖用户先放入 `.task` 文件——这是本计划唯一的外部前置，已在"关键前置"显式标注。

---

## 后续计划路线图（Phase 0 通过后各自单独出详细计划）

- **Plan 2（Phase 1）**：MediaPipe 增强层——全图 `num_faces=6` 推理 + 与 YuNet 脸 IoU 匹配、附加 `blend/lm478_norm/face_bbox`；降级与 backend 显示。验证：设置页 `mediapipe+yunet`、主脸字典带增强字段。
- **Plan 3（Phase 2）**：闭眼 EAR（`EYE_L/EYE_R` 6 点）+ `eyeBlinkLeft/Right` blendshape 双指标移植 + 真实图校准。
- **Plan 4（Phase 3）**：半截头 478 包围盒 + 贴边 + `FACE_MIN_SIZE/CROP_MIN_FACE` 尺寸过滤移植；未匹配脸走几何模型（已补尺寸过滤）+ 校准。
- **Plan 5（Phase 4）**：斜眼 blend/姿态矩阵增强（可选）+ 回归 + 发布。
