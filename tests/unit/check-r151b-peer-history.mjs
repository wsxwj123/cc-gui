#!/usr/bin/env node
// r151b T-X5:历史读取产出 peer-message(接口 X.3.3「历史消息」、行为清单 23)。
//   ① origin.kind=peer 且没有 senderTaskId → { type:'peer-message', uuid, timestamp, fromName, from, body, hostInjected },
//      排在它触发的回复之前(前面的回复被切成一段);不算用户提问。
//   ② body:origin.body;没有时取该行文本去掉固定前缀 / 从固定后缀起的结尾(信封标签不再拆);两段都找不到 → null。
//   ③ fromName:origin.name;没有 → null。旧 CLI(promptSource:sdk、无 turnOrigin)同样认出;不是 isMeta 的行也只看 origin。
//   ④ 带 senderTaskId 的子代理回传维持原处理(isMeta → 跳过);会话列表的首条提问与消息条数不受影响。
// 临时 HOME,不起服务。node tests/unit/check-r151b-peer-history.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151b-peerhist-')));
const HOME = join(TMP, 'home');
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
const PROJECT = '-tmp-r151b-peer';
mkdirSync(join(HOME, '.claude', 'projects', PROJECT), { recursive: true });
mkdirSync(join(HOME, '.claude-gui'), { recursive: true });

const { getSessionMessages, listSessions, peerMessageOf } = await import('../../server/services/session-reader.js');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed += 1; };

