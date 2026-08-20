// 单测:r17-① 上下文注入物提取(server/utils/context-injection.js)。
// fixture 用真实 CLI 请求体形态(假上游 127.0.0.1:6703 抓的 claude 2.1.237 真实请求,
// 只把正文换成短占位/敏感哨兵),import 真函数,不复制实现。
//
// 变异哨兵(每条都实际验证过红):
//   S1 把 claude-md 判据前缀改错("As you answer the user's question:") → t2 红
//   S2 去掉 <total_tokens> 忽略分支                                    → t3 红
//   S3 去掉 other 的首行 40 字截断(改成整块)                          → t5 红
//   S4 去掉 sessionId 解析失败即返回 null 的守卫                        → t7 红
//   S5 让 extractContextInjection 首行直接 throw                        → t9(转发不受影响)仍绿
import assert from 'node:assert/strict';
import { extractContextInjection, parseSessionIdFromMetadata, reportContextInjection } from '../../server/utils/context-injection.js';
import { clients } from '../../server/broadcast.js';

const SID = 'dd12c723-97e7-4cb4-95d1-3746baa1279f';
const META = { user_id: JSON.stringify({ device_id: '46c54d8f', account_uuid: '', session_id: SID }) };

// 隐私哨兵:正文里埋一串绝不允许外泄的字样,任何输出里出现即判红。
const SECRET = 'SECRET-donny-private-note-9f3a';

const rem = (s) => `<system-reminder>\n${s}\n</system-reminder>\n`;
const AGENTS = rem(`Available agent types for the Agent tool:\n- claude: ${SECRET} catch-all`);
const SKILLS = rem(`The following skills are available for use with the Skill tool:\n\n- dataviz: ${SECRET} charts`);
const CLAUDEMD = rem(`As you answer the user's questions, you can use the following context:\n# claudeMd\n${SECRET}\n# userEmail\nfoo@bar.com`);
const BUDGET = rem('<total_tokens>15000000 tokens left</total_tokens>');
const TOOLSEARCH = rem(`The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError.\n${SECRET}`);

const body = (content, metadata = META) => ({ model: 'claude-sonnet-4-6', metadata, messages: [{ role: 'user', content }] });
const FULL = body([
  { type: 'text', text: TOOLSEARCH },
  { type: 'text', text: AGENTS },
  { type: 'text', text: SKILLS },
  { type: 'text', text: BUDGET },
  { type: 'text', text: CLAUDEMD },
  { type: 'text', text: 'say ok' }, // 用户自己那条,不是注入物
]);

let n = 0;
const ok = (cond, msg) => { n += 1; assert.ok(cond, msg); };
const eq = (a, b, msg) => { n += 1; assert.equal(a, b, msg); };

// t1 sessionId 从 metadata.user_id(JSON 字符串)里取出
{
  eq(parseSessionIdFromMetadata(META), SID, 't1: session_id 解析');
  eq(extractContextInjection(FULL).sessionId, SID, 't1: 结果带 sessionId');
}

// t2 四类分类:agents / skills / claude-md 各按块首前缀归类
{
  const items = extractContextInjection(FULL).items;
  const kinds = items.map((x) => x.kind);
  ok(kinds.includes('agents'), 't2: agents 应被识别');
  ok(kinds.includes('skills'), 't2: skills 应被识别');
  ok(kinds.includes('claude-md'), 't2: claude-md 应被识别');
  eq(items.find((x) => x.kind === 'claude-md').label, 'CLAUDE.md', 't2: claude-md 标签');
  eq(items.find((x) => x.kind === 'agents').label, 'agents', 't2: agents 标签');
  eq(items.find((x) => x.kind === 'skills').label, 'skills', 't2: skills 标签');
}

// t3 <total_tokens> 预算块被忽略(它不是注入物)
{
  const items = extractContextInjection(FULL).items;
  ok(!items.some((x) => x.label.includes('total_tokens')), 't3: 预算块不应出现');
  eq(items.length, 4, 't3: 5 个 reminder 减掉预算块 = 4 条');
  eq(extractContextInjection(body([{ type: 'text', text: BUDGET }])), null, 't3: 只有预算块 → null');
}

// t4 用户自己那条消息(无 <system-reminder> 包裹)不算注入物
{
  eq(extractContextInjection(body([{ type: 'text', text: 'say ok' }])), null, 't4: 纯用户文本 → null');
}

