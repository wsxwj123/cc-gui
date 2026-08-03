# 旁问(btw)截包 harness

手动回归工具,**不进 `tests/unit` 跑批**(依赖本机装了 claude CLI,且要起一个本地服务)。
用来回答一个 argv 层看不出来的问题:CLI 在 `--resume` 一条主会话时,到底往上游 payload
里塞了什么 —— 这是旁问"答成主会话的问题"(串台)的排查依据。

## 依赖

- 本机 PATH 里有 `claude` CLI
- node

不联网、不碰真上游:`ANTHROPIC_BASE_URL` 指向本地 mock,凭证是假串 `sk-mock-not-real`,
`env -i` 清空宿主环境变量(宿主的 `ANTHROPIC_*` / `CLAUDE_CODE_*` 会把请求打到真上游)。
会话数据落在隔离的 `CLAUDE_CONFIG_DIR` 下,不碰 `~/.claude`。

## 运行

```sh
cd tests/integration/btw-capture
CASE=clean node mock-api.js   # 终端 A:假 Anthropic 端点,监听 127.0.0.1:8931
./run.sh clean                # 终端 B:跑一个用例
```

`CASE` 只影响截包文件名(mock 是独立进程,拿不到 run.sh 的用例名),不设则统一叫 `capture-x-N.json`。

产物默认落 `$TMPDIR/btw-capture`(可用 `OUT=/some/dir` 覆盖),**不写进仓库**:

- `capture-<case>-<n>.json` — CLI 发出的完整请求体
- `requests.log` — 请求流水
- `err-<case>.log` — CLI stderr

## 用例(主会话尾部的六种形态)

`clean` / `dangling_user` / `dangling_tooluse` / `dangling_toolresult` /
`dangling_toolresult_err` / `interrupted`,构造代码见 `mkcase.js` 顶部注释。
主任务正文带 `MAINTASK` 标记,旁问正文带 `SIDEQUESTION_MARKER`,便于在截包里对号入座。

## 可断言的三件事

1. **payload 的 `tools` 恒为 `[]`** —— `--tools ""` 只关内置工具集,MCP 要靠空
   `--mcp-config` + `--strict-mcp-config` 才一起关掉。
   `jq '.tools | length' capture-*.json` 应恒为 0。
2. **六种尾部形态下 CLI 的注入行为** —— 尤其 `dangling_user` / `dangling_tooluse`:
   CLI 会自动补一句 "Continue from where you left off." 之类的修复指令。
   `jq '.messages[-3:]' capture-*.json` 看尾部被塞了什么。
3. **最后一条 user 消息含内联标记** —— J1 的修法是把旁问约束贴在用户消息首尾,
   后缀必须是整条消息的字面最后内容(单测 `tests/unit/check-btw-inline.mjs` 焊死构造侧,
   这里验证它真的原样到达上游)。
   `jq -r '.messages[-1].content[-1].text' capture-*.json | tail -1` 应是 `[旁问结束]…`,
   且它就是该消息的最后一个字符为止 —— 后面不许再有任何内容。
