#!/usr/bin/env node
// 单测:r29 Bug2②「/clear 显示 (no content) 且可能没清成」。
// 机制根因(取证 /tmp/cgui-clear-test/turn1.txt,CLI 2.1.237):
//   ① "(no content)" 是 CLI 2.1.x 二进制内置占位串,会当 assistant 文本增量吐进流;
//      ✅「会话已清空」分支建立在「/clear 返回完全空流」的旧假设上 → 占位串被画成气泡。
//   ② /clear 已是轮换新会话语义:SSE 发 conversation_reset(old→new) → init(新 sid);
//      全仓无 conversation_reset 处理,isInitBindingOrigin 对非 draft 会话恒 false
//      → 窗格挂在旧会话上,新会话绑不上。
// 变异哨兵(实际验证过红):
//   S1 删 isResetBindingOrigin 的 sessionId 比对(恒 true)→ t2 红(切走场景被抢绑)
//   S2 删 App.jsx 的 conversation_reset 分支 → t4 红
//   S3 删占位串归空那行 → t5 红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isResetBindingOrigin, isCliNoContentPlaceholder, isInitBindingOrigin } from '../../client/src/utils/routing.js';

// t1 isCliNoContentPlaceholder:只认精确的 CLI 占位串
{
  assert.equal(isCliNoContentPlaceholder('(no content)'), true, 't1: 精确占位串');
  assert.equal(isCliNoContentPlaceholder('  (no content)\n'), true, 't1: 容忍首尾空白(SSE 增量拼接)');
  assert.equal(isCliNoContentPlaceholder('(no content)。'), false, 't1: 占位串+其他内容不吞');
  assert.equal(isCliNoContentPlaceholder('(no content'), false, 't1: 括号不全不吞(模型真说话别误伤)');
  assert.equal(isCliNoContentPlaceholder(''), false, 't1: 空串不算(空串本来就是空,不需要这个判定)');
  assert.equal(isCliNoContentPlaceholder(null), false, 't1: null 安全');
  assert.equal(isCliNoContentPlaceholder(undefined), false, 't1: undefined 安全');
}

// t2 isResetBindingOrigin 真值表:只许「本流 reset 的旧会话 = 当前选中」换绑
{
  assert.equal(isResetBindingOrigin('sid-old', { sessionId: 'sid-old' }), true, 't2: 选中仍是旧会话 → 换绑');
  assert.equal(isResetBindingOrigin('sid-old', { sessionId: 'sid-other' }), false, 't2: 用户已切走 → 不抢绑(安全失败)');
  assert.equal(isResetBindingOrigin('sid-old', null), false, 't2: 无选中 → 不绑');
  assert.equal(isResetBindingOrigin('sid-old', { draft: true, draftId: 'd1' }), false, 't2: 选中变成新 draft → 不抢绑');
  assert.equal(isResetBindingOrigin(null, { sessionId: 'sid-old' }), false, 't2: 老 CLI 无 reset 事件 → 永不触发(兼容口径)');
  assert.equal(isResetBindingOrigin(undefined, { sessionId: 'sid-old' }), false, 't2: undefined 同 null');
  // 与 isInitBindingOrigin 的互补:/clear 流 startedAsDraft=false,draft 判定恒 false,必须靠 reset 判定
  assert.equal(isInitBindingOrigin(false, undefined, { sessionId: 'sid-old' }), false, 't2: 互补性锚点 —— 非 draft 会话 init 恒不绑');
}

// t3 App.jsx 接线:reset 判定接入 init 绑定块
{
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /isResetBindingOrigin\(conversationResetFrom, sel\)/, 't3: init 块接入 reset 判定');
  assert.match(app, /let conversationResetFrom = null;/, 't3: 每流 reset 状态初始化(老 CLI 恒 null)');
  const bind = app.slice(app.indexOf('if (resetIsOrigin) {'), app.indexOf('if (resetIsOrigin) {') + 1500);
  assert.match(bind, /setPaneMessages\(tabIndex, \[\], event\.session_id\)/, 't3: 换绑清本地历史并认领新 sid');
  assert.match(bind, /setSelectedSession\(\{[\s\S]*?sessionId: event\.session_id/, 't3: 窗格换绑新会话');
  assert.match(bind, /firstPrompt: ''/, 't3: 旧会话标题不带进新会话');
  assert.match(bind, /conversationResetFrom = null;/, 't3: 一次性消费,后续 init 不再触发');
}

// t4 conversation_reset 事件分支:存在性 + 清流式残影 + 不落入消息处理
{
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const i = app.indexOf("event.type === 'conversation_reset'");
  assert.ok(i > 0, 't4: conversation_reset 分支存在(全仓此前零处理)');
  const branch = app.slice(i, i + 500);
  assert.match(branch, /conversationResetFrom = event\.session_id \|\| streamSid \|\| null;/, 't4: 记旧 sid(缺省兜底本流归属)');
  assert.match(branch, /setChatMessages\(\[\]\);/, 't4: 清本 pane 流式本地消息');
  assert.match(branch, /continue;/, 't4: reset 事件不落入后续消息处理');
  // 兼容锚点:分支只在事件到达时触发,老 CLI(无此事件)整条路径不激活
  assert.match(branch, /^event\.type === 'conversation_reset'\) \{/, 't4: 严格按事件类型门控');
}

// t5 占位串视同空:isClear 且 accumulatedText 只含占位串 → 归空 → 进 ✅ 分支
{
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const strip = app.indexOf('isCliNoContentPlaceholder(accumulatedText)');
  assert.ok(strip > 0, 't5: 占位串归空接线存在');
  const around = app.slice(strip - 300, strip + 2200);
  assert.match(around, /if \(isClear && isCliNoContentPlaceholder\(accumulatedText\)\) \{\s*accumulatedText = '';\s*\}/, 't5: isClear 门控下归空');
  assert.match(around, /isClear \? '✅ 会话已清空，请发送新的消息。'/, 't5: ✅「会话已清空」分支仍在(归空后才能到达)');
  // 归空必须先于「有内容」判定,否则占位串被当正常回复画气泡
  assert.ok(strip < app.indexOf("const okText = isClear"), 't5: 归空在 ✅ 分支判定之前');
}

console.log('✓ check-r29-clear-content: 占位串视同空 + conversation_reset 换绑/清消息 + 老 CLI 兼容');
