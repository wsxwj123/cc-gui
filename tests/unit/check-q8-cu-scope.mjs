#!/usr/bin/env node
// Q8 审查项 5/6/7(computer-use 授权边界与截图目录):
//   5. window_list 文本面对未授权前台应用写"(未授权应用,不显示)",structuredContent.frontmost 却原样给
//      {pid,name,bundleId}(修前应红);授权应用时结构面必须仍回真数据(反向,修前应绿)
//   6. cursor_position 未授权全屏时文本面只给局部坐标,structuredContent.point 却仍是全局坐标(修前应红);
//      授权全屏时 point 必须仍回真坐标(反向,修前应绿);完全不在授权窗口内 → CU_SCREEN_SCOPE_REQUIRED(修前应绿)
//   7. pruneShots 只清本实例前缀 → 已退出实例的截图永远留在 shots/(修前应红);新鲜的他实例文件不许误删(修前应绿)
// 测法:真起 mcp-server.js + 桩 helper(不碰桌面、不建 venv),授权文件写在假家目录。
// 跑法:node tests/unit/check-q8-cu-scope.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { makeReport } from './q8-helpers/report.mjs';
import { GRANTED, grantedWindow, makeFakeHome, startMcp } from './q8-helpers/cu-harness.mjs';

const report = makeReport('check-q8-cu-scope');
const fake = makeFakeHome('cu-scope');
fake.setGrants({ apps: [GRANTED.bundleId], screenScope: false });

const VAULT = { pid: 777, name: 'Secret Vault', bundleId: 'com.vendor.passwordmanager' };
const vaultWindow = { id: 6001, pid: 777, app: 'Secret Vault', bundleId: VAULT.bundleId, title: 'Vault - master.kdbx', bounds: { x: 400, y: 300, w: 500, h: 400 }, displayId: 1 };
const grantedFront = { pid: GRANTED.pid, name: GRANTED.name, bundleId: GRANTED.bundleId };
const LOCAL = { bundleId: GRANTED.bundleId, pid: GRANTED.pid, windowId: GRANTED.windowId, x: 10, y: 20 };

// 项 7 的种子文件要在 mcp 进程启动【之前】放好(修法若是"启动时清理"也能覆盖到)
const seedShots = () => {
  const now = Date.now();
  const seed = (name, ageMs) => {
    const p = join(fake.shotDir, name);
    fs.writeFileSync(p, Buffer.from('ffd8ffd9', 'hex'));
    const t = new Date(now - ageMs);
    fs.utimesSync(p, t, t);
    return p;
  };
  return {
    stale: seed('cu-aaaaaa-1.jpg', 7 * 24 * 60 * 60 * 1000),   // 别的实例、7 天前:早该清
    fresh: seed('cu-bbbbbb-2.jpg', 60 * 1000),                 // 别的实例、1 分钟前:可能在途,不许动
  };
};
const seeds = seedShots();
const mcp = await startMcp(fake);

