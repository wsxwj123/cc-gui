#!/usr/bin/env node
// r26-C2【单测】:系统代理探活后再用。
// 背景:detectLocalProxy 原来 readSystemProxy 命中即 return,不做连通性验证 ——
// 系统代理设置残留(代理软件已关但设置没还原)时,更新命令全部走死代理。
// 验收点(PLAN C2,替代验收口径 —— 本机造不出确定的「系统代理死端口」,注入 mock):
//   ①系统代理指向 closed 端口(测试起即关的 server 拿端口号)→ detectLocalProxy
//     不采用它,落端口探测/返回 null(探活哨兵);
//   ②系统代理指向存活的 TCP server → 采用;
//   ③env 代理仍最优先且不探活(显式配置信任优先,既有语义保留);
//   ④probeTcp 纯函数:活端口 true / 死端口 false。
// Run: node tests/unit/check-r26-c2-proxy-probe.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { makeTmpHome, cleanupDirs } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('c2-unit'); // version-check 顶层固化 PREFS_FILE,先隔离 HOME

// 拿一个「确定没人听」的端口:起 server 拿到端口号后立刻关
async function closedPort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

// 隔离 env 代理(本机 shell 可能带 http_proxy 等),跑完还原
const ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
function clearProxyEnv() {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  return () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
}

let liveServer = null;
try {
  const { detectLocalProxy, probeTcp } = await import('../../server/routes/version-check.js');

  // ④probeTcp 纯函数
  const dead = await closedPort();
  assert.equal(await probeTcp('127.0.0.1', dead), false, 'C2: probeTcp 死端口必须 false');
  liveServer = createServer();
  await new Promise((r) => liveServer.listen(0, '127.0.0.1', r));
  const livePort = liveServer.address().port;
  assert.equal(await probeTcp('127.0.0.1', livePort), true, 'C2: probeTcp 活端口必须 true');

  // ①死系统代理不得采用(落端口探测或 null,但绝不能是死代理本身)
  {
    const restore = clearProxyEnv();
    try {
      const deadUrl = `http://127.0.0.1:${dead}`;
      const got = await detectLocalProxy({ readSystem: async () => deadUrl });
      assert.notEqual(got, deadUrl, 'C2: 系统代理指向死端口时不得采用(探活哨兵 —— 修复前原样 return 死代理)');
    } finally { restore(); }
  }

  // ②活系统代理采用
  {
    const restore = clearProxyEnv();
    try {
      const liveUrl = `http://127.0.0.1:${livePort}`;
      const got = await detectLocalProxy({ readSystem: async () => liveUrl });
      assert.equal(got, liveUrl, 'C2: 系统代理探活通过必须采用');
    } finally { restore(); }
  }

  // ③env 代理最优先且不探活(readSystem 抛错也不应被调到)
  {
    const restore = clearProxyEnv();
    try {
      process.env.HTTPS_PROXY = 'http://127.0.0.1:9'; // 刻意死端口:被探活就露馅
      let called = false;
      const got = await detectLocalProxy({ readSystem: async () => { called = true; return null; } });
      assert.equal(got, 'http://127.0.0.1:9', 'C2: 显式 env 代理优先(不探活,信任优先)');
      assert.equal(called, false, 'C2: env 代理命中时不得再读系统代理(短路)');
    } finally { restore(); }
  }

  // 源码钉:系统代理不得再「读到就 return」(与 acceptance c2 同锚,双保险)
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  assert.ok(!/if \(sys\) return sys;/.test(src), 'C2: 系统代理不探活直接 return 的旧形态必须消除');
} finally {
  if (liveServer) await new Promise((r) => liveServer.close(r));
  cleanupDirs(TMP_HOME);
}

console.log('PASS check-r26-c2-proxy-probe');
