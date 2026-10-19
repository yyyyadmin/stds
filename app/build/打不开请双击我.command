#!/bin/bash
# 万象筛图 · Mac 一键修复工具
# 用途：清除系统对未签名软件的拦截标记，解决"已损坏，无法打开"/"来自身份不明的开发者"提示。
# 用法：先把 万象筛图 拖进「应用程序」文件夹，再双击本文件即可，全程不需要懂终端。

APP="/Applications/万象筛图.app"

echo "==============================================="
echo "  万象筛图 · 一键修复"
echo "==============================================="
echo ""

if [ ! -d "$APP" ]; then
  echo "没有在「应用程序」文件夹里找到 万象筛图。"
  echo "请先：打开下载好的 DMG → 把 万象筛图 图标拖到右边的 Applications 文件夹 → 再回来双击本文件。"
  echo ""
  read -p "按回车键关闭窗口..."
  exit 1
fi

echo "正在清除系统拦截标记（如弹出输入密码，输入开机密码后回车）..."
xattr -cr "$APP" 2>/dev/null || sudo xattr -cr "$APP"
if [ $? -ne 0 ]; then
  echo ""
  echo "❌ 拦截标记没擦掉。请把本窗口截图发给软件提供方。"
  echo ""
  read -p "按回车键关闭窗口..."
  exit 1
fi

echo "正在补签内置 AI 引擎（Apple 芯片必需，不签则引擎启动会被系统拦下，人物分类/瑕疵检测全部失效）..."
codesign --force --deep --sign - --timestamp=none "$APP" 2>/dev/null || sudo codesign --force --deep --sign - --timestamp=none "$APP"
if codesign --verify --deep --strict "$APP" 2>/dev/null; then
  echo ""
  echo "✅ 修复完成！现在打开「启动台」或「应用程序」文件夹，双击 万象筛图 即可正常使用。"
else
  echo ""
  echo "⚠️ 拦截标记已清除，但签名补了一半没成功。仍然可以先打开软件试试；"
  echo "若右上角显示“基础引擎/降级”字样，请把本窗口截图发给软件提供方。"
fi
echo ""
read -p "按回车键关闭窗口..."
