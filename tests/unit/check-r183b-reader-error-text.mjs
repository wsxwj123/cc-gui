#!/usr/bin/env node
// r183b:后端读会话记录时,命令行的合成报错消息(isApiErrorMessage === true)拆出来的文字块
// 带 errorText: true;普通助手记录的文字块不带。一条合成消息含两个文字块时两块都带。
// 行为断言:读一个临时会话文件,看 getSessionMessages 返回的块。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cgui-r183b-reader-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const HASH = 'test-project-hash';
mkdirSync(join(home, '.claude', 'projects', HASH), { recursive: true });

const write = (sid, lines) =>
  writeFileSync(join(home, '.claude', 'projects', HASH, `${sid}.jsonl`), lines.join('\n') + '\n');
const rec = (sid, o) => JSON.stringify({ sessionId: sid, cwd: '/tmp', ...o });
const HUMAN = (sid, uuid, text) => rec(sid, {
  type: 'user', uuid, timestamp: '2026-11-14T10:00:00.000Z',
  message: { role: 'user', content: text },
});
const TURN = (sid, uuid, content, extra = {}) => rec(sid, {
  type: 'assistant', uuid, timestamp: '2026-11-14T10:00:05.000Z',
  message: { role: 'assistant', model: extra.model || 'claude-sonnet-4-6', id: `msg_${uuid}`, content },
  ...extra.top,
});

const { getSessionMessages } = await import('../../server/services/session-reader.js');
let pass = 0;
const ok = (name) => { pass += 1; console.log(`  ok  ${name}`); };
const textBlocks = (messages) => messages.filter((m) => m.type === 'turn').flatMap((m) => m.blocks || []).filter((b) => b.type === 'text');

try {
  // 1. 普通回合 + 合成报错消息(两块)
  {
    const SID = 'r183b-two-blocks';
    write(SID, [
      HUMAN(SID, 'u1', '第一问'),
      TURN(SID, 'a1', [{ type: 'text', text: '正常 **回复**' }]),
      HUMAN(SID, 'u2', '第二问'),
      TURN(SID, 'a2', [
        { type: 'text', text: 'API Error: 400 第一块 ![图](http://x/two.png)' },
        { type: 'text', text: '第二块 [点这里充值](http://x/pay)' },
      ], { model: '<synthetic>', top: { isApiErrorMessage: true, error: 'unknown', apiErrorStatus: 400 } }),
    ]);
    const { messages } = await getSessionMessages(SID, HASH);
    const blocks = textBlocks(messages);
    const normal = blocks.find((b) => b.content === '正常 **回复**');
    assert.ok(normal, '普通文字块在');
    assert.equal('errorText' in normal, false, '普通记录的文字块不带 errorText');
    assert.deepEqual(Object.keys(normal).sort(), ['content', 'type'], '普通块结构不变');
    ok('普通记录的文字块不带标记、结构不变');
    const e1 = blocks.find((b) => b.content.startsWith('API Error: 400 第一块'));
    const e2 = blocks.find((b) => b.content.startsWith('第二块'));
    assert.equal(e1?.errorText, true, '合成报错消息第一块带 errorText');
    assert.equal(e2?.errorText, true, '合成报错消息第二块带 errorText');
    ok('合成报错消息的两个文字块都带 errorText');
    const errTurn = messages.find((m) => m.type === 'turn' && m.apiError);
    assert.ok(errTurn, '回合上的 apiError 标记照旧');
    assert.equal(errTurn.apiError.status, 400);
    ok('回合上的 apiError 标记照旧');
  }

  // 2. 子代理记录文件:合成报错消息的文字块带标记(子代理视图读的就是这些块平铺)
  {
    const SID = 'r183b-sidechain';
    write(SID, [
      rec(SID, { type: 'user', uuid: 's1', isSidechain: true, agentId: 'agt1', timestamp: '2026-11-14T10:00:00.000Z', message: { role: 'user', content: '子代理提示' } }),
      TURN(SID, 's2', [{ type: 'text', text: 'API Error: 400 余额不足 **粗体**' }],
        { model: '<synthetic>', top: { isSidechain: true, agentId: 'agt1', isApiErrorMessage: true, error: 'unknown', apiErrorStatus: 400 } }),
    ]);
    const { messages } = await getSessionMessages(SID, HASH);
    const blocks = textBlocks(messages);
    const e = blocks.find((b) => b.content.includes('余额不足'));
    assert.equal(e?.errorText, true, '子代理记录里的合成报错块带 errorText');
    ok('子代理记录里的合成报错块带 errorText');
  }

  // 3. isApiErrorMessage 不是严格 true(字符串)→ 不打标
  {
    const SID = 'r183b-not-strict';
    write(SID, [
      HUMAN(SID, 'u1', '问'),
      TURN(SID, 'a1', [{ type: 'text', text: '看起来像 API Error: 400' }], { top: { isApiErrorMessage: 'true' } }),
      HUMAN(SID, 'u2', '再问'),
    ]);
    const { messages } = await getSessionMessages(SID, HASH);
    const b = textBlocks(messages).find((x) => x.content.includes('看起来像'));
    assert.ok(b);
    assert.equal('errorText' in b, false, '只认严格 true');
    ok('只认 isApiErrorMessage === true');
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log(`r183b reader: ${pass} passed`);
