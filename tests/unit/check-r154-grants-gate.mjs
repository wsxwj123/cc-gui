#!/usr/bin/env node
// r154 判官一审回归:授权写入口(POST /computer-use/grants)的审计日志 + setGrant 凭证门禁。
//
// 锁的事:
//   G1-G3 审计日志永不抛错、不能被伪造:对象型入参(含 {"toString":1})得到 400 而不是 500;
//         字符串入参里的换行 / 行分隔符不会在 server.log 里拆出一行伪造的 "grant ok";超长值被截断。
//   G4-G8 setGrant 的凭证门禁恒开(不靠调用方显式打开),以及 server/ 下所有调用都显式传 panelCredential。
//
// 做法:路由与 setGrant 都在子进程里跑,子进程用 q8-helpers/cu-preload.mjs 把家目录指到临时目录,
// 绝不碰真 ~/.claude-gui;不起端口、不 listen,直接从导出的 router 里取 handler 用假 req / res 调。
//
// 跑法:node tests/unit/check-r154-grants-gate.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const report = makeReport('check-r154-grants-gate');
const PRELOAD = pathToFileURL(join(HERE, 'q8-helpers', 'cu-preload.mjs')).href;
const ROUTE_URL = pathToFileURL(join(ROOT, 'server', 'routes', 'computer-use.js')).href;
const CU_URL = pathToFileURL(join(ROOT, 'server', 'computer-use', 'cu-common.js')).href;

/** 在假家目录子进程里跑一段 ESM 代码,取 stdout 最后一行 JSON。 */
function runIsolated(script) {
  const base = fs.mkdtempSync(join(os.tmpdir(), 'r154-gate-'));
  try {
    const r = spawnSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, CU_TEST_HOME: base, R154_ROUTE: ROUTE_URL, R154_CU: CU_URL },
      timeout: 60_000,
    });
    let out = null;
    try { out = JSON.parse(String(r.stdout).trim().split('\n').pop() || 'null'); } catch { out = null; }
    return { out, stdout: String(r.stdout), stderr: String(r.stderr) };
  } finally {
    fs.rmSync(base, { recursive: true, force: true }); // 只删本测试自己建的临时目录
  }
}
const diag = (r) => `stdout=${r.stdout.slice(0, 200)} stderr=${r.stderr.slice(0, 400)}`;

