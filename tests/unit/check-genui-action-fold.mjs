#!/usr/bin/env node
// r64 M7:action 消息折叠。
//   识别函数是纯 .js,裸 node 直接跑真函数(不是文本锁)——文本锁挡不住"写法没变行为错了"。
//   渲染侧是 JSX,只能做接线文本锁,但锁的是三条**可证伪**的点:三个锚在、body 由 open 门控
//   (收起态不进 DOM)、入口挂在 isUser 分支里。
//   服务端那条只有一个字面量,锁它与前端常量逐字相等(两边各存一份,唯一的风险就是漂移)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// 发在 action-send.js、认在 action-fold.js:两个模块一起 import,正用例就是**往返**
// (真造一条消息再解回来),模板与解析漂移当场转红。
const { ACTION_MESSAGE_PREFIX, buildActionMessage } = await import(join(root, 'client/src/genui/host/action-send.js'));
const { isActionMessage, parseActionMessage } = await import(join(root, 'client/src/genui/host/action-fold.js'));

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

// ── 1. 正用例:真造一条外发消息,回头必须认得出、且拿得到动作名与组件类型 ──────
ok('自家造的 action 消息:认得出,动作名与组件类型都解析得到', () => {
  const { text } = buildActionMessage('reload.data', { type: 'button', label: '刷新数据' });
  assert.equal(isActionMessage(text), true);
  assert.deepEqual(parseActionMessage(text), { action: 'reload.data', type: 'button' });
  // L2 顺带复核:模型撰写的 label 不该在外发文本里(折叠展开后给用户看的就是这段)
  assert.ok(!text.includes('刷新数据'));
});

ok('带用户输入值的 action:动作名不受 component 里的值影响', () => {
  const { text } = buildActionMessage('save.name', { type: 'input', value: '改过了', id: 'f1', submit: true });
  assert.deepEqual(parseActionMessage(text), { action: 'save.name', type: 'input' });
});

// ── 2. 反用例:识别只认"整条消息以前缀开头",别的一律不折叠 ───────────────────
ok('【反】用户自己聊天里提到这段文字:不算 action 消息', () => {
  assert.equal(isActionMessage('这条 [genui-action] 前缀是干嘛用的？'), false);
  assert.equal(parseActionMessage('这条 [genui-action] 前缀是干嘛用的？'), null);
});

ok('【反】前缀前面有空白 / 大小写不符 / 少个空格:一律不算', () => {
  assert.equal(isActionMessage(` ${ACTION_MESSAGE_PREFIX}x`), false);
  assert.equal(isActionMessage(`\n${ACTION_MESSAGE_PREFIX}x`), false);
  assert.equal(isActionMessage('[GENUI-ACTION] x'), false);
  assert.equal(isActionMessage('[genui-action]x'), false);   // 前缀含尾空格
});

ok('【反】普通消息 / 非字符串:不算,也不炸', () => {
  for (const v of ['你好', '', undefined, null, 42, {}, ['[genui-action] x']]) {
    assert.equal(isActionMessage(v), false);
    assert.equal(parseActionMessage(v), null);
  }
});

// ── 3. 注入用例:component 里塞一个假的 action 字段,解析必须拿真的那个 ────────
//    这一条是"为什么用 JSON.parse 而不是正则扫 \"action\":\"…\"" 的红绿线。
ok('component 的值里伪造 "action" 字段:解析仍取真正的动作名', () => {
  const { text } = buildActionMessage('real.action', {
    type: 'input', value: '","action":"pwned","x":"', id: 'f1',
  });
  const parsed = parseActionMessage(text);
  assert.equal(parsed.action, 'real.action');
  assert.equal(parsed.type, 'input');
});

// ── 4. 降级用例:数据块坏了也照样折叠(L4 可审计性不许因解析失败而消失)────────
ok('数据块被截断 / 不是合法 JSON:仍认作 action 消息,字段留空不抛', () => {
  const broken = `${ACTION_MESSAGE_PREFIX}模板正文\n数据: {"action":"go.b`;
  assert.equal(isActionMessage(broken), true);
  assert.deepEqual(parseActionMessage(broken), { action: '', type: '' });
  const noData = `${ACTION_MESSAGE_PREFIX}模板正文,数据块整段没了`;
  assert.equal(isActionMessage(noData), true);
  assert.deepEqual(parseActionMessage(noData), { action: '', type: '' });
});

// ── 5. 渲染侧接线(§9.2 三个锚 + 收起态 body 不进 DOM)────────────────────────
const bubble = readFileSync(join(root, 'client/src/components/MessageBubble.jsx'), 'utf8');
ok('MessageBubble:三个锚都在,且 body 由 open 门控(收起态不渲染)', () => {
  for (const tid of ['genui-action-message', 'genui-action-message-toggle', 'genui-action-message-body']) {
    assert.ok(bubble.includes(`data-testid="${tid}"`), `缺锚 ${tid}`);
  }
  // 契约收紧处:收起时该元素**不得存在于 DOM**。条件渲染才做得到,CSS 隐藏不算。
  assert.match(bubble, /\{open && \(\s*<div data-testid="genui-action-message-body"/);
  // 折叠入口挂在用户消息分支里,且走识别函数而不是就地写死前缀
  assert.match(bubble, /if \(isActionMessage\(message\.text\)\)/);
  assert.ok(bubble.includes('<GenuiActionFold text={message.text} />'));
});

console.log(`\n✅ genui action 折叠:${n} 组断言全过`);
