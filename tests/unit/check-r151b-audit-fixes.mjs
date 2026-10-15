#!/usr/bin/env node
// r151b 安全审计与判官之后的服务端修复(SECURITY-r151b I1 I2 S1 S2 S5 S7 S8;JUDGE 建议 2 3 5 6 7 10;
// 接口 2026-10-15 审计后补 / 判官后补)。每节对应一次提交;对长输入的处理都带耗时上限断言。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身,不起 claude 进程;临时 HOME;端口 6900–6990(跳过 6710)。
// node tests/unit/check-r151b-audit-fixes.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync, rmSync, readdirSync, existsSync, symlinkSync, readFileSync, statSync } from 'node:fs';
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
      // r151c 先修 3:macOS 默认文件系统不区分大小写,两边统一转小写 → 拒;其它 POSIX 平台仍区分大小写
      ['uds:/tmp/CC-SOCKS/103.sock', process.platform === 'darwin', process.platform === 'darwin' ? 'macOS 地址不区分大小写' : 'POSIX 路径区分大小写'],
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
    eq(brief(), [['start', 1, 1, null, null, 'sdk-j3'], ['end', 1, 1, 'stopped', null, 'sdk-j3'], ['start', 2, 2, null, null, 'sdk-j3']],
      '上一回合没报过结束 → 先补报 stopped(结算成 interrupted;带它自己的 tag 与回合代数),再报新回合开始');
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

  // ── 接口(审计后补):会话在本 GUI 里被删除时,已结束记录里该会话的标题抹成空字符串 ──────────────────────────────
  {
    const store = await import('../../server/services/xsession-store.js');
    const PROJ = '-r151b-audit-del';
    const projDir = join(HOME, '.claude', 'projects', PROJ);
    mkdirSync(projDir, { recursive: true });
    const S = '5a5a5a5a-0000-4000-8000-0000000000a1'; const T = '5b5b5b5b-0000-4000-8000-0000000000b2'; const O = '5c5c5c5c-0000-4000-8000-0000000000c3';
    // r151c 先修 5:O 也给记录文件 —— 记录文件不在 = 来源已删,忽略时会把来源标题抹掉;这一段要的是"O 还在"
    for (const sid of [S, T, O]) writeFileSync(join(projDir, `${sid}.jsonl`), `${JSON.stringify({ type: 'user', uuid: `${sid.slice(0, 8)}-u`, sessionId: sid, message: { role: 'user', content: '你好' } })}\n`);
    const rows = [{ sessionId: S, title: '源会话标题', projectDir: WORK }, { sessionId: T, title: '目标会话标题', projectDir: WORK }, { sessionId: O, title: '其它会话', projectDir: WORK }];
    const send = async (from, to) => (await xs.sendManualMessages({ to: [to], body: `R151B 删会话 ${from.slice(0, 2)}→${to.slice(0, 2)}`, fromSessionId: from }, rows))[0].id;
    const m1 = await send(S, T); // 未结束,来源 S
    const m2 = await send(S, O); await xs.dismissMessage(m2); // 已结束,来源 S
    const m3 = await send(O, T); await xs.dismissMessage(m3); // 已结束,目标 T
    const m4 = await send(O, S); // 未结束,目标 S → 删 S 时删掉
    const m5 = await send(T, O); // 未结束,来源 T
    const titles = async () => Object.fromEntries((await store.listXsMessages()).map((m) => [m.id, [m.status, m.from.title, m.to.title]]));
    let r = await api('DELETE', `/sessions/${S}?projectHash=${PROJ}`);
    eq(r.status, 200, '删会话 S');
    let t = await titles();
    eq([t[m1], t[m2], t[m3], t[m4], t[m5]], [
      ['pending', '源会话标题', '目标会话标题'], // 以 S 为来源、未结束:卡片还要用来源标题,不动
      ['dismissed', '', '其它会话'], // 已结束、来源是 S → 来源标题抹空
      ['dismissed', '其它会话', '目标会话标题'],
      undefined, // 以 S 为目标、未结束 → 删除(既有行为)
      ['pending', '目标会话标题', '其它会话'],
    ], '删 S:已结束记录里 S 的标题抹成空串,其余不动');
    r = await api('DELETE', `/sessions/${T}?projectHash=${PROJ}`);
    t = await titles();
    eq([t[m1], t[m2], t[m3], t[m5]], [undefined, ['dismissed', '', '其它会话'], ['dismissed', '其它会话', ''], ['pending', '目标会话标题', '其它会话']],
      '删 T:以 T 为目标的未结束消息删除;已结束记录里 T 的标题抹空;以 T 为来源的未结束消息不动');
    const pub = (await xs.listInboxMessages({ sessionId: O, statuses: new Set(['dismissed']) })).find((m) => m.id === m2);
    eq(pub.from.title, '', '对外的消息对象里 from.title 为空字符串');
    await xs.dismissMessage(m5); // 收尾:不给后面几节留未结束的消息
  }

  // ── 接口(审计后补):GET config 的 stored.unfinished;POST /api/xsession/clear ─────────────────────────────────────
  {
    const store = await import('../../server/services/xsession-store.js');
    const GUI = join(HOME, '.claude-gui'); const XSD = join(GUI, 'xsession'); const BOD = join(XSD, 'bodies');
    const tree = (d) => { const out = []; const walk = (x) => { if (!existsSync(x)) return; for (const e of readdirSync(x, { withFileTypes: true })) { const p = join(x, e.name); if (e.isDirectory()) walk(p); else out.push(`${p.slice(XSD.length + 1)} ${statSync(p).mtimeMs}`); } }; walk(d); return out.sort(); };
    const CLEAR_409 = { ok: false, code: 'XS_CLEAR_WHILE_ENABLED', error: '请先关闭跨会话消息，或在卡片上逐条处理' };
    const P = 'p1p1p1p1-0000-4000-8000-000000000001'.replace(/p/g, '6'); const Q = '77777777-0000-4000-8000-000000000002';
    const rows = [{ sessionId: P, title: '甲', projectDir: WORK }, { sessionId: Q, title: '乙', projectDir: WORK }];

    setEnabled(true);
    let r = await api('POST', '/xsession/clear');
    eq([r.status, r.body], [409, CLEAR_409], '开关开着:clear → 409 XS_CLEAR_WHILE_ENABLED,错误体逐字');
    const [n1] = await xs.sendManualMessages({ to: [P], body: 'R151B clear 一', fromSessionId: Q }, rows);
    const [n2] = await xs.sendManualMessages({ to: [Q], body: 'R151B clear 二', fromSessionId: P }, rows);
    await xs.claimMessage(n2.id); // pending 1 + claimed 1 = 未结束 2;前几节留下的都已结束
    const all = await store.listXsMessages();
    eq(all.filter((m) => store.isOpenStatus(m.status)).length, 2, '前置:未结束 2 条');
    r = await api('GET', '/xsession/config');
    eq([r.status, r.body.enabled, r.body.stored], [200, true, { unfinished: 2 }], '开着时也带 stored');
    setEnabled(false);
    r = await api('GET', '/xsession/config');
    eq([r.status, r.body.enabled, r.body.stored], [200, false, { unfinished: 2 }], '关着:stored.unfinished = 未结束条数(已结束的不算)');
    eq(Object.keys(r.body).sort(), ['enabled', 'limits', 'nativeGuard', 'stored'], 'config 应答的键');
    eq((await api('GET', '/xsession/pending')).status, 409, '关着:其它接口照旧 409');
    eq([(await api('GET', '/xsession/clear')).status, (await api('PUT', '/xsession/clear', {})).status], [409, 409], '关着:clear 只放行 POST,别的方法照旧 409');

    // 摆上损坏留存、本模块的临时文件、不是本模块的文件、xsession 以外的兄弟目录
    writeFileSync(join(XSD, 'messages.json.corrupt-123'), '{坏');
    writeFileSync(join(XSD, `messages.json.tmp.${process.pid}.77`), '{}');
    writeFileSync(join(BOD, `${'8'.repeat(8)}-0000-4000-8000-000000000008.txt`), '孤儿正文');
    writeFileSync(join(BOD, `${n1.id}.txt.tmp.99999990.1`), '半截');
    writeFileSync(join(BOD, 'notes.txt'), '不是正文');
    writeFileSync(join(XSD, 'README'), '不是本模块的');
    mkdirSync(join(GUI, 'xsession-keep'), { recursive: true });
    writeFileSync(join(GUI, 'xsession-keep', 'keep.txt'), 'keep');
    const prefsBefore = readFileSync(join(GUI, 'prefs.json'), 'utf8');
    ok(existsSync(join(BOD, `${n1.id}.txt`)) && existsSync(join(BOD, `${n2.id}.txt`)), '前置:未结束消息的正文在');

    r = await api('POST', '/xsession/clear', { r151b: '请求体忽略' });
    eq([r.status, r.body], [200, { ok: true, removed: all.length }], '关着:clear → 200 {ok, removed: 消息总条数(含已结束)}');
    eq(tree(XSD), [`README ${statSync(join(XSD, 'README')).mtimeMs}`, `bodies/notes.txt ${statSync(join(BOD, 'notes.txt')).mtimeMs}`].sort(),
      '收件箱记录、全部正文与正文临时文件、损坏留存、记录临时文件都删了;不是本模块命名的不动');
    eq([readFileSync(join(GUI, 'xsession-keep', 'keep.txt'), 'utf8'), readFileSync(join(GUI, 'prefs.json'), 'utf8')], ['keep', prefsBefore], 'xsession 以外不动');

    const t0 = tree(XSD);
    r = await api('GET', '/xsession/config');
    eq(r.body.stored, { unfinished: 0 }, '清空后 stored 为 0');
    eq(tree(XSD), t0, '读 stored 不产生文件');
    r = await api('POST', '/xsession/clear');
    eq([r.status, r.body], [200, { ok: true, removed: 0 }], '已清空再 clear → removed 0');
    r = await api('POST', '/xsession/clear', '{坏的 JSON');
    eq([r.status, r.body], [200, { ok: true, removed: 0 }], '请求体不是合法 JSON 也照常处理(请求体本来就忽略)');
    eq(tree(XSD), t0, '收件箱不存在时 clear 不新建文件');
    setEnabled(true);
    eq([(await xs.listInboxMessages({ sessionId: P, statuses: new Set(store.XS_STATUSES) })).length, (await xs.listInboxMessages({ sessionId: Q, statuses: new Set(store.XS_STATUSES) })).length],
      [0, 0], '重新打开后一条消息都没有(内存里的也清了)');
    const [n3] = await xs.sendManualMessages({ to: [P], body: 'R151B clear 三', fromSessionId: Q }, rows);
    setEnabled(false);

    // 删除失败 → 500 STORAGE_WRITE_FAILED,数据不变
    chmodSync(XSD, 0o500);
    try {
      r = await api('POST', '/xsession/clear');
      eq([r.status, r.body?.code], [500, 'STORAGE_WRITE_FAILED'], '删不掉 → 500 STORAGE_WRITE_FAILED');
    } finally { chmodSync(XSD, 0o700); }
    eq((await api('GET', '/xsession/config')).body.stored, { unfinished: 1 }, '删除失败时数据不变');
    eq((await store.listXsMessages()).map((m) => m.id), [n3.id], '删除失败时记录不变');
    eq((await api('POST', '/xsession/clear')).body, { ok: true, removed: 1 }, '恢复权限后可以清空');

    // 只读计数:另一份存储实例(没读过盘)直接数文件,不做恢复、不挪损坏文件、不写
    const freshStore = async (tag, home) => {
      const prev = process.env.HOME;
      process.env.HOME = home; process.env.USERPROFILE = home;
      try { return await import(`../../server/services/xsession-store.js?${tag}`); } finally { process.env.HOME = prev; process.env.USERPROFILE = prev; }
    };
    const H3 = join(TMP, 'home-stored'); const X3 = join(H3, '.claude-gui', 'xsession');
    mkdirSync(join(X3, 'bodies'), { recursive: true });
    const rec = (id, status) => ({ id, status, to: { sessionId: P } });
    const recs = [rec('31313131-0000-4000-8000-000000000001', 'claimed'), rec('31313131-0000-4000-8000-000000000002', 'processing'), rec('31313131-0000-4000-8000-000000000003', 'done'), { id: 'bad' }];
    writeFileSync(join(X3, 'messages.json'), JSON.stringify({ version: 1, messages: recs }));
    writeFileSync(join(X3, 'bodies', '31313131-0000-4000-8000-000000000009.txt'), '孤儿');
    const st3 = await freshStore('stored-a', H3);
    const before3 = tree(X3).join('|');
    eq(await st3.countUnfinishedXsMessages(), 2, '没读过盘:直接数文件里的未结束条数(不合规的记录不算)');
    eq([tree(X3).join('|'), JSON.parse(readFileSync(join(X3, 'messages.json'), 'utf8')).messages], [before3, recs], '只读:不做恢复、不清孤儿、不写');
    writeFileSync(join(X3, 'messages.json'), '{坏的');
    eq(await st3.countUnfinishedXsMessages(), 0, '文件损坏 → 0');
    ok(!readdirSync(X3).some((f) => f.includes('corrupt')), '只读:损坏文件不挪走');
    const st4 = await freshStore('stored-b', join(TMP, 'home-none'));
    eq(await st4.countUnfinishedXsMessages(), 0, '文件不存在 → 0');
    eq(await st4.clearXsInbox(), 0, '文件不存在时清空 → 0');
    ok(!existsSync(join(TMP, 'home-none')), '文件不存在时读计数与清空都不建任何目录');

    // 正文目录是符号链接:clear 不跟进去
    const H5 = join(TMP, 'home-clear-link'); const X5 = join(H5, '.claude-gui', 'xsession'); const OUT5 = join(TMP, 'outside-clear');
    mkdirSync(X5, { recursive: true }); mkdirSync(OUT5, { recursive: true });
    writeFileSync(join(OUT5, '31313131-0000-4000-8000-000000000001.txt'), 'outside');
    symlinkSync(OUT5, join(X5, 'bodies'));
    writeFileSync(join(X5, 'messages.json'), JSON.stringify({ version: 1, messages: [rec('31313131-0000-4000-8000-000000000001', 'pending')] }));
    const st5 = await freshStore('clear-link', H5);
    eq(await st5.clearXsInbox(), 1, '符号链接场景:记录照删');
    eq([existsSync(join(X5, 'messages.json')), readdirSync(OUT5)], [false, ['31313131-0000-4000-8000-000000000001.txt']], '正文目录是符号链接 → 不删链接那头的文件');
  }

  // ── 接口(审计后补):GET /api/xsession/sessions 每项带 projectHash(该会话项目目录的编码名,与历史接口同一口径)────
  {
    setEnabled(true);
    const seedIn = (cwd, sid, prompt, ageMin) => {
      const hash = cwd.replace(/[^A-Za-z0-9]/g, '-');
      const dir = join(HOME, '.claude', 'projects', hash);
      mkdirSync(dir, { recursive: true }); mkdirSync(cwd, { recursive: true });
      const at = new Date(Date.now() - ageMin * 60_000).toISOString();
      const base = { cwd, sessionId: sid, timestamp: at, isSidechain: false, userType: 'external' };
      const lines = [
        { ...base, type: 'user', uuid: `${sid.slice(0, 8)}-u0`, parentUuid: null, message: { role: 'user', content: prompt } },
        { ...base, type: 'assistant', uuid: `${sid.slice(0, 8)}-a1`, parentUuid: `${sid.slice(0, 8)}-u0`, message: { id: `m-${sid.slice(0, 8)}`, type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: '好' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
        { ...base, type: 'user', uuid: `${sid.slice(0, 8)}-u2`, parentUuid: `${sid.slice(0, 8)}-a1`, message: { role: 'user', content: '再问一句' } },
      ];
      writeFileSync(join(dir, `${sid}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
      return hash;
    };
    const W1 = join(TMP, 'ws', 'proj-one'); const W2 = join(TMP, 'ws', 'proj.two_2');
    const s1 = '91919191-0000-4000-8000-000000000001'; const s2 = '92929292-0000-4000-8000-000000000002';
    const h1 = seedIn(W1, s1, 'R151B 项目一的提问', 2); const h2 = seedIn(W2, s2, 'R151B 项目二的提问', 1);
    let r = await api('GET', '/xsession/sessions');
    eq(r.status, 200, 'GET sessions');
    const by = Object.fromEntries(r.body.sessions.map((s) => [s.sessionId, s]));
    eq([by[s1]?.projectHash, by[s2]?.projectHash], [h1, h2], '每项的 projectHash = 项目目录的编码名');
    ok(r.body.sessions.every((s) => typeof s.projectHash === 'string' && s.projectHash.length > 0), '每项都带 projectHash');
    eq(Object.keys(by[s1]).sort(), ['lastActivity', 'pending', 'project', 'projectHash', 'sessionId', 'shortId', 'state', 'title'], '单项的键(projectDir 等服务端字段不出现)');
    const hist = await api('GET', `/sessions/${s2}/messages?projectHash=${encodeURIComponent(by[s2].projectHash)}`);
    eq(hist.status, 200, '拿 projectHash 调既有历史接口能取到这个会话');
    r = await api('GET', `/xsession/sessions?ids=${s2}`);
    eq(r.body.sessions.map((s) => [s.sessionId, s.projectHash]), [[s2, h2]], '按 ids 查单个会话也带 projectHash');
    setEnabled(false);
  }
} finally {
  try { await chat.closeAllPersistentProcesses(); } catch {}
  http?.server.close();
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`check-r151b-audit-fixes: ${passed} 项通过`);
process.exit(0);
