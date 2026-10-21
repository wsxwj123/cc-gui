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

## 用例

| 用例 | 真实操作 | 断言 |
|---|---|---|
| S1 | 打开种子历史会话 → 展开面板坞 → 分屏选 2 窗格 → 再切回 1 窗格 | 2 窗格时真实消息操作区的「重做/分叉」文字标签计算样式 `display:none`;1 窗格时不为 `none`;容器 `data-pane-count` 为 `2`/`1`;无 pageerror |
| S2 | 首页输入框 `[data-cgui="home-input"]` 派发合成 `paste`(DataTransfer 携带 MacRoman 乱码) | 乱码 `‚úª 500 ÂΩìÂâçÊó†ÂèØÁî®Âá≠ËØÅ` 还原为 `✻ 500 当前无可用凭证`;再粘正常中文不被篡改;无 pageerror |
| S3 | 同一合成粘贴,正常中文/英文/法文各一条 | 值保持原值,不被误改;无 pageerror |

S1 的标签按文本「重做/分叉」定位,不依赖 `.cgui-action-label` 类:修复前这些 span 还没有该类
(类是修复提交一起加的),按类定位会让基线因为“找不到元素”而红,掩盖真正要证明的“display 未被隐藏”。
修复后同时断言这些标签都带 `.cgui-action-label` 类。

S2/S3 的合成事件默认不会触发浏览器插入。为让基线红证据呈现真实失败形态(输入框里仍是乱码),
只有 S2 的乱码那一次在 `dispatchEvent` 未被 `preventDefault` 时补一次等价于浏览器默认动作的插入;
修复版会 `preventDefault` 并自行插入还原文本,不会走到这条补插逻辑。正常文本用例不补插,
断言值保持原样。

## 红/绿基线

| 运行 | commit | 结果 |
|---|---|---|
| 绿 | `65cbf92e`(HEAD,0.2.429) | S1/S2/S3 全绿 |
| 红·分屏 | `d7b5d796`(分屏修复 `1c3f8a71`/`2ef3884e9` 的直接父提交) | S1 红在计算样式:2 窗格标签 `display` 仍为 `block`、`data-pane-count` 缺失;S3 绿;S2 红(该基线也还没有粘贴修复) |
| 红·粘贴 | `6951e4fc`(0.2.428,无 `mojibake.js`) | S2 红在值未还原,输入框仍是 MacRoman 乱码;S1/S3 绿(分屏修复已在该基线) |

> 任务书写的“分屏基线 = `1c3f8a71^`(即 `35dc141d`)”与实际 git 不符:`git rev-parse 1c3f8a71^`
> 得到 `d7b5d796`;`35dc141d` 是更早两个提交。两者都在分屏修复之前,本套件按直接父提交
> `d7b5d796` 跑,基线红点已在 `.devflow/test-output-r151n-red-split.txt`。

证据落盘:

- `.devflow/test-output-r151n-green.txt`
- `.devflow/test-output-r151n-red-split.txt`
- `.devflow/test-output-r151n-red-paste.txt`

基线用临时 worktree `.claude/worktrees/r151n-baseline`(软链主仓 `node_modules` /
`client/node_modules`),跑完 `git worktree remove --force`,不 `rm -rf`。
