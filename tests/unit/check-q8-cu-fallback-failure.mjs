#!/usr/bin/env node
// Q8 补测(审查项 3 的盲区):type 后台输入、目标文本框读不回(ax-type 回 UNREADABLE)而改走回退投递时——
//   Q8A-01 回退投递本身失败(helper 回 ok:false / 非零退出且无输出 / 输出不可解析):回执必须明确失败
//          (isError、ok:false、CU_DISPATCH_FAILED),文本面与结构面都不得声称"已投递 N 个码点"(修前应红)
//   Q8A-02 回退投递卡住超时:回执 code 必须是 CU_TIMEOUT(修前应红)
//   Q8A-03 反向守卫:回退投递成功时照旧成功、verification=unknown、文本写明投递的码点数(修前应绿)
// 测法:沿用 check-q8-cu-argv.mjs 的夹具(真起 mcp-server + 假 python3 + 假家目录),只把假 python3 换成
//       q8-helpers/cu-stub-wildcard.mjs:剧本 "*" 命中所有没点名的子命令,回退投递不管走 ax-key、分块多次
//       还是改名的新子命令都会被打到。每条用例(及 01 的每种形态)各用独立假家目录 + 独立 mcp 进程。
// 超时上限按合同是 30000+25×码点 毫秒,夹具无法压短;用 1 个码点的文本,Q8A-02 约 30 秒。
// 跑法:node tests/unit/check-q8-cu-fallback-failure.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { makeReport } from './q8-helpers/report.mjs';
import { HERE, TARGET, GRANTED, grantedWindow, makeFakeHome, startMcp } from './q8-helpers/cu-harness.mjs';

const report = makeReport('check-q8-cu-fallback-failure');
const WRAPPER = join(HERE, 'cu-stub-wildcard.mjs');
const NOT_FALLBACK = new Set(['app-info', 'windows', 'ax-type', 'ax-state']); // 查询/前置调用;其余子命令都算回退投递
const CLAIM = /投递\s*[1-9]\d*\s*个?(码点|字符)|已(投递|送达|输入)/; // 声称已送达的说法
const CLAIM_VERIFICATION = ['dispatched', 'verified', 'unknown']; // 合同:unknown = 已投递但效果未确认

/** 起一个独立实例:授权 GRANTED,ax-type 读不回;star = 所有其余子命令(即回退投递)的剧本,null = 原桩默认成功。 */
async function withMcp(name, star, fn) {
  const fake = makeFakeHome(`cu-fallback-${name}`);
  fs.writeFileSync(join(fake.runtimeDir, 'venv', 'bin', 'python3'), `#!/bin/sh\nexec "${process.execPath}" "${WRAPPER}" "$@"\n`);
  fake.setGrants({ apps: [GRANTED.bundleId], screenScope: false });
  fake.setScenario({
    windows: { reply: { ok: true, frontmost: { pid: GRANTED.pid, name: GRANTED.name, bundleId: GRANTED.bundleId }, windows: [grantedWindow()] } },
    'app-info': {}, 'ax-state': {}, // 原桩默认应答
    'ax-type': { reply: { ok: false, code: 'UNREADABLE', reason: 'no-text-element' } },
    ...(star ? { '*': star } : {}),
  });
  const mcp = await startMcp(fake);
  try { return await fn(mcp, fake); } finally { mcp.kill(); }
}
const typeBg = (mcp, actionId, text, timeoutMs) => mcp.call('type', { actionId, target: TARGET, foreground: false, text }, timeoutMs);
function assertFallbackReached(fake) {
  const subs = fake.argv().map((e) => e.subcmd);
  assert.ok(subs.some((s) => !NOT_FALLBACK.has(s)), `前提不成立:UNREADABLE 之后没有回退投递的 helper 调用,实际子命令 ${subs.join(',')}`);
}

const FAILURES = [
  ['helper 回 ok:false', { reply: { ok: false, code: 'POST_FAILED', error: 'CGEventPostToPid failed' } }],
  ['helper 非零退出且无输出', { raw: '', exitCode: 1 }],
  ['helper 退出码 0 但输出不可解析', { raw: 'Traceback (most recent call last): boom\n' }],
];

// 每条用例自带实例并在 withMcp 的 finally 里收尾,用例之间不共享进程/家目录
{
  await report.check('Q8A-01', '回退投递失败(三种形态):回执明确失败 CU_DISPATCH_FAILED,文本/结构面都不声称已投递', 'red', async () => {
    const bad = [];
    for (const [i, [form, star]] of FAILURES.entries()) {
      await withMcp(`fail${i + 1}`, star, async (mcp, fake) => {
        const r = await typeBg(mcp, 'q8fb_1', 'hello world');
        assertFallbackReached(fake);
        const sc = JSON.stringify(r.sc);
        const probs = [];
        if (r.isError !== true) probs.push(`isError=${r.isError}`);
        if (r.sc.ok !== false) probs.push(`ok=${r.sc.ok}`);
        if (r.sc.code !== 'CU_DISPATCH_FAILED') probs.push(`code=${r.sc.code}`);
        if (CLAIM.test(r.text)) probs.push(`文本声称已送达「${r.text}」`);
        if (CLAIM.test(sc) || CLAIM_VERIFICATION.includes(r.sc.verification) || ['dispatched', 'verified'].includes(r.sc.state)) probs.push(`结构面声称已送达 ${sc}`);
        if (probs.length) bad.push(`[${form}] ${probs.join('; ')}`);
      });
    }
    assert.equal(bad.length, 0, bad.join('\n'));
  });

  await report.check('Q8A-02', '回退投递卡住超时:回执 code 必须是 CU_TIMEOUT', 'red', async () => {
    await withMcp('timeout', { sleepMs: 45_000 }, async (mcp, fake) => {
      const r = await typeBg(mcp, 'q8fb_2', 'a', 120_000);
      assertFallbackReached(fake);
      assert.equal(r.isError, true, `超时应是失败回执,实际 ${JSON.stringify(r.sc)};文本「${r.text}」`);
      assert.equal(r.sc.code, 'CU_TIMEOUT', `实际 code=${r.sc.code};文本「${r.text}」`);
    });
  });

  await report.check('Q8A-03', '反向守卫:回退投递成功时照旧成功、verification=unknown、文本写明投递的码点数', 'green', async () => {
    await withMcp('success', null, async (mcp, fake) => {
      const r = await typeBg(mcp, 'q8fb_3', 'hello 世界👋'); // 9 个码点(UTF-16 为 10 个码元,≤20 不触发长文本分块/拒绝)
      assertFallbackReached(fake);
      assert.equal(r.isError, false, `回退成功不该报失败,实际 ${JSON.stringify(r.sc)}`);
      assert.equal(r.sc.ok, true, `ok 应为 true,实际 ${JSON.stringify(r.sc)}`);
      assert.equal(r.sc.verification, 'unknown', '读不回的目标只能报 unknown');
      assert.match(r.text, /(?<!\d)9\s*个?(码点|字符)/, `文本应写明投递 9 个码点,实际「${r.text}」`);
    });
  });
}

process.exit(report.finish());
