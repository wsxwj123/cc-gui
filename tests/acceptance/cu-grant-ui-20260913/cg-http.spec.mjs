// CG-01..CG-05(正)+ CG-R01/R02/R06/R10(反):两个新只读端点的 HTTP 面。
// 合同:.devflow/INTERFACE-20260913-cu-grant-ui.md §B/§C/§F。
// 观测只有公开面:状态码 + 响应体 + grants.json 磁盘内容。
import { test, expect } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { api, requireFlag, EnvironmentBlocked, sleep } from './helpers/harness.mjs';

const KEYS = ['bundleId', 'granted', 'name']; // 排序后(§B B1)
const SENSITIVE = ['title', 'pid', 'bounds', 'windowId', 'displayId', 'imgW', 'base64', 'logicalBounds'];

test('CG-01 /apps:HTTP 200 ok:true,每个元素恰好三键 bundleId/name/granted', async () => {
  const r = await api('/api/computer-use/apps');
  expect(r.status, '同族 doctor 体例:只读报告恒 200').toBe(200);
  expect(r.body?.ok).toBe(true);
  expect(Array.isArray(r.body.apps), 'apps 必须是数组').toBe(true);
  for (const app of r.body.apps) {
    expect(Object.keys(app).sort(), `元素键集合:${JSON.stringify(app)}`).toEqual(KEYS);
    expect(typeof app.bundleId).toBe('string');
    expect(app.bundleId.length).toBeGreaterThan(0);
    expect(typeof app.name).toBe('string');
    expect(typeof app.granted).toBe('boolean');
  }
  console.log(`   apps=${r.body.apps.length} 条`);
});

test('CG-02 响应体不含窗口/像素类敏感字段(I3/G4)', async () => {
  const r = await api('/api/computer-use/apps');
  // 应用名/ bundleId 本身是系统给的值,可能碰巧含某个词 —— 命中时再看它是不是落在值里(字段泄漏才算红)。
  const values = (r.body?.apps || []).map((a) => `${a.bundleId} ${a.name}`).join(' ');
  const leaked = SENSITIVE.filter((needle) => r.text.includes(needle) && !values.includes(needle));
  expect(leaked, `响应体出现敏感字段:${leaked.join(', ')}`).toEqual([]);
  const keys = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) { keys.add(k); walk(v); }
    }
  };
  walk(r.body);
  for (const needle of SENSITIVE) expect([...keys], `键集合里不该有 ${needle}`).not.toContain(needle);
});

test('CG-03 /apps 按 bundleId 非递减、无重复;同一应用两个实例仍只一条', async () => {
  const r = await api('/api/computer-use/apps');
  const ids = (r.body?.apps || []).map((a) => a.bundleId);
  expect(ids, '非递减').toEqual([...ids].sort());
  expect(new Set(ids).size, 'bundleId 无重复').toBe(ids.length);

  // 造"同一应用两个进程实例":TextEdit 开两个独立进程(和 CU 批次 3 的夹具同款做法)。
  requireFlag('CU_ALLOW_FIXTURE', '这条要在操作者机器上开两个临时 TextEdit 进程造重复 bundleId');
  const app = '/System/Applications/TextEdit.app';
  const before = textEditPids();
  const files = [path.join('/tmp', `cgui-grant-dup-a-${Date.now()}.txt`), path.join('/tmp', `cgui-grant-dup-b-${Date.now()}.txt`)];
  const opened = [];
  try {
    for (const file of files) {
      fs.writeFileSync(file, '');
      execFileSync('open', ['-g', '-n', '-a', app, file], { encoding: 'utf8' });
    }
    const deadline = Date.now() + 10_000;
    let pids = [];
    while (Date.now() < deadline) {
      pids = textEditPids().filter((p) => !before.includes(p));
      if (pids.length >= 2) break;
      await sleep(300);
    }
    if (pids.length < 2) throw new EnvironmentBlocked(`没造出两个 TextEdit 进程(只看到 ${pids.length} 个新 pid)`);
    opened.push(...pids);
    await sleep(500); // 进程起来到 runningApplications 反映出来有个滞后
    const again = await api('/api/computer-use/apps');
    const textEdit = (again.body?.apps || []).filter((a) => a.bundleId === 'com.apple.TextEdit');
    expect(textEdit.length, `两个进程实例 → 列表里仍只一条(实际 ${textEdit.length})`).toBe(1);
  } finally {
    // 只杀本用例自己开的 pid(绝不碰操作者自己的 TextEdit)
    for (const pid of opened) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经退了 */ } }
    for (const file of files) { try { fs.rmSync(file, { force: true }); } catch { /* 无关紧要 */ } }
  }
});

