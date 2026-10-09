# 人数分类改用人体检测 设计文档（Phase 3）

> 状态：待用户评审。评审通过后再用 writing-plans 生成实现计划。
> 决策依据：用户拍板方案 A —— **人体计数成为"单人/多人/无人物"分类的唯一权威**；人脸仅保留给闭眼/斜眼/半截头/狰狞维度。

## Goal

把"单人照 / 多人合照 / 无人物场景"三类的人数判定，从**数人脸（YuNet）**改为**数人体（轻量人体检测器）**，根治婚礼跟拍中背对/大侧脸/面纱遮脸导致的人脸漏检误判（明显多人被判无人物、明显两人被判单人），目标显著降低这两类误判。

## Architecture（一句话）

新增一个 Apache 授权的轻量人体检测器，导出/获取为 **ONNX**，跑在引擎**已有的 onnxruntime** 上（**不引入 torch/ultralytics**）；`detect()` 里用它数出 `person_count` 作为三类人数分类的唯一权威，人体模型缺失/异常时**逐字节回落到现有 face-count 分支**（零回归保障）。人脸相关维度完全不动。

## 为什么不用 YOLOv8 / ultralytics（硬约束）

`ultralytics` 强依赖 **PyTorch（~200MB+）**，会把这个项目刚在 Phase 0-2 爬完的"三平台 PyInstaller 冻结引擎塞 ML 依赖"地狱重踩一遍，且 YOLOv8 权重是 **AGPL-3.0**（对分发的商业桌面软件有传染授权风险）。两者都不可接受。

## 技术选型：人体检测模型（实现裁决）

**首选落地：MediaPipe Tasks `ObjectDetector` + `efficientdet_lite0` COCO 模型（.tflite）**。

- 理由（为何优于最初写的 onnxruntime+YOLO）：本环境本机无 Python、只能靠 CI 验证；`ObjectDetector` 复用 **Phase 0-2 已冻结跑通的同一 mediapipe 运行时**（`landmarks.py` 里 `mediapipe.tasks.python.vision` 已在用），**零新依赖、零手写解码、无 ORT 中文路径坑**——风险最低。EfficientDet-Lite0 系 COCO 预训练，`person` 类含大量背身/遮挡人体，召回远好于人脸。Apache-2.0（Google），模型走稳定 Google storage URL。
- 封装：人体检测器实现于 `engine/person.py::PersonDetector`，对外只暴露 `available` 与 `count(bgr) -> (person_count, bodies)`。**接口隔离**：若真实照校准发现 Lite 召回不足，将来只需改这一个文件切到 ONNX(NanoDet-Plus/PicoDet，均 Apache-2.0) 走 onnxruntime，**接入点与分类分支不动**。
- 备选（将来可能切换）：NanoDet-Plus-m-1.5x-416 / PP-PicoDet-S（均 Apache-2.0，需导出/获取 ONNX + 手写 ORT 字节流解码）。
- 类别过滤：只保留 COCO `person`（class 0）框，其余忽略。

## 依赖与打包

- **零新增 Python 依赖**：复用已冻结的 `mediapipe` 运行时（ObjectDetector 与 FaceLandmarker 同一模块）。
- 模型文件（`models/efficientdet_lite0.tflite`，或重命名 `person_*.tflite`）**提交进仓库**（`git add -f`），并在 `build-engine.mjs` 复制 models 后加**硬校验**：人体模型缺失则 `process.exit(1)`——完全对齐 yunet/face_landmarker 那次的修复模式，绝不打残缺包。
- `models.py` 新增 `person_model_path()`（`find_model("efficientdet*.tflite", "person_*.tflite")`）。

### 中文安装目录坑（已规避）

mediapipe `ObjectDetector` 用 `BaseOptions(model_asset_path=...)` 加载，与 `face_landmarker` 同机制——**必须走已验证的 `_ascii_model_path(task)` 转 ASCII 路径**（`landmarks.py:45` 已这么用）。若将来切 ONNX，则需字节流加载（`ort.InferenceSession(f.read(), ...)`）以绕开非 ASCII 安装目录。

