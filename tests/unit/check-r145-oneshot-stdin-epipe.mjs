#!/usr/bin/env node
// r145 F9:一次性子进程(会话标题、旁问、上下文摘要)把 prompt 写进 stdin,但 stdin 没挂 'error' 监听;
// CLI 先退出(没装好 / 秒崩 / 被杀)时,剩余数据写进已关闭的管道 → EPIPE 作为 stdin 的 'error' 事件抛出,
// 无人监听 = 未捕获异常(进 crash.log,后端可能整个挂掉)。spawn 失败(!proc.pid)的分支同理要有 error 处理。
// 修好后:这些 stdin 与 !proc.pid 分支都有 error 处理,子进程先退时不产生未捕获异常。
//
// ① 行为(旁问):PATH 前挂一个立刻退出、不读 stdin 的假 claude(纯 sh),旁问带 20 轮 history(约 240KB,
//    远超管道缓冲)→ 写到一半读端已关,必然 EPIPE。测试进程挂 uncaughtException 记账,断言一个都没有。
// ② 源码(标题、上下文摘要):标题 prompt 被截到约 1KB,一次就进了管道缓冲,mac 上触发不了 EPIPE(Windows 管道
//    写是异步的才会);上下文摘要要走完整的 compact-segment 预览(会话文件 + 分段),与这一行监听不成比例 ——
//    这两处只做源码断言:spawn 后、write 前挂了 stdin 的 error 监听;!proc.pid 分支有 error 处理。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateHome, listenInRange, makeChecker } from './r145-helpers/common.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { bin, cleanup } = isolateHome('f9');
writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
chmodSync(join(bin, 'claude'), 0o755);

const uncaught = [];
process.on('uncaughtException', (e) => { uncaught.push(`${e?.code || ''} ${e?.message || e}`.trim()); });

const chatRouter = (await import('../../server/routes/chat.js')).default;
const express = (await import('express')).default;
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api', chatRouter);
const httpServer = createServer(app);
const port = await listenInRange(httpServer);

const history = Array.from({ length: 20 }, (_, i) => ({ q: `q${i} ${'问'.repeat(3990)}`, a: `a${i} ${'答'.repeat(7990)}` }));
const btwOnce = async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/chat/btw`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'q', history }),
  });
  await r.text();
  return r.status;
};

// 取一段处理器源码:从 startMarker 起,到 endMarker(不含)为止。
const sliceBetween = (src, startMarker, endMarker) => {
  const s = src.indexOf(startMarker);
  assert.ok(s >= 0, `找不到 ${startMarker}`);
  const e = src.indexOf(endMarker, s + startMarker.length);
  return src.slice(s, e > s ? e : undefined);
};
const STDIN_ERR = /\.stdin\??\.(?:on|once)\(\s*['"]error['"]/;
function assertStdinGuarded(body, label) {
  const m = STDIN_ERR.exec(body);
  assert.ok(m, `${label}:stdin 没有 'error' 监听`);
  const w = body.indexOf('proc.stdin.write(');
  assert.ok(w > 0, `${label}:找不到 proc.stdin.write(`);
  assert.ok(m.index < w, `${label}:stdin 的 error 监听挂在 write 之后(write 同步失败时来不及)`);
}
function assertNoPidGuarded(body, label) {
  const i = body.indexOf('if (!proc.pid)');
  assert.ok(i > 0, `${label}:找不到 if (!proc.pid) 分支`);
  const line = body.slice(i, body.indexOf('\n', i));
  const before = body.slice(0, i);
  assert.ok(/\.(?:on|once)\(\s*['"]error['"]/.test(line) || /proc\.(?:on|once)\(\s*['"]error['"]/.test(before),
    `${label}:spawn 失败(!proc.pid)分支没有 error 处理 —— 子进程的 'error' 事件(ENOENT 等)会成未捕获异常`);
}

const { check, finish } = makeChecker('check-r145-oneshot-stdin-epipe');
let exitCode = 1;
try {
  console.log('F9 · 行为:旁问的 CLI 秒退、prompt 写不完 → 不产生未捕获异常');
  await check('3 次旁问(各约 240KB stdin,假 claude 立即退出)后 uncaughtException 为 0', async () => {
    for (let i = 0; i < 3; i++) await btwOnce();
    await new Promise((r) => setTimeout(r, 300)); // EPIPE 是异步 'error' 事件,等它冒出来
    assert.deepEqual(uncaught, [], `出现未捕获异常:${uncaught.slice(0, 3).join(' | ')}`);
  });

  console.log('F9 · 源码:标题 / 旁问 / 上下文摘要');
  const chatSrc = readFileSync(join(root, 'server', 'routes', 'chat.js'), 'utf8');
  const histSrc = readFileSync(join(root, 'server', 'routes', 'session-history.js'), 'utf8');
  const title = sliceBetween(chatSrc, "router.post('/chat/title'", "\nrouter.");
  const btwBody = sliceBetween(chatSrc, "router.post('/chat/btw'", "\nrouter.");
  const summary = sliceBetween(histSrc, 'function generateSegmentSummary(', '\n}\n');
  await check('标题:stdin 挂了 error 监听(在 write 之前)', () => assertStdinGuarded(title, '/chat/title'));
  await check('标题:!proc.pid 分支有 error 处理', () => assertNoPidGuarded(title, '/chat/title'));
  await check('旁问:stdin 挂了 error 监听(在 write 之前)', () => assertStdinGuarded(btwBody, '/chat/btw'));
  await check('旁问:!proc.pid 分支有 error 处理', () => assertNoPidGuarded(btwBody, '/chat/btw'));
  await check('上下文摘要:stdin 挂了 error 监听(在 write 之前)', () => assertStdinGuarded(summary, 'generateSegmentSummary'));
  await check('上下文摘要:!proc.pid 分支有 error 处理', () => assertNoPidGuarded(summary, 'generateSegmentSummary'));
  exitCode = finish();
} finally {
  cleanup();
}
process.exit(exitCode);
