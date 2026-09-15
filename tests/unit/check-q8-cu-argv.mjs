#!/usr/bin/env node
// Q8 审查项 1/2/3(computer-use 文本传参):
//   1. type 工具把输入文本/窗口标题当 argv 传给 cu_helper → ps 全局可见(修前应红)
//   2. 后台路径 `--text <v>` 两段式,'-' 开头的文本/标题被 argparse 当选项 → 必失败(修前应红)
//   3. ax-type 报 UNREADABLE 的回退把整段文本塞进【一个】键盘事件(_post_key)→ 静默截断(修前应红)
// 测法:真起 mcp-server.js,但 python3 被换成只记 argv/按剧本应答的桩(不建 venv、不装包、不碰桌面);
//       argparse/_post_key 的判据用系统 python3 + 纯 stdlib 探针复现(见 q8-helpers/cu-helper-probe.py)。
// 跑法:node tests/unit/check-q8-cu-argv.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeReport } from './q8-helpers/report.mjs';
import {
  HERE, HELPER_PY, TARGET, GRANTED, grantedWindow, makeFakeHome, startMcp, dashValuesAfterFlags,
} from './q8-helpers/cu-harness.mjs';

const report = makeReport('check-q8-cu-argv');
const fake = makeFakeHome('cu-argv');
fake.setGrants({ apps: [GRANTED.bundleId], screenScope: false });
const frontmostGranted = { pid: GRANTED.pid, name: GRANTED.name, bundleId: GRANTED.bundleId };
const scenarioWith = (title, extra = {}) => ({
  windows: { reply: { ok: true, frontmost: frontmostGranted, windows: [grantedWindow(title)] } },
  ...extra,
});
fake.setScenario(scenarioWith('Granted Doc'));
const mcp = await startMcp(fake);
let seq = 0;
const typeCall = (text, foreground = false) => mcp.call('type', { actionId: `q8argv_${++seq}`, target: TARGET, foreground, text });
const entriesOf = (subcmd) => fake.argv().filter((e) => e.subcmd === subcmd);
const argvHas = (entry, needle) => entry.args.some((a) => String(a).includes(needle));

const PY = existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
function probe(mode, args) {
  return spawnSync(PY, [join(HERE, 'cu-helper-probe.py'), mode, ...args], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, CU_HELPER_PATH: HELPER_PY },
  });
}
const pyOk = spawnSync(PY, ['-c', 'import argparse, json'], { encoding: 'utf8' }).status === 0;

