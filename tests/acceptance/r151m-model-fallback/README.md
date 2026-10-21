# r151m · 第三方 provider 下 claude 模型名兜底映射(验收)

规格唯一来源:`.devflow/r151m-model-fallback-接口.md` 第 1–3 节公开入口/映射规则 + 第 5 节行为清单 1–11。
本套件是黑盒验收:只 import 接口文件列出的公开入口,产品代理实现不 import、不读源码。

## 跑法

```sh
tests/acceptance/r151m-model-fallback/run.sh          # 全量 1–10
tests/acceptance/r151m-model-fallback/run.sh 1 4 6    # 只跑指定用例(调试)
```

- 退出码非 0 = 至少一条用例红;每条用例单独 node 进程,互不依赖,顺序/组合都可。
- 端口只在 6700–6999 里挑,避开 6677/6689/6710/8788/8789/8798/8799/8000。
- 跑完按 `.artifacts/runs/...` 里记录的 pid 收进程,并核对记录过的端口是否已释放。
- 原始输出复制到仓库 `.devflow/test-output-r151m-step1.txt`(gitignored)。

## 用例 ↔ 行为清单

| CASE | 行为清单 | 断言重点 |
|---|---|---|
| 1 | 1 OpenAI 映射 | 假上游 `chat/completions` body.model = `deepseek/x`,客户端 200 |
| 2 | 2 OpenAI 列表内保留 | 上游收到 `deepseek/x`;列表里显式写了 claude 名也不改写(规则 2 优先) |
| 3 | 3 OpenAI 非 claude 未知名 | 上游收到 `gpt-not-in-list`;无 model/空串/非字符串按原值转发(规则 1) |
| 4 | 4 Anthropic 映射 | 假上游 `/v1/messages` body.model = `deepseek/x`,客户端 200 |
| 5 | 5 Anthropic 列表内保留 | 上游原值;列表里显式写了 claude 名也不改写 |
| 6 | 6 models 缺失只给 default | `models` 缺失/空数组时用 default;default 缺失时用 `models[0]` |
| 7 | 7 default/models 都缺 | 上游收到 claude 原名(两种形态都测) |
| 8 | 8 响应 model 不改 | 客户端响应 `model` 仍是 `claude-opus-4-7` |
| 9 | 9 流式 | 上游流式 body.model 映射;回译含 message_start/delta/stop |
| 10 | 10 日志一次 | 同组合两次请求只一条含两个模型名的日志,且不含 key/token |

第 11 条(既有代理单测/验收全绿)不在本套件重复跑,见验收报告。

## 假上游

- OpenAI 形态:`POST /chat/completions`,记录 JSON body;`stream:false` 返回合法 `choices/message/usage`,
  `stream:true` 返回 SSE(`chat.completion.chunk` + `[DONE]`)。
- Anthropic 形态:`POST /v1/messages`,记录 JSON body,返回合法 Anthropic `message` 响应。
- 两种假上游都在本进程内,用 `127.0.0.1:6700–6999` 的端口,不碰外部服务。

## 基线(未修复 HEAD 35dc141d)

预期红:1、4、6、9、10(1/4/6/9 红在“假上游收到 claude 原名”,CASE 6 同时红在
`models[0]`/空数组两条映射;CASE 10 红在“映射日志条数 0”并附带上游仍是原名)。
预期绿:2、3、5、7、8(CASE 2/5 含“列表内 claude 名不改写”,CASE 3 含缺失/空串/非字符串 model)。修复后全绿。
