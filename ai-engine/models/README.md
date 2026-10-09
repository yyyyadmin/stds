# AI 模型权重目录

**一键拉取（推荐）**：在 `app/` 下运行 `npm run fetch-models`（或 `npm run build:engine:ai` 一步完成拉取+打包），
会自动下载开源可商用的 **YuNet 人脸检测权重**（MIT，~228KB）到本目录。YuNet 替换 Haar 后，
半截头/双人/闭眼/斜眼/狰狞 等依赖人脸框的维度精度整体跃升。CI（release.yml）已内置该步骤。

其余权重可手动放入本目录，引擎会自动从"规则降级模式"升级为"深度学习完整模式"
（文件名可不严格一致，引擎按关键字模糊匹配；缺失的模型会逐项自动回退到传统算法）。

| 维度 | 模型 | 获取途径 |
| ---- | ---- | -------- |
| 人脸检测 | YuNet / SCRFD | onnxmodels / insightface 开源权重 |
| 关键点 | PFLD / 106点 | insightface |
| 闭眼检测 | OCEC (eyes_closed) | GitHub `OCEC` 仓库导出的 onnx |
| 视线估计 | MobileGaze / XGaze | 原作者发布权重 |
| 表情（狰狞） | Emotion-ONNX (FER2013) | HuggingFace 搜索 `emotion onnx` |
| 人脸/embedding | ArcFace / DINOv2-tiny | insightface / facebookresearch |

启用检测：放置文件后重启软件，设置页 → "当前引擎" 应显示 `Python 完整 AI 引擎`，
各维度 `method` 字段将从 `rule/*haar` 变为 `onnx:*`。

> 无以上权重时引擎仍可运行：人脸走 OpenCV Haar 级联（pip 依赖自带），
> 闭眼/斜眼/狰狞/半截头走几何规则算法，模糊/曝光/黑白/重复走传统图像算法。
