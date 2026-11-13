# r178-error-vanish 黑盒验收套件

验什么:个别第三方中转站下,回合以「命令行不存盘的报错」或「什么都没回」结束时,页面上的报错块 / 提示不能自己消失;
报错原文带 `[ede_diagnostic]` 时,原文之后要多一段中文说明;用户发下一条消息后,上一轮留下的报错撤掉;正常回复和刷新后的会话不受影响。
只通过页面观测(`[data-cgui="message-list"]` 的可见文字、`[data-cgui="stop-btn"]`、输入框、侧栏 `project-row` / `session-row`),不碰内部模块,不断言内部状态。

## 怎么跑

```sh
bash tests/acceptance/r178-error-vanish/run-isolated.sh                     # 全量:WebKit 全部 S1~S9 + Chromium 的 S1/S4/S7
bash tests/acceptance/r178-error-vanish/run-isolated.sh --project=webkit    # 只跑 WebKit
bash tests/acceptance/r178-error-vanish/run-isolated.sh --project=chromium  # 只跑 Chromium(S1/S4/S7)
bash tests/acceptance/r178-error-vanish/run-isolated.sh --grep 'S6 '        # 额外参数原样转给 playwright
R178_HOLD=1 bash tests/acceptance/r178-error-vanish/run-isolated.sh         # 只起隔离实例不跑用例(调试用)
```

输出建议存文件:`... > tests/acceptance/r178-error-vanish/.artifacts/full.log 2>&1`。不要同时跑两份,也不要和别的验收套件同时跑。

## 隔离

- 端口:后端 6795、Vite 开发服务器 6796(写死);启动前用 `lsof` 确认空闲,被占就退出;硬拒 6677 / 6689 / 6710 / 8798 / 8799。
- 家目录:`HOME` 与 `USERPROFILE` 都指向 `.artifacts/runtime-data/home`;后端进程带 `tests/unit/q8-helpers/cu-preload.mjs` 预加载并设 `CU_TEST_HOME`;
  `CGUI_DISABLE_FILE_WATCHER=1`(会话文件监听关闭,与打包应用一致);所有 `ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN`、`CU_ALLOW_*` 清掉。
- 命令行是假的(`helpers/fake-claude.mjs`,PATH 最前面挂一个 `claude` 薄壳)。
- 夹具工作区放系统临时目录(`$TMPDIR` 的真实路径)下的 `r178-ws-<标记>`,每个用例一个,里面只有一条种子历史会话;
  用例在该工作区里点开种子会话,再点「新建会话」发 M1,所以每条用例都是全新会话,互不共用。
- 收尾:只按 `.artifacts/pids` 里记录的 pid 结束进程,不按端口或进程名杀。

## 假命令行的场景文件

`$CGUI_FAKE_CLAUDE_DIR/scenario.json`(即 `.artifacts/runtime-data/home/fake-claude/scenario.json`),每收到一条用户消息读一次:

```json
{ "shapes": ["empty-error", "normal"] }
```

同一个会话的第 N 条用户消息用 `shapes[N-1]`,超出列表用最后一个。形态:

| 形态 | 行为 |
| --- | --- |
| `empty-error` | 空内容报错:写用户消息 → init → `user` 事件(文字块 `[Your previous response had no visible output. …]`)+ 带 `isMeta` 的用户行 → `result`:`error_during_execution`、`is_error:true`、`stop_reason:end_turn`、`terminal_reason:completed`、`errors:["[ede_diagnostic] … last_content_type=none …"]`,无 `result` 字段;不输出助手消息 |
| `unknown-type` | 同上,`errors` 里是 `last_content_type=reasoning` |
| `empty-success` | 规范的空回复:同样的 `user` 事件与 `isMeta` 行 → `result`:`success`、`is_error:false`、`result:""` |
| `partial-then-error` | 先输出一条完整助手消息(文字含 `R178PARTIAL`,同时落盘),再同 `empty-error` 的 `user` 事件、`isMeta` 行与 `result` |
| `normal` | 一条完整助手消息(文字含 `R178OK`,同时落盘)→ `result`:`success`、`is_error:false`、`result` 为那段文字 |

回合结束后进程不退出,继续等下一条用户消息。应用起标题用的调用(工作目录名含 `cgui-title-`)立刻回一个短标题。

状态文件 `status-<工作区目录名>.json`:`{ "received": 已收到的用户消息条数, "processed": 已处理完(回合结束事件已输出)的条数 }`;
「第几条」的计数记在这里,应用在两条消息之间重启命令行也接得上。夹具里每个用例一个工作区、一个会话,所以按工作区计数 = 按会话计数。

## 用例(名字以清单编号开头)

| 编号 | 形态 | 验什么 |
| --- | --- | --- |
| S1 | empty-error | 报错原文(`ede_diagnostic`)出现后连续 10 秒一直在;10 秒后 M1 恰好 1 次、停止键不在 |
| S2 | empty-error | 出现「上游返回了内容为空的回复」,5 秒后仍在,原文含 `last_content_type=none`,`ede_diagnostic` 恰好 1 次 |
| S3 | unknown-type | 出现「无法识别的内容类型(reasoning)」,5 秒后仍在,原文含 `last_content_type=reasoning`,不含「上游返回了内容为空的回复」 |
| S4 | empty-success | 提示「没有返回任何内容」出现后连续 10 秒一直在;M1 恰好 1 次、停止键不在 |
| S5 | partial-then-error | 回合结束 5 秒后及再过 5 秒:`R178PARTIAL`、`ede_diagnostic` 各 1 次,正文在报错之前 |
| S6 | empty-error → normal | 发 M2 后上一轮报错撤掉;`R178OK`、M1、M2 各 1 次,顺序 M1 < M2 < R178OK |
| S7 | empty-error ×2 | 第二条后 `ede_diagnostic` 只剩 1 次且在 M2 之后;M1、M2 各 1 次,M1 在前 |
| S8 | normal | `R178OK`、M1 各 1 次;不含 `ede_diagnostic`、「没有返回任何内容」 |
| S9 | empty-error | 刷新页面并从侧栏点回会话,3 秒后 M1 恰好 1 次(刷新后报错块在不在不断言) |

「出现」靠页面内观察器(每 25 毫秒 + 每次 DOM 变动采样一次消息区文字):修复前报错块只存在 25~200 毫秒,外部几百毫秒一次的轮询看不到。
「连续 N 秒一直在」= 这 N 秒里观察器每一次采样都有该子串,并且相邻采样间隔 ≤ 500 毫秒(否则不算数)。

## 没覆盖

手机宽度布局、桌面应用壳(Tauri)里的表现、真实第三方中转站、刷新后报错块是否还在(接口文件明确不在本轮范围)。
