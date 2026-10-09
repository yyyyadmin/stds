# MediaPipe 打包可行性 Spike · 结果与结论

- 日期：2026-10-09
- 对应计划：`docs/superpowers/plans/2026-10-09-mediapipe-packaging-spike.md`
- 对应设计：`docs/superpowers/specs/2026-10-09-mediapipe-face-landmarker-design.md` §7 Phase 0
- **结论：GO —— 启动 Phase 1（MediaPipe 增强层）**

## 1. 自检结果（`--selfcheck` 单行 JSON）

冻结引擎在各平台构建后运行 `screener-engine --selfcheck`，对一张 64×64 合成灰图跑一次
`FaceLandmarker.detect()`，验证四件事：mediapipe 能否 import、`.task` 是否随包、非 ASCII
路径能否加载、推理能否不崩。

| 平台 | runner | 结果 |
|---|---|---|
| **Windows** | windows-latest / Python 3.11 | ✅ `detect_ok:true` |
| **macOS arm64** | macos-14 / Python 3.11 | ✅ `detect_ok:true` |
| macOS Intel(x64) | macos-15-intel | 未取；装不上则回落 YuNet，不影响结论 |

Windows：
```json
{"mediapipe_import": true, "task_found": true, "task_ascii_path_ok": true, "detect_ok": true, "num_faces": 0, "blend_keys": 0, "error": null}
```

macOS arm64（日志可见 MediaPipe 真实初始化：TensorFlow Lite XNNPACK delegate、face_landmarker_graph、FaceBlendshapesGraph→xnnpack）：
```json
{"mediapipe_import": true, "task_found": true, "task_ascii_path_ok": true, "detect_ok": true, "num_faces": 0, "blend_keys": 0, "error": null}
```

> `num_faces:0 / blend_keys:0` 属预期：自检喂的是无脸的合成灰图，返回空结果正是"能推理不崩"的证明，非检出失败。mac 日志显示 FaceBlendshapesGraph 已按 `output_face_blendshapes=True` 装配，真实有脸时才会产出 52 维 blendshape。

## 2. 过程中发现并解决的打包阻断点（spike 的核心价值）

### 2.1 matplotlib 被误排除（承重，已修）
- **现象**：首轮三平台 `mediapipe_import:false`，`error=ModuleNotFoundError: No module named 'matplotlib'`。
- **根因**：`mediapipe` pip 包把 matplotlib 列为依赖，`import mediapipe` 顶层会连带导入 matplotlib；而 `engine.spec` 为瘦身**无条件** `excludes=["...", "matplotlib", ...]`，导致冻结 exe 内缺失。
- **修复**（commit `92725f5`）：条件化——仅当 mediapipe 成功收集时，从 excludes 移除 matplotlib 并收集其数据/隐藏导入；mediapipe 缺失的机器仍保持排除，不影响瘦身与回落。

### 2.2 spec 兜底分支中文 print（评审发现，已修）
- `engine.spec` 的 mediapipe `except` 块曾用中文 `print()`；Windows 非 UTF-8 代码页下会抛 `UnicodeEncodeError`，且异常在 except 内无法自捕获 → 冒泡出 spec 求值 → PyInstaller 非 0 退出 → **反而让"mediapipe 装不上"的机器构建失败**，违反"可选依赖不阻断构建"硬约束。改为纯 ASCII 打印。

### 2.3 其余约束验证
- `.task` 随仓库提交 + `build-engine.mjs` 存在性硬校验（缺失 `process.exit(1)`）：三平台 `task_found:true` ✅
- 非 ASCII 安装目录：`task_ascii_path_ok:true`，`_ascii_model_path` 生效 ✅
- best-effort 安装：mediapipe 装不上仅告警，构建继续 ✅

## 3. 判定

按设计 §7 Phase 0 门槛："至少 win+arm 均 `detect_ok:true` → spike 通过"。**已满足 → GO。**

## 4. 进入 Phase 1 前需携带的已知代价 / 待办

1. **体积代价**：Windows 引擎现会额外打进 matplotlib（mediapipe 顶层 import 的连带依赖）。Phase 1 实测安装包增量；若过大，评估"绕开 `import mediapipe` 顶层、只喂 Tasks API"的轻量方案。
2. **opencv 冲突**：mediapipe 依赖 `opencv-contrib-python`，与现有 `opencv-python` 抢 `cv2`。本轮未爆（自检先撞 matplotlib），Phase 1 真跑检测时须重点验证 cv2 行为不劣化。
3. **>6 人大合照**：MediaPipe 作增强层（YuNet 仍主计数），`num_faces=6` 仅影响被增强分析的前 6 张脸，不影响计数——沿用 spec 拆分架构。
4. **Intel Mac**：如需覆盖，Phase 1 里单独确认 wheel 可用性；否则该平台回落 YuNet（可接受）。
