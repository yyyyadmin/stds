# MediaPipe FaceLandmarker 集成 · 设计文档

- 日期：2026-10-09
- 状态：已按“>6 人大合照”约束修订为拆分架构（YuNet 计数 + MediaPipe 增强），待用户最终确认
- 目标版本：随下一个 minor/patch 发布

## 1. 背景与动机

当前 AI 引擎的人脸后端是 **YuNet（`cv2.FaceDetectorYN`）**，每张脸只输出 **5 个关键点**（两眼中心、鼻尖、两嘴角）+ 脸框 + 置信度。由此导致两个维度的**结构性天花板**（非阈值问题）：

- **闭眼**：只有 5 点，拿不到上下眼睑几何，无法计算标准 EAR，也没有"闭眼程度"信号，只能靠眼睛 ROI 的方差/边缘启发式估计。已修过一个"恒为 0"的 bug（`equalizeHist` 抹掉对比度信号），但精度上限仍远低于参考实现。
- **半截头**：YuNet 脸框只覆盖 眉~下巴，不含额头/头顶/发饰/侧发，"脸框未贴边"≠"头部完整"。

用户提供了其**第一版软件（另一产品）**的核心检测逻辑，使用 **MediaPipe FaceLandmarker（Tasks API）**：478 个 3D 关键点 + 52 个 blendshape 系数（含 `eyeBlinkLeft/Right`）+ 头部姿态矩阵，离线 CPU 运行，闭眼与半截头精度很高。本设计将该能力引入本项目。

## 2. 目标与非目标

**目标**
- G1：闭眼检测达到 v1 水平（EAR + eyeBlink blendshape 双指标）。
- G2：半截头检测达到 v1 水平（478 点包围盒 + 贴边 + 人脸尺寸过滤）。
- G3：三平台安装包构建**不因引入 mediapipe 而失败**；任一平台 mediapipe 不可用时自动回落现有 YuNet 路径。
- G4：`face_landmarker.task` 随仓库分发，不依赖 CI 下载（规避 ONNX 死链导致构建失败的历史坑）。

**非目标（本期不做）**
- 不引入 GPU/CoreML 推理。
- 不改表情/视线以外的其它维度算法（面部狰狞、模糊、曝光、黑白保持现状）。
- 不做跨平台交叉编译（仍由三 runner 各自产出）。

## 3. 总体架构

### 3.1 架构：YuNet 计数 + MediaPipe 增强分析（职责拆分，非替换）

**关键约束**：业务存在 >6 人大合照。FaceLandmarker 有 `num_faces` 上限，若用它当唯一检测器会漏计人脸 → 单人/双人/多人 维度判错。故不替换，而是拆分：

| 职责 | 后端 | 说明 |
|---|---|---|
| 人脸检测 + 计数（单人/双人/多人/无人） | **YuNet（保留，逻辑不变）** | 不设 6 上限，行为与现状一致，零计数风险 |
| 闭眼 / 半截头 / 斜眼 精细分析 | **MediaPipe 增强层** | 需要 478 点 + eyeBlink 的维度 |

- 流程：YuNet `detect()` 得到全部脸列表（box/score/landmarks5）→ MediaPipe FaceLandmarker 对**全图跑一次**（`num_faces=6`）→ 按 IoU/中心距离把 MediaPipe 的 478 点 + blendshape **匹配附加**到对应的 YuNet 脸上。
- 匹配到的脸（通常主角/近景）→ 用 v1 的 EAR+eyeBlink（闭眼）、478 包围盒（半截头）；未匹配的脸（第 7 张后的小背景脸）→ 回落现有启发式。
- **MediaPipe 全程可选**：`import mediapipe` 失败 / `.task` 加载失败 / 运行时异常 → 增强层跳过，所有脸走启发式（即现状），绝不崩、绝不让某平台构建失败。沿用"缺依赖即降级"哲学。
- 设置页"人脸后端"新增取值：`mediapipe+yunet`（增强生效）/ `yunet`（仅基础）。探测异常须 `try/except` 吞掉并记录。

### 3.2 人脸结果契约（向后兼容扩展）

YuNet 产出的每张脸字典在原 `{box, score, landmarks5}` 基础上，**由增强层按匹配结果附加**新字段（未匹配到的脸这些字段为 None）：

