#!/usr/bin/env node
// 单测:r148 P5 —— 上下文明细接口不在请求路径上同步整读会话文件。
//
// 现象:GET /api/context/:sessionId 在会话没有活进程时,同步列目录 + readFileSync 整个 jsonl 再逐行解析,
// 只为取工作目录和最后一个模型名。几十 MB 的会话会让事件循环整段停住,这期间所有会话的流式转发跟着停。
//
// 可数的量:处理一次请求期间,① 对这个 jsonl 的同步读调用次数;② 事件循环转了几圈(整段同步 = 0 圈)。
// 返回内容不变:404 / 409 / 400 的判定照旧;取到的工作目录、模型、项目目录名逐项对。
// 全程临时 HOME,不碰真实的 ~/.claude。
// Run: node tests/unit/check-r148-p5-context-async.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r148-p5-'));
process.env.HOME = tmp; process.env.USERPROFILE = tmp;     // 必须在加载路由模块之前
const PROJ = '-tmp-r148-p5-proj';
const projDir = path.join(tmp, '.claude', 'projects', PROJ);
fs.mkdirSync(projDir, { recursive: true });
const MISSING_CWD = path.join(tmp, 'no-such-workdir');     // 工作目录故意不存在 → 接口在起子进程之前就以 400 收场

const line = (o) => `${JSON.stringify(o)}\n`;
const assistant = (model, text = 'x') => ({ type: 'assistant', cwd: MISSING_CWD, message: { role: 'assistant', model, content: [{ type: 'text', text }] } });
function writeSession(sid, lines) { fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), lines.join('')); }

writeSession('r148-small', [
  line({ type: 'summary', summary: '没有 cwd 的行' }),
  '这一行不是 JSON\n',
  line({ type: 'user', cwd: MISSING_CWD, message: { role: 'user', content: 'hi' } }),
  line(assistant('model-first')),
  line({ type: 'user', cwd: '/later/cwd/should/not/win', message: { role: 'user', content: 'again' } }),
  line(assistant('model-last')),
  line(assistant('<synthetic>')),          // 尖括号开头的不是真模型名,不算
  '\n',
]);
writeSession('r148-nomodel', [line({ type: 'user', cwd: MISSING_CWD, message: { role: 'user', content: 'hi' } })]);
// 大文件:约 24MB(每行 ~4KB),模型名只在最后
{
  const pad = 'p'.repeat(4000);
  const fd = fs.openSync(path.join(projDir, 'r148-big.jsonl'), 'w');
  fs.writeSync(fd, line({ type: 'user', cwd: MISSING_CWD, message: { role: 'user', content: 'start' } }));
  const chunk = Array.from({ length: 200 }, (_, i) => line(assistant('model-mid', `${pad}${i}`))).join('');
  for (let i = 0; i < 30; i += 1) fs.writeSync(fd, chunk);
  fs.writeSync(fd, line(assistant('model-big-last')));
  fs.closeSync(fd);
}

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').join('\n      ')}`); }
};

console.log('r148 P5 上下文明细接口不同步整读会话文件');

// 数同步读:包一层 fs.readFileSync,只数对会话 jsonl 的调用(syncBuiltinESMExports 让 `import { readFileSync }` 的模块也看到)
const syncReads = [];
const realReadFileSync = fs.readFileSync;
fs.readFileSync = function patched(p, ...rest) {
  if (typeof p === 'string' && p.startsWith(projDir) && p.endsWith('.jsonl')) syncReads.push(path.basename(p));
  return realReadFileSync.call(this, p, ...rest);
};
syncBuiltinESMExports();

const chat = await import(root + 'server/routes/chat.js');
const router = chat.default;
const layer = router.stack.find((l) => l.route && l.route.path === '/context/:sessionId');
const handler = layer && layer.route.stack[0].handle;

/** 直接调路由处理函数(不起服务、不占端口)。返回 { status, body, loops }:loops = 处理期间事件循环转的圈数。 */
async function call(sessionId, query = {}) {
  const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.finished = true; return this; } };
  let loops = 0; let spinning = true;
  const spin = () => { if (!spinning) return; loops += 1; setImmediate(spin); };
  setImmediate(spin);
  await handler({ params: { sessionId }, query }, res);
  spinning = false;
  return { status: res.statusCode, body: res.body, loops };
}

await check('路由存在且可直接调用', async () => { assert.equal(typeof handler, 'function'); });

await check('处理一次请求,对会话文件的同步整读 = 0 次(原来 1 次)', async () => {
  syncReads.length = 0;
  const r = await call('r148-small');
  assert.equal(r.status, 400); assert.equal(r.body.code, 'context-cwd-invalid');
  assert.deepEqual(syncReads, [], `同步读了:${syncReads.join(', ')}`);
});

await check('24MB 的会话:处理期间事件循环照常在转(原来整段同步,一圈都转不了)', async () => {
  const r = await call('r148-big');
  assert.equal(r.status, 400); assert.equal(r.body.code, 'context-cwd-invalid');
  assert.ok(r.loops >= 10, `处理 24MB 会话期间事件循环只转了 ${r.loops} 圈`);
});

await check('返回内容不变:找不到会话 → 404;项目目录名对不上 → 409;对得上 → 继续往下(这里因工作目录不存在停在 400)', async () => {
  const none = await call('r148-not-exist');
  assert.equal(none.status, 404); assert.equal(none.body.code, 'context-session-not-found');
  const mismatch = await call('r148-small', { projectHash: '-some-other-project' });
  assert.equal(mismatch.status, 409); assert.equal(mismatch.body.code, 'context-session-mismatch');
  const match = await call('r148-small', { projectHash: PROJ });
  assert.equal(match.status, 400); assert.equal(match.body.code, 'context-cwd-invalid');
});

await check('取到的内容逐项不变:工作目录 = 第一条带 cwd 的;模型 = 最后一条真模型名;坏行跳过', async () => {
  assert.equal(typeof chat.readHistoricalContextMeta, 'function', '需要导出 readHistoricalContextMeta 供核对内容');
  const meta = await chat.readHistoricalContextMeta('r148-small');
  assert.deepEqual(meta, { sessionId: 'r148-small', projectHash: PROJ, cwd: MISSING_CWD, model: 'model-last' });
  assert.deepEqual(await chat.readHistoricalContextMeta('r148-nomodel'), { sessionId: 'r148-nomodel', projectHash: PROJ, cwd: MISSING_CWD, model: null });
  assert.deepEqual(await chat.readHistoricalContextMeta('r148-big'), { sessionId: 'r148-big', projectHash: PROJ, cwd: MISSING_CWD, model: 'model-big-last' });
  assert.equal(await chat.readHistoricalContextMeta('r148-not-exist'), null);
});

fs.readFileSync = realReadFileSync; syncBuiltinESMExports();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
