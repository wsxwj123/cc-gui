# r151n 分屏图标化 / 粘贴乱码还原 · 补验收

补两处已实现但当时没走完整 dev flow 的修复的验收。Playwright 跑真实 App(dev server 源码直出 +
隔离 server/HOME),不 import 产品代码,不改产品代码。

## 跑法

```sh
# 全量(自带隔离实例 + vite dev server,端口从 6700–6999 挑)
tests/acceptance/r151n-ui-fixes/run.sh

# 单跑某条
tests/acceptance/r151n-ui-fixes/run.sh -g 'S1'

# 落盘 JSON 报告
R151N_PW_JSON="$PWD/.devflow/pw-r151n.json" tests/acceptance/r151n-ui-fixes/run.sh
```

端口硬拒 6677 / 6689 / 6710(以及 8788/8789/8798/8799/8000);收尾只按 run.sh 记录的 pid 收进程。
首次访问 dev server 要冷编译整棵模块图,`navigationTimeout` 给到 60s;用例内部不用固定 sleep,
分屏/粘贴的状态变化都走 `expect.poll` 条件等待。

## 用例

| 用例 | 真实操作 | 主断言(用户可观察行为) |
|---|---|---|
| S1 | 打开种子历史会话 → 展开面板坞 → 分屏选 2 窗格 → 再切回 1 窗格 | 2 窗格时**真实 pane 元素数 = 2 且都可见**;消息操作按钮仍在且可见;按钮里的「重做/分叉」文字标签计算样式 `display:none`。切回后 pane 数 = 1,文字标签 `display` 不为 `none` 且真实渲染。无 pageerror |
| S2 | 首页输入框 `[data-cgui="home-input"]` 派发合成 `paste`(DataTransfer 携带 MacRoman 乱码) | 乱码被 `preventDefault`(dispatchEvent 返回 false)并还原为 `✻ 500 当前无可用凭证`;正常中文不 `preventDefault`,模拟浏览器默认插入后值 = 原值 + 粘贴原文;无 pageerror |
| S2b | 打开真实历史会话,在会话内 `[data-cgui="composer-input"]`(ChatInput 真 textarea)做同样的合成 paste | 与 S2 同口径:会话内乱码还原、正常中文按原文追加不被篡改、无 pageerror |
| S3 | 首页输入框对正常中文/英文/法文各粘一次 | 未 `preventDefault`(`dispatchReturn=true`、`defaultPrevented=false`),模拟浏览器默认插入后值 = `原值` + 粘贴原文,三种语言都不误改;无 pageerror |

### S1 的观测口径:行为为主,实现钩子只作辅助

- 主断言不依赖修复自带的东西:真实窗格用 `[data-testid="pane"]`(分屏修复前就存在)计数并量
  `getBoundingClientRect()`;文字标签按按钮文本「重做/分叉」定位(修复前这些 span 还没有
  `.cgui-action-label` 类),断言其计算样式 `display`。
- `data-pane-count` / `.cgui-action-label` 只在最后做辅助一致性断言,不作为红绿判据。这样分屏
  红基线只因「文字没被隐藏」而红,不会因为「找不到修复新增的类/属性」而红。

### S2/S2b/S3 的合成粘贴口径

合成事件不会触发浏览器默认插入,所以 `dispatchPaste()` 返回了事件本身的结果:
`dispatchReturn`(dispatchEvent 返回值)、`prevented`、`defaultPrevented`、`valueAfter`。
正常文本的用例额外 `simulateBrowserDefault`:仅在事件未被取消时补一次等价于浏览器默认动作的
`setRangeText + input`,断言值 = 原值 + 粘贴原文。修复版对乱码会 `preventDefault` 并自行插入
还原文本,不会走补插分支;因此“乱码还原”与“正常文本原样放行”两种路径都能被区分。

## 红/绿基线

| 运行 | commit / 准备 | 结果 |
|---|---|---|
| 绿 | `103918de`(master HEAD,0.2.429,工作区套件为最终版) | S1/S2/S2b/S3 全绿(4 passed),证据 `.devflow/test-output-r151n-green-v2.txt` |
| 红·分屏(v2 精确) | 临时 worktree 停在 `103918de`,`git revert --no-commit 2ef3884e` **只还原分屏修复**(粘贴修复 `65cbf92e` 保留) | S1 红在断言「2 窗格时「重做/分叉」文字标签计算样式应为 display:none」;S2/S2b/S3 绿。证据 `.devflow/test-output-r151n-red-split-v2.txt` |
| 红·粘贴(v2) | 临时 worktree 停在 `6951e4fc`(0.2.428,分屏修复已在、粘贴修复未在),用最终版套件重跑 | S2/S2b 红在「乱码应被 preventDefault 并由修复逻辑还原」,事件里 `prevented=false`、值仍是 MacRoman 乱码;S1/S3 绿。证据 `.devflow/test-output-r151n-red-paste-v2.txt` |

分屏红基线 v2 改进了首版:首版用 `d7b5d796`(早于粘贴修复),导致 S1/S2 同红、无法证明 S1 只钉分屏;
现在只 revert `2ef3884e`,S1 红、粘贴三例绿。首版证据 `.devflow/test-output-r151n-red-split.txt` 与
`.devflow/test-output-r151n-green.txt`、`.devflow/test-output-r151n-red-paste.txt` 已被 v2 取代。

基线复现方式(临时 worktree 加主仓 `node_modules` / `client/node_modules` 软链,跑完只
`git worktree remove --force`,不 `rm -rf`):

```sh
git worktree add --detach .claude/worktrees/r151n-red-split-v2 103918de
ln -s "$PWD/node_modules" .claude/worktrees/r151n-red-split-v2/node_modules
ln -s "$PWD/client/node_modules" .claude/worktrees/r151n-red-split-v2/client/node_modules
# 把当前套件同步进去(排除 .artifacts),再只 revert 分屏修复:
rsync -a --exclude '.artifacts/' tests/acceptance/r151n-ui-fixes/ \
  .claude/worktrees/r151n-red-split-v2/tests/acceptance/r151n-ui-fixes/
git -C .claude/worktrees/r151n-red-split-v2 revert --no-commit 2ef3884e
.claude/worktrees/r151n-red-split-v2/tests/acceptance/r151n-ui-fixes/run.sh
git worktree remove --force .claude/worktrees/r151n-red-split-v2
```
