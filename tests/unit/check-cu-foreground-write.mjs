#!/usr/bin/env node
// C2 / 前台授权写入侧:HTTP 越权、凭证、限时、迁移与审计(W1–W9)+ 客户端源码守卫(W10–W12)。
//
// 做法与 r154 同口径:路由 handler 与 setGrant 都在假家目录子进程里跑(预加载改 os.userInfo),
// 不 listen、不碰真实 ~/.claude-gui;不起应用、不做任何前台/鼠标/键盘动作。
//
// 跑法:node tests/unit/check-cu-foreground-write.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const report = makeReport('check-cu-foreground-write');
const PRELOAD = pathToFileURL(join(HERE, 'q8-helpers', 'cu-preload.mjs')).href;
const ROUTE_URL = pathToFileURL(join(ROOT, 'server', 'routes', 'computer-use.js')).href;
const CU_URL = pathToFileURL(join(ROOT, 'server', 'computer-use', 'cu-common.js')).href;
const TOKEN_URL = pathToFileURL(join(ROOT, 'server', 'computer-use', 'grant-token.js')).href;
const CLIENT = join(ROOT, 'client', 'src', 'components', 'CuGrants.jsx');

function runIsolated(script) {
  const base = fs.mkdtempSync(join(os.tmpdir(), 'c2-fg-write-'));
  try {
    const r = spawnSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env, CU_TEST_HOME: base,
        C2_ROUTE: ROUTE_URL, C2_CU: CU_URL, C2_TOKEN: TOKEN_URL,
      },
      timeout: 90_000,
    });
    let out = null;
    try { out = JSON.parse(String(r.stdout).trim().split('\n').pop() || 'null'); } catch { out = null; }
    return { out, stdout: String(r.stdout), stderr: String(r.stderr) };
  } finally {
    fs.rmSync(base, { recursive: true, force: true }); // 只删本测试自己建的临时目录
  }
}

const SCRIPT = `
import fs from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
fs.mkdirSync(join(process.env.CU_TEST_HOME, '.claude-gui', 'cu-runtime'), { recursive: true });
const CU = await import(process.env.C2_CU);
const { default: router } = await import(process.env.C2_ROUTE);
const { getGrantToken } = await import(process.env.C2_TOKEN);
const token = getGrantToken();

const postLayer = router.stack.find((l) => l.route && l.route.path === '/computer-use/grants' && l.route.methods.post);
const getLayer = router.stack.find((l) => l.route && l.route.path === '/computer-use/grants' && l.route.methods.get);
const post = postLayer.route.stack[0].handle;
const get = getLayer.route.stack[0].handle;

const warns = [];
console.warn = (...a) => { warns.push(format(...a)); };

async function callPost(body, credential = 'none') {
  warns.length = 0;
  const headers = credential === 'ok' ? { 'x-cgui-grant-token': token }
    : credential === 'bad' ? { 'x-cgui-grant-token': 'not-the-token' } : {};
  const res = { statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let threw = null;
  try { await post({ body, headers }, res, () => {}); } catch (e) { threw = String(e && e.message || e); }
  return { threw, status: res.statusCode, body: res.body, code: res.body && res.body.code, warns: [...warns] };
}
async function callGet() {
  const res = { statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await get({ headers: {} }, res, () => {});
  return res.body;
}
const bytes = () => fs.readFileSync(CU.GRANTS_FILE, 'utf8');
const entry = (id) => CU.readGrants().apps[id] || null;
async function rowOf(id) {
  const d = await callGet();
  return (d.apps || []).find((a) => a.bundleId === id) || null;
}
const A = 'com.example.granted';
const B = 'com.example.other';
const out = {};

// 起始:只授 A(带凭证)
CU.setGrant({ bundleId: A, granted: true }, { panelCredential: true });

// W1 无凭证开前台
let before = bytes();
out.w1 = await callPost({ bundleId: A, foreground: true });
out.w1.fileUnchanged = bytes() === before;

// W2 带凭证开前台(默认 60 分钟)+ GET 回显
before = bytes();
out.w2 = await callPost({ bundleId: A, foreground: true }, 'ok');
out.w2.entry = entry(A);
out.w2.row = await rowOf(A);

// W3 对未授权应用开前台
before = bytes();
out.w3 = await callPost({ bundleId: B, foreground: true }, 'ok');
out.w3.fileUnchanged = bytes() === before;

// W4 关前台不需要凭证
before = bytes();
out.w4 = await callPost({ bundleId: A, foreground: false });
out.w4.entry = entry(A);

// W5 foregroundMinutes 非法 / 合法边界
out.w5 = [];
for (const m of [0, -1, 241, 0.5, '60']) {
  const r = await callPost({ bundleId: A, foreground: true, foregroundMinutes: m }, 'ok');
  out.w5.push({ minutes: m, status: r.status, code: r.code });
}
out.w5ok = [];
for (const m of [5, 240]) {
  const r = await callPost({ bundleId: A, foreground: true, foregroundMinutes: m }, 'ok');
  const e = entry(A);
  out.w5ok.push({ minutes: m, status: r.status, expiresAt: e && e.foreground && e.foreground.expiresAt });
}

// W6 重授应用不带 foreground:原值保留
const keep = entry(A).foreground;
out.w6 = await callPost({ bundleId: A, granted: true, name: 'Renamed' }, 'ok');
out.w6.entry = entry(A);
out.w6.keep = keep;

// W7 撤销应用:整条删除
out.w7 = await callPost({ bundleId: A, granted: false });
out.w7.entry = entry(A);

// W8 审计日志
out.w8 = { open: (await callPost({ bundleId: A, foreground: true }, 'ok')).warns.slice(-2),
           close: (await callPost({ bundleId: A, foreground: false })).warns.slice(-2),
           token };

// W9 setGrant 内部路径不带 panelCredential 开前台
CU.setGrant({ bundleId: A, granted: true }, { panelCredential: true });
let w9err = null;
try { CU.setGrant({ bundleId: A, foreground: true }, {}); } catch (e) { w9err = { code: e.code, message: e.message }; }
out.w9 = w9err;

// W13 自相矛盾的请求(撤销应用 + 开前台,带凭证):必须整条拒绝,不能吞掉撤销、反而把前台打开
CU.setGrant({ bundleId: A, granted: true }, { panelCredential: true });
before = bytes();
out.w13 = await callPost({ bundleId: A, granted: false, foreground: true }, 'ok');
out.w13.fileUnchanged = bytes() === before;
let w13err = null;
try { CU.setGrant({ bundleId: A, granted: false, foreground: true }, { panelCredential: true }); } catch (e) { w13err = { code: e.code }; }
out.w13.direct = w13err;
out.w13.directUnchanged = bytes() === before;
out.w13.entryAfter = entry(A);

// W14 撤销应用 + 显式 foreground:false:照旧撤销(新校验不能误伤)
CU.setGrant({ bundleId: A, granted: true }, { panelCredential: true });
out.w14 = await callPost({ bundleId: A, granted: false, foreground: false });
out.w14.entry = entry(A);

process.stdout.write(JSON.stringify(out) + '\\n');
`;