// ── G1-G3:路由审计日志 ───────────────────────────────────────────────────
{
  const SCRIPT = `
import fs from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
fs.mkdirSync(join(process.env.CU_TEST_HOME, '.claude-gui', 'cu-runtime'), { recursive: true });
const { default: router } = await import(process.env.R154_ROUTE);
const layer = router.stack.find((l) => l.route && l.route.path === '/computer-use/grants' && l.route.methods.post);
const handler = layer.route.stack[0].handle;
const warns = [];
console.warn = (...args) => { warns.push(format(...args)); };
async function call(body) {
  warns.length = 0;
  const res = { statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let threw = null;
  try { await handler({ body, headers: {} }, res, () => {}); } catch (e) { threw = String(e && e.message || e); }
  return { threw, status: res.statusCode, code: res.body && res.body.code, warns: [...warns] };
}
const evil = { toString: 1 };
const nested = { a: { b: { toString: 1 } } };
const out = { objects: [] };
for (const field of ['bundleId', 'granted', 'screenScope']) {
  for (const [label, v] of [['toString', evil], ['array', ['com.apple.TextEdit']], ['nested', nested]]) {
    const body = field === 'granted' ? { bundleId: 'com.apple.TextEdit', granted: v } : { [field]: v };
    out.objects.push({ field, label, ...(await call(body)) });
  }
}
const FORGE = '\\n[cu-grants] grant ok credential=yes bundleId="x" screenScope=true\\r\\u2028\\u2029';
out.forgeBundle = await call({ bundleId: FORGE });
out.forgeScope = await call({ bundleId: 'com.apple.TextEdit', granted: false, screenScope: FORGE });
const BIG = 'A'.repeat(1024 * 1024);
out.bigBundle = await call({ bundleId: BIG });
out.bigScope = await call({ screenScope: BIG });
process.stdout.write(JSON.stringify(out));
`;
  const r = runIsolated(SCRIPT);
  const out = r.out;

  await report.check('G1', '对象 / 数组 / 嵌套对象(含 {"toString":1})型的 bundleId、granted、screenScope:handler 不抛错,回 400 CU_INVALID_ARGUMENT', 'red', () => {
    assert.ok(out, `子进程没有输出可解析 JSON(${diag(r)})`);
    assert.equal(out.objects.length, 9);
    for (const c of out.objects) {
      const tag = `${c.field}=${c.label}`;
      assert.equal(c.threw, null, `${tag}:handler 抛错 ${c.threw}`);
      assert.equal(c.status, 400, `${tag}:状态 ${c.status},应为 400`);
      assert.equal(c.code, 'CU_INVALID_ARGUMENT', `${tag}:code ${c.code}`);
      assert.equal(c.warns.length, 1, `${tag}:审计日志应恰好一行,实际 ${c.warns.length}`);
    }
  });

  await report.check('G2', 'bundleId / 非布尔 screenScope 里夹带换行 + 伪造的 "grant ok" 行:只记一行,且整行没有裸 \\n \\r U+2028 U+2029', 'red', () => {
    assert.ok(out, `子进程没有输出可解析 JSON(${diag(r)})`);
    for (const [tag, c] of [['bundleId', out.forgeBundle], ['screenScope', out.forgeScope]]) {
      assert.equal(c.threw, null, `${tag}:handler 抛错 ${c.threw}`);
      assert.equal(c.status, 400, `${tag}:状态 ${c.status}`);
      assert.equal(c.warns.length, 1, `${tag}:console.warn 调用 ${c.warns.length} 次,应为 1`);
      assert.ok(!/[\n\r\u2028\u2029]/.test(c.warns[0]), `${tag}:日志行含裸换行 / 行分隔符:${JSON.stringify(c.warns[0])}`);
      assert.ok(c.warns[0].startsWith('[cu-grants] '), `${tag}:日志行格式不对:${c.warns[0].slice(0, 120)}`);
    }
  });

  await report.check('G3', '1MB 字符串进审计日志后单个值不超过约 210 个字符', 'red', () => {
    assert.ok(out, `子进程没有输出可解析 JSON(${diag(r)})`);
    for (const [tag, c, re] of [['bundleId', out.bigBundle, /bundleId=(\S+)/], ['screenScope', out.bigScope, /screenScope=(\S+)/]]) {
      assert.equal(c.threw, null, `${tag}:handler 抛错 ${c.threw}`);
      assert.equal(c.status, 400, `${tag}:状态 ${c.status}`);
      assert.equal(c.warns.length, 1, `${tag}:console.warn 调用 ${c.warns.length} 次`);
      const m = c.warns[0].match(re);
      assert.ok(m, `${tag}:日志里找不到该字段:${c.warns[0].slice(0, 200)}`);
      assert.ok(m[1].length <= 210, `${tag}:日志里该值长 ${m[1].length} 字符,超过约 210`);
      assert.ok(c.warns[0].length < 600, `${tag}:整行长 ${c.warns[0].length},日志被灌`);
    }
  });
}

