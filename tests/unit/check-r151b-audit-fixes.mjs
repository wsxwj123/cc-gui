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

  // ── I2 + S7 + 判官建议 2:回合错误摘要先截到 2000 字、正则量词有上限、脱敏补带 / + = . 的长串与 URL 里的 用户名:密码@ ──
  {
    const { summarizeTurnError: sum } = chat;
    for (const [label, s] of [
      ['20 万个字母数字', 'a1'.repeat(100_000)],
      ['20 万个 "-"', '-'.repeat(200_000)],
      ['重复 4 万次 token', 'token'.repeat(40_000)],
      ['重复 2 万次 api_key=', 'api_key='.repeat(25_000)],
      ['scheme:// 后 20 万个字母', `https://${'a'.repeat(200_000)}`],
      ['20 万个 "a:"', 'a:'.repeat(100_000)],
      ['重复 3 万次 "Bearer "', 'Bearer '.repeat(30_000)],
      ['20 万个空白', ' \t\n'.repeat(70_000)],
      ['20 万个 base64 字符带点和斜杠', 'Ab+/=.'.repeat(35_000)],
    ]) {
      const out = within(50, () => sum(s), `错误摘要 ${label}`);
      ok(out === null || out.length <= 201, `${label} → 摘要不超过 200 字加省略号`);
    }
    // 先截到 2000 字;截断时被截开的最后一段非空白一并丢掉(半截的凭据不会因为太短躲过脱敏)
    eq(sum(`${' '.repeat(1990)}sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ`), null, '截点落在凭据中间 → 半截凭据丢掉(这里只剩空白 → null)');
    eq(sum(`错误 ${' '.repeat(1990)}ABCDEFGHIJKLMNOPQRSTUVWXYZ`), '错误', '截断后只留完整的部分');
    ok(!sum(`${'x '.repeat(999)}${'😀'.repeat(10)}`).includes('\uFFFD'), '截到 2000 字不切开代理对');
    const leaks = [
      ['base64 带斜杠', 'key material AbCd/EfGh+IjKl/MnOp=QrSt/UvWx+YzAb/CdEf== rejected', 'AbCd/EfGh'],
      ['JWT 带点', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N bad', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0'],
      ['URL 用户名:密码@', 'connect https://alice:s3cr3t-pass@proxy.example.com:8080 failed', 's3cr3t'],
      ['URL 用户名:密码@(密码里带冒号)', 'GET http://bob:pa:ss@10.0.0.1/x', 'pa:ss'],
    ];
    for (const [label, text, secret] of leaks) {
      const s = sum(text);
      ok(typeof s === 'string' && !s.includes(secret) && s.includes('***'), `脱敏 ${label}:${text} → ${s}`);
    }
    eq(sum('connect https://alice:s3cr3t-pass@proxy.example.com:8080 failed'), 'connect https://***@proxy.example.com:8080 failed', 'URL 只抹用户名与密码,主机留着');
    eq(sum('fetch https://api.example.com/v1/messages failed: 503'), 'fetch https://api.example.com/v1/messages failed: 503', '不带凭据的短 URL 原样');
  }

  // ── S1:PreToolUse 守卫位只认明确的 deny;其它返回值回落既有判定;2 秒没返回按检查失效(回落 + 记失效时间)────────
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let guardImpl = () => null;
    const unhook = chat.registerSessionRuntimeHooks({ preToolUse: (input, ctx) => guardImpl(input, ctx) });
    const DENY = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
    for (const slot of [
      { label: '官方', thirdPartyProvider: false, guiMode: 'default', sessionId: A, cwd: WORK, runId: 'sdk-a' },
      { label: '第三方 auto', thirdPartyProvider: true, guiMode: 'auto', sessionId: A, cwd: WORK, runId: 'sdk-b' },
    ]) {
      const hook = chat.makePreToolUseHook(slot);
      const input = { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } };
      guardImpl = () => null;
      const baseline = await hook(input, 'tu-0');
      for (const [what, out] of [
        ['{continue:true}', { continue: true }],
        ['allow', { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }],
        ['ask', { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }],
        ['decision 大小写不对', { hookSpecificOutput: { permissionDecision: 'DENY' } }],
        ['字符串', 'deny'],
        ['空对象', {}],
      ]) {
        guardImpl = () => out;
        eq(await hook(input, 'tu-1'), baseline, `${slot.label}:守卫返回 ${what} → 回落既有判定`);
      }
      guardImpl = () => ({ ...DENY('R'), continue: false, systemMessage: 'x', hookSpecificOutput: { ...DENY('R').hookSpecificOutput, updatedInput: { command: 'ls' } } });
      eq(await hook(input, 'tu-2'), DENY('R'), `${slot.label}:deny → 只保留拒绝与原因`);
      guardImpl = () => ({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 42 } });
      eq(await hook(input, 'tu-3'), DENY(''), `${slot.label}:deny 的原因不是字符串 → 空串`);
      guardImpl = async () => { await sleep(300); return DENY('慢一点'); };
      eq(await hook(input, 'tu-4'), DENY('慢一点'), `${slot.label}:2 秒内给出的 deny 照常生效`);
      eq(chat.preToolUseGuardTimeoutAt(), null, '没超时就不记失效时间');
    }
    const hook = chat.makePreToolUseHook({ thirdPartyProvider: false, guiMode: 'default', sessionId: A, cwd: WORK, runId: 'sdk-c' });
    for (const [what, impl] of [['永不返回', () => new Promise(() => {})], ['2.5 秒后才 deny', async () => { await sleep(2500); return DENY('迟到'); }],
      ['2.5 秒后才抛错', async () => { await sleep(2500); throw new Error('迟到的错'); }]]) {
      guardImpl = impl;
      const t0 = Date.now();
      const before = Date.now();
      eq(await hook({ tool_name: 'SendMessage', tool_input: { to: 'x' } }, 'tu-5'), { continue: true }, `守卫${what} → 回落既有判定`);
      const dt = Date.now() - t0;
      ok(dt >= 1900 && dt < 3000, `守卫${what}:约 2 秒后回落(实际 ${dt}ms)`);
      const at = Date.parse(chat.preToolUseGuardTimeoutAt());
      ok(at >= before - 5 && at <= Date.now(), '记下失效时间');
      eq(xs.nativeGuardLastFailure(), chat.preToolUseGuardTimeoutAt(), 'nativeGuard.lastFailureAt 取到守卫超时的时刻');
    }
    await sleep(700); // 让迟到的结果 / 错误落地:不得变成未处理的 rejection,也不改变已经给出的判定
    unhook();
  }
} finally {
  try { await chat.closeAllPersistentProcesses(); } catch {}
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`check-r151b-audit-fixes: ${passed} 项通过`);
process.exit(0);
