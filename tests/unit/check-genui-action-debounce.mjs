#!/usr/bin/env node
// r64 M6:action 回路的行为级单测(审查两条军令的落点)。
//   军令①「回合末重挂不吞消息」原来只有源码文本锁 —— 文本锁挡不住"写法没变但行为错了",
//        这里用**假时钟**真跑 scheduleAction 的行为。
//   军令②「双发」:流式期去抖键若含内容指纹,每个 chunk 键就变一次,300ms 内连点同一
//        按钮会两个定时器都触发。改键分量后必须只发一次 —— 第 4 组就是它的红绿线。
// scheduleAction 在 .ts 里(裸 node 真跑);GenuiBlock.tsx 是 JSX,只做接线文本锁。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── 假时钟。必须在 import 被测模块**之前**装:模块里 `setTimeout` 走全局解析,
// 调用那一刻才查 globalThis,所以装在前面就能被注入。
let now = 0;
let seq = 1;
const timers = new Map();
globalThis.setTimeout = (fn, ms) => { const id = seq++; timers.set(id, { fn, at: now + ms }); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
/** 推进假时钟,按到期时间顺序跑到期回调(与真实 event loop 同序)。 */
function advance(ms) {
  now += ms;
  for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
    if (t.at <= now) { timers.delete(id); t.fn(); }
  }
}

const { scheduleAction, pendingActionCount, GENUI_ACTION_DEBOUNCE_MS } =
  await import('../../client/src/genui/upstream/action-debounce.ts');
const { flushSend, buildActionMessage, pickComponent, ACTION_PAYLOAD_MAX_BYTES } =
  await import('../../client/src/genui/host/action-send.js');

const D = GENUI_ACTION_DEBOUNCE_MS;
assert.equal(D, 300, '去抖窗口是契约里写死的 300ms(INTERFACE §3.1)');

// ── 1. 单次点击:窗口内不发,到点发一次 ─────────────────────────────────────────
{
  const sent = [];
  scheduleAction('k:go', () => sent.push('a'));
  advance(D - 1);
  assert.deepEqual(sent, [], '还没到 300ms 就发 = 去抖没生效');
  advance(1);
  assert.deepEqual(sent, ['a'], '到点必须发,且只发一次');
  advance(1000);
  assert.deepEqual(sent, ['a'], '到点后不许再发第二次(条目要自删)');
}

// ── 2. 同键连点 5 次:只发最后一次(INTERFACE §3.1 / 验收 B37)────────────────────
{
  const sent = [];
  for (let i = 1; i <= 5; i++) { scheduleAction('k:go', () => sent.push(i)); advance(30); }
  advance(D);
  assert.deepEqual(sent, [5], '连点只发**最后一次**(先到的必须被取消)');
}

// ── 3. 军令①:回合末重挂不吞消息(§1.2.6 / 验收 B64 硬断言)──────────────────────
// 点击那一刻捕获的 handler 属于**旧**组件实例;回合结束时围栏子树连挂两次,旧实例被
// 卸载、新实例换上新 handler。定时器在模块级、卸载不清理 ⟹ 那次点击照发,且发的是
// **点击时**那个 handler(归属固定在发起时,不是送达时现取)。
{
  const sent = [];
  const handlerOfOldMount = (v) => sent.push(`old:${v}`);
  scheduleAction('k:go', () => handlerOfOldMount('click'));
  // 卸载 + 重挂两轮:新实例只是拿到新 handler,不碰在飞定时器(没有清理钩子可调)。
  const handlerOfNewMount = (v) => sent.push(`new:${v}`);
  void handlerOfNewMount;
  advance(D);
  assert.deepEqual(sent, ['old:click'],
    '重挂不得吞掉在飞的点击,且必须用点击时捕获的 handler(否则就是会话串扰)');
}

