#!/usr/bin/env node
// r176:读会话文件时,命令行写下的接口报错消息(isApiErrorMessage)要把标记带到历史回合上
// (apiError: { status, kind });普通助手行不带。<synthetic> 不计入回合模型的口径不变。
// 只读临时家目录,不碰真实 ~/.claude。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cgui-r176-'));
process.env.HOME = home;
const projectHash = '-tmp-r176-ws';
const projDir = join(home, '.claude', 'projects', projectHash);
mkdirSync(projDir, { recursive: true });

const { getSessionMessages } = await import('../../server/services/session-reader.js');

const base = (sid) => ({ sessionId: sid, cwd: '/tmp/r176-ws', isSidechain: false, version: '2.1.322' });
const userLine = (sid, uuid, parentUuid, text, ts) => ({
  ...base(sid), type: 'user', uuid, parentUuid, timestamp: ts,
  message: { role: 'user', content: text },
});
const assistantLine = (sid, uuid, parentUuid, text, ts, model = 'deepseek-flash', extra = {}) => ({
  ...base(sid), type: 'assistant', uuid, parentUuid, timestamp: ts,
  message: { role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  ...extra,
});
const write = (sid, rows) => writeFileSync(join(projDir, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const turnsOf = (res) => (res.messages || []).filter((m) => m.type === 'turn');

let passed = 0;
try {
  // 1. 有 isApiErrorMessage 的合成消息 → 回合带 apiError;model 不被 <synthetic> 污染
  {
    const sid = '11111111-1111-4111-8111-111111111111';
    const errText = 'Failed to authenticate. API Error: 401 Authentication Fails, Your api key: ****0000 is invalid';
    write(sid, [
      userLine(sid, 'u1', null, 'R176AUTH 你好', '2026-11-12T00:00:00.000Z'),
      assistantLine(sid, 'a1', 'u1', errText, '2026-11-12T00:00:01.000Z', '<synthetic>', {
        isApiErrorMessage: true, error: 'authentication_failed', apiErrorStatus: 401,
      }),
    ]);
    const res = await getSessionMessages(sid, projectHash);
    const turns = turnsOf(res);
    assert.equal(turns.length, 1, '一个回合');
    assert.deepEqual(turns[0].apiError, { status: 401, kind: 'authentication_failed' }, '回合带出接口报错标记');
    assert.deepEqual(turns[0].text, [errText], '报错原文原样在回合正文里');
    passed++;
  }

  // 2. 普通助手行(即使正文含 401 / api key)不带 apiError
  {
    const sid = '22222222-2222-4222-8222-222222222222';
    write(sid, [
      userLine(sid, 'u1', null, '解释 401', '2026-11-12T00:00:00.000Z'),
      assistantLine(sid, 'a1', 'u1', 'HTTP 401 表示 api key 无效', '2026-11-12T00:00:01.000Z'),
    ]);
    const res = await getSessionMessages(sid, projectHash);
    const turns = turnsOf(res);
    assert.equal(turns.length, 1);
    assert.equal('apiError' in turns[0], false, '普通助手回合没有 apiError 字段');
    assert.equal(turns[0].model, 'deepseek-flash');
    passed++;
  }

  // 3. 400 / unknown 类别:状态码与类别原样带出
  {
    const sid = '33333333-3333-4333-8333-333333333333';
    write(sid, [
      userLine(sid, 'u1', null, 'R176RISK 你好', '2026-11-12T00:00:00.000Z'),
      assistantLine(sid, 'a1', 'u1', 'API Error: 400 Content Exists Risk', '2026-11-12T00:00:01.000Z', '<synthetic>', {
        isApiErrorMessage: true, error: 'unknown', apiErrorStatus: 400,
      }),
    ]);
    const turns = turnsOf(await getSessionMessages(sid, projectHash));
    assert.deepEqual(turns[0].apiError, { status: 400, kind: 'unknown' });
    passed++;
  }

  // 4. 同一回合报错后又来了正常助手内容 → 标记作废
  {
    const sid = '44444444-4444-4444-8444-444444444444';
    write(sid, [
      userLine(sid, 'u1', null, '你好', '2026-11-12T00:00:00.000Z'),
      assistantLine(sid, 'a1', 'u1', 'API Error: 500 overloaded', '2026-11-12T00:00:01.000Z', '<synthetic>', {
        isApiErrorMessage: true, error: 'server_error', apiErrorStatus: 500,
      }),
      assistantLine(sid, 'a2', 'a1', '好的', '2026-11-12T00:00:02.000Z'),
    ]);
    const turns = turnsOf(await getSessionMessages(sid, projectHash));
    assert.equal(turns.length, 1);
    assert.equal('apiError' in turns[0], false, '后来成功的回合不再带报错标记');
    passed++;
  }
  console.log(`check-r176-session-api-error: ${passed}/4 passed`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
