// r29 取证链路单测:Windows 公开版"用一段时间整个窗口消失"的最小取证。
// 覆盖:①crash.log 写入形态 ②client-log 路由(限流/截断/落盘) ③日志滚动
// ④NUL watcher error 监听哨兵 ⑤Rust 监护线程源码哨兵。
// 纪律:全部样本落 /tmp(mkdtemp),绝不读写真实 ~/.claude-gui;端口取 OS 临时口(listen(0),真实端口从 server.address() 读回),跑完关干净。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import {
  createClientLogRouter, writeCrashLog, rotateLogIfBig, appendJsonLine,
} from '../../server/routes/client-log.js';

const tmp = mkdtempSync(join(tmpdir(), 'cgui-r29-'));

// t1 crash.log 写入形态:一行 JSON,时间戳/类型/stack,stack 截 2KB
{
  const err = new Error('boom-' + 'x'.repeat(5000));
  assert.ok(writeCrashLog('uncaughtException', err, tmp), 't1: 写入应成功');
  const lines = readFileSync(join(tmp, 'crash.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 't1: 一行一条');
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.type, 'uncaughtException', 't1: type 字段');
  assert.ok(Number.isFinite(rec.ts) && rec.ts > 0, 't1: unix 毫秒时间戳');
  assert.ok(typeof rec.iso === 'string' && rec.iso.includes('T'), 't1: 人读 ISO 时间戳');
  assert.ok(rec.stack.includes('boom-'), 't1: stack 落盘');
  assert.ok(rec.stack.length <= 2048, `t1: stack 截 2KB(实际 ${rec.stack.length})`);
  // 非 Error 的 rejection reason(字符串/对象)也要能落
  assert.ok(writeCrashLog('unhandledRejection', 'plain string reason', tmp), 't1: 字符串 reason');
  const rec2 = JSON.parse(readFileSync(join(tmp, 'crash.log'), 'utf8').trim().split('\n')[1]);
  assert.equal(rec2.type, 'unhandledRejection', 't1: 第二种 type');
  assert.equal(rec2.stack, 'plain string reason', 't1: 字符串 reason 原样落');
}

// t2 client-log 路由:落盘 / 同消息 5s 限流 / body 截断 2KB / 缺 message 400
{
  const app = express();
  app.use(express.json());
  app.use('/api', createClientLogRouter(tmp));
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const post = (body) => fetch(`http://127.0.0.1:${srv.address().port}/api/client-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));

    const r1 = await post({ kind: 'error', message: 'msg-a', stack: 'stack-a', url: 'http://x/' });
    assert.equal(r1.status, 200, 't2: 首条 200');
    assert.equal(r1.body.ok, true, 't2: 首条 ok');

    const r2 = await post({ kind: 'error', message: 'msg-a', stack: 'stack-a2' });
    assert.equal(r2.body.throttled, true, 't2: 5s 内同消息被限流');

    const big = 'm'.repeat(3000);
    const bigStack = 's'.repeat(9000);
    const r3 = await post({ kind: 'unhandledrejection', message: big, stack: bigStack });
    assert.equal(r3.body.ok, true, 't2: 不同消息不受 msg-a 限流影响');

    const r4 = await post({ kind: 'error' });
    assert.equal(r4.status, 400, 't2: 缺 message 400');

    const lines = readFileSync(join(tmp, 'client.log'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 't2: 限流只放行 2 条(msg-a + big),400 不落盘');
    const e1 = JSON.parse(lines[0]);
    assert.equal(e1.kind, 'error', 't2: kind 落盘');
    assert.equal(e1.message, 'msg-a', 't2: message 落盘');
    assert.equal(e1.url, 'http://x/', 't2: url 落盘');
    assert.ok(Number.isFinite(e1.ts) && e1.iso, 't2: 双时间戳');
    const e2 = JSON.parse(lines[1]);
    assert.equal(e2.message.length, 2048, 't2: message 截 2KB');
    assert.equal(e2.stack.length, 2048, 't2: stack 截 2KB');
    assert.equal(e2.kind, 'unhandledrejection', 't2: 第二条 kind');
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
}

// t3 日志滚动:超 5MB 改名 .old 再开新;小文件不动;不存在不炸
{
  const big = join(tmp, 'big.log');
  writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
  assert.ok(rotateLogIfBig(big), 't3: 超 5MB 应滚动');
  assert.ok(!existsSync(big), 't3: 原文件已改名(下次写入开新)');
  assert.equal(statSync(big + '.old').size, 5 * 1024 * 1024 + 1, 't3: .old 保留原内容');

  const small = join(tmp, 'small.log');
  writeFileSync(small, 'hello\n');
  assert.equal(rotateLogIfBig(small), false, 't3: 小文件不滚');
  assert.equal(readFileSync(small, 'utf8'), 'hello\n', 't3: 小文件内容不动');

  assert.equal(rotateLogIfBig(join(tmp, 'nonexistent.log')), false, 't3: 不存在不炸');

  // appendJsonLine 原语:目录不存在自动建
  assert.ok(appendJsonLine(join(tmp, 'sub', 'x.log'), { a: 1 }), 't3: 自动建目录');
  assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'sub', 'x.log'), 'utf8').trim()), { a: 1 }, 't3: 单行 JSON');
}

// t4 NUL watcher 哨兵:startWinNulWatcher 函数体内必须有 error 监听(静默关闭)
{
  const src = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  const start = src.indexOf('function startWinNulWatcher');
  const end = src.indexOf('\nfunction ', start + 1);
  assert.ok(start > 0 && end > start, 't4: 定位 startWinNulWatcher 函数体');
  const body = src.slice(start, end);
  assert.match(body, /\.on\('error'/, "t4: watcher 必须挂 error 监听(否则 cwd 被删时 throw 成 uncaughtException 淹 crash.log)");
  assert.match(body, /w\.close\(\)/, 't4: error 时静默关闭 watcher');
}

// t5 Rust 监护哨兵:try_wait + 5s 间隔 + 退出落 tauri-startup.log + server.log 滚动
{
  const src = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(src, /try_wait/, 't5: 监护必须 try_wait(非阻塞探活)');
  assert.match(src, /Duration::from_secs\(5\)/, 't5: 5s 间隔');
  // 监护块:try_wait 命中退出后必须 log_startup(写 tauri-startup.log)+ eprintln
  const wi = src.indexOf('try_wait');
  const around = src.slice(Math.max(0, wi - 800), wi + 1200);
  assert.match(around, /log_startup/, 't5: 退出写入 tauri-startup.log');
  assert.match(around, /eprintln!/, 't5: 退出同时 eprintln');
  assert.match(around, /exited/, 't5: 退出事件有明确措辞');
  // server.log 滚动(spawn 前超 5MB 改名 .old)
  assert.match(src, /server\.log\.old/, 't5: server.log 超 5MB 滚动成 .old');
  assert.match(src, /5 \* 1024 \* 1024/, 't5: 滚动阈值 5MB');
}

// t6 index.js / main.jsx 接线哨兵
{
  const idx = readFileSync(new URL('../../server/index.js', import.meta.url), 'utf8');
  // 两个全局 handler 都落 crash.log
  const ue = idx.slice(idx.indexOf("process.on('uncaughtException'"));
  assert.match(ue, /writeCrashLog\('uncaughtException'/, 't6: uncaughtException 落 crash.log');
  const ur = idx.slice(idx.indexOf("process.on('unhandledRejection'"));
  assert.match(ur, /writeCrashLog\('unhandledRejection'/, 't6: unhandledRejection 落 crash.log');
  // 启动滚动 crash.log/client.log
  assert.match(idx, /rotateLogIfBig\(join\(homedir\(\), '\.claude-gui', 'crash\.log'\)\)/, 't6: 启动滚 crash.log');
  assert.match(idx, /rotateLogIfBig\(join\(homedir\(\), '\.claude-gui', 'client\.log'\)\)/, 't6: 启动滚 client.log');
  // client-log 挂载在 authMiddleware 之后(自动带鉴权)
  const authPos = idx.indexOf("app.use('/api', authMiddleware)");
  const mountPos = idx.indexOf("app.use('/api', clientLogRoutes)");
  assert.ok(authPos > 0 && mountPos > authPos, 't6: client-log 必须挂在 authMiddleware 之后');

  const main = readFileSync(new URL('../../client/src/main.jsx', import.meta.url), 'utf8');
  assert.match(main, /addEventListener\('error'/, 't6: 前端监听 error');
  assert.match(main, /addEventListener\('unhandledrejection'/, 't6: 前端监听 unhandledrejection');
  assert.match(main, /\/api\/client-log/, 't6: 前端上报打 /api/client-log');
}

console.log('check-r29-crashlog: all 6 groups passed');
