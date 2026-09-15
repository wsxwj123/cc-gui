# 功能 A 验证报告：流式回复图片渲染

日期：2026-09-09 · 分支：`feat/stream-image` · 验证环境：本机 macOS（4K 屏，旧版=已安装 CC-GUI.app 0.2.378 @6677，新版=worktree build @6688）

## 方法

同一会话（question/cc-gui 加 computer use）同一组消息内容，分别用旧版与新版客户端渲染，playwright（主仓 node_modules 现成依赖）做 DOM 级取证，样本四形态：

1. `![](/Users/dev/Desktop/cu-render-test/plain.png)`（无空格路径 markdown）
2. `![图](/Users/dev/Desktop/cu-render-test/界 面 图.png)`（空格路径 markdown）
3. `/Users/dev/Desktop/cu-render-test/plain.png`（裸路径独立行）
4. `![](data:image/png;base64,…)`（data URL）

## 修复前（6677，旧版客户端）

DOM 统计（含样本的气泡）：`imgCount:1`（仅形态1被解析为 `<img>` 且 `loaded:false` —— src 是文件系统路径相对页面 origin → 404）；形态2/3/4 全部原文（`rawBase64Visible:true, rawPathVisible:true, spacePathVisible:true`）。
截图：`docs/validation/feature-a-before.png`（6KB 劣质 base64 糊满气泡即形态4原文直显的实锤）。

## 修复后（6688，worktree build）

DOM 统计（同气泡）：`imgCount:3`，三张全部 `loaded:true`，src 均已改写为 `/api/files/read?path=...`（形态1/2/3）；`rawPathVisible:false, spacePathVisible:false`。
形态4 单独验证（1×1 PNG data URL）：全页 `img[src^="data:image"]` 命中 1 个，`loaded:true, naturalWidth:1`。
截图：`docs/validation/feature-a-after.png`。

## 单测

```
$ node tests/unit/check-stream-image.mjs
check-stream-image: 全部断言通过 ✓
```
覆盖：四形态转换、围栏免疫（含未闭合波浪围栏的流式半截）、Windows 盘符路径、超限占位、data URL 上限判定、resolveImageSrc 六种入参。

## 构建

```
$ npm run build:local     # eslint + vite build
✓ built in 6.06s
```

## 已知边界（有意不碰）

- 带空格的**裸路径独立行**不自动成图（与普通句子无法区分，防误判）；markdown 形态带空格路径已覆盖。
- 非法 base64（含空格/`-_`）保持原文 —— 验证过程中实际发生了模型手打 base64 漂移出空格的案例，正确地未被误转。
