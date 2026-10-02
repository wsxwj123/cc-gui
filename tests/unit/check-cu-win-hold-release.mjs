#!/usr/bin/env node
// r142 / T-4 —— 按键释放合同(§3.2 B-2 四层)。伪 win32 真跑,不碰桌面。
//
// 覆盖:
//   层 4(超时路径)  —— 先杀死 helper,再补发 release-hold;顺序用"心跳"证明,不是看代码
//   层 2(watcher)   —— 父进程猝死(只杀 mcp 本体,不杀同组)后,watcher 从管道 EOF 醒来,经
//                        helper 的 release-hold 子命令补发抬起
//   hold 文件清理    —— 释放完不留 hold-*.json 垃圾
// 真机项(任务管理器强杀 CC-GUI + osk.exe 目视)在 TEST-PLAN 的 Windows 清单里,这里测不到。
//
// 为什么"必须先杀后释放":释放后再杀,等于给"杀完之后才按下的那次"留了 TOCTOU 窗口。
// 心跳判定法:helper 桩活着就每 60ms 写一次心跳;release-hold 调用会把"排除自己之后的最晚心跳"记进日志。
// 若实现先释放后杀,目标 helper 此刻还活着 ⇒ 最晚心跳 ≥ 释放时刻 ⇒ 断言红。
//
// 跑法:node tests/unit/check-cu-win-hold-release.mjs   (修后约 25 秒)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeReport } from './q8-helpers/report.mjs';
import { GRANTED, grantedWindow, makeWinHome, PRELOAD, releaseHoldEntry, ROOT, startWinMcp } from './r142-helpers/win-fixture.mjs';

const report = makeReport('check-cu-win-hold-release');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 除 excludePid 外,还有谁在 t 之后心跳过(= 那个进程在 t 时刻还活着)。 */
function beatersAfter(fake, t, excludePid) {
  const out = [];
  for (const f of fs.readdirSync(fake.beatDir)) {
    const pid = Number(/beat-(\d+)\.log/.exec(f)?.[1]);
    if (pid === excludePid) continue;
    const beats = fs.readFileSync(join(fake.beatDir, f), 'utf8').split('\n').filter(Boolean).map(Number);
    const late = beats.filter((b) => b >= t);
    if (late.length) out.push({ pid, firstLate: Math.min(...late), count: late.length });
  }
  return out;
}

// ── T4-00 夹具自检(修前绿):夹具本身可信,后面的红绿才作数 ─────────────
{
  const fake = makeWinHome('t4-selfcheck');
  // (a) 假 venv-win 解释器能被直接驱动,并按剧本回 JSON + 记 argv
  const direct = spawnSync(fake.venvPy, [join(ROOT, 'server', 'computer-use', 'cu_helper_windows.py'), 'windows'],
    { encoding: 'utf8', env: { ...process.env, CU_STUB_LOG: fake.stubLog, CU_STUB_SCENARIO: fake.scenarioFile, CU_STUB_SIGLOG: fake.sigLog } });
  // (b) 预加载真的把子进程伪装成 win32 + 假家目录
  const probe = spawnSync(process.execPath, ['--import', PRELOAD, '-e',
    'console.log(JSON.stringify({ p: process.platform, o: require("os").platform(), h: require("os").userInfo().homedir }))'],
  { encoding: 'utf8', env: { ...process.env, CU_TEST_HOME: fake.home } });
  const probed = JSON.parse(probe.stdout || '{}');
  // (c) 伪 win32 下 MCP 仍能握手并应答工具调用(修前也成立:硬门在 bootstrapRuntime,不在模块加载)
  const mcpWin = await startWinMcp(fake);
  const answered = await mcpWin.call('doctor', {}, 20_000).catch((e) => ({ error: String(e) }));
  mcpWin.kill();
  await report.check('T4-00', '夹具自检:假解释器可驱动 / 预加载真的伪装 win32 / 伪 win32 下 MCP 能握手', 'green', () => {
    assert.equal(probed.p, 'win32', `预加载没把 process.platform 改成 win32(实际 ${probed.p})`);
    assert.equal(probed.o, 'win32', `预加载没把 os.platform() 改成 win32(实际 ${probed.o})`);
    assert.equal(probed.h, fake.home, `预加载没把家目录指到假目录(实际 ${probed.h})`);
    assert.ok(fake.log().some((e) => e.kind === 'helper' && e.subcmd === 'windows'),
      `假 venv-win 解释器没被驱动起来;stdout=${JSON.stringify(direct.stdout)} stderr=${String(direct.stderr).slice(0, 200)}`);
    assert.ok(answered && !answered.error, `伪 win32 下 MCP 没有应答 tools/call:${JSON.stringify(answered)}`);
  });
}

