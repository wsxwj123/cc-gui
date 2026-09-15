#!/usr/bin/env node
// R10:CLI 的 task-notification 不得冒充用户消息(历史上的"你 / 已并入"气泡),也不许被
// 整条吞掉(用户看不到后台任务回了什么)。
//
// 真机转写实测的两种落盘形态(会话字段原文见 .devflow/RESEARCH-20260910-attachments-notifications.md):
//   普通 user 记录   : origin.kind='task-notification' + queueSkipAttachments:true
//   attachment/queued_command: commandMode='task-notification',无 source_uuid
// 协议自报字段是判据;文本形态(整段一封完整 <task-notification> 信封)只用于"来源未确认"
// 的兜底,绝不"包含标签就吞",也绝不因"缺 source_uuid"就吞。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cgui-r10-notice-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const HASH = 'test-project-hash';
mkdirSync(join(home, '.claude', 'projects', HASH), { recursive: true });

const write = (sid, lines) =>
  writeFileSync(join(home, '.claude', 'projects', HASH, `${sid}.jsonl`), lines.join('\n') + '\n');
const rec = (sid, o) => JSON.stringify({ sessionId: sid, cwd: '/tmp', ...o });
const ENVELOPE = (status, id) => [
  '<task-notification>',
  `<task-id>${id}</task-id>`,
  `<tool-use-id>toolu_${id}</tool-use-id>`,
  `<output-file>/tmp/${id}.out</output-file>`,
  `<status>${status}</status>`,
  `<summary>FB_TASK_SUMMARY_${id}</summary>`,
  '</task-notification>',
].join('\n');
const HUMAN = (sid, uuid, text, extra = {}) => rec(sid, {
  type: 'user', uuid, timestamp: '2026-09-10T10:00:00.000Z',
  message: { role: 'user', content: text }, ...extra,
});
const TURN = (sid, uuid, text) => rec(sid, {
  type: 'assistant', uuid, timestamp: '2026-09-10T10:00:05.000Z',
  message: { role: 'assistant', model: 'claude-sonnet-4-6', id: `msg_${uuid}`, content: [{ type: 'text', text }] },
});

const { getSessionMessages } = await import('../../server/services/session-reader.js');
const humanTexts = (messages) => messages.filter((m) => m.type === 'user').map((m) => m.text);

// ── 1. 普通 user 形态:不显示为"你",但不许整条消失 ─────────────────────────
{
  const SID = 'r10-user-form';
  const BODY = ENVELOPE('completed', 'fb1');
  write(SID, [
    HUMAN(SID, 'u1', '起一个后台任务'),
    TURN(SID, 'a1', '已启动'),
    rec(SID, {
      type: 'user', uuid: 'n1', timestamp: '2026-09-10T10:01:00.000Z', promptSource: 'sdk',
      origin: { kind: 'task-notification' }, queueSkipAttachments: true,
      message: { role: 'user', content: BODY },
    }),
    TURN(SID, 'a2', '后台任务完成,继续'),
  ]);
  const { messages } = await getSessionMessages(SID, HASH);
  assert.deepEqual(humanTexts(messages), ['起一个后台任务'], '通知不得成为用户气泡(前端"你")');
  const notices = messages.filter((m) => m.type === 'task-notice');
  assert.equal(notices.length, 1, '通知要在消息流里保留一行(不能整条吞掉)');
  assert.equal(notices[0].text, BODY, '原文逐字保留(不截断)');
  assert.equal(notices[0].confirmed, true, '协议字段 origin.kind=task-notification → 已确认');
  assert.equal(notices[0].status, 'completed', '信封里的 status 透给 UI');
  assert.equal(notices[0].taskId, 'fb1');
  assert.equal(notices[0].uuid, 'n1', '身份用记录自身 uuid(黑盒对账)');
  assert.deepEqual(messages.map((m) => m.type), ['user', 'turn', 'task-notice', 'turn'],
    '通知插在真实位置;切的是 AI 回合,不制造空人工回合');
  assert.deepEqual(messages[3].text, ['后台任务完成,继续'], '通知之后的回复进新回合容器');
}

// ── 2. queued_command 形态:不显示为"已并入" ────────────────────────────────
{
  const SID = 'r10-queued-form';
  const BODY = ENVELOPE('failed', 'fb2');
  write(SID, [
    HUMAN(SID, 'u1', '起一个后台任务'),
    TURN(SID, 'a1', '已启动'),
    rec(SID, { type: 'queue-operation', operation: 'remove', timestamp: '2026-09-10T10:01:00.000Z' }),
    rec(SID, {
      type: 'attachment', uuid: 'n2', timestamp: '2026-09-10T10:01:00.000Z',
      attachment: { type: 'queued_command', prompt: BODY, commandMode: 'task-notification', timestamp: '2026-09-10T10:01:00.000Z' },
    }),
    TURN(SID, 'a2', '任务失败了'),
  ]);
  const { messages } = await getSessionMessages(SID, HASH);
  assert.equal(messages.filter((m) => m.steered).length, 0, 'queued_command 通知不得合成 steered 用户消息(前端"已并入")');
  assert.deepEqual(humanTexts(messages), ['起一个后台任务']);
  const notices = messages.filter((m) => m.type === 'task-notice');
  assert.equal(notices.length, 1, '折叠形态同样要保留一行');
  assert.equal(notices[0].text, BODY);
  assert.equal(notices[0].confirmed, true);
  assert.equal(notices[0].status, 'failed');
  assert.deepEqual(messages.map((m) => m.type), ['user', 'turn', 'task-notice', 'turn']);
}

