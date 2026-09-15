# 流式回复图片渲染（功能 A）

## 用了什么改动

聊天气泡此前不渲染图片（只有文件预览渲染），AI 回复里的本地图片路径/base64 全部原文显示。修复后聊天气泡与文件预览走同一套预处理，四种形态都能渲染：

| 形态 | 示例 | 处理 |
|---|---|---|
| markdown 路径含空格 | `![图](/Users/x/图 片.png)` | 自动补 `<>` 使其成为合法 markdown（`wrapSpacedImageUrls`） |
| data URL | `![](data:image/png;base64,...)` | react-markdown 默认 urlTransform 会把 `data:` 删成空 → 改为恒等 urlTransform |
| 裸路径独立行 | `/Users/x/screenshot.png`（整行恰为一个图片路径） | 自动转成 `![](...)`（`embedBareImagePaths`） |
| 裸 base64 独立行 | 一整行 base64（≥512 字符且 magic bytes 是图片） | 自动转成 data URL 图片（`embedBareBase64Images`） |

绝对路径统一改写成 `/api/files/read?path=...&raw=1`（此前聊天气泡的 `<img src="/Users/...">` 相对页面 origin 解析 → 404 死图）。

**大小上限**：data URL / 裸 base64 超过 30 万字符（≈225KB 二进制）只显示占位框，不进 DOM（防几 MB 字符串拖垮渲染）。

**流式安全**：全部预处理是纯函数、O(n) 单趟、代码围栏内不碰；流式期间每条 chunk 重跑无闪烁（图片 src 稳定则 React 复用 DOM 不重载）。

## 代码位置

- `client/src/utils/markdownImages.js` — 全部纯函数（可单测直连）
- `client/src/components/MarkdownRenderer.jsx` — img 组件（超限占位）+ 预处理接线
- `tests/unit/check-stream-image.mjs` — 单测（四种形态 + 围栏免疫 + 上限 + Windows 路径）

```bash
node tests/unit/check-stream-image.mjs   # 跑单测
```

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 图片仍显示路径 | 路径含空格且不是 markdown 形态（裸行带空格无法与正文区分，故意不碰） | 让 AI 输出成 `![](<路径>)` 形态 |
| 图片显示但裂图 | 文件不存在或无读取权限 | 核对路径；`/api/files/read` 404 会在 server.log 留痕 |
| base64 显示为原文 | 不是合法 base64（含空格/`-_` 等）或 magic bytes 不是图片 —— 防误判，属预期 | 无 |
| 超大图片只显示占位 | 超 30 万字符上限，属预期（防 DOM 爆炸） | 无 |
| 代码块里的路径被转成图 | 不应发生（围栏免疫）；若复现请提 bug 并附原文 | — |
