# r178c-notice-keep 黑盒验收套件

验什么:上游长时间没有输出时,应用自动结束这一轮并在页面上给一条说明(「上游超过 N 分钟无后续输出,已结束本回合并重置连接……」)。
这条说明不能在回合收尾后自己消失:要一直留到用户在这个会话发下一条消息、切到别的会话或刷新页面为止;
只提示版(设置为「只提示,不结束」)不变:回合进行中可见,回合结束后不保留;压缩完成提示同样保留。
只通过页面观测(`[data-cgui="message-list"]` 的可见文字、`[data-cgui="stop-btn"]`、输入框、「发送」按钮、侧栏 `project-row` / `session-row`),
不碰内部模块,不断言内部状态。准备步骤里只调用应用的设置接口 `PUT /api/prefs/stall-timeout`(`{"value":"5m"}` / `{"value":"never"}`)。

## 怎么跑

```sh
bash tests/acceptance/r178c-notice-keep/run-isolated.sh                     # 全量:WebKit 全部 T1~T4 + Chromium 的 T1/T3
bash tests/acceptance/r178c-notice-keep/run-isolated.sh --project=webkit    # 只跑 WebKit
bash tests/acceptance/r178c-notice-keep/run-isolated.sh --project=chromium  # 只跑 Chromium(T1/T3)
bash tests/acceptance/r178c-notice-keep/run-isolated.sh --grep 'T2 '        # 额外参数原样转给 playwright
R178C_HOLD=1 bash tests/acceptance/r178c-notice-keep/run-isolated.sh        # 只起隔离实例不跑用例(调试用)
```

输出建议存文件:`... > tests/acceptance/r178c-notice-keep/.artifacts/full.log 2>&1`(先 `mkdir -p` 该目录)。不要同时跑两份,也不要和别的验收套件同时跑。

## 隔离

- 端口:后端 6797、Vite 开发服务器 6798(写死);启动前用 `lsof` 确认空闲,被占就退出;硬拒 6677 / 6689 / 6710 / 8798 / 8799。
- 家目录:`HOME` 与 `USERPROFILE` 都指向 `.artifacts/runtime-data/home`;后端进程带 `tests/unit/q8-helpers/cu-preload.mjs` 预加载并设 `CU_TEST_HOME`;
  `CGUI_DISABLE_FILE_WATCHER=1`(会话文件监听关闭);**`CGUI_STALL_MS=2000`**(静默超时从 5 分钟缩到 2 秒,提示文字里的时长随之写成「2 秒」);
  所有 `ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN`、`CU_ALLOW_*` 清掉。
- 命令行是假的(`helpers/fake-claude.mjs`,PATH 最前面挂一个 `claude` 薄壳)。
- 夹具工作区放系统临时目录(`$TMPDIR` 的真实路径)下的 `r178c-ws-<标记>`,每个用例一个,里面只有一条种子历史会话;
  用例在该工作区里点开种子会话,再点「新建会话」发 M1,所以每条用例都是全新会话,互不共用。
- 设置接口经 6798 的代理打到 6797;每条用例开头显式设一次自己需要的值(T3 设 `never`,结束前在 `finally` 里改回 `5m`)。
- 收尾:只按 `.artifacts/pids` 里记录的 pid 结束进程,不按端口或进程名杀。

## 假命令行的场景文件

`$CGUI_FAKE_CLAUDE_DIR/scenario.json`(即 `.artifacts/runtime-data/home/fake-claude/scenario.json`),每收到一条用户消息读一次:

```json
{ "shapes": ["subagent-silent", "normal"] }
```

同一个会话的第 N 条用户消息用 `shapes[N-1]`,超出列表用最后一个。形态:

| 形态 | 行为 |
| --- | --- |
| `subagent-silent` | 派子代理后不再出声:用户消息写进会话文件 → init → 一条完整助手消息(文字块含 `R178CMAIN` + 工具调用块 `Agent`,参数 `{"description":"子任务","prompt":"只回答 ok","subagent_type":"general-purpose"}`,同时写进会话文件)→ 此后不再输出任何东西,也不退出。不输出回合结束事件,状态文件 `processed` 不增加;用例用停止键判断回合是否结束 |
| `compact` | 压缩(用户消息是 `/compact` 时用):用户消息写进会话文件 → init → `system` 事件 `subtype: compact_boundary` → `result`:`success`、`is_error:false`、`result:""`;不输出助手消息 |
| `normal` | 一条完整助手消息(文字含 `R178OK`,同时写进会话文件)→ `result`:`success`、`is_error:false`、`result` 为那段文字 |

收到 `control_request`:一律回成功应答;`request.subtype` 为 `interrupt` 时再输出用户消息 `[Request interrupted by user]` 与一条 `result`(`error_during_execution`、`is_error:true`),然后继续等下一条用户消息。
应用起标题用的调用(工作目录名含 `cgui-title-`)立刻回一个短标题。

状态文件 `status-<工作区目录名>.json`:`{ "received": 已收到的用户消息条数, "processed": 已处理完(回合结束事件已输出)的条数 }`;
「第几条」的计数记在这里,应用在两条消息之间重启命令行(静默超时会终止进程)也接得上。

## 用例(名字以清单编号开头)

| 编号 | 设置 / 形态 | 验什么 |
| --- | --- | --- |
| T1 | `5m` / subagent-silent | 出现「无后续输出」且同时含「已结束本回合」;停止键消失;从停止键消失起连续 10 秒提示一直在;10 秒后 `R178CMAIN`、M1 标记各恰好 1 次(**修复前应失败**) |
| T2 | `5m` / subagent-silent → normal | 提示出现、停止键消失、再等 2 秒后发 M2;M2 回复结束再等 3 秒:不含「无后续输出」;`R178OK`、M1、M2 各 1 次;顺序 M1 < `R178CMAIN` < M2 < `R178OK` |
| T3 | `never` / subagent-silent | 出现「无后续输出」且含「不自动结束本回合」、不含「已结束本回合」;4 秒后停止键仍在;点停止后 15 秒内停止键消失;再过 5 秒不含「无后续输出」,`R178CMAIN` 恰好 1 次 |
| T4 | `5m` / normal → compact | M1 正常回复结束再等 2 秒后发 `/compact`:出现「上下文已压缩，可继续对话」;停止键消失后连续 10 秒一直在 |

浏览器:WebKit 跑 T1~T4,Chromium 另跑 T1、T3。

「出现」靠页面内观察器(每 25 毫秒 + 每次 DOM 变动采样一次消息区文字):提示在修复前只存在一两秒,外部几百毫秒一次的轮询容易漏。
「连续 N 秒一直在」= 这 N 秒里观察器每一次采样都有该子串,并且相邻采样间隔 ≤ 500 毫秒(否则不算数)。

## 没覆盖

切到别的会话 / 刷新页面后提示是否撤掉(接口文件行为清单未列)、手机宽度布局、桌面应用壳(Tauri)里的表现、真实第三方中转站、默认 5 分钟时长。
