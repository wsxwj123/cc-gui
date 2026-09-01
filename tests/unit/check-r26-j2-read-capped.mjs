#!/usr/bin/env node
// r26-J2【单测】:readCapped 限量读(抽到 server/utils/read-capped.js 共用)。
// 哨兵:①100MB body + 如实 content-length → 预检返回 null,body 一个字节不读;
// ②谎报 content-length(chunked 无声明)灌超 → 读到上限即停,返回 null(限量截断);
// ③正常小 body 原样返回;④无 body 返回 '';⑤image.js/provider-quota.js 都改调导出版
// (源码钉);⑥额度路由 /huge 行为不变(1MB 上限沿用,回归哨兵,复跑既有探针测试覆盖)。
// 端口取 OS 临时口(listen(0),真实端口从 server.address() 读回),跑完杀干净。
// Run: node tests/unit/check-r26-j2-read-capped.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { readCapped } from '../../server/utils/read-capped.js';

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };

// 行为夹具:同一个临时口上三种上游
let bigBytesSent = 0; // 服务端实际写出的字节数,钉"客户端早退"
const app = createServer((req, res) => {
  if (req.url === '/big-declared') {
    // 100MB,如实声明
    const BIG = 100 * 1024 * 1024;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(BIG) });
    const chunk = Buffer.alloc(4 * 1024 * 1024, 'x');
    let sent = 0;
    const write = () => {
      while (sent < BIG) {
        sent += chunk.length;
        if (!res.write(chunk)) { res.once('drain', write); return; }
      }
      res.end();
    };
    res.on('error', () => {});
    write();
    return;
  }
  if (req.url === '/big-chunked') {
    // chunked 不声明长度,尽力灌(客户端读到上限即取消)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const chunk = Buffer.alloc(1024 * 1024, 'y');
    let stopped = false;
    res.on('close', () => { stopped = true; });
    res.on('error', () => {});
    const write = () => {
      while (!stopped) {
        bigBytesSent += chunk.length;
        if (!res.write(chunk)) { res.once('drain', write); return; }
      }
    };
    write();
    return;
  }
  if (req.url === '/small') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404); res.end();
});

const server = await new Promise((resolve, reject) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
  s.once('error', reject);
});
const BASE = `http://127.0.0.1:${server.address().port}`;

let failure = null;
try {
  // ① 100MB 如实声明 → 预检 null;服务端还没来得及灌多少
  {
    const r = await fetch(`${BASE}/big-declared`);
    const out = await readCapped(r, 1024 * 1024);
    assert.equal(out, null, 'J2: content-length 声明超限 → 预检 null');
    n += 1;
  }
  // ② chunked 谎报(无声明)→ 读到上限即停,返回 null;服务端发送量应远小于无限灌
  {
    bigBytesSent = 0;
    const r = await fetch(`${BASE}/big-chunked`);
    const out = await readCapped(r, 2 * 1024 * 1024);
    assert.equal(out, null, 'J2: 无声明超限 → 限量读 null(截断)');
    n += 1;
    // 给服务端的 close 事件一个 tick 停掉 timer
    await new Promise((d) => setTimeout(d, 100));
    assert.ok(bigBytesSent < 50 * 1024 * 1024,
      `J2: 客户端截断后服务端不应灌满内存级体量(实际已发 ${(bigBytesSent / 1048576).toFixed(1)}MB)`);
    n += 1;
  }
  // ③ 正常小 body 原样返回
  {
    const r = await fetch(`${BASE}/small`);
    assert.equal(await readCapped(r, 1024), '{"ok":true}', 'J2: 小 body 原样返回');
    n += 1;
  }
  // ④ 无 body → ''
  {
    const fake = { headers: { get: () => null }, body: null };
    assert.equal(await readCapped(fake), '', 'J2: 无 body 返回空串');
    n += 1;
  }
  // ⑤ 源码钉:两条消费链都走导出版,本地副本不得复活
  {
    const img = readFileSync(new URL('../../server/routes/image.js', import.meta.url), 'utf8');
    const quota = readFileSync(new URL('../../server/routes/provider-quota.js', import.meta.url), 'utf8');
    ok(/import \{ readCapped \} from '\.\.\/utils\/read-capped\.js'/.test(img), 'J2: image.js 调导出版 readCapped');
    ok(/import \{ readCapped \} from '\.\.\/utils\/read-capped\.js'/.test(quota), 'J2: provider-quota.js 调导出版 readCapped');
    ok(!/async function readCapped/.test(quota), 'J2: provider-quota.js 本地 readCapped 副本已删');
    ok(!/await r\.text\(\)/.test(img), 'J2: image.js 不再有裸 r.text()');
  }
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}
if (failure) throw failure;
console.log(`PASS check-r26-j2-read-capped (${n} assertions)`);
