# 功能 C 验证报告：computer use MCP server

日期：2026-09-09 · 分支：`feat/computer-use` · 环境：macOS 真机（4K@2x），GLM glm-5.3-flash（anthropic 协议）

## 第 0 步：模型可行性（开工前实测，通过）

cc-gui 窗口截图（3367×1954）发 GLM，要求定位「停止」「设置」按钮：
- 模型感知图宽 2560 vs 实际 3367 → 坐标按比例折算后 **x 误差 ≈1%**（3096→3130、3173→3200）
- **y 误差 1–4%**（噪声大）；模型对"感知图尺寸"自报不可靠
- 设计结论：工具返回时明示精确像素尺寸 + 映射只信服务端记录（已实现）

## 阶段一：MCP 可加载、工具可见（通过）

```
$ node /tmp/cu-mcp-smoke.mjs
initialize: {"name":"computer-use","version":"1.0.0"} proto: 2024-11-05
tools: screenshot, left_click, double_click, right_click, drag, scroll, type, key, cursor_position, window_list, doctor
{"tools_list_ok":true,"count":11}
错误通路(x/y缺失): "错误: 请先调用 screenshot 获得坐标基准"
未知工具: "未知工具: nope"

$ claude mcp list
ccgui-computer-use: /opt/homebrew/.../node .../mcp-server.js - ✔ Connected
```
（注册走 GUI 通用端点 POST /api/mcp → `claude mcp add -s user`；`computer-use` 裸名是 Claude Code 保留名会被拒，已改名 `ccgui-computer-use`。）

## 阶段二：真截图 + 模型描述（通过）

MCP 协议内 `tools/call screenshot`：返回图像 1600×900（sips 降采样）、1.14MB base64 + 映射说明文本。
`window_list` 返回 16 个真实窗口（Zotero 前台，标题/坐标与实际一致）；`cursor_position` 返回真实坐标。
截图发 GLM 描述（stop=end_turn, output 795 tokens）：

> "画面显示的是一台 Mac 电脑桌面，主窗口是一个 PDF 阅读器，正在打开一篇发表于《Biomaterials Research》的综述论文…屏幕右侧是一个 AI 文献阅读助手面板…底部显示使用的是 DeepSeek(deepseek-v4-flash)模型。屏幕右侧边缘最靠上的应用图标…应为钉钉。"

与 window_list 实际数据完全吻合。

## 阶段三：真机闭环（通过，两层证据）

**① 协议驱动全闭环**（`/tmp/cu-e2e.mjs`，TextEdit 打开 `cu-textedit-test.txt` @ (234,75) 646×418）：
```
STEP1 截图: 图像尺寸 1600x900 像素;屏幕逻辑尺寸 1920x1080
STEP2 点击: 单击 逻辑坐标 (557,284)。全局事件 ← 图内(464,237) 映射精确命中窗口中心
STEP3 输入: 已键入 34 字符(cg-unicode)进当前焦点窗口   ← 中文+ASCII 混合
STEP4 复截图: 保存 → 窗口内可见 "ccgui-computer-use 闭环打通 2026-09-09"(标题栏"已编辑")
```
复截图: `/tmp/cu-evidence/` 下 cu-e2e-after.png（已人工目检确认文字）。

**② cc-gui 会话内模型自主驱动**（新会话 + 放任模式，真实使用形态）：
GLM 自主完成 3 轮"思考→工具调用"（截图 → window_list → 进程核查），正确发现"TextEdit 窗口不在当前桌面空间"，并推理出下一步策略（证据：会话 54f08ed6 渲染截图，`/tmp/cu-evidence/session-e2e.png`）。
**未走完**：输入步骤被用户叫停——模型按旧工具描述选择 foreground/AppleScript 激活，反复切换用户前台（见"由此引发的修复"）。闭环本身已由①充分证明；②证明了模型会正确选择并驱动工具。

### 由此引发的修复（抢前台问题的产品化）
- `left_click/double_click/right_click` 描述：foreground:true 标注为"⚠️打断用户前台，最后手段"，要求后台投递验证无效才可升级
- `type/key` 描述：要求先 screenshot 确认焦点、告知用户将带前台；**明令禁止 AppleScript/shell 激活窗口绕路**
- 排错文档新增【不抢前台的工作规则】一节

## 阶段四：构建（通过）

```
$ npm run build:local    # eslint + vite build
✓ built in 6.50s
```
（未新增 Tauri command，无 #53 ACL 风险面；打包真机 invoke 验证随发版流程。）

## 依赖与运行时证据

- venv 手动预装验证 + ensureRuntime 戳机制：`~/.claude-gui/cu-runtime/venv`，依赖 5 包（mss/pyautogui/pyobjc-Cocoa/Quartz/ApplicationServices）
- doctor 全绿：`{"screen_recording":"ok","accessibility":"ok","pyautogui":"ok"}`

## 已知边界

- y 轴点击噪声 1–4%：所有点击工具结果都提示"截图验证，无效再调整"——这是视觉 computer use 的共同约束
- mss 截图为逻辑分辨率（1920×1080），映射直接用返回 pixel↔logical，不依赖 scale 字段
- 会话轮次停止时 GUI 停止路由对 "starting" 态进程返回 Process not found（既有边界，非本次引入；测试中用进程直杀兜底）