function textEditPids() {
  const out = spawnSync('pgrep', ['-x', 'TextEdit'], { encoding: 'utf8' });
  return String(out.stdout || '').split('\n').map((l) => Number(l.trim())).filter(Boolean);
}

test('CG-04 /app-info:已安装的 bundleId → installed:true + name/path 非空', async () => {
  const r = await api('/api/computer-use/app-info?bundleId=com.apple.TextEdit');
  expect(r.status).toBe(200);
  expect(r.body?.ok).toBe(true);
  expect(r.body.installed).toBe(true);
  expect(typeof r.body.bundleId).toBe('string');
  expect(String(r.body.path || '').length, 'path 非空').toBeGreaterThan(0);
  expect(String(r.body.name || '').length, 'name 非空').toBeGreaterThan(0);
  console.log(`   name=${r.body.name} path=${r.body.path}`);
});

test('CG-05 /app-info:不存在的 bundleId → ok:true + installed:false,name/path 为 null(不是 4xx/5xx)', async () => {
  const id = `com.cgui.nonexistent.${Date.now()}`;
  const r = await api(`/api/computer-use/app-info?bundleId=${id}`);
  expect(r.status).toBe(200);
  expect(r.body?.ok).toBe(true);
  expect(r.body.installed).toBe(false);
  expect(r.body.name).toBeNull();
  expect(r.body.path).toBeNull();
});

test('CG-R01 /app-info 不带 bundleId → 400 CU_INVALID_ARGUMENT', async () => {
  const r = await api('/api/computer-use/app-info');
  expect(r.status).toBe(400);
  expect(r.body?.ok).toBe(false);
  expect(r.body?.code).toBe('CU_INVALID_ARGUMENT');
});

test('CG-R02 /app-info 空串 / 201 字符 / 重复 query(非字符串)→ 400 CU_INVALID_ARGUMENT', async () => {
  const long = 'a'.repeat(201);
  const cases = [
    ['空串', '/api/computer-use/app-info?bundleId='],
    ['201 字符', `/api/computer-use/app-info?bundleId=${long}`],
    ['重复 query(解析成数组)', '/api/computer-use/app-info?bundleId=com.apple.finder&bundleId=com.apple.TextEdit'],
  ];
  for (const [label, url] of cases) {
    const r = await api(url);
    expect(r.status, label).toBe(400);
    expect(r.body?.code, label).toBe('CU_INVALID_ARGUMENT');
  }
  // 200 字符(边界内)不该被拒
  const ok = await api(`/api/computer-use/app-info?bundleId=${'a'.repeat(200)}`);
  expect(ok.status, '200 字符是边界内').toBe(200);
  expect(ok.body?.ok).toBe(true);
});

test('CG-R06 撤销一个从未授权的 bundleId → 200 ok:true(幂等),列表不变', async () => {
  requireFlag('CU_ALLOW_GRANT_WRITE', '这条会走 POST /grants 写真实的 grants.json(授权真源没有可隔离的环境变量,见 §CG-8)');
  const id = `com.cgui.never-granted.${Date.now()}`;
  const before = (await api('/api/computer-use/grants')).body.apps.map((a) => a.bundleId).sort();
  const r = await api('/api/computer-use/grants', { method: 'POST', body: { bundleId: id, granted: false } });
  expect(r.status).toBe(200);
  expect(r.body?.ok).toBe(true);
  expect(r.body.apps.map((a) => a.bundleId).sort()).toEqual(before);
});

test('CG-R10 未认证的外部客户端打两个新端点 → 401(本机回环不受挑战)', async () => {
  requireFlag('CU_ALLOW_GRANT_WRITE', '这条要在隔离实例上设一次访问密码(写夹具 HOME 的配置)');
  // 产品自己的外部判定:CF 标记头(只用于【否决】,客户端伪造它只会把自己判成外部 —— auth.js 注释原文)。
  // 本机回环 + 无 CF 头 = 本机,永远免密;带 CF 头 = 外部 → 没设密码前两者都放行,设了密码才能看到 401。
  const set = await api('/api/network/password', { method: 'POST', body: { password: 'cgui-test-123456' } });
  expect(set.status, '隔离实例上设密码').toBe(200);
  try {
    const external = { 'cf-connecting-ip': '203.0.113.9' };
    for (const p of ['/api/computer-use/apps', '/api/computer-use/app-info?bundleId=com.apple.TextEdit']) {
      const r = await api(p, { headers: external });
      expect(r.status, `${p} 外部客户端应 401`).toBe(401);
    }
    const local = await api('/api/computer-use/apps');
    expect(local.status, '本机回环免密').toBe(200);
  } finally {
    const clear = await api('/api/network/password', { method: 'POST', body: { clear: true } });
    expect(clear.status, '收尾:清掉测试密码').toBe(200);
  }
});
