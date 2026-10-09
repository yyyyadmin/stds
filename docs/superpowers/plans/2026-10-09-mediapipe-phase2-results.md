# MediaPipe 闭眼增强（Phase 2）· 结果与结论

- 日期：2026-10-09
- 对应计划：`docs/superpowers/plans/2026-10-09-mediapipe-phase2-closed-eye.md`
- 对应设计：`docs/superpowers/specs/2026-10-09-mediapipe-face-landmarker-design.md`
- 前置：Phase 1 增强层已三平台 PASS（`2026-10-09-mediapipe-phase1-results.md`）
- **结论：PASS / GO —— 闭眼已走 MediaPipe 478 点 EAR + eyeBlink 路径，挂载修复并经三平台验证，睁/闭信号大幅分离，零回归**

## 1. 本阶段交付

在**保留 YuNet 计数权威、逐脸缺省回落**的前提下，让 `eyes.py` 消费 Phase 1 挂载的 `face["mp"]`：

- `engine/eyes.py`：新增 `_mp_closed_prob()`——由 478 点取左右眼各 6 点（Soukupova & Cech EAR 变体，`_EYE_L=[33,160,158,133,153,144]` / `_EYE_R=[362,385,387,263,374,380]`）算 EAR，融合 `eyeBlinkLeft/Right` blendshape；闭合概率 `max(1 - ear/EAR_CLOSED, blink/BLINK_CLOSED)`，两眼取大（偏召回）。`closed_eye()` 主循环**逐脸分叉**：有 `mp` 走该路径并标 `[mediapipe]`，无 `mp` 回落原 `eye_rois/_eye_stats`/OCEC 启发式。`worst_from_mp` 追踪胜出来源，保证 `method`/`worst_detail` 与真实来源一致（CodeReview M1/M2）。
- `engine/selfcheck.py`：新增 `_fixture_named()` 双路径查找 + 第 5 段独立 try，用真实人脸 fixture 做**正向验证**（`mount_ok` 证 IoU 挂载生效、`closed_conf_closed > closed_conf_open` 证信号方向），补齐 Phase 1"挂载未正向验证"的遗留缺口。诊断字段 `closed_faces/enhanced/has_mp/reason` + `open_ml/closed_ml` + `open_ious/closed_ious` 用于一锤定音。
- `.github/workflows/release.yml`：三平台 selfcheck 步前置 `cp ../ai-engine/tests/fixtures/*.jpg engine-dist/<plat>/tests/fixtures/`，让冻结引擎能读到具名 fixture。
- **测试 fixture**：ImageGen 生成的无版权亚洲女性睁眼/闭眼图（带水印），仅供 CI 自动化；真实客户照片严禁入库，仅走软件人工验收。

## 2. 核心修复：IoU 挂载阈值 0.30 → 0.20

**现象**：闭眼 fixture `closed_faces=1`（YuNet 检出脸）但 `closed_enhanced=0`（没挂上 mp），回落到弱启发式后 `vv=262 dyn=188`（把闭眼读成睁眼），`closed_conf_closed=0.0 < 0.181`。

**诊断定位**（新增 `ml/ious` 字段）：`closed_ml=1`（FaceLandmarker **确实检测到**闭眼脸，非检测失败），但 `closed_ious=[0.269]`——478 点外接框与 YuNet 脸框 IoU 仅 0.269，差 0.031 卡在 0.30 门槛下被丢弃。对照睁眼 `open_ious=[0.489]` 正常挂载。

**根因（可复用教训）**：闭眼时 landmark 点集纵向内缩、外接框变紧，IoU **系统性**偏低——意味着原 0.30 门槛会专门漏掉"闭眼脸"这一最该检测的目标，正是要修的那类。

**修复**：`landmarks.py` 提为具名常量 `_IOU_MATCH_MIN = 0.20`。不同人之间脸框几乎不重叠（IoU≈0），0.20 既跨过实测 0.269，又远高于任何邻脸误配，安全区分"同一张脸"与"串到邻脸"。