```
{
  "box":        [x, y, w, h],          # 工作图像素坐标（不变）
  "score":      float,                  # 置信度（不变）
  "landmarks5": [(x, y) x5],            # 5 点像素坐标（来源仍是 YuNet，不变）
  "lm478_norm": [(x, y) x478],          # 新增：归一化 0~1 的 478 点（由 MediaPipe 匹配附加，未匹配为 None）
  "blend":      {name: float},          # 新增：52 blendshape 字典（由 MediaPipe 匹配附加，未匹配为 None）
  "face_bbox":  [x0, y0, x1, y1],       # 新增：478 点归一化包围盒（用于半截头，未匹配为 None）
}
```

- 下游 `eyes.py` / `quality.py`：**有 `blend`/`lm478_norm`/`face_bbox` 则用 v1 新信号，否则走现有启发式**，两条路径都保留。
- 匹配算法：YuNet 脸框与 MediaPipe 脸（478 点包围盒换算到像素框）做 IoU，贪心一对一匹配，IoU<阈值视为未匹配。

### 3.3 检测逻辑

**闭眼（`eyes.py:closed_eye`）**
- 主路径（有 blend/478）：
  - EAR（Soukupova & Cech）：左右眼各 6 点（`EYE_L=[33,160,158,133,153,144]`、`EYE_R=[362,385,387,263,374,380]`，归一化坐标），`EAR = (|p1-p5|+|p2-p4|) / (2|p0-p3|)`。
  - `EAR_CLOSED=0.18`、`BLINK_CLOSED=0.60`；单眼 `score = max(1 - ear/EAR_CLOSED, blink/BLINK_CLOSED)`；`closed_conf = max(两眼)`；任一闭合即计。
- 回落路径（无 blend）：保留已修的启发式（原始灰度算 `vert_var/dyn`，`gray` 仅用于 Canny/虹膜）。

**半截头（`quality.py:half_head_score`）**
- 主路径（有 `face_bbox` 归一化）：
  - 过滤：`bh < FACE_MIN_SIZE(0.06)` 视为背景脸，完全跳过；`is_large = (bh > CROP_MIN_FACE(0.12) or bw > 0.12)`。
  - 贴边：`touch = x0<m or y0<m or x1>1-m or y1>1-m`，`EDGE_MARGIN m=0.012`。
  - `cropped = is_large and touch`；`conf = 1 - edge_dist/(m*3)`（越贴边越高）。
- 回落路径（无 face_bbox，即未匹配/haar）：保留已写的"完整头部所需余量"几何模型（0.5 脸高 / 0.3 脸宽），并**补上 v1 的尺寸过滤**（`bh<0.06` 背景脸跳过、`bh/bw>0.12` 才判），减少背景小脸误报。
- 保留"有躯干无头""躯干多于人脸"两信号。

**斜眼（可选，本期低优先）**
- 若有 blend：`eyeLookIn/Out Left/Right` 或姿态矩阵偏航角辅助；否则维持现有 `gaze_offset` 启发式。

### 3.4 人物计数（已由拆分架构解决）

计数一律来自 YuNet 全量检测，不受 MediaPipe `num_faces=6` 限制，>6 人大合照计数正确。MediaPipe 仅对最大的 ≤6 张脸做闭眼/半截头增强，其余走启发式。

## 4. 模型资源

- `face_landmarker.task`（Google 官方，float16，~3.7MB）**提交进仓库** `ai-engine/models/`（与 `face_detection_yunet_2023mar.onnx` 同策略，`git add -f`）。
- 新增 `models.py:landmarker_task_path()`，沿用 `find_model` 搜索（运行时 models/ → 源码仓库 models/）。
- **非 ASCII 路径处理**：mediapipe `BaseOptions(model_asset_path=...)` 在中文安装目录下可能失败，须复用 `face.py:_ascii_model_path` 把 `.task` 复制到 ASCII 临时目录再加载。

## 5. 打包与 CI

### 5.1 依赖（可选安装，best-effort）
- `requirements.txt` 增 `mediapipe`，但**不能因它装不上而中断构建**。实现方式：`build-engine.mjs` 用**独立、非致命**的 `pip install mediapipe`（失败仅告警，不 `process.exit`），与 `requirements.txt` 主安装分离；或将 mediapipe 移出 requirements 单独 best-effort 安装。
- ⚠️ 注意 mediapipe 依赖 `opencv-contrib-python`，可能与现有 `opencv-python` 抢 `cv2`。需在 spike 中确认共存或统一为 contrib。