// ── 3. 人造内容不许误吞 ────────────────────────────────────────────────────
{
  const SID = 'r10-human';
  const ENV_TEXT = ENVELOPE('killed', 'fb3');
  const DISCUSS = '我在讨论 <task-notification> 这个标签该怎么显示,顺便贴一段: </task-notification>';
  write(SID, [
    HUMAN(SID, 'u1', DISCUSS, { origin: { kind: 'human' } }),
    TURN(SID, 'a1', '好的'),
    HUMAN(SID, 'u2', `我手工粘一份完整信封给你看:\n${ENV_TEXT}`, { origin: { kind: 'human' } }),
    TURN(SID, 'a2', '收到'),
    HUMAN(SID, 'u3', '没有 origin 字段的普通消息(旧 CLI 人工输入),正文里带 <task-notification> 字样', {}),
    TURN(SID, 'a3', '嗯'),
    rec(SID, {
      type: 'attachment', uuid: 's1', timestamp: '2026-09-10T10:02:00.000Z',
      attachment: { type: 'queued_command', prompt: ENV_TEXT, source_uuid: 'src-1', commandMode: 'prompt', timestamp: '2026-09-10T10:02:00.000Z' },
    }),
    // 旧 CLI 的人工并入:没有 commandMode/source_uuid 的老记录也不能因"缺 source_uuid"被吞
    rec(SID, {
      type: 'attachment', uuid: 's2', timestamp: '2026-09-10T10:02:30.000Z',
      attachment: { type: 'queued_command', prompt: '老的并入消息(无 source_uuid)', timestamp: '2026-09-10T10:02:30.000Z' },
    }),
    TURN(SID, 'a4', '结束'),
  ]);
  const { messages } = await getSessionMessages(SID, HASH);
  assert.equal(messages.filter((m) => m.type === 'task-notice').length, 0, '有人工来源的消息一律不进通知投影');
  const texts = humanTexts(messages);
  assert.equal(texts.length, 5, `人工消息一条不丢(实得 ${texts.length} 条)`);
  assert.equal(texts[1], `我手工粘一份完整信封给你看:\n${ENV_TEXT}`, '人工粘贴的完整信封逐字保留');
  const steered = messages.filter((m) => m.steered);
  assert.equal(steered.length, 2, '人工并入(prompt+source_uuid / 老无字段)照旧合成引导气泡');
  assert.equal(steered[0].steerUuid, 'src-1');
}

// ── 4. 来源不可确认的旧通知:保留 + 标来源未确认(不静默丢) ──────────────────
{
  const SID = 'r10-unknown-origin';
  const BODY = ENVELOPE('killed', 'fb4');
  write(SID, [
    HUMAN(SID, 'u1', '你好'),
    rec(SID, { type: 'user', uuid: 'n3', timestamp: '2026-09-10T10:03:00.000Z', message: { role: 'user', content: BODY } }),
    TURN(SID, 'a1', '结束'),
  ]);
  const { messages } = await getSessionMessages(SID, HASH);
  assert.deepEqual(humanTexts(messages), ['你好'], '没有协议字段的完整信封不当成用户气泡');
  const notices = messages.filter((m) => m.type === 'task-notice');
  assert.equal(notices.length, 1, '内容必须保留(不能静默丢用户内容)');
  assert.equal(notices[0].confirmed, false, 'confirmed:false = 前端显示"来源未确认"');
  assert.equal(notices[0].text, BODY);
  assert.equal(notices[0].status, 'killed', 'status 照样透给 UI');
}

// ── 5. 边角:空 prompt / 其余 attachment / 通知同一回合里的多个 ───────────────
{
  const SID = 'r10-edges';
  write(SID, [
    HUMAN(SID, 'u1', '你好'),
    rec(SID, {
      type: 'attachment', uuid: 'e1', timestamp: '2026-09-10T10:04:00.000Z',
      attachment: { type: 'queued_command', prompt: '   ', commandMode: 'task-notification' },
    }),
    rec(SID, { type: 'attachment', uuid: 'e2', timestamp: '2026-09-10T10:04:01.000Z', attachment: { type: 'skill_listing', content: 'skills…' } }),
    TURN(SID, 'a1', '在'),
  ]);
  const { messages } = await getSessionMessages(SID, HASH);
  assert.deepEqual(messages.map((m) => m.type), ['user', 'turn'], '空 prompt 不造空气泡,其余 attachment 照旧跳过');
}

rmSync(home, { recursive: true, force: true });
console.log('✓ check-reader-task-notification: 两种通知形态不冒充用户/并入气泡但内容保留;人工 XML 不误吞;来源未确认保留');
