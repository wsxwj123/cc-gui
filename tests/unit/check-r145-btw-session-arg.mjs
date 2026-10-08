#!/usr/bin/env node
// r145 F8:旁问(POST /chat/btw)把请求体里的 sessionId 不校验形态就作为独立 argv 放进 `--resume <sid>`。
// 传 `--tools=default` 之类以 - 开头的串,CLI 会把它当成选项解析 —— 旁问的"零工具"四件套被绕开。
// 修好后:非会话 id 形态(字符集与 /context 的 CONTEXT_SESSION_RE 同口径)一律 400,不起进程;
// 合法 id 与空 sessionId(草稿,无 --resume)照常起。
// PATH 前挂假 claude:把 argv 记进日志后立即退出。"起没起进程"只认带旁问特征(--strict-mcp-config)的调用,
// 不被 chat.js 模块级的 --help 预热之类干扰。express 挂 chat 路由,端口 6700–6999,临时 HOME。
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { isolateHome, writeFakeCommand, listenInRange, makeChecker } from './r145-helpers/common.mjs';

const { home, bin, cleanup } = isolateHome('f8');
const LOG = join(home, 'fake-claude.log');
writeFakeCommand(bin, 'claude', `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`);
const btwCalls = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  .filter((a) => a.includes('--strict-mcp-config'));

const chatRouter = (await import('../../server/routes/chat.js')).default;
const express = (await import('express')).default;
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api', chatRouter);
const httpServer = createServer(app);
const port = await listenInRange(httpServer);
const btw = async (body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/chat/btw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
};

const { check, finish } = makeChecker('check-r145-btw-session-arg');
let exitCode = 1;
try {
  console.log('F8 · 非会话 id 形态的 sessionId → 400,不起进程');
  for (const bad of ['--tools=default', '--tools', '-p', 'a b', 'x;y&z', '../../etc', 'a'.repeat(129)]) {
    await check(`sessionId ${JSON.stringify(bad.length > 20 ? `${bad.slice(0, 8)}…(${bad.length})` : bad)} → 400`, async () => {
      const before = btwCalls().length;
      const r = await btw({ question: 'q', sessionId: bad });
      assert.equal(r.status, 400, `应 400,实际 ${r.status} ${r.text.slice(0, 160)}`);
      await new Promise((res) => setTimeout(res, 150)); // 给"万一起了进程"留出写日志的时间
      assert.equal(btwCalls().length, before, '仍然起了 claude 进程');
    });
  }

  console.log('F8 · 不误伤');
  await check('合法会话 id(UUID)照常起进程,argv 里 --resume 后紧跟该 id', async () => {
    const sid = '0f3c9a2e-5b7d-4e1f-9a6b-2c8d4e6f8a10';
    const before = btwCalls().length;
    const r = await btw({ question: 'q', sessionId: sid });
    assert.notEqual(r.status, 400, r.text.slice(0, 160));
    const calls = btwCalls().slice(before);
    assert.equal(calls.length, 1, `应起 1 次,实际 ${calls.length}`);
    assert.equal(calls[0][calls[0].indexOf('--resume') + 1], sid);
  });
  await check('空 sessionId(草稿会话)照常起进程,且没有 --resume', async () => {
    const before = btwCalls().length;
    const r = await btw({ question: 'q' });
    assert.notEqual(r.status, 400, r.text.slice(0, 160));
    const calls = btwCalls().slice(before);
    assert.equal(calls.length, 1, `应起 1 次,实际 ${calls.length}`);
    assert.ok(!calls[0].includes('--resume'));
  });
  exitCode = finish();
} finally {
  cleanup();
}
process.exit(exitCode);
