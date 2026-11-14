#!/usr/bin/env node
// r183b:子代理的报错原文在前端的三处处理(行为断言,不数源码文本)。
//   ① 状态库合并子代理正文增量:报错段独立成块并打标,前后的普通文字都不跨过它合并;text 数组照旧带这段文字。
//   ② 共用拆分函数 splitAgentReply(子代理卡片 / 监控面板):实时块、读历史块都分得出报错段;
//      没有报错段时交给 Markdown 的那段与 agent.text.join('') 逐字相同。
//   ③ 报错原文显示前的换行归一 normalizeErrorNewlines。
// Run: node tests/unit/check-r183b-agent-error-split.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let failed = 0, passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL ${name}\n      ${String(e && e.message || e).split('\n').join('\n      ')}`); }
};

const storeMod = await import(root + 'client/src/stores/sessionStore.js');
const { useStore, flushAgentDeltas } = storeMod;
const { splitAgentReply, historyLegacyArrays } = await import(root + 'client/src/utils/agentView.js');
const { normalizeErrorNewlines } = await import(root + 'client/src/utils/apiErrorActions.js');
const agent = (id) => useStore.getState().activeAgents[id];
const ERR = 'API Error: 400 余额不足 ![图](http://127.0.0.1:1/sub.png) **粗体** <b>x</b>';

console.log('r183b 子代理报错原文:状态库合并 / 拆分函数 / 换行归一');

// ── ① 状态库合并 ──────────────────────────────────────────────
await check('报错段独立成块,前面的普通文字不并进去,之后的普通文字也不并进报错块', async () => {
  const s = useStore.getState();
  s.upsertAgent('r183b-live', { status: 'working', sessionId: 's-open' });
  s.appendAgentText('r183b-live', '前');
  s.appendAgentText('r183b-live', '文');
  s.appendAgentErrorText('r183b-live', ERR);
  s.appendAgentText('r183b-live', '后');
  s.appendAgentText('r183b-live', '续');
  flushAgentDeltas();
  const a = agent('r183b-live');
  assert.deepEqual(a.blocks.map((b) => [b.type, b.content, !!b.errorText]), [
    ['text', '前文', false],
    ['text', ERR, true],
    ['text', '后续', false],
  ]);
  assert.equal(a.text.join(''), `前文${ERR}后续`, 'text 数组照旧带这段文字');
});

await check('两条报错各自成块(报错块之间也不合并);普通文字合并规则不变', async () => {
  const s = useStore.getState();
  s.upsertAgent('r183b-two', { status: 'working', sessionId: 's-open' });
  s.appendAgentErrorText('r183b-two', 'E1');
  s.appendAgentErrorText('r183b-two', 'E2');
  s.appendAgentText('r183b-two', 'A');
  s.appendAgentText('r183b-two', 'B');
  flushAgentDeltas();
  assert.deepEqual(agent('r183b-two').blocks.map((b) => [b.content, !!b.errorText]), [['E1', true], ['E2', true], ['AB', false]]);
});

await check('报错块排在工具调用之后时顺序保持', async () => {
  const s = useStore.getState();
  s.upsertAgent('r183b-order', { status: 'working', sessionId: 's-open' });
  s.appendAgentText('r183b-order', 'A');
  s.appendAgentTool('r183b-order', { id: 't1', name: 'Read', input: {}, result: null });
  s.appendAgentErrorText('r183b-order', 'E');
  flushAgentDeltas();
  assert.deepEqual(agent('r183b-order').blocks.map((b) => b.type + (b.errorText ? '!' : '')), ['text', 'tool_use', 'text!']);
});

// ── ② 拆分函数 ────────────────────────────────────────────────
await check('实时块(状态库产出)分得出报错段,普通段内容逐字', async () => {
  const segs = splitAgentReply(agent('r183b-live'));
  assert.deepEqual(segs, [
    { errorText: false, content: '前文' },
    { errorText: true, content: ERR },
    { errorText: false, content: '后续' },
  ]);
});

await check('读历史块(后端块带 errorText,经 historyLegacyArrays 填 text)分得出报错段', async () => {
  const blocks = [
    { type: 'thinking', content: '想' },
    { type: 'text', content: '先说一句' },
    { type: 'tool_use', toolCall: { id: 't', name: 'Read', input: {} } },
    { type: 'text', content: '再说一句' },
    { type: 'text', content: ERR, errorText: true },
  ];
  const hydrated = { blocks, ...historyLegacyArrays(blocks) };
  assert.deepEqual(splitAgentReply(hydrated), [
    { errorText: false, content: '先说一句再说一句' },
    { errorText: true, content: ERR },
  ]);
});

await check('没有报错段:一段,内容与 agent.text.join("") 逐字相同(含实时与历史两种来源)', async () => {
  const live = { text: ['正常回复 **粗体', 'R183B** 结束'], blocks: [{ type: 'text', content: '正常回复 **粗体R183B** 结束' }] };
  assert.deepEqual(splitAgentReply(live), [{ errorText: false, content: live.text.join('') }]);
  const blocks = [{ type: 'text', content: 'a\n' }, { type: 'tool_use', toolCall: { id: 'x' } }, { type: 'text', content: 'b' }];
  const hist = { blocks, ...historyLegacyArrays(blocks) };
  assert.deepEqual(splitAgentReply(hist), [{ errorText: false, content: hist.text.join('') }]);
  // blocks 与 text 不一致时(没有报错段)以 text 为准 —— 与改前 agent.text.join('') 相同
  const odd = { text: ['只在 text 里'], blocks: [] };
  assert.deepEqual(splitAgentReply(odd), [{ errorText: false, content: '只在 text 里' }]);
});

await check('空正文 / 缺字段:返回空数组(不画「子代理回复」)', async () => {
  assert.deepEqual(splitAgentReply({ text: [], blocks: [] }), []);
  assert.deepEqual(splitAgentReply({}), []);
  assert.deepEqual(splitAgentReply(null), []);
});

// ── ③ 换行归一 ────────────────────────────────────────────────
await check('\\r\\n 与单独的 \\r 归一成 \\n,其余不动', async () => {
  assert.equal(normalizeErrorNewlines('第一行\r\n第二行'), '第一行\n第二行');
  assert.equal(normalizeErrorNewlines('a\rb\r\n\r\nc\n'), 'a\nb\n\nc\n');
  assert.equal(normalizeErrorNewlines('**不动** ![x](y)'), '**不动** ![x](y)');
  assert.equal(normalizeErrorNewlines(undefined), '');
  assert.equal(normalizeErrorNewlines(400), '400');
});

console.log(`r183b agent split: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
