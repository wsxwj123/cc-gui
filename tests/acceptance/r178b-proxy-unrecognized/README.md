# r178b-proxy-unrecognized 验收套件

验证本机转换代理(`/v1/messages`)遇到「上游回 200 但根本不是回复」时，报 502 带上游原话的错误，而不是回空消息；合法但为空的回复与正常回复不受影响。

## 跑法

```sh
( cd "<工作树根>" && /opt/homebrew/bin/node --test --test-force-exit tests/acceptance/r178b-proxy-unrecognized/r178b.acceptance.mjs )
```

## 文件
- `r178b.acceptance.mjs`：21 条用例（P1–P21，名字以清单编号开头；有 (a)(b)(c) 分点的在同一条里逐个断言，断言信息带分点）。
- `fake-upstream.mjs`：假上游（本机 `listen(0)`）+ 向代理发请求的小客户端 + SSE 解析。

## 隔离
- 导入代理模块前，`HOME` / `USERPROFILE` 指向临时目录，清掉 `ANTHROPIC_*` 与 http(s)/all_proxy 环境变量。
- 代理用 `startOpenAIProxy(0)` 取空闲端口，只用 `startOpenAIProxy` 与 `setOpenAIUpstream` 两个导出。
- 假上游不记录、不打印请求头，不连外部地址。

## 假上游怎么设定形态
每条用例调用 `callProxy({ stream, status, contentType, body })`：
- `stream`：命令行发给代理的请求里的 `stream`。
- `status`：假上游的 HTTP 状态，默认 200。
- `contentType`：假上游回的 Content-Type（省略则不带）。
- `body`：原样回的响应体。
测试用 Key 是 32 个字符的假 Key，用来验证摘要里的脱敏。

## 没覆盖
- 「响应头已发出后要回第 3 类 → 只结束连接并记日志」的兜底，以及「已开始往下发后上游流断了」「流里 error 已开始下发」：需要时序可控的上游，本套件未测。
- 日志内容（只写形态不写原文）不断言。
