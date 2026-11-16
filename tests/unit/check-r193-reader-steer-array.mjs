#!/usr/bin/env node
// r193:带图并入时,CLI 把并入消息落成 attachment{type:'queued_command'},它的 prompt 是【数组】(文字块 + 图片块,
// 取样 S9)。读历史要读出一条并入的用户消息:文字 = 文字块,steerUuid = source_uuid,消息里不含图片数据;
// 字符串形态不受影响。夹具写法照 check-reader-queued-command.mjs(真 session-reader + 临时 HOME)。
// 运行:node tests/unit/check-r193-reader-steer-array.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// HOME 必须在 import session-reader 之前改 —— 它在模块作用域 join(homedir(), ...)。
const home = mkdtempSync(join(tmpdir(), 'cgui-r193-reader-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const HASH = 'test-project-hash';
mkdirSync(join(home, '.claude', 'projects', HASH), { recursive: true });
const write = (sid, lines) => writeFileSync(join(home, '.claude', 'projects', HASH, `${sid}.jsonl`), lines.join('\n') + '\n');
const rec = (sid, o) => JSON.stringify({ sessionId: sid, ...o });

const { getSessionMessages } = await import('../../server/services/session-reader.js');

const STEER_TEXT = '再看这张\n\n附件:\n@/private/var/folders/xx/T/cgui-attachments/abc123.png';
const SRC_UUID = '7c0d9a1e-5b2f-4c3d-9e8f-0a1b2c3d4e5f';
const IMG_DATA = randomBytes(3000).toString('base64');
const SAMPLE = IMG_DATA.slice(0, 40); // 序列化后的消息里不许出现图片数据

function foldSession(sid, prompt) {
  write(sid, [
    rec(sid, { type: 'user', uuid: 'u1', timestamp: '2026-11-16T10:00:00.000Z', message: { role: 'user', content: '数到30' } }),
    rec(sid, { type: 'assistant', uuid: 'as1', timestamp: '2026-11-16T10:00:05.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', id: 'msg_A', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo 1' } }] } }),
    rec(sid, { type: 'user', uuid: 'u2', parentUuid: 'as1', timestamp: '2026-11-16T10:00:06.000Z', message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: '1', is_error: false }] } }),
    rec(sid, { type: 'queue-operation', operation: 'remove', timestamp: '2026-11-16T10:00:06.100Z', content: prompt }),
    rec(sid, {
      type: 'attachment', uuid: 'att-r193', parentUuid: 'u2', timestamp: '2026-11-16T10:00:06.200Z',
      attachment: { type: 'queued_command', prompt, source_uuid: SRC_UUID, commandMode: 'prompt', timestamp: '2026-11-16T10:00:06.200Z' },
    }),
    rec(sid, { type: 'assistant', uuid: 'as2', parentUuid: 'att-r193', timestamp: '2026-11-16T10:00:08.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-6', id: 'msg_B', content: [{ type: 'text', text: '看到了。' }] } }),
  ]);
}

let passed = 0;
// ── 1. prompt 是数组(一个文字块 + 一个图片块)──────────────────────────
{
  const SID = 'r193-steer-array';
  foldSession(SID, [
    { type: 'text', text: STEER_TEXT },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG_DATA } },
  ]);
  const { messages } = await getSessionMessages(SID, HASH);
  const steered = messages.filter((m) => m.type === 'user' && m.steered);
  assert.equal(steered.length, 1, '数组形态的并入消息读出一条(改动前整条消失)');
  assert.equal(steered[0].text, STEER_TEXT, '文字 = 文字块');
  assert.equal(steered[0].steerUuid, SRC_UUID, 'steerUuid = source_uuid(页面靠它对账)');
  assert.equal(steered[0].uuid, 'att-r193');
  assert.ok(!JSON.stringify(steered[0]).includes(SAMPLE), '消息里不含图片数据');
  assert.ok(!JSON.stringify(messages).includes(SAMPLE), '整份历史里不含图片数据');
  assert.deepEqual(messages.map((m) => m.type), ['user', 'turn', 'user', 'turn'], '折叠点照旧切段');
  passed += 1;
}

// ── 2. 多个文字块按用户行口径用换行拼;只有图片块 → 不合成 ──────────────
{
  const SID = 'r193-steer-array-multi';
  foldSession(SID, [
    { type: 'text', text: '第一段' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG_DATA } },
    { type: 'text', text: '第二段' },
  ]);
  const { messages } = await getSessionMessages(SID, HASH);
  assert.equal(messages.find((m) => m.steered)?.text, '第一段\n第二段');
  passed += 1;

  const SID2 = 'r193-steer-array-imageonly';
  foldSession(SID2, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG_DATA } }, null, 'junk']);
  const r2 = await getSessionMessages(SID2, HASH);
  assert.equal(r2.messages.filter((m) => m.steered).length, 0, '没有文字块 → 不画空气泡');
  passed += 1;
}

// ── 3. 字符串形态不受影响 ──────────────────────────────────────────────
{
  const SID = 'r193-steer-string';
  foldSession(SID, STEER_TEXT);
  const { messages } = await getSessionMessages(SID, HASH);
  const steered = messages.filter((m) => m.type === 'user' && m.steered);
  assert.equal(steered.length, 1);
  assert.equal(steered[0].text, STEER_TEXT);
  assert.equal(steered[0].steerUuid, SRC_UUID);
  passed += 1;
}

rmSync(home, { recursive: true, force: true }); // 只删本测试自建的临时目录
console.log(`✓ check-r193-reader-steer-array: ${passed} passed`);
