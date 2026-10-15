#!/usr/bin/env node
// r151b 安全审计与判官之后的服务端修复(SECURITY-r151b I1 I2 S1 S2 S5 S7 S8;JUDGE 建议 2 3 5 6 7 10;
// 接口 2026-10-15 审计后补 / 判官后补)。每节对应一次提交;对长输入的处理都带耗时上限断言。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身,不起 claude 进程;临时 HOME;端口 6900–6990(跳过 6710)。
// node tests/unit/check-r151b-audit-fixes.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync, rmSync, readdirSync, existsSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
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

// 后几节共用的 HTTP 夹具(第一次用到时才起):chat、xsession、sessions 三组路由与 index.js 同样挂在 /api 下。
let http = null;
async function api(method, path, body) {
  if (!http) {
    const { default: express } = await import('express');
    const { default: xsRoutes, xsessionBodyErrorHandler } = await import('../../server/routes/xsession.js');
    const { default: sessionRoutes } = await import('../../server/routes/sessions.js');
    const app = express();
    app.use(express.json());
    for (const r of [chat.default, xsRoutes, sessionRoutes]) app.use('/api', r);
    app.use('/api', xsessionBodyErrorHandler);
    let port = 0;
    for (let p = 6990; p >= 6900 && !port; p -= 1) {
      if (p === 6710) continue;
      if (await new Promise((r) => { const t = net.createServer().once('error', () => r(false)).once('listening', () => t.close(() => r(true))).listen(p, '127.0.0.1'); })) port = p;
    }
    if (!port) throw new Error('6900–6990 没有空闲端口');
    const server = await new Promise((r) => { const t = app.listen(port, '127.0.0.1', () => r(t)); });
    http = { port, server };
  }
  const init = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const r = await fetch(`http://127.0.0.1:${http.port}/api${path}`, init);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, body: json, text };
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 8000) {
  for (const t = Date.now(); Date.now() - t < ms;) { const v = await pred(); if (v) return v; await sleepMs(20); }
  throw new Error(`等不到:${what}`);
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

  // ── S2 + 判官建议 10:原生引导比对地址前规范化;Windows 管道地址、会话名不区分大小写 ─────────────────────────────
  {
    const { nativeGuardShouldDeny: deny } = xs;
    const entries = [
      { pid: 101, sessionId: A, name: 'proj-a1', messagingSocketPath: '/tmp/cc-socks/101.sock' },
      { pid: 103, sessionId: C, name: 'Proj-C3', messagingSocketPath: '/private/tmp/cc-socks/103.sock' },
      { pid: 105, sessionId: E, name: 'win-e5', messagingSocketPath: '\\\\.\\pipe\\Claude-Code-105' },
    ];
    const gui = [A, C, E];
    const bySock = (to) => ({ to, recipient: to, recipient_kind: 'session' });
    for (const [addr, want, what] of [
      ['uds:/tmp/cc-socks/103.sock', true, '登记表写 /private/tmp、目标写 /tmp'],
      ['uds:/tmp//cc-socks///103.sock', true, '重复斜杠'],
      ['uds:/tmp/cc-socks/../cc-socks/./103.sock', true, '带 .. 与 .'],
      ['uds:/private/tmp/../tmp/cc-socks/103.sock', true, '/private/tmp 里绕一圈'],
      ['uds:/tmp/../private/tmp/cc-socks/103.sock', true, '/tmp 里绕回 /private/tmp'],
      ['uds:/tmp/cc-socks/103.sock/', true, '结尾斜杠'],
      ['UDS:/tmp/cc-socks/103.sock', true, 'uds: 前缀不分大小写'],
      ['uds:\\\\.\\PIPE\\claude-code-105', true, 'Windows 命名管道不分大小写'],
      ['uds://./pipe/CLAUDE-CODE-105', true, 'Windows 命名管道斜杠方向不限'],
      ['uds:/tmp/cc-socks/101.sock', false, '发送方自己'],
      ['uds:/tmp/cc-socks/103.sock.bak', false, '只是前缀相同'],
      ['uds:/var/tmp/cc-socks/103.sock', false, '别的目录'],
      ['uds:/private/tmpx/cc-socks/103.sock', false, '/private/tmpx 不是 /private/tmp'],
      ['uds:/tmp/CC-SOCKS/103.sock', false, 'POSIX 路径区分大小写'],
      ['uds:cc-socks/103.sock', false, '相对路径'],
    ]) eq(deny(bySock(addr), entries, gui, A), want, `地址 ${addr}(${what})`);
    eq(deny({ to: 'uds:/tmp//cc-socks/../cc-socks/103.sock' }, entries, gui, A), true, '没有 recipient_kind 时按 uds: 推断,同样规范化');
    for (const [name, want] of [['PROJ-C3', true], ['proj-c3 [AB12]', true], ['Win-E5', true], ['proj-c', false], ['PROJ-A1', false]]) {
      eq(deny({ to: name, recipient: name, recipient_kind: 'name' }, entries, gui, A), want, `会话名 ${name} 不区分大小写比较`);
    }
    const dots = `uds:${'/..'.repeat(150)}/tmp/cc-socks/103.sock`; // 限长(512)以内的大量 ..
    eq(within(20, () => deny(bySock(dots), entries, gui, A), '规范化 150 个 ..'), true, '大量 .. 也规范化到同一处');
  }

  // ── S5 + 判官建议 6:启动恢复只删 <uuid>.txt 形状的孤儿正文、正文目录是符号链接时跳过;一并清掉本模块自己的临时文件 ──
  {
    // 每种场景用一份新的存储模块实例(URL 带查询串 = 新实例,cache 从空开始)和一个独立的 HOME(XS_DIR 在模块加载时定)
    const freshStore = async (tag, home) => {
      const prev = process.env.HOME;
      process.env.HOME = home; process.env.USERPROFILE = home;
      try { return await import(`../../server/services/xsession-store.js?${tag}`); } finally { process.env.HOME = prev; process.env.USERPROFILE = prev; }
    };
    const uid = (n) => `5e5e5e5e-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const DEAD = 99999990; // 不存在的 pid
    const msg = (id, status) => ({ id, createdAt: '2026-10-15T00:00:00.000Z', status, chainId: uid(900), hop: 1, from: { kind: 'user', sessionId: null, title: null },
      to: { sessionId: C, title: '丙' }, bodyBytes: 1, via: null, heldReason: status === 'pending' ? 'target-card' : null });

    // ① 正文目录是真目录
    const H1 = join(TMP, 'home-s5a'); const X1 = join(H1, '.claude-gui', 'xsession'); const B1 = join(X1, 'bodies');
    mkdirSync(B1, { recursive: true });
    writeFileSync(join(X1, 'messages.json'), JSON.stringify({ version: 1, messages: [msg(uid(1), 'pending'), msg(uid(2), 'done')] }));
    const files1 = {
      [`bodies/${uid(1)}.txt`]: true, // 未结束消息的正文:留
      [`bodies/${uid(2)}.txt`]: false, // 已结束消息的正文:孤儿,删
      [`bodies/${uid(3)}.txt`]: false, // 没有记录的 <uuid>.txt:孤儿,删
      'bodies/notes.txt': true, // 不是 <uuid>.txt 形状:不动
      [`bodies/${uid(4)}.TXT`]: true,
      [`bodies/x${uid(5)}.txt`]: true,
      [`bodies/${uid(6)}.txt.tmp.${DEAD}.3`]: false, // 本模块的临时文件、写它的进程已不在:删
      [`bodies/${uid(7)}.txt.tmp.${process.ppid}.1`]: true, // 写它的进程还活着(同一 HOME 的另一个实例):不动
      [`bodies/notes.txt.tmp.${DEAD}.1`]: true, // 不是本模块命名:不动
      [`messages.json.tmp.${DEAD}.12`]: false,
      [`messages.json.tmp.${process.pid}.99`]: false, // 本进程号(上一个同号进程留下的;本进程读盘时还没开始写):删
      [`messages.json.tmp.${process.ppid}.2`]: true,
      [`messages.json.tmp.${DEAD}`]: true, // 不是完整的临时文件名
      [`other.json.tmp.${DEAD}.1`]: true,
      [`messages.json.corrupt-1`]: true,
    };
    for (const f of Object.keys(files1)) writeFileSync(join(X1, f), 'x');
    const st1 = await freshStore('s5a', H1);
    eq((await st1.listXsMessages()).map((m) => m.id), [uid(1), uid(2)], '读盘恢复照常');
    for (const [f, keep] of Object.entries(files1)) eq(existsSync(join(X1, f)), keep, `启动恢复后 ${f} ${keep ? '留着' : '删掉'}`);

    // ② 正文目录是指向别处的符号链接:不跟着链接删(孤儿正文与临时文件都不动)
    const H2 = join(TMP, 'home-s5b'); const X2 = join(H2, '.claude-gui', 'xsession'); const OUT = join(TMP, 'outside-bodies');
    mkdirSync(X2, { recursive: true }); mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${uid(3)}.txt`), 'outside');
    writeFileSync(join(OUT, `${uid(6)}.txt.tmp.${DEAD}.3`), 'outside');
    symlinkSync(OUT, join(X2, 'bodies'));
    writeFileSync(join(X2, 'messages.json'), JSON.stringify({ version: 1, messages: [msg(uid(1), 'done')] }));
    const st2 = await freshStore('s5b', H2);
    eq((await st2.listXsMessages()).length, 1, '符号链接场景读盘照常');
    eq(readdirSync(OUT).sort(), [`${uid(3)}.txt`, `${uid(6)}.txt.tmp.${DEAD}.3`].sort(), '正文目录是符号链接 → 不清链接那头的文件');

    // ③ 头注释与实际一致(判官建议 5):不再声称"关着时不读不写"
    const head = readFileSync(new URL('../../server/services/xsession-store.js', import.meta.url), 'utf8').split('\n').slice(0, 25).join('\n');
    ok(!head.includes('关着时不读、不写、不建目录'), '存储层头注释不再写"关着时不读、不写、不建目录"');
  }

  // ── 判官建议 3:回合开始覆盖上一回合的记录前,上一回合若还没报过结束,先补报一次 ─────────────────────────────────
  {
    const log = [];
    const unhook = chat.registerSessionRuntimeHooks({ turnStart: (i) => log.push(['start', i]), turnEnd: (i) => log.push(['end', i]) });
    const brief = () => log.map(([k, i]) => [k, i.tag?.n, i.turnEpoch, i.outcome ?? null, i.errorSummary ?? null, i.pid]);
    const slot = { runId: 'sdk-j3', sessionId: A, cwd: WORK, turnEpoch: 1, seq: 7 };
    chat.notifyTurnStart(slot, 'sdk-j3', false, { n: 1 });
    slot.turnEpoch = 2; // 复用路径:回合代数先 +1,再通知回合开始
    chat.notifyTurnStart(slot, 'sdk-j3', true, { n: 2 });
    eq(brief(), [['start', 1, 1, null, null, 'sdk-j3'], ['end', 1, 1, 'failed', null, 'sdk-j3'], ['start', 2, 2, null, null, 'sdk-j3']],
      '上一回合没报过结束 → 先补报 failed(带它自己的 tag 与回合代数),再报新回合开始');
    slot.runtimeTurn.stopRequested = true;
    slot.turnEpoch = 3;
    chat.notifyTurnStart(slot, 'sdk-j3', true, { n: 3 });
    eq(brief().slice(3), [['end', 2, 2, 'stopped', null, 'sdk-j3'], ['start', 3, 3, null, null, 'sdk-j3']], '上一回合收到过停止请求 → 补报 stopped');
    slot.runtimeTurn.ended = true; // 正常收尾报过结束的
    slot.turnEpoch = 4;
    chat.notifyTurnStart(slot, 'sdk-j3', true, { n: 4 });
    eq(brief().slice(5), [['start', 4, 4, null, null, 'sdk-j3']], '上一回合已报过结束 → 不再补报');
    unhook();
  }

  // ── S8 + 判官建议 7:入口钩子改写过的回合,进程预览用固定文字"（跨会话消息）",不带信封与正文 ────────────────────
  {
    const ENVELOPE = '<cross-session-message from="gui:user" from-name="用户">\nR151B-机密正文-不该进预览\n</cross-session-message>';
    let rewrite = true;
    const unhook = chat.registerSessionRuntimeHooks({ chatEntry: () => (rewrite ? { prompt: ENVELOPE, tag: { r151b: 'preview' } } : null) });
    const previewOf = (pid) => chat.getActiveChatProcesses().find((p) => p.pid === pid)?.promptPreview;
    const idleOf = (pid) => chat.getActiveChatProcesses().find((p) => p.pid === pid && p.idle);
    const BODY = (extra) => ({ prompt: '（跨会话消息）', cwd: WORK, model: 'r151b-model', permissionMode: 'default', keepAlive: true, ...extra });
    let r = await api('POST', '/chat', BODY({}));
    eq(r.status, 200, '改写回合(冷启)起来了');
    const pid = r.body.pid;
    eq(previewOf(pid), '（跨会话消息）', '冷启:进程预览是固定文字');
    const sid = (await waitFor(() => idleOf(pid), '冷启回合收尾')).sessionId;
    r = await api('POST', '/chat', BODY({ sessionId: sid }));
    eq([r.status, r.body.reused, r.body.pid], [200, true, pid], '改写回合复用空闲进程');
    eq(previewOf(pid), '（跨会话消息）', '复用:进程预览是固定文字');
    ok(!JSON.stringify(chat.getActiveChatProcesses()).includes('R151B-机密正文'), '进程列表里任何字段都不带正文');
    await waitFor(() => idleOf(pid), '复用回合收尾');
    rewrite = false;
    r = await api('POST', '/chat', BODY({ sessionId: sid, prompt: '普通提问 R151B-plain' }));
    eq([r.body.reused, previewOf(pid)], [true, '普通提问 R151B-plain'], '没改写的回合照旧取提问原文');
    await waitFor(() => idleOf(pid), '普通回合收尾');
    unhook();
  }
} finally {
  try { await chat.closeAllPersistentProcesses(); } catch {}
  http?.server.close();
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`check-r151b-audit-fixes: ${passed} 项通过`);
process.exit(0);