const r = runIsolated(SCRIPT);
const out = r.out;
const diag = () => `stdout=${r.stdout.slice(0, 300)} stderr=${r.stderr.slice(0, 600)}`;

await report.check('C2-W1', 'HTTP 越权:不带面板凭证开前台 → 403 CU_GRANT_FORBIDDEN,授权文件字节不变', 'green', () => {
  assert.ok(out, `子进程没有输出 JSON:${diag()}`);
  assert.equal(out.w1.status, 403, `状态码 ${out.w1.status},应为 403`);
  assert.equal(out.w1.code, 'CU_GRANT_FORBIDDEN', `错误码 ${out.w1.code}`);
  assert.equal(out.w1.fileUnchanged, true, '被拒绝的请求改了 grants.json');
});

await report.check('C2-W2', '带正确凭证开前台:200,写入 foreground.expiresAt ≈ now+60min,GET 回显 granted:true', 'red', () => {
  assert.equal(out.w2.status, 200, `状态码 ${out.w2.status}`);
  const fg = out.w2.entry && out.w2.entry.foreground;
  assert.ok(fg && typeof fg.expiresAt === 'string', `文件里没有 foreground:${JSON.stringify(out.w2.entry)}`);
  const delta = Date.parse(fg.expiresAt) - Date.now();
  assert.ok(delta > 55 * 60_000 && delta <= 61 * 60_000, `expiresAt 不在 60 分钟附近:${delta}ms`);
  assert.equal(out.w2.row && out.w2.row.foreground && out.w2.row.foreground.granted, true,
    `GET 没有回显 foreground.granted:${JSON.stringify(out.w2.row)}`);
});

await report.check('C2-W3', '对未授权应用开前台 → 400 CU_INVALID_ARGUMENT,文件不变', 'red', () => {
  assert.equal(out.w3.status, 400, `状态码 ${out.w3.status}`);
  assert.equal(out.w3.code, 'CU_INVALID_ARGUMENT', `错误码 ${out.w3.code}`);
  assert.equal(out.w3.fileUnchanged, true, '被拒绝的请求改了 grants.json');
});

await report.check('C2-W4', 'foreground:false 不带凭证 → 200,字段被删', 'red', () => {
  assert.equal(out.w4.status, 200, `状态码 ${out.w4.status}`);
  assert.ok(!(out.w4.entry && out.w4.entry.foreground), `字段还在:${JSON.stringify(out.w4.entry)}`);
});

await report.check('C2-W5', 'foregroundMinutes 非法(0/-1/241/小数/字符串)→ 400;5 与 240 通过', 'red', () => {
  for (const x of out.w5) assert.equal(x.status, 400, `minutes=${JSON.stringify(x.minutes)} 得到 ${x.status},应为 400`);
  for (const x of out.w5ok) {
    assert.equal(x.status, 200, `minutes=${x.minutes} 被拒:${x.status}`);
    const delta = Date.parse(x.expiresAt) - Date.now();
    assert.ok(delta > (x.minutes - 1) * 60_000 && delta <= (x.minutes + 1) * 60_000,
      `minutes=${x.minutes} 写入的 expiresAt 偏差过大:${delta}ms`);
  }
});