try {
  // ── 项 1:文本/标题不得进 argv ───────────────────────────────────────────
  await report.check('Q8-01a', 'type 后台路径:输入文本不出现在 helper argv(ps 不可见)', 'red', async () => {
    fake.clearLogs();
    const secret = 'hunter2-SECRET-argv-bg';
    const r = await typeCall(secret);
    assert.equal(r.isError, false, `type 应成功,实际 ${JSON.stringify(r.sc)}`);
    const calls = entriesOf('ax-type');
    assert.ok(calls.length >= 1, '后台 type 应调用 helper 的 ax-type');
    const leaked = calls.filter((e) => argvHas(e, secret));
    assert.equal(leaked.length, 0, `文本以 argv 传给了 helper: ${JSON.stringify(leaked.map((e) => e.args))}`);
  });

  await report.check('Q8-01b', 'type 前台路径:输入文本不出现在 helper argv(--text=… 同样进进程表)', 'red', async () => {
    fake.clearLogs();
    const secret = 'hunter2-SECRET-argv-fg';
    const r = await typeCall(secret, true);
    assert.equal(r.isError, false, `前台 type 应成功,实际 ${JSON.stringify(r.sc)}`);
    const calls = entriesOf('type');
    assert.ok(calls.length >= 1, '前台 type 应调用 helper 的 type 子命令');
    const leaked = calls.filter((e) => argvHas(e, secret));
    assert.equal(leaked.length, 0, `文本以 argv 传给了 helper: ${JSON.stringify(leaked.map((e) => e.args))}`);
  });

  await report.check('Q8-01c', '窗口标题不出现在 helper argv(--title 同样进进程表)', 'red', async () => {
    const title = 'Login — hunter2-TITLE-secret';
    fake.setScenario(scenarioWith(title));
    fake.clearLogs();
    const r = await typeCall('plain text');
    assert.equal(r.isError, false, `type 应成功,实际 ${JSON.stringify(r.sc)}`);
    const leaked = fake.argv().filter((e) => argvHas(e, 'hunter2-TITLE-secret'));
    assert.equal(leaked.length, 0, `窗口标题以 argv 传给了 helper(子命令 ${leaked.map((e) => e.subcmd).join(',')})`);
  });

  // ── 项 2:'-' 开头的值不能落成两段式 `--flag value` ────────────────────
  await report.check('Q8-02a', "文本 '--dry-run':不得以两段式 `--text --dry-run` 传参(argparse 会当选项)", 'red', async () => {
    fake.setScenario(scenarioWith('Granted Doc'));
    fake.clearLogs();
    const r = await typeCall('--dry-run');
    assert.equal(r.isError, false, `以 '-' 开头的合法文本不该失败,实际 ${JSON.stringify(r.sc)}`);
    const calls = entriesOf('ax-type');
    assert.ok(calls.length >= 1, '应调用 ax-type');
    const bad = calls.flatMap((e) => dashValuesAfterFlags(e.args));
    assert.deepEqual(bad, [], `两段式传参撞上 '-' 开头的值: ${JSON.stringify(bad)}`);
  });

  await report.check('Q8-02b', "窗口标题 '-zsh':不得以两段式 `--title -zsh` 传参", 'red', async () => {
    fake.setScenario(scenarioWith('-zsh'));
    fake.clearLogs();
    const r = await typeCall('hello');
    assert.equal(r.isError, false, `标题以 '-' 开头不该导致失败,实际 ${JSON.stringify(r.sc)}`);
    const bad = fake.argv().flatMap((e) => dashValuesAfterFlags(e.args, ['--title']));
    assert.deepEqual(bad, [], `两段式 --title 撞上 '-' 开头的标题: ${JSON.stringify(bad)}`);
  });

  if (!pyOk) {
    report.skip('Q8-02c', '把 mcp-server 实际拼出的 ax-type argv 回放进 cu_helper 自己的 argparse', 'red', '本机没有可用的 python3');
  } else {
    await report.check('Q8-02c', '把 mcp-server 实际拼出的 ax-type argv 回放进 cu_helper 自己的 argparse:不得被拒(退出码 2)', 'red', async () => {
      fake.setScenario(scenarioWith('Granted Doc'));
      fake.clearLogs();
      await typeCall('--dry-run');
      const call = entriesOf('ax-type').pop();
      assert.ok(call, '应调用 ax-type');
      const out = probe('argparse', ['ax-type', ...call.args]);
      assert.notEqual(out.status, 2, `cu_helper 的 argparse 拒绝了服务端拼出的参数(退出码 2): ${out.stderr.trim().split('\n').pop()}`);
      assert.doesNotMatch(out.stderr, /expected one argument/, 'argparse 报 expected one argument');
    });
  }

  // ── 项 3:UNREADABLE 回退不得把整段文本塞进一个键盘事件 ───────────────────
  await report.check('Q8-03a', 'ax-type 报 UNREADABLE 时服务端仍走回退投递(前提,修前即成立)', 'green', async () => {
    fake.setScenario(scenarioWith('Granted Doc', { 'ax-type': { reply: { ok: false, code: 'UNREADABLE', reason: 'no-text-element' } } }));
    fake.clearLogs();
    const long = 'x'.repeat(600);
    const r = await typeCall(long);
    assert.equal(r.isError, false, `回退路径应返回 unknown 回执而非失败,实际 ${JSON.stringify(r.sc)}`);
    assert.equal(r.sc.verification, 'unknown', '读不回的目标只能报 unknown');
    const after = fake.argv().filter((e) => e.subcmd !== 'ax-type' && e.subcmd !== 'windows' && e.subcmd !== 'app-info');
    assert.ok(after.length >= 1, `UNREADABLE 之后应再调用一次 helper 做回退投递,实际只有: ${fake.argv().map((e) => e.subcmd).join(',')}`);
  });

  if (!pyOk) {
    report.skip('Q8-03b', 'helper ax-key --unicode <600 字>:不得单事件整段投递', 'red', '本机没有可用的 python3');
  } else {
    await report.check('Q8-03b', 'helper ax-key --unicode <600 字>:每个键盘事件 ≤20 个 UTF-16 码元且全文送达,或明确拒绝(不许静默截断)', 'red', async () => {
      const text = 'x'.repeat(600);
      const out = probe('ax-key-unicode', [text]);
      assert.equal(out.status, 0, `探针异常: ${out.stderr.slice(-400)}`);
      const data = JSON.parse(out.stdout.trim().split('\n').pop());
      assert.equal(data.error, null, `helper 抛错: ${data.error}`);
      const refused = data.helper_out.some((o) => o && o.ok === false);
      if (refused) return; // 明确拒绝长文本也算合格(不冒充投递成功)
      const downs = data.events.filter((e) => e.down);
      assert.ok(downs.length >= 1, '没有任何键盘事件被投递');
      const maxU16 = Math.max(...data.events.map((e) => e.u16));
      assert.ok(maxU16 <= 20, `单个键盘事件携带 ${maxU16} 个 UTF-16 码元(上限 20),整段塞进一个事件只会打出开头一小段;事件数=${data.events.length}`);
      assert.equal(downs.map((e) => e.s).join(''), text, '按下事件拼起来必须等于全文(不丢字)');
    });
  }
} finally {
  mcp.kill();
}

process.exit(report.finish());