// ── T4-01 层 4:超时路径必须先杀 helper、再补发 release-hold(修前红)─────
{
  const fake = makeWinHome('t4-timeout');
  fake.setGrants({ apps: [GRANTED.bundleId] });
  fake.setScenario({
    windows: { reply: { ok: true, frontmost: null, windows: [grantedWindow()] } },
    key: { sleepMs: 26_000 }, // > key 动作 20s 上限
  });
  const mcpWin = await startWinMcp(fake);
  const t0 = Date.now();
  const r = await mcpWin.call('key', { actionId: 'r142_t4a', target: { bundleId: GRANTED.bundleId, pid: GRANTED.pid, windowId: GRANTED.windowId }, keys: 'ctrl+a' }, 60_000).catch((e) => ({ error: e }));
  const rel = releaseHoldEntry(fake);
  mcpWin.kill();
  await report.check('T4-01', '超时收尾:回执 = CU_TIMEOUT,且 release-hold 在 helper 已经死掉之后才发出(先杀后释放)', 'red', () => {
    assert.equal(r?.sc?.code, 'CU_TIMEOUT', `超时回执 code=${r?.sc?.code}(§B-3 #5:走层 4 超时路径)`);
    assert.ok(rel, `超时后没有观察到 release-hold 调用;桩记录:${JSON.stringify(fake.log().slice(-6))}`);
    assert.ok(rel.at >= t0, 'release-hold 的时间戳早于本次动作,说明读到的是别的调用的残留日志');
    assert.ok(rel.latestBeatAt !== null && rel.latestBeatAt < rel.at,
      `release-hold 发出时另一个 helper 还在心跳(最晚心跳 ${rel.latestBeatAt} ≥ 释放 ${rel.at})⇒ 实现是"先释放后杀",`
      + '中间那段窗口里新按下的键不会被抬起(§3.2 B-2 的顺序约束)');
    const late = beatersAfter(fake, rel.at, rel.pid);
    assert.deepEqual(late, [], `release-hold 之后仍有进程在心跳(它们在释放时还活着):${JSON.stringify(late)}`);
  });
}

// ── T4-02 层 2:父进程猝死 → watcher 经 release-hold 补发抬起(修前红)────
// 关键:只 SIGKILL mcp 本体(等价"任务管理器强杀 CC-GUI"),同组的 watcher 必须自己从 EOF 醒来。
{
  const fake = makeWinHome('t4-watcher');
  fake.setGrants({ apps: [GRANTED.bundleId] });
  fake.setScenario({ windows: { reply: { ok: true, frontmost: null, windows: [grantedWindow()] } } });
  const mcpWin = await startWinMcp(fake);
  await mcpWin.call('window_list', {}, 20_000).catch(() => null); // 确保运行时/watcher 已经起来
  fake.clearLogs();
  // ⚠️ 属主 pid 必须用**超出进程号空间**的值(本机 kern.maxproc=16000、pid 上限 99999):
  // watcher 的收尾要按属主 pid 判活(`process.kill(pid, 0)`),拿 4242 这种常见 pid 时,机器上
  // 恰好有同号活进程就会把这份凭据当"还活着"⇒ 用例间歇性假红(方向是假红不是假绿,但间歇红
  // 最容易被当噪声忽略)。9_999_999 必然 ESRCH,确定性。
  const holdFile = fake.writeHoldFile(9_999_999, ['CTRL']);
  const killedAt = Date.now();
  mcpWin.killParentOnly('SIGKILL');
  await mcpWin.waitExit(3000);
  let rel = null;
  for (let i = 0; i < 40 && !rel; i += 1) { await sleep(50); rel = releaseHoldEntry(fake); }
  const latencyMs = rel ? rel.at - killedAt : null;
  await sleep(400); // 给 watcher 一点时间做清理/退出,再判"有没有残留"
  const leftovers = fake.holdFiles();
  mcpWin.kill(); // 收尾:连 watcher 一起收
  await report.check('T4-02', '父进程被强杀后,watcher 从管道 EOF 醒来并经 helper release-hold 补发抬起(≤1s)', 'red', () => {
    assert.ok(rel, `mcp 被杀后 2 秒内没有 release-hold 调用(层 2 缺失或 watcher 不走 helper 子命令);`
      + `桩记录:${JSON.stringify(fake.log().slice(-6))};hold 文件仍在:${JSON.stringify(fake.holdFiles())}`);
    assert.ok(latencyMs <= 1000,
      `从强杀到释放用了 ${latencyMs}ms(>1s)。方案 §6.1 T-4 要求 200ms 内;这里放宽到 1s 是因为要把"起一个解释器进程"算进去,`
      + '再慢就说明 watcher 根本没在管道上等');
  });
  await report.check('T4-03', '释放完成 + watcher 退出后不留 hold-*.json(§3.2 B-2 hold 文件清理)', 'red', () => {
    assert.deepEqual(leftovers, [], `运行时目录里残留 ${JSON.stringify(leftovers)};下次启动会被当成"还有键按着"`);
    assert.equal(fs.existsSync(holdFile), false, '夹具写的那个 hold 文件没被清掉');
  });
}

process.exit(report.finish());