## 集成点（`engine/__init__.py::detect`）

**唯一改动范围 = 人数三分类分支（现 L100-113）。** 人脸门控（`face_count` 驱动的闭眼/斜眼/半截头/狰狞、`upper` 躯干）**一律保持按 `face_count`**，不改，避免连带回归 Phase 1/2。

新增：
1. `__init__`：`self.person = PersonDetector()`（加载失败→`available=False`）。
2. `detect()`：`faces = self.faces.detect(bgr)` 之后，`person_count, bodies = self.person.count(bgr)`（人体框经背景过滤）。
3. 人数分类分支改为：
   - `self.person.available == True` → 用 `person_count` 走新分级（下表）。
   - `False` → **原样执行现有 `face_count` 分支**（fallback，逐字保留）。

### 新分级（person.available）

| 条件 | 维度 | 置信度 | reason 关键字 |
|---|---|---|---|
| `person_count == 0` 且 `bright < DARK` | `no_person` | 0.70 | "未检出人体，画面偏暗(亮度X)，可能漏检" → 中置信待确认 |
| `person_count == 0` 亮度正常 | `no_person` | 0.95 | "未检出人体" |
| `person_count == 1` | `single_person` | `min(0.99, 0.88 + body_h_ratio*0.4 + score*0.05)` | "检出 1 个人体" |
| `person_count >= 2` | `group_photo` | `min(0.98, 0.88 + avg_score*0.1)` | "检出 N 个人体" |

- 置信度公式沿用参考方案思路（人体越大越确信单人；多人用平均置信），但常量待真实照校准。
- `method` 字段标 `body-count`（区别于 fallback 的 `face-count`），前端/排查可辨权威来源。
- 前端分级阈值不变：默认严格度 `very`（high 0.8 / mid 0.55）→ 上表 0.95/0.9+/0.975 类直接标记高置信，0.70 暗光落待确认。

### 背景过滤（`PersonDetector.count` 内）

对每个人体框按工作图比例过滤，剔除远景宾客/边缘碎框：
- `_BODY_MIN_H_RATIO`（人体框高/图高下限，初值 **0.10**，待校）；
- `_BODY_MIN_AREA_RATIO`（人体框面积/图面积下限，初值 **0.006**，待校）；
- 二者任一不达标 → 视为背景路人，不计入 `person_count`。
- 依据（参考方案，婚礼实测）：主角占图高通常 ≥30%，远景宾客 3-6%；阈值留裕度。**这些常量提为具名，待真实照分布再校，不写死在逻辑里。**

## 非回归硬约束（用户明确要求：绝不影响闭眼 / 半截头，含 v1 启发式）

本次人体检测只替换人数三分类的计数权威，对闭眼/半截头/斜眼/狰狞零改动，靠三重保证：

1. 不碰输入：闭眼/斜眼/狰狞仍用 `faces`（`self.eyes.closed_eye(eye_bgr, faces)`、`face_count` 门控），半截头仍用 `faces + upper`（`Q.half_head_score(bgr.shape, faces, upper, scale)`）。本次不修改 `faces` 的数量/顺序/内容，不修改 `face_count`、`upper`、`eye_bgr` 的任何计算——`person_count` 是并行新增的独立信号，只喂给分类分支，不回灌人脸维度。
2. 不改 v1 启发式：`eyes.py` 的启发式闭眼判据与 `landmarks.py` 的 MediaPipe 增强（Phase 1/2 成果）完全不动；人体检测器是新文件 `engine/person.py`，与眼睛/半截头代码路径无交集。
3. CI 回归闸（机器验证，非口头保证）：`selfcheck.py` 每次人体检测改动都同时重跑 Phase 2 的闭眼正向字段（`mount_closed_ok`、`closed_enhanced`、`closed_has_mp`、`closed_conf_closed > closed_conf_open`、reason 含 `[mediapipe]`）并要求保持 PASS；半截头字段同样不得相对基线回退。任一闭眼/半截头字段变差 = 本次改动判 FAIL、不予合入。