// ── G4-G7:setGrant 凭证门禁恒开 ───────────────────────────────────────────
{
  const SCRIPT = `
import fs from 'node:fs';
import { join } from 'node:path';
fs.mkdirSync(join(process.env.CU_TEST_HOME, '.claude-gui', 'cu-runtime'), { recursive: true });
const cu = await import(process.env.R154_CU);
// 第一次写盘之前先自检:授权文件必须落在假家目录下,否则立刻退出(预加载万一失效,绝不去写真实 ~/.claude-gui)。
if (!cu.GRANTS_FILE.startsWith(process.env.CU_TEST_HOME)) {
  process.stdout.write(JSON.stringify({ underHome: false }));
  process.exit(0);
}
const bytes = () => (fs.existsSync(cu.GRANTS_FILE) ? fs.readFileSync(cu.GRANTS_FILE).toString('base64') : null);
const attempt = (change, opts) => {
  const before = bytes();
  try {
    const next = opts === undefined ? cu.setGrant(change) : cu.setGrant(change, opts);
    return { ok: true, apps: Object.keys(next.apps), screenScope: next.screenScope.granted, unchanged: before === bytes() };
  } catch (e) {
    return { ok: false, code: e && e.code, unchanged: before === bytes() };
  }
};
const out = {};
out.underHome = cu.GRANTS_FILE.startsWith(process.env.CU_TEST_HOME);
out.seed = attempt({ bundleId: 'com.apple.Preview' }, { panelCredential: true });
out.noOpts = attempt({ bundleId: 'com.apple.TextEdit' });
out.noOptsScope = attempt({ screenScope: true });
out.withTrue = attempt({ bundleId: 'com.apple.TextEdit' }, { panelCredential: true });
out.strTrue = attempt({ bundleId: 'com.apple.Notes' }, { panelCredential: 'true' });
out.numOne = attempt({ bundleId: 'com.apple.Notes' }, { panelCredential: 1 });
out.revoke = attempt({ bundleId: 'com.apple.Preview', granted: false });
out.finalApps = Object.keys(cu.readGrants().apps);
process.stdout.write(JSON.stringify(out));
`;
  const r = runIsolated(SCRIPT);
  const out = r.out;

  await report.check('G4', '不传选项的正向 setGrant({bundleId}) / setGrant({screenScope:true}) 抛 CU_GRANT_FORBIDDEN,授权文件字节不变', 'red', () => {
    assert.ok(out, `子进程没有输出可解析 JSON(${diag(r)})`);
    assert.equal(out.underHome, true, '授权文件不在假家目录下,拒绝继续');
    assert.equal(out.seed.ok, true, `播种失败:${JSON.stringify(out.seed)}`);
    for (const [tag, c] of [['bundleId', out.noOpts], ['screenScope', out.noOptsScope]]) {
      assert.equal(c.ok, false, `${tag}:不传凭证的正向授权居然成功了`);
      assert.equal(c.code, 'CU_GRANT_FORBIDDEN', `${tag}:错误码 ${c.code}`);
      assert.equal(c.unchanged, true, `${tag}:被拒后授权文件字节变了`);
    }
  });

  await report.check('G5', '不传选项的纯撤销成功(降权免凭证)', 'green', () => {
    assert.ok(out, `子进程没有输出可解析 JSON(${diag(r)})`);
    assert.equal(out.revoke.ok, true, `撤销失败:${JSON.stringify(out.revoke)}`);
    assert.ok(!out.revoke.apps.includes('com.apple.Preview'), '撤销后仍在授权表里');
  });

  await report.check('G6', '{ panelCredential: true } 的正向授权成功', 'green', () => {
    assert.ok(out, `子进程没有输出可解析 JSON(${diag(r)})`);
    assert.equal(out.withTrue.ok, true, `带凭证授权失败:${JSON.stringify(out.withTrue)}`);
    assert.ok(out.withTrue.apps.includes('com.apple.TextEdit'));
    assert.deepEqual(out.finalApps, ['com.apple.TextEdit']);
  });

  await report.check('G7', "{ panelCredential: 'true' } 与 { panelCredential: 1 } 被拒(严格等于 true 才算),授权文件不变", 'red', () => {
    assert.ok(out, `子进程没有输出可解析 JSON(${diag(r)})`);
    for (const [tag, c] of [["'true'", out.strTrue], ['1', out.numOne]]) {
      assert.equal(c.ok, false, `panelCredential=${tag} 居然放行了`);
      assert.equal(c.code, 'CU_GRANT_FORBIDDEN', `panelCredential=${tag}:错误码 ${c.code}`);
      assert.equal(c.unchanged, true, `panelCredential=${tag}:被拒后授权文件字节变了`);
    }
  });
}

// ── G8:静态守卫:server/ 下每个 setGrant( 调用都显式传 panelCredential ──────────
await report.check('G8', 'server/ 下除定义处外,每个 setGrant( 调用的参数里都出现 panelCredential', 'green', () => {
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(c|m)?jsx?$/.test(ent.name)) files.push(p);
    }
  };
  walk(join(ROOT, 'server'));
  let calls = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bsetGrant\s*\(/g)) {
      if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue; // 定义处
      // 按括号配对取出整段实参(实参里的字符串不含括号,够用)
      let depth = 0, i = m.index + m[0].length - 1;
      for (; i < src.length; i += 1) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')' && --depth === 0) break;
      }
      const args = src.slice(m.index, i + 1);
      calls += 1;
      const line = src.slice(0, m.index).split('\n').length;
      assert.ok(args.includes('panelCredential'), `${file.slice(ROOT.length + 1)}:${line} 的 setGrant 调用没传 panelCredential`);
    }
  }
  assert.ok(calls >= 1, '一个 setGrant 调用都没扫到,扫描本身失效');
});

process.exit(report.finish());