## 3. 三平台 `--selfcheck` 结果（CI v2.0.57）

| 平台 | 结论 |
|---|---|
| **Windows** | ✅ PASS |
| **macOS arm64** | ✅ PASS（与 Windows 逐字段一致） |

关键闸门字段：
```json
{"mount_faces": 1, "mount_enhanced": 1, "mount_ok": true, "eye_mp_used": true,
 "closed_conf_open": 0.181, "closed_conf_closed": 1.0, "mount_closed_ok": true,
 "closed_faces": 1, "closed_enhanced": 1, "closed_has_mp": true,
 "open_ml": 1, "open_ious": [0.489], "closed_ml": 1, "closed_ious": [0.269],
 "open_reason": "眼闭合度 0.18 (mp:0.18[L(ear=0.334 blink=0.11) R(ear=0.372 blink=0.06)]) [mediapipe]",
 "closed_reason": "眼闭合度 1.00 (mp:1.00[L(ear=0.014 blink=0.78) R(ear=0.098 blink=0.71)]) [mediapipe]",
 "error": null}
```

**两道闸**：
1. **挂载修复生效**：`closed_has_mp:true` / `closed_enhanced:1` / `mount_closed_ok:true`（修复前为 `false/0/false`）。
2. **闭眼信号方向正确且大幅分离**：`closed_conf_closed=1.0 ≫ closed_conf_open=0.181`，两条 `reason` 均标 `[mediapipe]`。

**信号分离度**（`EAR_CLOSED=0.18`、`BLINK_CLOSED=0.60` 的落点校验）：
- **EAR**：闭眼 0.014–0.098 vs 睁眼 0.334–0.372 → 阈值 0.18 稳稳居中。
- **blink**：闭眼 0.71–0.78 vs 睁眼 0.06–0.11 → 阈值 0.60 稳稳居中。
- **回归全绿**：`yunet_ok/detect_ok/landmarker_available/enhance_smoke_ok/e2e_ok:true`，`error:null`；同批的类型改动（去双人照）未扰动 `e2e_dims`。

## 4. 已知限制 / 后续

1. **绝对阈值仍需真实照校准**：AI fixture 是干净正脸，给出的分离度不能替代真实场景。真实新娘照片存在暗光、戴眼镜、侧脸、半眯眼等，`EAR_CLOSED/BLINK_CLOSED` 终值需用软件读 `reason` 里的 `ear=/blink=` 分布再校。当前值在 fixture 上偏保守安全。
2. **`num_faces=6` 与 `faces[:12]` 口径不一致**：>6 人大合照仅前 6 张大脸拿到 mp（Phase 1 遗留）。闭眼消费时第 7-12 张脸回落启发式，漏检风险随人数上升。
3. **贪婪匹配非全局最优**：重叠/邻近脸下个别小脸可能漏挂（不会错挂、不会崩）。
4. **`eye_mp_used` 字段名偏宽**（M3，park）：多脸下若任一脸走 mp 即置真；单脸 fixture 下语义准确。

## 5. CodeReview 结论

Phase 2 主体（Task 1-4）评审 `7be0883..927da84`：**0 Critical / 0 Important**，M1/M2（混合模式来源一致性）已修。后续三次增量（诊断字段 `d670e86`、类型改动 `355a339`、IoU 阈值修复 `3210477`）均为自 check 字段 / 具名常量 / 已由 `tsc` 双工程验证的类型删除，风险低。

## 6. 下一步

- **真实照人工校准**（本阶段收尾）：软件里跑已知闭眼/睁眼新娘照，采 `ear=/blink=` 分布，微调 `EAR_CLOSED/BLINK_CLOSED`。
- **半截头增强**（Phase 3）：`quality.py` 用 478 点包围盒（含额头）替代 YuNet 框，同属"读 `face.get('mp')`、缺省回落"。
- **人数分类精度优化**（用户已标记"误判很严重"）：单人 / 多人合照 / 无人物场景检测——独立阶段，需先走 brainstorming。
