# MediaPipe 增强层（Phase 1）· 结果与结论

- 日期：2026-10-09
- 对应计划：`docs/superpowers/plans/2026-10-09-mediapipe-phase1-enhancement-layer.md`
- 对应设计：`docs/superpowers/specs/2026-10-09-mediapipe-face-landmarker-design.md` §3.1 拆分架构、§5 数据契约
- 前置：Phase 0 打包可行性 Spike 已 GO（`docs/superpowers/plans/2026-10-09-mediapipe-spike-results.md`）
- **结论：PASS / GO —— 增强层已接入并三平台验证，可启动 Phase 2（闭眼 EAR + eyeBlink 消费 `face["mp"]`）**

## 1. 本阶段交付

在**保留 YuNet 做人脸计数唯一权威**的前提下，加入 MediaPipe FaceLandmarker 增强层：

- `engine/landmarks.py`：新增 `FaceLandmarkEnhancer`。对全图跑一次 FaceLandmarker（`num_faces=6`，IMAGE 模式，输出 blendshapes + 变换矩阵），按 **IoU（阈值 0.30，`used` 唯一匹配）** 把结果挂到 YuNet 检出的 `face["mp"]`，返回被增强的脸数；mediapipe 缺失 / `.task` 缺失 / 加载或推理异常时 `available=False`，全流程静默回落。
- `engine/__init__.py`：`DetectEngine.detect()` 在 `faces = self.faces.detect(bgr)` 之后、`face_count = len(faces)` 之前，用**外层 try 保护**调用一次 `enhance()`；绝不改变 `faces` 数量/顺序。`capabilities()` 新增 `landmarker:bool`，`faceBackend` 在增强可用时标为 `"yunet+mediapipe"`；引擎就绪日志追加 `landmarker=` 状态。
- `engine/models.py`：新增 `mediapipe_task_path()`，经 `find_model` 在随包 `models/` 定位 `face_landmarker.task`。
- `requirements.txt`：`opencv-python` → **`opencv-contrib-python`**（单一 cv2 提供方，mediapipe 亦依赖 contrib，消除双 cv2 冲突）。
- `engine/selfcheck.py`：扩展为 **yunet 共存 / mediapipe / enhance 冒烟 / e2e 端到端** 四段独立 try 自检（各段彼此隔离，一段失败不吞掉前段结果；错误统一 append）。

## 2. `face["mp"]` 数据契约（Phase 2/3 消费）

```python
face["mp"] = {
  "landmarks": [(x_px, y_px), ...],          # 478 个工作图像素坐标（有序，与 MediaPipe 索引一致）
  "blend": {name: score, ...},                # 52 个 blendshape 名 -> 概率，含 eyeBlinkLeft / eyeBlinkRight
  "bbox": [x, y, w, h],                       # 由 478 点 extent 得到的像素框（int）
  "matrix": [[...4],[...4],[...4],[...4]],    # 4x4 面部变换矩阵（Phase 4 姿态用），不可用时为 None
  "score": float,                             # 与 YuNet box 的 IoU（mediapipe 无显式置信度）
}
```

- 坐标空间：工作图像素（归一化 × `bgr.shape` 的 H/W），与 YuNet `face["box"]` 同空间。
- 缺省语义：`face` 不带 `mp` 即代表该平台/该脸未获增强，消费方须 `face.get("mp")` 判空回落原启发式。

## 3. 三平台 `--selfcheck` 结果（CI v2.0.35）

| 平台 | runner | 关键布尔 | 结论 |
|---|---|---|---|
| **Windows** | windows-latest / Python 3.11 | 全绿 | ✅ PASS |
| **macOS arm64** | macos-14 / Python 3.11 | 全绿 | ✅ PASS |
| macOS Intel(x64) | macos-15-intel | 未取；装不上则回落 YuNet，不影响结论 | — |

Windows / mac-arm 自检 JSON（二者一致）：
```json
{"mediapipe_import": true, "task_found": true, "task_ascii_path_ok": true, "detect_ok": true,
 "num_faces": 0, "blend_keys": 0, "yunet_backend": "yunet", "yunet_ok": true,
 "landmarker_available": true, "enhance_smoke_ok": true, "enhanced_faces": 0,
 "e2e_ok": true, "e2e_dims": ["black_white", "blur", "exposure", "half_head", "no_person"],
 "out_landmarker_cap": true, "error": null}
```

