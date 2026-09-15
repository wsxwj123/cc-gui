#!/usr/bin/env node
// R35/R36:「⚡ 并入」(steer)消息的两条用户实报缺陷。
//
//   R35 —— 带图片/文件的并入消息必须和普通消息一样拿到【同一份渲染数据】
//          (attachments 缩略图/文件卡 + displayText 说明文字),不是把给 CLI 的
//          原始出站文本(正文 + "附件:\n@/var/folders/…/cgui-attachments/….png")
//          摊在气泡里。数据来源 = 既有附件 sidecar(服务端保存的元数据),不新造存储。
//   R36 —— 并入消息的回退判据必须成立:会话裁剪(trim)的锚点就是它自己在 jsonl 里的
//          记录 uuid,效果与普通人工消息一致(只回退到这条消息之前)。
//
// 转写形态取自真机(折叠形态 = attachment{type:'queued_command'} 记录,无 user 行,
// source_uuid = 提交时的 steerId;形态 B = 回合末另起新回合的真 user 行,uuid = steerId)。
// 跑的是真 session-reader 与真 R25 历史变换引擎,不是构造的示意结构。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HOME 必须在 import session-reader 之前改 —— 它在模块作用域 join(homedir(), ...)。
const home = mkdtempSync(join(tmpdir(), 'cgui-r35-steer-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows 上 homedir() 读 %USERPROFILE%
const HASH = 'r35-test-project-hash';
mkdirSync(join(home, '.claude', 'projects', HASH), { recursive: true });
mkdirSync(join(home, '.claude-gui', 'attachments'), { recursive: true });

const { getSessionMessages, attachmentTextHash } = await import('../../server/services/session-reader.js');
const { applyHistoryOp } = await import('../../server/routes/session-history.js');

const write = (sid, lines) =>
  writeFileSync(join(home, '.claude', 'projects', HASH, `${sid}.jsonl`), lines.join('\n') + '\n');
const rec = (sid, o) => JSON.stringify({ sessionId: sid, cwd: '/tmp', ...o });
const writeSidecar = (sid, doc) =>
  writeFileSync(join(home, '.claude-gui', 'attachments', `${sid}.json`), JSON.stringify(doc, null, 2));

const STEER_ID = 'fd6aeca2-b2ca-4248-bc25-ba4b9fdd9683';       // 客户端提交时的 uuid(= steerId)
const REC_UUID = 'f342ee59-eb9e-4438-b813-48811a049bd3';       // CLI 给记录自己的 uuid(折叠形态)
const DISPLAY = '请看这两张图和一个文件';
const OUTBOUND = `${DISPLAY}\n\n附件:\n@/var/folders/xy/T/cgui-attachments/aa11.png\n@/var/folders/xy/T/cgui-attachments/bb22.txt`;
const ATTACHMENTS = [
  { kind: 'image', name: 'red.png', path: '/var/folders/xy/T/cgui-attachments/aa11.png', preview: 'data:image/png;base64,iVBORw0KGgo=', bytes: 68 },
  { kind: 'text', name: 'note.txt', path: '/var/folders/xy/T/cgui-attachments/bb22.txt', preview: null, bytes: 11 },
];
// 服务端 sidecar 的真实形态:身份索引 messages[messageId] + 旧 textHash 条目各写一份。
const sidecarDoc = () => ({
  [attachmentTextHash(OUTBOUND)]: { text: OUTBOUND, attachments: ATTACHMENTS, displayText: DISPLAY },
  messages: { [STEER_ID]: { text: OUTBOUND, attachments: ATTACHMENTS, displayText: DISPLAY } },
});
// MessageBubble 对人工消息的唯一取值口径(逐字取自 client/src/components/MessageBubble.jsx):
//   (attachments?.length && displayText !== undefined) ? displayText : text
const renderedText = (m) => ((m.attachments?.length && m.displayText !== undefined) ? m.displayText : m.text);

// ── A1/A2 折叠形态:并入消息在磁盘上没有 user 行,只有一条 attachment 记录 ─────────
{
  const SID = 'steer-fold-attach-session';
  write(SID, [
    rec(SID, { type: 'user', uuid: 'u1', timestamp: '2026-09-11T05:46:04.296Z', message: { role: 'user', content: 'Run exactly this one command with the Bash tool: sleep 20' } }),
    rec(SID, { type: 'assistant', uuid: 'as1', timestamp: '2026-09-11T05:46:05.100Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', id: 'msg_A', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 20' } }] } }),
    rec(SID, { type: 'user', uuid: 'u2', timestamp: '2026-09-11T05:46:05.500Z', message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: '', is_error: false }] } }),
    rec(SID, { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-11T05:46:05.933Z', content: OUTBOUND }),
    // ⚡ 折叠点:CLI 把队列条目移出队列并写下 queued_command 附件 = 真实的并入位置
    rec(SID, { type: 'queue-operation', operation: 'remove', timestamp: '2026-09-11T05:46:05.933Z', content: OUTBOUND }),
    rec(SID, {
      type: 'attachment', uuid: REC_UUID, timestamp: '2026-09-11T05:46:05.933Z', parentUuid: 'u2',
      attachment: { type: 'queued_command', prompt: OUTBOUND, source_uuid: STEER_ID, commandMode: 'prompt', timestamp: '2026-09-11T05:46:05.933Z' },
    }),
    rec(SID, { type: 'assistant', uuid: 'as2', timestamp: '2026-09-11T05:46:07.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', id: 'msg_B', content: [{ type: 'text', text: '收到，两图一文件都看到了。' }] } }),
  ]);
  writeSidecar(SID, sidecarDoc());
  const raw = (await import('node:fs')).readFileSync(join(home, '.claude', 'projects', HASH, `${SID}.jsonl`), 'utf8');
  const { messages } = await getSessionMessages(SID, HASH);

  // A1:R35 —— 附件元数据必须解析出来,并交给与普通消息同一个渲染取值口径
  const steered = messages.filter((m) => m.type === 'user' && m.steered);
  assert.equal(steered.length, 1, 'A1: 折叠形态合成一条并入消息');
  const msg = steered[0];
  assert.deepEqual(msg.attachments, ATTACHMENTS, 'A1: sidecar 元数据(按 source_uuid=steerId)注入 attachments —— 与普通消息同一套卡片数据');
  assert.equal(msg.displayText, DISPLAY, 'A1: displayText 注入 → 气泡显示说明文字');
  assert.match(msg.text, /附件:\n@\/var\/folders/, 'A1: text 仍是给 CLI 的完整出站文本(重发/落盘对账靠它)');
  assert.equal(renderedText(msg), DISPLAY, 'A1: 同一渲染口径取 displayText,不摊原始 @path 文本');
  assert.doesNotMatch(renderedText(msg), /cgui-attachments/, 'A1: 气泡正文里不出现原始附件路径(R35 症状)');

  // 客户端实时气泡的锚点解析(App.jsx resolveSteerAnchor 的两条匹配臂):uuid 或 steerUuid
  // 命中 steerId 才算"这条并入消息已经落盘",找不到就如实提示、不画点了没反应的入口。
  assert.equal(msg.uuid, REC_UUID, 'A1: 记录 uuid 用 CLI 自己的(trim 锚点就是它)');
  assert.equal(msg.steerUuid, STEER_ID, 'A1: steerUuid = 提交时的 steerId(实时气泡据此找落盘孪生)');
  const findAnchor = (id) => messages.find((m) => m.type === 'user'
    && (String(m.uuid || '').toLowerCase() === String(id).toLowerCase()
      || String(m.steerUuid || '').toLowerCase() === String(id).toLowerCase())) || null;
  assert.equal(findAnchor(STEER_ID)?.uuid, REC_UUID, 'A1: 按 steerId 能找回落盘锚点(steerUuid 命中臂)');

  // A2:R36 —— 回退判据 = trim(uuid=并入消息的 uuid) 从它自己那一行截起,保留段逐字未改
  const trim = applyHistoryOp('trim', raw, { uuid: msg.uuid });
  assert.equal(trim.ok, true, 'A2: 并入消息可以裁剪(回退入口不是假按钮)');
  assert.equal(trim.compatibility, 'compatible', 'A2: 保留段工具配对完整 → 可继续发送');
  assert.equal(trim.requiresNewSession, false, 'A2: 前面还有真实对话,不需要新建会话');
  assert.equal(trim.report.anchor.kind, 'uuid', 'A2: 锚点形态 = 记录 uuid');
  assert.equal(trim.affectedRange.fromLine, 5, 'A2: 正是那条 attachment 记录所在行(3 之前=回合前段保留)');
  assert.match(trim.newContent, /sleep 20/, 'A2: 并入之前的对话原样保留');
  assert.doesNotMatch(trim.newContent, new RegExp(REC_UUID), 'A2: 并入消息那条记录本身被裁掉');
  assert.doesNotMatch(trim.newContent, /"type":"attachment"/, 'A2: attachment 记录整条不留在保留段');
  assert.doesNotMatch(trim.newContent, /收到，两图一文件/, 'A2: 并入之后的回复也一并回退(只回到这条消息之前)');
  // 落盘裁剪后的重读:并入气泡从历史里消失(回退对会话/历史的真实效果,不是只裁了内存)。
  // 保留段里仍留着 queue-operation 记账行(CLI 自己写的书签,reader 不渲染)—— 它们带着同一段
  // 文本却不能再合成一条并入消息,这正是 reader 只认 queued_command 的理由。
  write(SID, trim.newContent.split('\n').filter((l) => l.trim()));
  const after = await getSessionMessages(SID, HASH);
  assert.equal(after.messages.filter((m) => m.steered).length, 0, 'A2: 回退后历史里没有并入消息');
  assert.equal(after.messages.filter((m) => m.type === 'turn').length, 1, 'A2: 只剩并入之前的那一个回合');

  // A5 反例:把 steerId 直接当 trim 锚点在折叠形态上必然 404 —— 实时气泡必须先解析落盘锚点,
  // 不能把 steerId 原样交给回退链路(否则用户点了只会看到"裁剪失败")。
  const wrongAnchor = applyHistoryOp('trim', raw, { uuid: STEER_ID });
  assert.equal(wrongAnchor.ok, false, 'A5: steerId 不是磁盘记录 uuid,不能当锚点');
  assert.equal(wrongAnchor.status, 404, 'A5: 找不到锚点 → 404');
}

// ── A3/A4 形态 B:回合末另起新回合的真 user 行,它的 uuid 就是 steerId ─────────────
{
  const SID = 'steer-drain-attach-session';
  write(SID, [
    rec(SID, { type: 'user', uuid: 'u1', timestamp: '2026-09-11T06:00:00.000Z', message: { role: 'user', content: '数到3' } }),
    rec(SID, { type: 'assistant', uuid: 'as1', timestamp: '2026-09-11T06:00:05.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', id: 'msg_C', content: [{ type: 'text', text: '1 2 3' }] } }),
    rec(SID, { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-09-11T06:00:10.000Z' }),
    rec(SID, { type: 'user', uuid: STEER_ID, timestamp: '2026-09-11T06:00:10.066Z', promptSource: 'sdk', message: { role: 'user', content: OUTBOUND } }),
    rec(SID, { type: 'assistant', uuid: 'as2', timestamp: '2026-09-11T06:00:12.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', id: 'msg_D', content: [{ type: 'text', text: '看到了。' }] } }),
  ]);
  writeSidecar(SID, sidecarDoc());
  const raw = (await import('node:fs')).readFileSync(join(home, '.claude', 'projects', HASH, `${SID}.jsonl`), 'utf8');
  const { messages } = await getSessionMessages(SID, HASH);

  const steerMsg = messages.find((m) => m.type === 'user' && m.uuid === STEER_ID);
  assert.ok(steerMsg, 'A3: 形态 B 的真 user 行就是那条并入消息');
  assert.deepEqual(steerMsg.attachments, ATTACHMENTS, 'A3: 身份索引(messageId=steerId)注入附件 —— 与折叠形态同一份数据');
  assert.equal(renderedText(steerMsg), DISPLAY, 'A3: 同一渲染口径取 displayText');

  const findAnchor = (id) => messages.find((m) => m.type === 'user' && String(m.uuid || '').toLowerCase() === String(id).toLowerCase()) || null;
  assert.equal(findAnchor(STEER_ID)?.uuid, STEER_ID, 'A4: 形态 B 按 uuid 命中锚点(实时气泡的第二条匹配臂)');

  const trim = applyHistoryOp('trim', raw, { uuid: STEER_ID });
  assert.equal(trim.ok, true, 'A3: 形态 B 的并入消息同样可裁剪');
  assert.equal(trim.compatibility, 'compatible', 'A3: 保留段可继续发送');
  assert.equal(trim.report.anchor.uuid, STEER_ID, 'A3: 锚点 = steerId(它在这形态下就是记录 uuid)');
  assert.doesNotMatch(trim.newContent, /cgui-attachments/, 'A3: 并入消息被裁掉');
  assert.match(trim.newContent, /数到3/, 'A3: 之前的对话保留');
}

// ── A6 普通附件消息与并入消息拿到【同一字段形态】(同一个渲染点、同一套判据)──────────
{
  const SID = 'steer-baseline-session';
  const NORMAL_UUID = '09da8bcb-9eba-4592-96fe-c872701a2479';
  write(SID, [
    rec(SID, { type: 'user', uuid: NORMAL_UUID, timestamp: '2026-09-11T06:10:00.000Z', message: { role: 'user', content: OUTBOUND } }),
    rec(SID, { type: 'assistant', uuid: 'as1', timestamp: '2026-09-11T06:10:02.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', id: 'msg_E', content: [{ type: 'text', text: 'ok' }] } }),
  ]);
  writeSidecar(SID, sidecarDoc());
  const { messages } = await getSessionMessages(SID, HASH);
  const normal = messages.find((m) => m.type === 'user');
  assert.equal(normal.steered, undefined, 'A6: 普通消息不打 steered 标记');
  assert.deepEqual(normal.attachments, ATTACHMENTS, 'A6: 普通消息读同一份元数据');
  assert.equal(renderedText(normal), renderedText({ ...normal, steered: true }), 'A6: 并入标记不改变渲染取值口径');
}

// ── A7 前端接线(源码锚点):JSX 进不了 node,这里按去注释后的源码钉住接线不许回退 ──────
// 口径与 check-r114-locks.mjs 一致:先剥注释再断言,写一行注释骗不过锁。
{
  const { readFileSync } = await import('node:fs');
  const { dirname, join: joinPath } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const stripComments = (s) => s
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*\n?/gm, '')
    .replace(/^[ \t]*\/\/[^\n]*\n?/gm, '')
    .replace(/^([^'"`/\n]*?)[ \t]+\/\/[^\n]*$/gm, '$1');
  const app = stripComments(readFileSync(joinPath(ROOT, 'client/src/App.jsx'), 'utf8'));

  // R36:两处消息列表的回退入口都不许带 steered 门(gate 回来 = 并入消息又没有回退)
  assert.ok(app.includes('onRollback={msg.type === \'user\' ? onRollback : undefined}'),
    'A7: 历史消息列表对并入消息同样给回退入口');
  assert.ok(app.includes('onRollback={msg.type === \'user\' ? handleRollback : undefined}'),
    'A7: 实时/本地消息列表同样给回退入口');
  assert.ok(!app.includes('&& !msg.steered ? onRollback'), 'A7: 回退入口不许再被 steered 门掉');
  assert.ok(!app.includes('&& !msg.steered ? handleRollback'), 'A7: 同上(另一处渲染点)');

  // R35:实时并入气泡必须与普通发送同形(附件 + displayText)+ 带解析落盘锚点的回退
  assert.ok(app.includes('attachments: item.opts?.meta?.attachments'), 'A7: 实时并入气泡透传附件元数据');
  assert.ok(app.includes('displayText: item.opts?.meta?.displayText'), 'A7: 实时并入气泡透传 displayText');
  assert.ok(app.includes('}} onRollback={handleSteerRollback} />'), 'A7: 实时并入气泡带回退入口');

  // 实时气泡的回退必须先解析落盘锚点,找不到就如实提示 —— 不许静默 return(点了没反应)
  assert.ok(app.includes("String(m.steerUuid || '').toLowerCase() === want"), 'A7: 锚点解析认 steerUuid(折叠形态)');
  assert.ok(app.includes("String(m.uuid || '').toLowerCase() === want"), 'A7: 锚点解析认记录 uuid(形态 B)');
  assert.ok(app.includes('handleRollbackRef.current?.(anchor, opts)'), 'A7: 解析到锚点才走统一回退链路');
  assert.ok(app.includes('暂时无法回退'), 'A7: 解析不到锚点时给出明确提示,不静默失败');
}

// ── A8 提交闸:关闭常驻空闲进程的那笔写入不许被误判成"会话有新活动" ──────────────
// (R36 回退第一次点击就打在这里:见 server/routes/session-history.js 的 closeWriteAbsorbable
// 注释 —— 真机上带常驻空闲 slot 的会话第一次提交必败 SESSION_CHANGED。)
{
  const { closeWriteAbsorbable } = await import('../../server/routes/session-history.js');
  const prev = '{"a":1}\n{"b":2}\n';
  assert.equal(closeWriteAbsorbable({ prevRaw: prev, freshRaw: prev + '{"bookkeeping":1}\n', idleSlotsClosed: true }), true,
    'A8: 确实关了常驻空闲进程 + 纯追加(收尾记录)→ 吸收');
  assert.equal(closeWriteAbsorbable({ prevRaw: prev, freshRaw: prev + '{"bookkeeping":1}\n', idleSlotsClosed: false }), false,
    'A8: 没关任何常驻进程 → 追加就是第三方新写入,拒绝');
  assert.equal(closeWriteAbsorbable({ prevRaw: prev, freshRaw: '{"x":0}\n' + prev, idleSlotsClosed: true }), false,
    'A8: 不是纯追加(前面插了行)→ 拒绝');
  assert.equal(closeWriteAbsorbable({ prevRaw: prev, freshRaw: prev.slice(0, -2), idleSlotsClosed: true }), false,
    'A8: 内容被截短 → 拒绝');
  assert.equal(closeWriteAbsorbable({ prevRaw: prev, freshRaw: null, idleSlotsClosed: true }), false,
    'A8: 读不到新内容 → 拒绝');
}

rmSync(home, { recursive: true, force: true });
console.log('✓ check-r35-r36-steer-message: 并入消息解析出附件并交给同一渲染 + 回退判据(trim 锚点=记录 uuid)成立');
