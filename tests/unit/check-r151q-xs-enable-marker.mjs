#!/usr/bin/env node
// r151q 第 6 项补缝:总开关由开变关的那次写入里,偏好缺 xsEnabledAt 就一并补记"开过"。
// 一期升级上来的老用户(总开关开着、没有 xsEnabledAt)若启动补记没落盘就关掉总开关,不补的话再打开会被当成新用户、
// 入站默认被写成 auto。这里经真路由 PUT /api/xsession/config 走一遍,再读偏好文件与 inboundDefaultOf 核对。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身,不起 claude 进程;临时 HOME;端口 6900–6999 先探测空闲再用。
// node tests/unit/check-r151q-xs-enable-marker.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151q-xsmark-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin');
const GUI = join(HOME, '.claude-gui'); const PREFS = join(GUI, 'prefs.json');
for (const d of [join(HOME, '.claude', 'sessions'), GUI, BIN]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;

registerR151bSdkStub();
const chat = await import('../../server/routes/chat.js');
const { inboundDefaultOf, readXsPrefsSync } = await import('../../server/routes/prefs.js');
const { default: express } = await import('express');
const { default: xsRoutes, xsessionBodyErrorHandler } = await import('../../server/routes/xsession.js');

const AT = '2026-10-01T00:00:00.000Z';
const isIsoTime = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const readPrefs = () => JSON.parse(readFileSync(PREFS, 'utf8'));
// 模块都加载完之后才写偏好:模拟"启动补记没落盘"的老用户(补记只在启动时跑一次)。
const seed = (prefs) => writeFileSync(PREFS, JSON.stringify(prefs));

let server = null;
let passed = 0;
try {
  const app = express();
  app.use(express.json());
  app.use('/api', xsRoutes);
  app.use('/api', xsessionBodyErrorHandler);
  let port = 0;
  for (let p = 6999; p >= 6900 && !port; p -= 1) {
    if (await new Promise((r) => { const t = net.createServer().once('error', () => r(false)).once('listening', () => t.close(() => r(true))).listen(p, '127.0.0.1'); })) port = p;
  }
  if (!port) throw new Error('6900–6999 没有空闲端口');
  server = await new Promise((r) => { const t = app.listen(port, '127.0.0.1', () => r(t)); });
  const setEnabled = async (enabled) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/xsession/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
    });
    assert.equal(r.status, 200, `PUT enabled=${enabled} 应 200,实际 ${r.status}:${await r.text()}`);
    passed += 1;
  };

  // 1. 一期老用户:总开关开着、没有 xsEnabledAt → 关掉时补记;再打开不写 xsInboundDefault,默认仍是 card
  seed({ xsEnabled: true });
  await setEnabled(false);
  let p = readPrefs();
  assert.equal(p.xsEnabled, false); passed += 1;
  assert.ok(isIsoTime(p.xsEnabledAt), `关总开关时应补记 xsEnabledAt,实际 ${JSON.stringify(p.xsEnabledAt)}`); passed += 1;
  assert.equal(p.xsInboundDefault, undefined, '关的时候不写入站默认'); passed += 1;
  assert.equal(inboundDefaultOf(p), 'card', '关着时算开过 → card'); passed += 1;
  await setEnabled(true);
  p = readPrefs();
  assert.equal(p.xsInboundDefault, undefined, '老用户关了再开:不能被当新用户写成 auto'); passed += 1;
  assert.equal(inboundDefaultOf(p), 'card', '老用户关了再开 → 仍是 card'); passed += 1;
  assert.equal(readXsPrefsSync().inboundDefault, 'card', '读取口径(normalizeXsPrefs)同样是 card'); passed += 1;

  // 2. 已有 xsEnabledAt 的老用户:关掉时不改动原有启用时刻
  seed({ xsEnabled: true, xsEnabledAt: AT });
  await setEnabled(false);
  assert.equal(readPrefs().xsEnabledAt, AT, '已有的 xsEnabledAt 原样保留'); passed += 1;

  // 3. 新环境:关着时再关(不是由开变关)什么都不补;之后第一次打开仍按新用户写 auto
  seed({});
  await setEnabled(false);
  assert.equal(readPrefs().xsEnabledAt, undefined, '不是由开变关 → 不补记'); passed += 1;
  await setEnabled(true);
  p = readPrefs();
  assert.equal(p.xsInboundDefault, 'auto', '新用户第一次打开 → 写 xsInboundDefault:auto'); passed += 1;
  assert.equal(inboundDefaultOf(p), 'auto'); passed += 1;
} finally {
  try { await chat.closeAllPersistentProcesses(); } catch {}
  server?.close();
  rmSync(TMP, { recursive: true, force: true }); // 只清本测试自己 mkdtemp 出来的目录
}
console.log(`PASS check-r151q-xs-enable-marker: ${passed} 项通过`);
process.exit(0);
