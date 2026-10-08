# engine-dist（自带 AI 引擎产物目录）

本目录存放 **PyInstaller 打包出的自包含 Python AI 引擎**，随安装包分发到
`resources/engine/`，让每台电脑（Windows / macOS）无需安装 Python 即自动升级为
完整 12 维检测（需求⑨）。

## 生成方式（在装有 Python 3.9+ 的构建机 / CI 上运行）

```bash
# Windows 构建机
cd app
npm run build:engine        # 生成 engine-dist/win/screener-engine.exe + _internal/ + models/

# macOS 构建机（arm64 或 x64 原生各跑一次）
cd app
npm run build:engine        # 生成 engine-dist/mac/screener-engine + _internal/ + models/
```

产物结构：

```
engine-dist/
├── win/
│   ├── screener-engine.exe
│   ├── _internal/          # Python 运行时 + opencv/numpy/onnxruntime 等依赖
│   └── models/             # 放 ONNX 权重即提升精度（用户可后补，无需重新打包）
└── mac/
    ├── screener-engine
    ├── _internal/
    └── models/
```

## 应用如何识别

`app/src/main/engine/python.ts` 的 `findBundledEngine()` 会在打包后优先探测
`resources/engine/screener-engine(.exe)`，命中即以「自带完整引擎」启动；
未命中则回退系统 Python，再回退 Node 基础引擎。

## 说明

- 两个子目录若尚未构建，本占位文件保证 `electron-builder` 的 extraResources 不因缺目录而报错；
  此时应用会回退到系统 Python / Node 引擎。
- macOS 需在与目标架构一致（或 Universal2 合并）的机器上运行 `build:engine`。
- 追求最高精度：把 `models/README.md` 列出的 ONNX 权重放入 `engine-dist/<平台>/models/`
  后重新 `npm run dist`，或在用户端直接把权重放进安装目录的 `resources/engine/models/`。