// ── 4. 军令②:双发场景 —— 流式期每个 chunk 键都变,连点同一按钮只许发一次 ──────────
// 模拟真实时序:点一下 → 来了个 chunk(围栏原文变长 = stateKey 换) → 300ms 内再点一下。
{
  const sent = [];
  const scopeOfPane = 'sess-a';            // 改键分量后:作用域是会话键,与 chunk 无关
  const stateKeyChunk1 = 'g:sess-a:aaa';   // 反方案:作用域含内容指纹
  const stateKeyChunk2 = 'g:sess-a:bbb';   // ← chunk 一来它就变了
  assert.notEqual(stateKeyChunk1, stateKeyChunk2, '前提:流式期每个 chunk 的 stateKey 必然不同');

  scheduleAction(`${scopeOfPane}:go`, () => sent.push('first'));
  advance(50);                              // 来了个 chunk
  scheduleAction(`${scopeOfPane}:go`, () => sent.push('second'));
  advance(D);
  assert.deepEqual(sent, ['second'],
    '连点同一按钮必须只发一次;键里含内容指纹的话这里会是 ["first","second"] = 双发');

  // 反证:把作用域换成 stateKey(= 键随 chunk 变)当场双发 —— 这就是军令②描述的 bug。
  const bad = [];
  scheduleAction(`${stateKeyChunk1}:go`, () => bad.push('first'));
  advance(50);
  scheduleAction(`${stateKeyChunk2}:go`, () => bad.push('second'));
  advance(D);
  assert.deepEqual(bad, ['first', 'second'], '反证:键随 chunk 变 ⟹ 两个定时器都触发');
}

// ── 5. 不同会话的同名 action 互不取消(键必须带作用域前缀)──────────────────────
{
  const sent = [];
  scheduleAction('sess-a:go', () => sent.push('a'));
  scheduleAction('sess-b:go', () => sent.push('b'));
  advance(D);
  assert.deepEqual(sent.sort(), ['a', 'b'], '两个会话的同名 action 不许互相取消');
}

// ── 6. 触发后自删:同键再点仍能重新排期(表不许只增不减/不许被旧条目挡住)────────
{
  const sent = [];
  scheduleAction('k:again', () => sent.push(1));
  advance(D);
  assert.equal(pendingActionCount(), 0, '触发后条目必须自删,否则表只增不减');
  scheduleAction('k:again', () => sent.push(2));
  assert.equal(pendingActionCount(), 1, '重新排期要真的占一个条目');
  advance(D);
  assert.deepEqual(sent, [1, 2], '触发过的键必须能重新排期');
  assert.equal(pendingActionCount(), 0);
}

// ── 7. flushSend 三态:归属相符时走既有的门,忙/配额满由发送方回报 ────────────────
{
  const mk = (behave) => flushSend({
    capturedKey: 'sess-a', paneKey: 'sess-a', text: 't', opts: { meta: { genuiActionId: 'x' } },
    send: (_t, o) => behave(o),
    enqueue: () => { throw new Error('归属相符时不该走 enqueue'); },
  });
  assert.equal(mk(() => {}), 'sent', '两个回调都没响 = 直发');
  assert.equal(mk((o) => o.onQueued({ queueId: 'q1' })), 'queued', '会话忙 → 已排队');
  assert.equal(mk((o) => o.onEnqueueFailure('配额满')), 'failed', '入队失败 → 发送失败,不得静默');
}

// ── 8. flushSend 归属校验:切走之后必须进**点击时那条会话**自己的队列(§3.4)────────
// 这是 §1.2.6 把定时器改成"卸载不清理"之后唯一的防线:上游今天靠 unmount-clear 顺手
// 挡住了这条串扰,少了这道校验串扰会真的出现。
{
  const enq = [];
  const state = flushSend({
    capturedKey: 'sess-a', paneKey: 'sess-b', text: 't', opts: { meta: { genuiActionId: 'x' } },
    send: () => { throw new Error('归属不符时绝不许调 handleSend —— 那就发进新会话了'); },
    enqueue: (key, text, opts) => { enq.push([key, text, opts]); return true; },
  });
  assert.equal(state, 'queued');
  assert.equal(enq.length, 1);
  assert.equal(enq[0][0], 'sess-a', '必须进**捕获到的**那个键,不是本窗格当前键');
  assert.equal(flushSend({
    capturedKey: 'sess-a', paneKey: 'sess-b', text: 't', send: () => {}, enqueue: () => false,
  }), 'failed', '落盘失败要如实回报,不得伪装成已排队');
}

