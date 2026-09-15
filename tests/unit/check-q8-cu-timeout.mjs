#!/usr/bin/env node
// Q8 审查项 4(computer-use helper 超时):
//   a. runHelper 超时只 SIGKILL,exit 后 stdout 为空 → "helper 输出不可解析" → 被归成 CU_DISPATCH_FAILED,
//      CU_TIMEOUT 事实上不可达(修前应红)
//   b. helper 在被 SIGKILL 前必须先收到可捕获的终止信号(SIGTERM),否则"不留按下的修饰键"的承诺无法兑现(修前应红)
//   c. 超时机制本身在 20s 上下生效(修前应绿)
//   d. 真机项:超时后系统里是否残留按下的修饰键/鼠标左键 —— 本测试测不到,只登记
// 测法:桩 helper 收到 ax-key 就睡 26s(> key 动作 20s 上限),观察回执 code 与桩收到的信号。约 20 秒。
// 跑法:node tests/unit/check-q8-cu-timeout.mjs
import assert from 'node:assert/strict';
import { makeReport } from './q8-helpers/report.mjs';
import { TARGET, GRANTED, grantedWindow, makeFakeHome, startMcp } from './q8-helpers/cu-harness.mjs';

const report = makeReport('check-q8-cu-timeout');
const fake = makeFakeHome('cu-timeout');
fake.setGrants({ apps: [GRANTED.bundleId] });
fake.setScenario({
  windows: { reply: { ok: true, frontmost: null, windows: [grantedWindow()] } },
  'ax-key': { sleepMs: 26_000 },
});
const mcp = await startMcp(fake);

try {
  const t0 = Date.now();
  const r = await mcp.call('key', { actionId: 'q8to_1', target: TARGET, keys: 'a' }, 90_000);
  const elapsed = Date.now() - t0;
  const sigs = fake.signals().filter((s) => s.subcmd === 'ax-key');

  await report.check('Q8-04a', 'helper 超时的回执 code 必须是 CU_TIMEOUT(而不是 CU_DISPATCH_FAILED)', 'red', async () => {
    assert.equal(r.isError, true, `超时应是失败回执,实际 ${JSON.stringify(r.sc)}`);
    assert.equal(r.sc.code, 'CU_TIMEOUT', `实际 code=${r.sc.code};文案=${r.text.slice(0, 120)}`);
  });

  await report.check('Q8-04b', '超时时 helper 先收到 SIGTERM(可捕获,才能补 up 事件),不能一上来就 SIGKILL', 'red', async () => {
    assert.ok(sigs.some((s) => s.signal === 'SIGTERM'), `helper 收到的信号: ${JSON.stringify(sigs.map((s) => s.signal))}(空 = 直接被 SIGKILL,来不及收尾)`);
  });

  await report.check('Q8-04c', '超时机制本身在 20s 上限附近触发(19–40s 之间返回)', 'green', async () => {
    assert.ok(elapsed >= 19_000 && elapsed <= 40_000, `实际耗时 ${elapsed}ms`);
  });

  report.skip('Q8-04d', '超时被杀后不残留按下的修饰键/鼠标左键(合同 CU_TIMEOUT 文案的承诺)', 'red',
    '真机项:需在真实 macOS 上让 helper 卡在 down/up 之间被杀,再观察系统修饰键状态;桩进程测不到');
} finally {
  mcp.kill();
}

process.exit(report.finish());