逐字段解读：
- `yunet_backend:"yunet"` + `yunet_ok:true` —— **本轮头号闸门**：opencv-contrib 切换后 YuNet 的 `cv2.FaceDetectorYN` 在冻结引擎里仍可用，且与 mediapipe 共存不冲突（两平台均证）。
- `mediapipe_import:true` + `detect_ok:true` —— 回归干净：Phase 0 的 matplotlib 条件化打包修复未被破坏。
- `landmarker_available:true` + `enhance_smoke_ok:true` —— 增强器实例化成功且 `enhance()` 跑通不崩。
- `e2e_ok:true` + `e2e_dims` 完整 —— **完整 `DetectEngine.detect()` 接入增强层后仍跑通、维度不缺失**。
- `e2e_dims` 恰为 `[black_white,blur,exposure,half_head,no_person]`：合成图 0 脸，故 `eyes_closed/eyes_side/face_ugly`（有脸才算）**正确缺席**，`no_person` 为无脸预期维度 —— 优雅降级成立的直接证据。
- `enhanced_faces:0` —— 合成图无脸，属预期正常值（不代表失败）。

## 4. 已知限制 / 遗留（进入 Phase 2 前须知）

1. **无真实人脸 fixture**：合成灰图 0 脸，`enhanced_faces` 恒为 0，CI 只能证"实例化 + 跑通 + 不崩 + 维度完整"，**无法正向确认 IoU 匹配真的把 `mp` 挂到了真实脸**。挂载逻辑与匹配阈值（0.30）的实际正确性需在 Phase 2 用真实照片验证。
2. **`num_faces=6` 与输出 `faces[:12]` 口径不一致**：YuNet 计数可达 12，但 mediapipe 候选池上限 6，故按面积排序第 7-12 张脸拿不到 `mp`。Phase 1 不判定故无影响；Phase 2/3 消费多人大合照时需明确"仅前 6 张大脸有 landmarks"，届时视需要把 `num_faces` 抬到 12 或对齐口径。
3. **贪婪匹配非全局最优**：重叠/邻近脸下个别小脸可能漏挂 `mp`（不会错挂、不会崩）。如需更稳，后续可改为按 (iou, -score) 全局排序做二部匹配。
4. **opencv-contrib 体积代价**：contrib 是 base 超集，包体略增，运行时未见功能劣化；持续观察。
5. **CI 计费插曲（非代码问题）**：本轮首跑因 GitHub Actions 私有仓计费门槛未起跑，用户选择将仓库转公开以解除限制。记录备查。

## 5. CodeReview 结论

评审范围 `c17cdfc..7b8b89b`。运行时增强层质量高，六项硬约束（优雅降级 / 计数权威 / 数据契约 / opencv 共存 / 非 ASCII 路径 / ASCII 安全）均满足。发现并已修复：
- **Important**：`selfcheck.py` 的 `task not found` 提前 `return` 破坏段落隔离（吞掉 enhance/e2e 两段），且 `error` 覆盖赋值抹掉 yunet 段错误 → 改为不 return + 统一 append。
- **Minor**：`_synthetic_png()` 未检查 `cv2.imwrite` 返回值（只读冻结包下可能空跑通过）→ 增加退回系统临时目录的兜底。

评审建议的两项 Minor（`num_faces` 口径、贪婪匹配非全局最优）记为本阶段已知限制（见 §4），延后到 Phase 2/3 处理。

## 6. 下一步（Phase 2）

启动 Phase 2：闭眼检测改造——`eyes.py` 消费 `face["mp"]["blend"]` 的 `eyeBlinkLeft/eyeBlinkRight` + 由 478 点算 EAR，与现有启发式融合；`quality.py` 半截头可用 478 包围盒（含额头）替代 YuNet 框。均为**读 `face.get("mp")`、缺省回落**，不破优雅降级。需先为 Phase 2 写实现计划（含真实人脸 fixture 以正向验证挂载）。