try {
  // ── 项 5:window_list 前台应用 ─────────────────────────────────────────
  await report.check('Q8-05a', 'window_list:前台是未授权应用时,structuredContent.frontmost 不得泄露其 pid/name/bundleId', 'red', async () => {
    fake.setScenario({ windows: { reply: { ok: true, frontmost: VAULT, windows: [grantedWindow(), vaultWindow] } } });
    const r = await mcp.call('window_list', {});
    assert.equal(r.isError, false, `window_list 应成功,实际 ${JSON.stringify(r.sc)}`);
    assert.match(r.text, /未授权应用,不显示/, '文本面应写"(未授权应用,不显示)"');
    const f = r.sc.frontmost;
    const leaked = f && (f.pid !== undefined || f.name !== undefined || f.bundleId !== undefined);
    assert.ok(!leaked, `结构面 frontmost 泄露了未授权应用: ${JSON.stringify(f)}`);
    const dump = JSON.stringify(r.sc);
    assert.ok(!dump.includes(VAULT.name) && !dump.includes(VAULT.bundleId) && !dump.includes('"pid":777'), `结构面里仍含未授权应用信息: ${dump.slice(0, 300)}`);
  });

  await report.check('Q8-05b', 'window_list:窗口列表只含已授权应用(未授权窗口连标题都不出现)', 'green', async () => {
    const r = await mcp.call('window_list', {});
    assert.deepEqual(r.sc.windows.map((w) => w.bundleId), [GRANTED.bundleId], '窗口列表只应含已授权应用');
    assert.ok(!JSON.stringify(r.sc.windows).includes('master.kdbx'), '未授权窗口标题不得出现');
  });

  await report.check('Q8-05c', 'window_list:前台是已授权应用时,structuredContent.frontmost 必须仍回 {pid,name,bundleId}(反向:不许修成永远不回)', 'green', async () => {
    fake.setScenario({ windows: { reply: { ok: true, frontmost: grantedFront, windows: [grantedWindow()] } } });
    const r = await mcp.call('window_list', {});
    assert.deepEqual(r.sc.frontmost, grantedFront, '已授权前台应用应原样返回');
    assert.match(r.text, new RegExp(`前台应用: ${GRANTED.name} \\(pid ${GRANTED.pid}\\)`), '文本面应写出已授权前台应用');
  });

  // ── 项 6:cursor_position 坐标 ────────────────────────────────────────
  await report.check('Q8-06a', 'cursor_position:未授权全屏、光标在已授权窗口内 → structuredContent.point 不得给全局坐标', 'red', async () => {
    fake.setGrants({ apps: [GRANTED.bundleId], screenScope: false });
    fake.setScenario({ cursor: { reply: { ok: true, point: [1234, 567], local: LOCAL } } });
    const r = await mcp.call('cursor_position', {});
    assert.equal(r.isError, false, `应成功返回局部坐标,实际 ${JSON.stringify(r.sc)}`);
    assert.match(r.text, /局部坐标 \(10,20\)/, '文本面应只给局部坐标');
    assert.deepEqual(r.sc.local, LOCAL, '结构面 local 必须保留(反向:不能把局部坐标也砍掉)');
    assert.ok(r.sc.point === null || r.sc.point === undefined, `结构面 point 仍是全局坐标: ${JSON.stringify(r.sc.point)}`);
    assert.ok(!JSON.stringify(r.sc).includes('1234'), `结构面里仍含全局坐标: ${JSON.stringify(r.sc)}`);
  });

  await report.check('Q8-06b', 'cursor_position:已授权全屏时 structuredContent.point 必须仍回全局坐标(反向)', 'green', async () => {
    fake.setGrants({ apps: [GRANTED.bundleId], screenScope: true });
    fake.setScenario({ cursor: { reply: { ok: true, point: [1234, 567], local: LOCAL } } });
    const r = await mcp.call('cursor_position', {});
    assert.equal(r.isError, false, `应成功,实际 ${JSON.stringify(r.sc)}`);
    assert.deepEqual(r.sc.point, [1234, 567], '全屏授权后应回全局坐标');
  });

  await report.check('Q8-06c', 'cursor_position:未授权全屏且光标不在任何授权窗口内 → CU_SCREEN_SCOPE_REQUIRED,零坐标', 'green', async () => {
    fake.setGrants({ apps: [GRANTED.bundleId], screenScope: false });
    fake.setScenario({ cursor: { reply: { ok: true, point: [1234, 567] } } });
    const r = await mcp.call('cursor_position', {});
    assert.equal(r.isError, true, '应拒绝');
    assert.equal(r.sc.code, 'CU_SCREEN_SCOPE_REQUIRED');
    assert.ok(!JSON.stringify(r.sc).includes('1234') && !r.text.includes('1234'), '拒绝时不得带任何屏幕坐标');
  });

  // ── 项 7:截图目录清理 ────────────────────────────────────────────────
  await report.check('Q8-07a', 'shots/ 里已退出实例遗留的 7 天旧截图,在本实例截图后必须被清掉(不能只清自己前缀)', 'red', async () => {
    fake.setGrants({ apps: [GRANTED.bundleId], screenScope: true });
    fake.setScenario({});
    const r = await mcp.call('screenshot', {});
    assert.equal(r.isError, false, `screenshot 应成功,实际 ${JSON.stringify(r.sc)}`);
    assert.ok(!fs.existsSync(seeds.stale), `7 天前的他实例截图仍在: ${seeds.stale}`);
  });

  await report.check('Q8-07b', '他实例 1 分钟前的截图(可能在途)不许被误删', 'green', async () => {
    assert.ok(fs.existsSync(seeds.fresh), `新鲜的他实例截图被误删: ${seeds.fresh}`);
  });

  await report.check('Q8-07c', '本实例刚生成的截图文件保留在 shots/(自己的当前文件不受清理影响)', 'green', async () => {
    const mine = fs.readdirSync(fake.shotDir).filter((f) => /\.jpe?g$/i.test(f) && !['cu-aaaaaa-1.jpg', 'cu-bbbbbb-2.jpg'].includes(f));
    assert.equal(mine.length, 1, `本实例应恰有 1 个截图文件,实际: ${JSON.stringify(fs.readdirSync(fake.shotDir))}`);
  });
} finally {
  mcp.kill();
}

process.exit(report.finish());
