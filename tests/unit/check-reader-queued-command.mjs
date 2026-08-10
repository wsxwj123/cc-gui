#!/usr/bin/env node
// R7-1:「⚡ 并入」的引导消息在 GUI 历史里必须看得见。
//
// 实测(CLI 2.1.226 / SDK 0.3.191,streaming-input 模式往忙 slot push 第二条 user 消息):
// CLI 的持久化有【两种形态】,取决于回合里还有没有工具边界 ——
//   形态 A(有工具边界,折叠进同一回合):磁盘上【没有 user 行】,原文只存在于一条
//     attachment{type:'queued_command'},写在折叠位置(紧跟 queue-operation{remove}、
//     在 AI 后续回应之前)。reader 此前跳过所有 attachment → 这条消息在 GUI 里永远不出现
//     (AI 行为变了,对话里却看不到用户说过什么)。
//   形态 B(纯文本回合,排到回合末另起新回合):磁盘上是普通 user 行,uuid = push 时传的
//     command uuid。这一形态本来就正常,本测试钉住"别因为修 A 而把 B 画两遍"。
//
// 下面的 fixture 逐字取自真机转写(会话 f8394304… = 形态 A,58ae9cef… = 形态 B),
// 跑的是真 session-reader,不是构造的示意结构。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HOME 必须在 import session-reader 之前改 —— 它在模块作用域 join(homedir(), ...)。
const home = mkdtempSync(join(tmpdir(), 'cgui-steer-home-'));
process.env.HOME = home;
const HASH = 'test-project-hash';
mkdirSync(join(home, '.claude', 'projects', HASH), { recursive: true });

const STEER_TEXT = '改主意了：只数到15就停，别继续了。请在最终回复里原样写出"我收到了中途插入的消息"。';
const SRC_UUID = '3e56c1cd-83b2-4f60-bc11-856297980c44';
const write = (sid, lines) =>
  writeFileSync(join(home, '.claude', 'projects', HASH, `${sid}.jsonl`), lines.join('\n') + '\n');
const rec = (sid, o) => JSON.stringify({ sessionId: sid, ...o });

const { getSessionMessages } = await import('../../server/services/session-reader.js');

// ── 1. 形态 A:折叠进同一回合,只有 attachment 没有 user 行 ────────────────
{
  const SID = 'steer-fold-session';
  write(SID, [
    rec(SID, { type: 'user', uuid: 'u1', timestamp: '2026-08-09T15:37:10.000Z', message: { role: 'user', content: '数到30' } }),
    rec(SID, { type: 'assistant', uuid: 'as1', timestamp: '2026-08-09T15:37:15.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', id: 'msg_A', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo 1 2 3' } }] } }),
    // ⚡ 那一刻 CLI 记的入队操作(无 uuid、无内容语义,绝不合成消息)
    rec(SID, { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-09T15:37:17.541Z', content: STEER_TEXT }),
    // 工具结果(user 记录但只有 tool_result 块)—— 并进上一回合,不切段
    rec(SID, { type: 'user', uuid: 'u2', timestamp: '2026-08-09T15:37:17.876Z', message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: '1 2 3', is_error: false }] } }),
    // 折叠:CLI 把队列条目移出队列,随即写下 queued_command 附件 = 真实的并入位置
    rec(SID, { type: 'queue-operation', operation: 'remove', timestamp: '2026-08-09T15:37:17.879Z', content: STEER_TEXT }),
    rec(SID, {
      type: 'attachment', uuid: 'fb7d5660-62bc-4a39-897f-7b4608e2a4ac', timestamp: '2026-08-09T15:37:17.541Z',
      parentUuid: '2499528d-3fa6-4b39-bdbc-2fe650f14ccd',
      attachment: { type: 'queued_command', prompt: STEER_TEXT, source_uuid: SRC_UUID, commandMode: 'prompt', timestamp: '2026-08-09T15:37:17.541Z' },
    }),
    rec(SID, { type: 'assistant', uuid: 'as2', timestamp: '2026-08-09T15:37:19.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', id: 'msg_B', content: [{ type: 'text', text: '收到。停在15。' }] } }),
  ]);
  const { messages } = await getSessionMessages(SID, HASH);

  const steered = messages.filter((m) => m.type === 'user' && m.steered);
  assert.equal(steered.length, 1, 'queued_command 必须合成【一条】用户消息(不合成 = 用户说的话在 GUI 里凭空消失)');
  assert.equal(steered[0].text, STEER_TEXT, '正文取 attachment.prompt 原文');
  assert.equal(steered[0].steered, true, 'steered 标记供前端画"已并入"小标 + 关掉回滚/分叉入口');
  assert.equal(steered[0].steerUuid, SRC_UUID, 'source_uuid = ⚡ 时传的 command uuid → 前端据它精确对账');
  assert.equal(steered[0].uuid, 'fb7d5660-62bc-4a39-897f-7b4608e2a4ac', 'uuid 用记录自身的(参与 reader 的 uuid 去重,resume 重放才不双画)');
  assert.equal(steered[0].timestamp, '2026-08-09T15:37:17.541Z');

  // 位置:必须在两个回合【之间】—— 这正是 flushTurn 的作用,也是 Desktop 的呈现
  assert.deepEqual(messages.map((m) => m.type), ['user', 'turn', 'user', 'turn'],
    '折叠点切段 → 「回合A → 引导气泡 → 回合B」,引导消息不许被并进某个回合里');
  assert.equal(messages[1].toolCalls.length, 1, '切段前的回合保留它的工具调用(切开不等于丢内容)');
  assert.equal(messages[1].toolCalls[0].result?.content, '1 2 3', '工具结果照旧并进前一回合');
  assert.deepEqual(messages[3].text, ['收到。停在15。'], '并入之后的回复进新回合容器');

  // queue-operation 一条都不许合成(enqueue/remove 都带 content,合成就是同一句话画两遍)
  assert.equal(messages.filter((m) => m.type === 'user').length, 2, '只有真用户消息 + 合成的引导消息,queue-operation 不产生消息');
}