const SID = '11111111-2222-4333-8444-555555555555';
const ts = (n) => new Date(Date.parse('2026-10-02T08:00:00.000Z') + n * 1000).toISOString();
const PREFIX = 'Another Claude session sent a message:\n';
const SUFFIX = '\n\nThis came from another Claude session — not typed by your user.';
const asst = (n, parent, text) => ({ type: 'assistant', uuid: `a${n}`, parentUuid: parent, timestamp: ts(n * 10), sessionId: SID,
  message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'r151-chat', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
const peer = (uuid, n, origin, content, extra = {}) => ({ type: 'user', uuid, timestamp: ts(n), sessionId: SID, isMeta: true, origin, message: { role: 'user', content }, ...extra });
const envelope = '<cross-session-message from="uds:/tmp/cc-socks/9.sock" from-name="x">\n内文 <b>\n</cross-session-message>';

const lines = [
  { type: 'user', uuid: 'u0', timestamp: ts(0), sessionId: SID, promptSource: 'sdk', message: { role: 'user', content: '首条提问' } },
  asst(1, 'u0', '回复一'),
  // 新 CLI 写法:有 name / body / hostInjected
  peer('p1', 11, { kind: 'peer', from: 'gui:user', name: '用户转发自 甲', body: '正文一', hostInjected: true },
    `${PREFIX}<cross-session-message from="gui:user" from-name="用户转发自 甲">\n正文一\n</cross-session-message>${SUFFIX}`,
    { promptSource: 'system', turnOrigin: 'peer' }),
  asst(2, 'p1', '回复二'),
  // 旧 CLI 2.1.273 写法:promptSource sdk、无 turnOrigin;origin 无 name / body,文本带前后缀 → 取中间原文
  peer('p2', 21, { kind: 'peer', from: 'uds:/tmp/cc-socks/9.sock' }, `${PREFIX}${envelope}${SUFFIX}`, { promptSource: 'sdk' }),
  asst(3, 'p2', '回复三'),
  // 两段固定文字都没有 → body null;content 是块数组
  peer('p3', 31, { kind: 'peer' }, [{ type: 'text', text: '无法识别的文本' }]),
  asst(4, 'p3', '回复四'),
  // 只有前缀 / 只有后缀
  peer('p4', 41, { kind: 'peer', name: '乙' }, `${PREFIX}只有前缀`),
  peer('p5', 42, { kind: 'peer' }, `只有后缀${SUFFIX}`),
  asst(5, 'p5', '回复五'),
  // 子代理回传:带 senderTaskId → 维持原处理(isMeta 跳过,不出任何条目)
  peer('p6', 51, { kind: 'peer', senderTaskId: 'task_1', name: '子代理', body: '子代理回传' }, '子代理回传原文'),
  // 不是 isMeta 的行也只看 origin
  { type: 'user', uuid: 'p7', timestamp: ts(61), sessionId: SID, origin: { kind: 'peer', name: '丙', body: '非 meta 行' }, message: { role: 'user', content: '非 meta 行原文' } },
  asst(6, 'p7', '回复六'),
  // 普通的第二条提问照旧是用户提问
  { type: 'user', uuid: 'u1', timestamp: ts(71), sessionId: SID, message: { role: 'user', content: '第二条提问' } },
  asst(7, 'u1', '回复七'),
];
writeFileSync(join(HOME, '.claude', 'projects', PROJECT, `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

const { messages } = await getSessionMessages(SID, PROJECT);
const kinds = messages.map((m) => (m.type === 'peer-message' ? `peer:${m.uuid}` : m.type === 'user' ? `user:${m.text}` : `turn:${(m.text || []).join('')}`));
eq(kinds, [
  'user:首条提问', 'turn:回复一', 'peer:p1', 'turn:回复二', 'peer:p2', 'turn:回复三', 'peer:p3', 'turn:回复四',
  'peer:p4', 'peer:p5', 'turn:回复五', 'peer:p7', 'turn:回复六', 'user:第二条提问', 'turn:回复七',
], '条目顺序:peer-message 紧挨在它触发的回复之前;子代理回传不出条目;只有两条用户提问');

const peers = Object.fromEntries(messages.filter((m) => m.type === 'peer-message').map((m) => [m.uuid, m]));
eq(peers.p1, { type: 'peer-message', uuid: 'p1', timestamp: ts(11), fromName: '用户转发自 甲', from: 'gui:user', body: '正文一', hostInjected: true }, 'p1 全字段');
eq([peers.p2.fromName, peers.p2.from, peers.p2.body, peers.p2.hostInjected], [null, 'uds:/tmp/cc-socks/9.sock', envelope, false], 'p2:旧 CLI 写法,body 取前后缀之间的原文(信封不拆)');
eq([peers.p3.from, peers.p3.body], [null, null], 'p3:两段固定文字都找不到 → body null,没有 from → null');
eq([peers.p4.fromName, peers.p4.body], ['乙', '只有前缀'], 'p4:只去前缀');
eq(peers.p5.body, '只有后缀', 'p5:只截后缀');
eq(peers.p7.body, '非 meta 行', 'p7:不是 isMeta 的行也认');
ok(!JSON.stringify(messages).includes('子代理回传'), '子代理回传(带 senderTaskId)维持原处理:不出现');

// 纯函数边界
eq(peerMessageOf({ type: 'user', origin: { kind: 'human' }, message: { content: 'x' } }), null, '不是 peer 的 origin → null');
eq(peerMessageOf({ type: 'user', message: { content: 'x' } }), null, '没有 origin → null');
eq(peerMessageOf({ type: 'user', origin: { kind: 'peer' }, message: { content: `a${SUFFIX}b${SUFFIX}` } }).body, `a${SUFFIX}b`, '后缀取最后一处(正文里碰巧出现同一句不截短)');
eq(peerMessageOf({ type: 'user', origin: { kind: 'peer', body: '' }, message: { content: `${PREFIX}x` } }).body, '', 'origin.body 是空串也照用');

// 会话列表:首条提问与消息条数不受影响(列表路径未改)
const rows = await listSessions(PROJECT);
const row = rows.find((r) => r.sessionId === SID);
ok(row, '会话列表里有这个会话');
eq(row.firstPrompt, '首条提问', '首条提问不变');
eq(row.messageCount, lines.length, '消息条数仍按记录行数');

console.log(`check-r151b-peer-history: ${passed} 项通过`);
