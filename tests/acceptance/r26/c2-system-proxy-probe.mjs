#!/usr/bin/env node
// r26-C2【复现(源码钉)】:系统代理不探活。
// 场景:用户开过系统代理后来关掉(或代理软件退出但系统设置残留),readSystemProxy 读到的
// 是死代理;version-check 直接采用且优先于端口探测 → 更新子进程 env 注入死代理 → 全部
// 连接超时,用户看到「更新卡死」。
// 修复后期望:系统代理取值后必须先做一次短超时 TCP 探活(host:port 可连才用),不通则
// 落端口探测/直连 —— 即 detectLocalProxy 里不得再出现「读到系统代理就原样 return」。
// 诚实标注:本机 scutil --proxy 全关,无法在测试进程里确定性地造「系统代理指向死端口」,
// 故本条的可执行部分是源码钉(精确锚在 bug 那一行),不是行为复现。
// Run: node tests/acceptance/r26/c2-system-proxy-probe.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTmpHome, cleanupDirs } from './lib.mjs';

const TMP_HOME = makeTmpHome('c2');
const src = readFileSync(new URL('../../../server/routes/version-check.js', import.meta.url), 'utf8');

try {
  // bug 那一行:系统代理不探活直接采用。修复(任何形式)都必须消掉这个直通 return。
  assert.ok(
    !/if \(sys\) return sys;/.test(src),
    'C2: readSystemProxy 的结果仍不探活直接 return —— 系统里残留的死代理会被原样注入更新进程',
  );

  // 反向钉:探测/直连的既有行为不许被改坏 —— 显式 env 代理优先的策略保持不变。
  const { detectLocalProxy } = await import('../../../server/routes/version-check.js');
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9'; // 用户显式配置的优先(不在本条修复范围)
  try {
    const viaEnv = await detectLocalProxy();
    assert.equal(viaEnv, 'http://127.0.0.1:9', 'C2: 显式 env 代理优先的策略不许改');
  } finally {
    delete process.env.HTTPS_PROXY;
  }
} finally {
  cleanupDirs(TMP_HOME);
}

console.log('PASS r26-c2-system-proxy-probe');