// ── 2. 形态 B:排到回合末,CLI 自己写了 user 行 → 只能有一条,不许再合成 ──────
{
  const SID = 'steer-drain-session';
  write(SID, [
    rec(SID, { type: 'user', uuid: 'u1', timestamp: '2026-08-09T15:48:00.000Z', message: { role: 'user', content: '数到30' } }),
    rec(SID, { type: 'assistant', uuid: 'as1', timestamp: '2026-08-09T15:48:05.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', id: 'msg_C', content: [{ type: 'text', text: '完成到30' }] } }),
    rec(SID, { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-08-09T15:48:10.064Z' }),
    // 真 user 行,uuid = push 时传的 command uuid,content 是纯字符串(不是数组)
    rec(SID, { type: 'user', uuid: '09da8bcb-9eba-4592-96fe-c872701a2479', timestamp: '2026-08-09T15:48:10.066Z', promptSource: 'sdk', message: { role: 'user', content: STEER_TEXT } }),
    rec(SID, { type: 'assistant', uuid: 'as2', timestamp: '2026-08-09T15:48:12.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', id: 'msg_D', content: [{ type: 'text', text: '我收到了中途插入的消息' }] } }),
  ]);
  const { messages } = await getSessionMessages(SID, HASH);
  const same = messages.filter((m) => m.type === 'user' && m.text === STEER_TEXT);
  assert.equal(same.length, 1, 'dequeue 后跟真 user 行 → 只渲染那一条(给 queue-operation 合成就是双画)');
  assert.equal(same[0].steered, undefined, '真 user 行是普通用户消息,不打 steered 标记');
  assert.equal(same[0].uuid, '09da8bcb-9eba-4592-96fe-c872701a2479', 'uuid = command uuid(前端据它对账形态 B)');
  assert.deepEqual(messages.map((m) => m.type), ['user', 'turn', 'user', 'turn'], '形态 B 的分段行为不受本次改动影响');
}

// ── 3. 空 prompt 不合成(别画空气泡)────────────────────────────────────
{
  const SID = 'steer-empty-session';
  write(SID, [
    rec(SID, { type: 'user', uuid: 'u1', timestamp: '2026-08-09T16:00:00.000Z', message: { role: 'user', content: '你好' } }),
    rec(SID, { type: 'attachment', uuid: 'a-empty', timestamp: '2026-08-09T16:00:01.000Z', attachment: { type: 'queued_command', prompt: '   ', source_uuid: 'x' } }),
    rec(SID, { type: 'attachment', uuid: 'a-none', timestamp: '2026-08-09T16:00:02.000Z', attachment: { type: 'queued_command', source_uuid: 'y' } }),
    rec(SID, { type: 'assistant', uuid: 'as1', timestamp: '2026-08-09T16:00:03.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', id: 'msg_E', content: [{ type: 'text', text: '在' }] } }),
  ]);
  const { messages } = await getSessionMessages(SID, HASH);
  assert.equal(messages.filter((m) => m.steered).length, 0, 'prompt 空/缺失 → 不合成(空气泡比不画更糟)');
  assert.deepEqual(messages.map((m) => m.type), ['user', 'turn'], '空 prompt 也不许白切一刀');
}

// ── 4. 其余 attachment 仍旧跳过(别把 attachment 闸门整个放开)────────────
{
  const SID = 'steer-other-attachment-session';
  write(SID, [
    rec(SID, { type: 'user', uuid: 'u1', timestamp: '2026-08-09T16:10:00.000Z', message: { role: 'user', content: '你好' } }),
    rec(SID, { type: 'attachment', uuid: 'a1', timestamp: '2026-08-09T16:10:01.000Z', attachment: { type: 'hook_success', hookName: 'PostToolUse:Bash', stdout: '{}\n', content: '' } }),
    rec(SID, { type: 'attachment', uuid: 'a2', timestamp: '2026-08-09T16:10:02.000Z', attachment: { type: 'skill_listing', content: 'skills…' } }),
    rec(SID, { type: 'assistant', uuid: 'as1', timestamp: '2026-08-09T16:10:03.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', id: 'msg_F', content: [{ type: 'text', text: '在' }] } }),
  ]);
  const { messages } = await getSessionMessages(SID, HASH);
  assert.deepEqual(messages.map((m) => m.type), ['user', 'turn'], 'hook_success / skill_listing 等仍旧不进消息流,也不切段');
}

rmSync(home, { recursive: true, force: true });
console.log('✓ check-reader-queued-command: 折叠形态合成用户消息 + 位置切段 + 空 prompt/其余 attachment 不误合成');
