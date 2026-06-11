#!/bin/bash
# 双击运行:移除 Claude GUI 的 macOS 隔离属性(com.apple.quarantine),使其可正常双击打开。
# 未做 Apple 付费公证的 app 从网络下载后会被 Gatekeeper 拦,本脚本去掉隔离标记即可。
# 无需 sudo —— 对自己的 app 操作不需要管理员权限。

APP="/Applications/Claude GUI.app"

if [ ! -d "$APP" ]; then
  osascript -e 'display dialog "还没找到 /Applications/Claude GUI.app。\n\n请先把本 dmg 里的「Claude GUI」拖到「应用程序」文件夹,再回来双击本脚本。" buttons {"好"} default button 1 with title "Claude GUI" with icon caution'
  exit 1
fi

xattr -dr com.apple.quarantine "$APP" 2>/dev/null

osascript -e 'display dialog "完成!已移除隔离属性,现在可以正常双击打开 Claude GUI 了。\n\n以后每次下载新版本 dmg 更新后,再双击本脚本一次即可。" buttons {"好"} default button 1 with title "Claude GUI"'