// t5 认不出的块归 other 且保留首行前 40 字(CLI 换文案时还能看出是什么)
{
  const other = extractContextInjection(FULL).items.find((x) => x.kind === 'other');
  ok(other, 't5: ToolSearch 块应归 other');
  eq(other.label, 'The following deferred tools are now ava', 't5: other 标签 = 首行前 40 字');
  eq(other.label.length, 40, 't5: 截断到 40');
  ok(!other.label.includes('\n'), 't5: 只取首行');
}

// t6 bytes 是字符数(不是 token),且没有任何 token 字段
{
  const items = extractContextInjection(FULL).items;
  eq(items.find((x) => x.kind === 'claude-md').bytes, CLAUDEMD.length, 't6: bytes = 该块字符数');
  ok(items.every((x) => Object.keys(x).join(',') === 'kind,label,bytes'), 't6: 字段只有 kind/label/bytes');
}

// t7 畸形输入一律 null,绝不抛
{
  eq(extractContextInjection(null), null, 't7: null');
  eq(extractContextInjection('not-an-object'), null, 't7: 字符串 body');
  eq(extractContextInjection({ metadata: META }), null, 't7: messages 缺失');
  eq(extractContextInjection({ metadata: META, messages: [] }), null, 't7: messages 空');
  eq(extractContextInjection(body('我是字符串不是数组')), null, 't7: content 是字符串');
  eq(extractContextInjection(body([{ type: 'text', text: CLAUDEMD }], { user_id: '{坏JSON' })), null, 't7: user_id 非合法 JSON');
  eq(extractContextInjection(body([{ type: 'text', text: CLAUDEMD }], { user_id: '{"device_id":"x"}' })), null, 't7: user_id 无 session_id');
  eq(extractContextInjection({ messages: [{ role: 'user', content: [{ type: 'text', text: CLAUDEMD }] }] }), null, 't7: metadata 缺失');
  eq(extractContextInjection(body([null, { type: 'image' }, { type: 'text' }])), null, 't7: 畸形 block 不抛');
}

// t8 【红线】输出里绝不含任何正文 —— 拿含敏感字样的 fixture,grep 整个广播载荷
{
  const out = extractContextInjection(FULL);
  const payload = JSON.stringify({ type: 'context-injection', sessionId: out.sessionId, items: out.items });
  ok(!payload.includes(SECRET), 't8: 广播载荷不得含正文哨兵');
  ok(!payload.includes('userEmail'), 't8: 不得含 CLAUDE.md 子节名');
  ok(!payload.includes('foo@bar.com'), 't8: 不得含 CLAUDE.md 里的邮箱');
  ok(!payload.includes('dataviz'), 't8: 不得含 skill 名');
  // 反向证明哨兵有效:同一份 fixture 的原始 body 里确实有这些字样
  ok(JSON.stringify(FULL).includes(SECRET), 't8: fixture 本身含哨兵(哨兵有效性)');
}

// t9 reportContextInjection:真的经既有 broadcast 发出,且载荷同样不含正文
{
  const sent = [];
  const fake = { readyState: 1, send: (m) => sent.push(m) };
  clients.add(fake);
  try {
    const r = reportContextInjection(Buffer.from(JSON.stringify(FULL)));
    eq(r.sessionId, SID, 't9: Buffer 入参也能提取');
    eq(sent.length, 1, 't9: 广播一条');
    const msg = JSON.parse(sent[0]);
    eq(msg.type, 'context-injection', 't9: 广播类型');
    eq(msg.sessionId, SID, 't9: 广播带 sessionId');
    eq(msg.items.length, 4, 't9: 广播带 4 条');
    ok(!sent[0].includes(SECRET), 't9: 【红线】广播实际字节里不含正文');
    // 畸形/异常一律静默:不抛、不广播
    sent.length = 0;
    eq(reportContextInjection('{坏JSON'), null, 't9: 坏 JSON → null 不抛');
    eq(reportContextInjection(undefined), null, 't9: undefined → null 不抛');
    eq(sent.length, 0, 't9: 无内容不广播');
  } finally {
    clients.delete(fake);
  }
}

// t10 broadcast 本身抛异常也不得冒泡到转发路径
{
  const boom = { readyState: 1, send: () => { throw new Error('ws dead'); } };
  clients.add(boom);
  try {
    ok(reportContextInjection(FULL) !== undefined, 't10: send 抛错时 report 不抛');
  } finally {
    clients.delete(boom);
  }
}

console.log(`context-injection: ${n} assertions OK`);