await report.check('C2-W6', '重授应用(不带 foreground)→ 原前台授权逐字保留', 'red', () => {
  assert.equal(out.w6.status, 200, `状态码 ${out.w6.status}`);
  const now = out.w6.entry && out.w6.entry.foreground;
  assert.ok(now && now.expiresAt === out.w6.keep.expiresAt,
    `重授冲掉了前台授权:${JSON.stringify(out.w6.keep)} → ${JSON.stringify(now)}`);
});

await report.check('C2-W7', '撤销应用 → 整条 entry 删除,前台授权一并消失', 'green', () => {
  assert.equal(out.w7.status, 200, `状态码 ${out.w7.status}`);
  assert.equal(out.w7.entry, null, `entry 还在:${JSON.stringify(out.w7.entry)}`);
});

await report.check('C2-W8', '审计日志含 foreground=yes/no,且不含凭证值', 'red', () => {
  const open = (out.w8.open || []).join('\n');
  const close = (out.w8.close || []).join('\n');
  assert.match(open, /foreground=yes/, `开前台日志没有 foreground=yes:${open}`);
  assert.match(close, /foreground=no/, `关前台日志没有 foreground=no:${close}`);
  assert.ok(!open.includes(out.w8.token) && !close.includes(out.w8.token), '审计日志里出现了凭证原值');
});

await report.check('C2-W9', 'setGrant 内部路径不带 panelCredential 开前台 → CU_GRANT_FORBIDDEN', 'green', () => {
  assert.ok(out.w9, 'setGrant 没有抛错,内部调用方可以静默扩权');
  assert.equal(out.w9.code, 'CU_GRANT_FORBIDDEN', `错误码 ${out.w9.code}`);
});

await report.check('C2-W13', '自相矛盾的请求(撤销应用 + 开前台):400 CU_INVALID_ARGUMENT,授权文件字节不变;setGrant 直调同样抛错', 'red', () => {
  assert.ok(out, `子进程没有输出 JSON:${diag()}`);
  assert.equal(out.w13.status, 400, `状态码 ${out.w13.status},应为 400(撤销被吞、前台被打开:${JSON.stringify(out.w13.entryAfter)})`);
  assert.equal(out.w13.code, 'CU_INVALID_ARGUMENT', `错误码 ${out.w13.code}`);
  assert.equal(out.w13.fileUnchanged, true, '被拒的请求不该改授权文件');
  assert.ok(out.w13.direct, 'setGrant 直调没有抛错');
  assert.equal(out.w13.direct.code, 'CU_INVALID_ARGUMENT', `直调错误码 ${out.w13.direct && out.w13.direct.code}`);
  assert.equal(out.w13.directUnchanged, true, 'setGrant 直调被拒前不该写文件');
});

await report.check('C2-W14', '撤销应用 + 显式 foreground:false:照旧撤销(新校验不误伤)', 'green', () => {
  assert.equal(out.w14.status, 200, `状态码 ${out.w14.status}`);
  assert.equal(out.w14.entry, null, `entry 还在:${JSON.stringify(out.w14.entry)}`);
});

await report.check('C2-W15', '只关前台的请求,审计日志标成撤销(revoke),不是授权(grant)', 'red', () => {
  const log = (out.w4.warns || []).join('\n');
  assert.match(log, /\[cu-grants\] revoke ok/, `只关前台被记成了授权:${log}`);
  assert.ok(!/\[cu-grants\] grant /.test(log), `审计日志里出现了 grant:${log}`);
});

// ── 客户端源码守卫(W10–W12)──────────────────────────────────────────────
const clientSrc = fs.readFileSync(CLIENT, 'utf8');

await report.check('C2-W10', 'CuGrants 的 positive 判定包含 foreground === true(无凭证时不发请求)', 'red', () => {
  assert.match(clientSrc, /positive\s*=[^\n]*foreground\s*===\s*true/,
    'postGrant 的 positive 判定没有把 foreground:true 算作正向意图');
});

await report.check('C2-W11', '开启前台前必须 confirmDialog(testId: cu-foreground-confirm)', 'red', () => {
  assert.match(clientSrc, /cu-foreground-confirm/, '没有前台授权的确认框 testId');
  assert.match(clientSrc, /confirmDialog\([^)]*cu-foreground-confirm/s, '确认框不是用 confirmDialog 打开的');
});

await report.check('C2-W12', '成功后用响应整体覆盖(不做乐观更新),关闭路径不带凭证', 'red', () => {
  assert.match(clientSrc, /setGrants\(\{\s*screenScope:\s*d\.screenScope/,
    '成功后没有用服务端响应覆盖本地状态(疑似乐观更新)');
  assert.match(clientSrc, /foreground:\s*false/, '没有关闭前台的路径');
});

process.exitCode = report.finish();