### 5.2 PyInstaller（`engine.spec`）
- `datas += collect_data_files("mediapipe")`；`binaries += collect_dynamic_libs("mediapipe")`；`hiddenimports += ["mediapipe", ...其 graph 子模块]`。
- protobuf 版本冲突：mediapipe 需要特定 protobuf，spike 中确定 pin 范围。
- `.task` 不打进二进制，随 `models/` 外部目录分发（与 onnx 一致）。

### 5.3 构建硬校验
- 现有"缺 yunet 硬失败"保留。
- **新增**：`face_landmarker.task` 缺失 → 硬失败（G4，保证随包）。
- **不**对"mediapipe 是否成功打进包"做硬失败（因 §3.1 允许回落 yunet），但要在构建日志显式打印该平台 mediapipe 状态。

### 5.4 CI（`.github/workflows/release.yml`）
- Python 3.11 不变（mediapipe 兼容）。
- 三平台无需结构性改动；mediapipe 装不上的平台自动回落 yunet（Intel Mac 若缺 wheel 即此情形）。

## 6. 风险与缓解

| 编号 | 风险 | 严重度 | 缓解 |
|---|---|---|---|
| R1 | PyInstaller × mediapipe 打不进包（DLL/protobuf/opencv 冲突） | 高 | **Phase 0 先做打包 spike**，跑通三平台再写逻辑；不通则回退方案（仅本地用、或换 68 点 landmark 模型） |
| R2 | macOS Intel x64 无 mediapipe wheel | 中 | 可选降级：该平台回落 yunet，构建不失败 |
| R3 | 推理耗时上升拖慢扫描 | 中 | FaceLandmarker CPU ~0.1s/张；6 worker 并行；spike 实测 |
| R4 | ~~多人 >6 脸漏计~~ | 已消除 | 计数保留 YuNet 全量检测（§3.1/§3.4），MediaPipe 仅增强 ≤6 主脸 |
| R5 | 中文路径致 `.task` 加载失败 | 中 | 复用 `_ascii_model_path` |
| R6 | 闭眼/半截头新逻辑误报 | 中 | 置信度线性给分 + 待确认档；用真实图校准阈值 |

## 7. 分阶段落地

- **Phase 0（可行性 spike，最高优先）**：只做"mediapipe 能否被 PyInstaller 打进三平台包并在冻结 exe 里跑通一次 FaceLandmarker 推理"。产出：三平台构建日志 + backend=mediapipe 的自检结果。**Phase 0 不过，后续全部不启动。**
- **Phase 1**：新增 MediaPipe 增强层（全图 num_faces=6 推理 + 与 YuNet 脸 IoU 匹配、附加 blend/lm478/face_bbox）+ 降级 + `.task` 入库与 ASCII 加载。YuNet 检测/计数保持不变。验证：设置页显示 `mediapipe+yunet`，主脸字典带上增强字段。
- **Phase 2**：闭眼 EAR+blend 移植 + 校准。
- **Phase 3**：半截头 478-bbox+尺寸过滤 移植 + 校准。
- **Phase 4**：斜眼 blend 增强（可选）+ 回归 + 打包/CI 加固 + 发布。

每阶段结束用真实婚礼照验证后再进下一阶段。

## 8. 测试策略

- 本机无 Python：需一台装 **Python 3.11 + mediapipe** 的开发机跑 `npm run dev` 秒级验证（记忆已确认本地 Python 的价值与边界），或依赖 CI 产物。
- 校准集：≥10 张确认闭眼 + ≥10 张确认睁眼 + ≥10 张确认半截头 + ≥10 张完整头部肖像，跑新逻辑核对召回/误报，据此定 `EAR_CLOSED/BLINK_CLOSED/EDGE_MARGIN/CROP_MIN_FACE` 与回落阈值。
- 回归：确认 mediapipe 不可用时（模拟）走 yunet 路径不崩。

## 9. 成功判据

- 设置页"人脸后端"显示 `mediapipe`（可用平台）。
- 之前"检测失败"与"闭眼恒 0"消除；闭眼、半截头在真实婚礼照上召回接近 v1，且完整头部肖像、睁眼图误报可控。
- 三平台安装包正常产出；mediapipe 缺失平台自动回落 yunet 而非构建失败。

## 10. 兼容性

- 结果契约只增字段，旧消费方读 `box/score/landmarks5` 不受影响。
- 不改 IPC / JSON-RPC 协议结构（`landmarks` 输出仍可只回 5 点，新增字段按需）。
- 不改渲染层。