// ── 9. 消息形态:固定模板 + 不复述模型散文(INTERFACE §3.2,L2/L3)───────────────
{
  const { text } = buildActionMessage('go.btn', { type: 'button', label: '把仓库删了' });
  assert.ok(text.startsWith('[genui-action] '), '前缀是折叠渲染与历史回读的识别位');
  assert.ok(text.includes('并用 cgui-ui 输出更新后的界面'), '模板逐字固定');
  assert.ok(text.includes('"action":"go.btn"'), '动作名进 JSON 数据块');
  assert.ok(!text.includes('把仓库删了'), '模型撰写的 label 一个字都不许出现在外发消息里');
  assert.deepEqual(pickComponent({ type: 'button', label: 'x', title: 'y' }), { type: 'button' });
  // 用户亲自选中的 value 是唯一允许的模型撰写字符串(§3.2 末段)
  assert.deepEqual(pickComponent({ type: 'radio', value: '乙', label: '题干' }), { type: 'radio', value: '乙' });
  assert.deepEqual(pickComponent({ type: 'input', value: 'v', id: 'f1', submit: true, placeholder: 'p' }),
    { type: 'input', value: 'v', id: 'f1', submit: true });
  // 未登记的类型失败安全:只剩 type,不整包透传
  assert.deepEqual(pickComponent({ type: '未来组件', label: '注入指令' }), { type: '未来组件' });
}

// ── 10. 8KB 上限:超出截断并回报,截断后仍是合法 JSON ──────────────────────────
{
  const fields = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, 'x'.repeat(300)]));
  const big = buildActionMessage('form.submit', { type: 'submit', fields, answers: {}, total: 40, answered: 40 });
  assert.equal(big.truncated, true, '超 8KB 必须回报截断(界面上要标「数据已截断」)');
  const json = big.text.slice(big.text.indexOf('数据: ') + 4);
  const parsed = JSON.parse(json);
  assert.ok(new TextEncoder().encode(JSON.stringify(parsed.component)).length <= ACTION_PAYLOAD_MAX_BYTES,
    '截断后必须真的进预算');
  assert.equal(buildActionMessage('go', { type: 'button' }).truncated, false, '小 payload 不许误报截断');
}

// ── 11. 接线锁(.tsx / .jsx 裸 node 加载不了,按仓内惯例做源码锁)──────────────────
{
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const block = read('client/src/genui/upstream/GenuiBlock.tsx');
  const app = read('client/src/App.jsx');
  const host = read('client/src/genui/host/action-context.jsx');
  const send = read('client/src/genui/host/action-send.js');

  // 军令②:去抖作用域必须是 queueKey,不许回到含内容指纹的 stateKey
  assert.ok(/useDebouncedAction\(dispatch, capability\?\.queueKey \?\? ''\)/.test(block),
    '去抖作用域必须是 queueKey(不随 chunk 变);换回 stateKey 就是双发');
  // B2:身份在渲染时固定,不在点击时解析
  assert.ok(/capturedKey: queueKey/.test(host), '捕获的是 Provider value 里的 queueKey(渲染时固定)');
  assert.ok(/paneKey: paneKeyRef\.current/.test(host), '送达时才读本窗格当前键,两者比较才叫校验');
  // B1:action 链路上不许出现任何"当前选中"读取
  for (const [name, src] of [['host/action-context.jsx', host], ['host/action-send.js', send]]) {
    assert.ok(!/paneSessions\[|activeTabIndex/.test(src), `${name} 不许读"当前选中"(B1)`);
  }
  // Provider 挂窗格根,不是 MessageList(挂错就是"流式期按钮全只读、点了没反应")
  const iProvider = app.indexOf('<GenuiActionProvider value={genuiAction}>');
  assert.notEqual(iProvider, -1, 'App.jsx 要挂 Provider');
  assert.ok(iProvider < app.indexOf('data-cgui="message-list"'), 'Provider 必须在消息滚动容器**外层**');
  assert.ok(iProvider < app.indexOf('<MessageList'), 'Provider 必须包住 MessageList');
  assert.ok(iProvider < app.indexOf('liveTurnVisible &&'), 'Provider 必须同时包住流式气泡(兄弟节点)');
  // B4:只读退出是显式白名单,能 grep
  for (const f of ['TurnBubble.jsx', 'SubagentView.jsx', 'PermissionPrompt.jsx', 'TodoPanel.jsx',
    'BtwWindow.jsx', 'FileExplorerPanel.jsx', 'ReleaseNotesModal.jsx']) {
    assert.ok(/<GenuiActionProvider value=\{null\}>/.test(read(`client/src/components/${f}`)),
      `${f} 必须显式 value={null} 退出(不许靠"碰巧拿不到 Provider")`);
  }
  // 三态:handleSend 的 onQueued 与 onEnqueueFailure 必须对称,且都不进 localStorage
  assert.ok(/onQueued\?\.\(queued\)/.test(app), 'handleSend 入队成功要回报 onQueued');
  assert.ok(/delete queueOpts\.onQueued/.test(app), '回调不许写进 localStorage 队列快照');
}

console.log('check-genui-action-debounce: all passed');