如果人体检测的接入让闭眼或半截头的自检字段回退，就视为本任务失败，而不是顺带的小副作用。

## 关键设计原则与风险

1. **零回归**：人脸缺失时新逻辑不触发（走 fallback）；人脸维度门控不动。Phase 1/2 闭眼结果不受影响（person 只改人数三类）。
2. **人体检测也有上限**（须对用户诚实）：两人紧贴/严重互相遮挡时，人体检测器可能把两人合成 1 框 → 仍会漏判。比人脸强很多但不是 100%。真实合照校准是最后一步。
3. **性能**：人体检测对每张图都跑（因为它是权威），增加约 30-80ms/张 CPU。可接受；不做"仅 face_count==0 才跑"的偷懒优化（那样救不了"两人→单人"，且用户要的是准）。
4. **`num_faces`/`faces[:12]` 等 MediaPipe 口径**与本次无关，不动。

## 验证基座（本机无 Python，靠冻结 selfcheck + CI）

- `engine/selfcheck.py` 增加一段**人体检测冒烟**：`available` 为真时，对一张含人体的 fixture 跑 `count()`，断言不抛异常且返回 `(int>=0, list)`；并输出 `person_backend`(onnx/off)、`person_smoke_ok`、`person_bodies_on_fixture` 等字段到 CI 单行 JSON。
- 新增 AI 生成 fixture（**非真实客户照**）：单人 / 多人(≥2) / 背身人群 / 无人物场景各一，专供人数分类正向验证（补 Phase 1/2 "合成图无脸" 只覆盖降级的缺口）。
- CI 三平台跑 `--selfcheck`，逐字段核对：win + mac-arm 一致；`person_smoke_ok:true` 且背身 fixture 上 `person_count>0`（证明"背对不再判无人物"）。

## 配置常量清单（集中定义，真实照校准对象）

`_BODY_MIN_H_RATIO=0.10`、`_BODY_MIN_AREA_RATIO=0.006`、`DARK<25`、单/多人置信公式系数、prob/iou 阈值（人体检测器内部 NMS）。全部具名集中，注释标注"CI fixture 起点值，待真实婚礼照校准"。

## 不做（YAGNI / 划界）

- 不改半截头/闭眼/斜眼/狰狞的人脸依赖逻辑。
- 不引入 GPU/torch；不替换 `detect_upper_bodies`（Haar 躯干继续只服务半截头）。
- 不做"雕像/海报 vs 真人"的 (c) 类区分（用户未列为主要痛点）。
- 不碰前端 UI（NEUTRAL 维度 tab 结构不变，`body-count` 仅换 confidence/reason 来源）。

## 交付顺序（供 writing-plans 展开）

1. Task 0：锁定并入库人体模型资产（efficientdet_lite0.tflite，验证来源/体积/授权），build 硬校验。
2. Task 1：`engine/person.py` PersonDetector（字节流加载 + 预处理 + 解码 + 背景过滤 + count()），available 降级。
3. Task 2：`engine/__init__.py` 接入（`self.person`；人数三分类按 available 走新分级/回落）；`capabilities()` 加 person 字段。
4. Task 3：`selfcheck.py` 人体冒烟 + 新 fixture；CI 三平台字段核对。
5. Task 4：真实照校准常量（用户在软件里读 reason 的 body 尺寸/分布）。

## 遗留 / 待用户评审确认

- 模型首选 NanoDet-Plus vs PicoDet 的最终锁定（取决于 Task 0 资产可得性与解码工作量）。
- 背景过滤初值 0.10/0.006 是否合理，需真实合照分布验证（CI 只能验合成图方向，验不了真实婚礼召回）。
- 是否接受"人体检测每图都跑"的性能开销（换取准确）。
