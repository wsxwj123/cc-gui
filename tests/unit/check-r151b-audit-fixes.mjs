#!/usr/bin/env node
// r151b 安全审计与判官之后的服务端修复(SECURITY-r151b I1 I2 S1 S2 S5 S7 S8;JUDGE 建议 2 3 5 6 7 10;
// 接口 2026-10-15 审计后补 / 判官后补)。每节对应一次提交;对长输入的处理都带耗时上限断言。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身,不起 claude 进程;临时 HOME;端口 6900–6990(跳过 6710)。
// node tests/unit/check-r151b-audit-fixes.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151b-audit-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin'); const WORK = join(TMP, 'work');
const REG = join(HOME, '.claude', 'sessions');
for (const d of [REG, join(HOME, '.claude-gui'), BIN, WORK]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;
const setEnabled = (v) => writeFileSync(join(HOME, '.claude-gui', 'prefs.json'), JSON.stringify({ xsEnabled: v }));

registerR151bSdkStub();
const chat = await import('../../server/routes/chat.js');
const xs = await import('../../server/services/xsession.js');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed += 1; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); passed += 1; };
/** 同步跑 fn,断言耗时 < ms(长输入不得卡住事件循环);返回 fn 的结果。 */
function within(ms, fn, what) {
  const t0 = performance.now();
  const v = fn();
  const dt = performance.now() - t0;
  ok(dt < ms, `${what}:耗时 ${dt.toFixed(1)}ms,应 < ${ms}ms`);
  return v;
}

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const C = 'cccccccc-0000-4000-8000-000000000003';
const E = 'eeeeeeee-0000-4000-8000-000000000005';

try {
  // ── I1:原生引导解析发送目标 —— 先限长(>512 不当 GUI 会话目标)、结尾"[短号]"线性去掉、每次调用只解析一次 ─────────
  {
    const { nativeGuardShouldDeny: deny } = xs;
    const longName = 'n'.repeat(512);
    const entries = [
      { pid: 101, sessionId: A, name: 'proj-a1', messagingSocketPath: '/tmp/cc-socks/101.sock' },
      { pid: 103, sessionId: C, name: 'proj-c3', messagingSocketPath: '/tmp/cc-socks/103.sock' },
      { pid: 105, sessionId: E, name: longName, messagingSocketPath: '/tmp/cc-socks/105.sock' },
    ];
    const gui = [A, C, E];
    const byName = (to) => ({ to, recipient: to, recipient_kind: 'name' });
    eq(deny(byName('proj-c3 [ab12cd]'), entries, gui, A), true, '"名字 [短号]" 照旧认');
    eq(deny(byName('  proj-c3   [x]  '), entries, gui, A), true, '前后与括号前的空白照旧去掉');
    eq(deny(byName('proj-c3 []'), entries, gui, A), true, '空短号也去掉(与原正则同口径)');
    eq(deny(byName('proj-c3 [a] b]'), entries, gui, A), false, '最后一对括号里夹着 "]" → 不当短号(与原正则同口径)');
    eq(deny(byName('proj-c3 [ab'), entries, gui, A), false, '没有收尾的 "]" → 原样比较');
    eq(deny(byName(longName), entries, gui, A), true, '恰好 512 字符照常判');
    eq(deny(byName(`${longName} [1]`), entries, gui, A), false, '超过 512 字符(哪怕去掉短号后能命中)→ 不是 GUI 会话目标');
    eq(deny({ to: `uds:/tmp/cc-socks/103.sock${' '.repeat(600)}`, recipient_kind: 'session' }, entries, gui, A), false, '地址超长同样不管');
    for (const [label, s] of [
      ['20 万个 "["', '['.repeat(200_000)],
      ['20 万个空格', ' '.repeat(200_000)],
      ['20 万个空格 + "]"', `${' '.repeat(199_999)}]`],
      ['"[" 与空格交替 20 万', '[ '.repeat(100_000)],
    ]) {
      eq(within(50, () => deny({ to: s, recipient: s }, entries, gui, A), `原生引导解析 ${label}`), false, `${label} → 不拒`);
    }
    const worst = `${'['.repeat(510)}]`; // 限长以内的最坏写法:线性处理
    eq(within(20, () => deny(byName(worst), entries, gui, A), '限长以内 511 个 "[" 的目标'), false, '511 个 "[" 不命中');

    // 每次调用只解析一次:xsNativeGuard 读 recipient_kind 恰好一次(原先 xsNativeGuard 与判定各解析一遍)
    setEnabled(true);
    writeFileSync(join(REG, '101.json'), JSON.stringify(entries[0]));
    let reads = 0;
    const toolInput = { to: 'proj-a1', recipient: 'proj-a1', get recipient_kind() { reads += 1; return 'name'; } };
    eq(await xs.xsNativeGuard({ tool_name: 'SendMessage', tool_input: toolInput }, { sessionId: C }), null, 'A 不是 GUI 存活会话 → 放行');
    eq(reads, 1, 'xsNativeGuard 每次调用只解析一次目标');
    setEnabled(false);
  }
} finally {
  try { await chat.closeAllPersistentProcesses(); } catch {}
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`check-r151b-audit-fixes: ${passed} 项通过`);
process.exit(0);
