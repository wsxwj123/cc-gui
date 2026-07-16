#!/usr/bin/env node
// 串扰窗口1守卫纯函数自检:paneMessages 归属判定(第226轮主诉,切会话瞬间
// 代办/计划/费用/模型徽章短暂串显的根因守卫)。失败方向必须是"藏"(EMPTY)而非"显"。
import assert from 'node:assert/strict';
import { paneMessagesOwned } from '../../client/src/utils/routing.js';

// 核心串扰场景:pane 历史还是 A 的(fetch 未回),当前会话已切到 B → 不归属,必须藏
assert.equal(paneMessagesOwned('sid-A', 'sid-B'), false, 'A 的历史不许以 B 名义显示');

// 正常场景:历史归属 = 当前会话 → 显示
assert.equal(paneMessagesOwned('sid-A', 'sid-A'), true, '归属匹配 → 可见');

// draft(sessionId null)+ 空白历史(null 标记)→ 同为 null 视为归属(draft 显示空数组本体)
assert.equal(paneMessagesOwned(null, null), true, 'draft/空窗格 null===null');
assert.equal(paneMessagesOwned(undefined, undefined), true, 'undefined 归一为 null');
assert.equal(paneMessagesOwned(undefined, null), true, 'undefined vs null 归一相等');

// draft 切到真会话(toast 跳转/撤销删除恢复):历史标记还是 null,会话已是真 sid → 藏
assert.equal(paneMessagesOwned(null, 'sid-B'), false, '空白标记不许认领真会话');

// 真会话切到 draft(回滚 sessionReset/新建会话按钮):旧 sid 历史不许显示在 draft 下
assert.equal(paneMessagesOwned('sid-A', null), false, '旧会话历史不许显示在 draft 下');

// 空串归一(防御:sessionId 意外为 '' 时与 null 同义,不因 ''!==null 误判)
assert.equal(paneMessagesOwned('', null), true, '空串归一为 null');
assert.equal(paneMessagesOwned('', 'sid-A'), false, '空串标记不认领真会话');

console.log('check-pane-ownership: all assertions passed');
