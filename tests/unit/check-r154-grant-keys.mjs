#!/usr/bin/env node
// r154 安全审计一审回归:授权表的键安全。
//
// 锁的事:
//   K1 空授权表下,Object.prototype 上的名字(constructor / toString / __proto__ …)不算已授权(darwin 与 win32)。
//   K2 normalizeAppIdForGrant 拒绝全部保留名,合法的 mac bundleId 与 Windows 路径照常通过。
//   K3 手写进 grants.json 的脏键:__proto__ 不换原型、保留名 / 含逗号的键被丢弃、前导空格被规范化、name 被截断。
//   K4 setGrant 写入超长 name 后文件里 name ≤ 200。
//   K5 effectiveGrants(readGrants()) 不改变 apps 的原型。
//
// 做法:全部在子进程里跑,子进程用 q8-helpers/cu-preload.mjs 把家目录指到临时目录,第一次写盘前先自检
// 授权文件落在假家目录,否则立即退出;不起端口,绝不碰真 ~/.claude-gui。
//
// 跑法:node tests/unit/check-r154-grant-keys.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const report = makeReport('check-r154-grant-keys');
const PRELOAD = pathToFileURL(join(HERE, 'q8-helpers', 'cu-preload.mjs')).href;
const CU_URL = pathToFileURL(join(ROOT, 'server', 'computer-use', 'cu-common.js')).href;
const RESERVED = Object.getOwnPropertyNames(Object.prototype);

function runIsolated(script) {
  const base = fs.mkdtempSync(join(os.tmpdir(), 'r154-keys-'));
  try {
    const r = spawnSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, CU_TEST_HOME: base, R154_CU: CU_URL },
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

const SCRIPT = `
import fs from 'node:fs';
import { join } from 'node:path';
const cu = await import(process.env.R154_CU);
// 第一次写盘之前先自检:授权文件必须落在假家目录下,否则立刻退出。
if (!cu.GRANTS_FILE.startsWith(process.env.CU_TEST_HOME)) {
  process.stdout.write(JSON.stringify({ underHome: false }));
  process.exit(0);
}
fs.mkdirSync(join(process.env.CU_TEST_HOME, '.claude-gui', 'cu-runtime'), { recursive: true });
const RESERVED = Object.getOwnPropertyNames(Object.prototype);
const out = { underHome: true, granted: [], reservedAccepted: [] };
for (const p of ['darwin', 'win32']) {
  const empty = { version: 1, screenScope: { granted: false, grantedAt: null }, apps: {} };
  for (const n of RESERVED) if (cu.appGranted(empty, n, p) !== false) out.granted.push(p + ':' + n);
  for (const n of RESERVED) if (cu.normalizeAppIdForGrant(n, p).ok) out.reservedAccepted.push(p + ':' + n);
}
out.textEdit = cu.normalizeAppIdForGrant('com.apple.TextEdit', 'darwin');
out.winPath = cu.normalizeAppIdForGrant('C:\\\\Program Files (x86)\\\\App\\\\x.exe', 'win32');

// K3:手写一份脏文件(用原始 JSON 文本,__proto__ 才是自有键)
const raw = '{"version":1,"screenScope":{"granted":false,"grantedAt":null},"apps":{'
  + '"__proto__":{"name":"P","grantedAt":null},'
  + '"constructor":{"name":"C","grantedAt":null},'
  + '"com.apple.TextEdit,com.apple.Terminal":{"name":"X","grantedAt":null},'
  + '" com.apple.Notes":{"name":"Notes","grantedAt":null},'
  + '"com.apple.Preview":{"name":"' + 'N'.repeat(5000) + '","grantedAt":null}}}';
fs.writeFileSync(cu.GRANTS_FILE, raw);
const g = cu.readGrants();
out.protoOk = Object.getPrototypeOf(g.apps) === Object.prototype;
out.keys = Object.keys(g.apps).sort();
out.maxName = Math.max(...Object.values(g.apps).map((e) => e.name.length));
const eff = cu.effectiveGrants(g);
out.effProtoOk = Object.getPrototypeOf(eff.apps) === Object.prototype && Object.getPrototypeOf(g.apps) === Object.prototype;

// K4
cu.setGrant({ bundleId: 'com.apple.TextEdit', name: 'T'.repeat(5000) }, { panelCredential: true });
const file = JSON.parse(fs.readFileSync(cu.GRANTS_FILE, 'utf8'));
out.writtenNameLen = file.apps['com.apple.TextEdit'] ? file.apps['com.apple.TextEdit'].name.length : -1;
process.stdout.write(JSON.stringify(out));
`;

const r = runIsolated(SCRIPT);
const out = r.out;
const ready = () => {
  assert.ok(out, `子进程没有输出可解析 JSON(${diag(r)})`);
  assert.equal(out.underHome, true, '授权文件不在假家目录下,拒绝继续');
};

await report.check('K1', `空授权表下全部 ${RESERVED.length} 个保留名在 darwin / win32 都不算已授权`, 'red', () => {
  ready();
  assert.deepEqual(out.granted, [], `被当成已授权:${out.granted.join(', ')}`);
});

await report.check('K2', 'normalizeAppIdForGrant 拒绝全部保留名;com.apple.TextEdit 与 Windows 带括号空格的路径照常通过', 'red', () => {
  ready();
  assert.deepEqual(out.reservedAccepted, [], `保留名被接受:${out.reservedAccepted.join(', ')}`);
  assert.equal(out.textEdit.ok, true);
  assert.equal(out.winPath.ok, true, JSON.stringify(out.winPath));
  assert.equal(out.winPath.id, 'C:\\Program Files (x86)\\App\\x.exe');
});

await report.check('K3', '手写脏 grants.json:原型不变,只剩规范化后的 com.apple.Notes 与 com.apple.Preview,name ≤ 200', 'red', () => {
  ready();
  assert.equal(out.protoOk, true, 'apps 的原型被换掉了');
  assert.deepEqual(out.keys, ['com.apple.Notes', 'com.apple.Preview']);
  assert.ok(out.maxName <= 200, `name 长 ${out.maxName}`);
});

await report.check('K4', 'setGrant 写入 5000 字符的 name 后,文件里 name ≤ 200', 'red', () => {
  ready();
  assert.ok(out.writtenNameLen > 0 && out.writtenNameLen <= 200, `文件里 name 长 ${out.writtenNameLen}`);
});

await report.check('K5', 'effectiveGrants(readGrants()) 不改变 apps 的原型', 'green', () => {
  ready();
  assert.equal(out.effProtoOk, true);
});

process.exit(report.finish());
