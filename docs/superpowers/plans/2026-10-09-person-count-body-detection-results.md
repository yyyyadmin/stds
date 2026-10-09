# Phase 3 人数分类人体检测 — CI 结果记录（Task 5 闭环）

**发布触发**：v2.0.58（tag `aa76fc0`），三平台 CI selfcheck 全绿。
**结论**：GO。人数权威切换（face-count → body-count）在三平台冻结引擎中链路与数值全部验证通过，Phase 2 闭眼回归闸零回归。

## 三平台字段核对（Windows / macOS-arm64 / macOS-x64 逐项完全一致）

| 组 | 字段 | 三平台值 | 判定 |
|---|---|---|---|
| 人体模型链路 | `person_model_found` / `person_available` / `person_count_run_ok` | true / true / true | ✅ fetch-models 自动下载 efficientdet_lite0.tflite 在 win/arm/x64 三架构均加载成功 |
| 人数计数 | `person_count_synth` / `open` / `multi` / `empty` | 0 / 1 / 2 / 0 | ✅ 合成噪点=0、单人脸图=1、双人 fixture=2、无人 fixture=0 |
| 端到端 | `e2e_person_dim` / `e2e_person_method` | `single_person` / `body-count` | ✅ detect() 走 body-count 权威分支 |
| Phase 2 回归闸 | `mount_closed_ok`=true；`closed_conf_closed`=1.0 ≫ `closed_conf_open`=0.181；两 reason 含 `[mediapipe]`；`open_ious`=[0.489] / `closed_ious`=[0.269] | 与 v2.0.57 基线比特级一致 | ✅ 闭眼/半截头未被人数改动波及 |
| 整体 | `error` | null（三平台） | ✅ |

## 计划字段名 → 实现字段名映射（自检实现时演化，语义等价）

| 计划（Task 4 定义） | 实现（selfcheck.py 实际输出） |
|---|---|
| `person_detector_available` | `person_available` |
| `person_smoke_ok` | `person_count_run_ok` |
| `person_single_count` | `person_count_open` |
| `person_multi_count` | `person_count_multi` |
| `person_gate_ok` | `person_count_empty`=0 + `e2e_person_method`=`body-count` 组合承载 |
| `phase2_regression_ok` | 由 Phase 2 原有字段直接逐项对照基线承载 |

**裁决**：核对以实现字段为准；验收语义（模型在、能跑、计数对、回落安全、回归零变化）全部覆盖，无遗漏。

## body-count vs face-count（改动半径复述）

- 唯一变更：`engine/__init__.py` 人数三分类分支以 `PersonDetector.count()` 为权威；`method` 输出 `body-count`。
- 安全网：模型缺失（`person_count=None`）或"判 0 但人脸/躯干存在"时逐字回落原 face-count 分支，reason/method 不变。
- 人脸维度（闭眼/斜眼/狰狞/半截头）输入（faces/face_count/upper/eye_bgr）一行未动——本 CI 回归闸机器证明。

## 遗留（Task 6，真实照校准）

CI 只证明链路通 + 合成 fixture 计数对 + 零回归；以下必须真实婚礼库分布：
1. `_BODY_MIN_H_RATIO` / `_BODY_MIN_AREA_RATIO`：远景宾客是否被计入 / 主角是否被误滤。
2. 面纱/紧贴人体的召回率（EfficientDet-Lite0 上限）；不足则按 spec 换 ONNX(NanoDet/PicoDet)，只改 `person.py`。
3. 半截头三常量（EDGE_MARGIN/CROP_MIN_FACE/FACE_MIN_SIZE）贴边距离直方图。
4. 闭眼 EAR/blink 在暗光/眼镜/侧脸下的绝对落点。

**采集机制已落地**（提交 `46b206e`，v2.0.59 起生效）：软件静默自动把全库 confidence/reason/method + 用户纠错标记写到 `安装目录\log\calib\calib-v<ver>-<ts>.jsonl`（筛选完成/停止 + 应用退出各写一次；只含文件名与数字，无照片无路径；保留最近 20 份）。用户跑真实库 → 纠错 → 关闭软件 → 传最新 jsonl 给开发者分析。**该文件严禁提交进仓库。**
