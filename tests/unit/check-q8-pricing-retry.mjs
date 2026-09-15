#!/usr/bin/env node
// Q8 审查项 10(价目刷新:已失败的 run 按 key 缓存 24h,手动/自动都无法重试):
//   a. 同一批预设:上一轮已 failed 后再 startRefresh 必须开新一轮(新 refreshId、真的再发请求)(修前应红)
//   b. 反向:同一批仍在 running 时再 startRefresh 必须合并(同 refreshId、不重复发请求)(修前应绿)
//   c. warmupIfStale:失败 11 分钟后(超过 AUTO_RETRY_MIN_MS=10min)必须重试,而不是被 24h 的 key 缓存挡住
//      —— 修前 10 分钟常量是死码(修前应红)
// 测法:fetch 打桩(计数 + 按域名决定拒绝/挂起),HOME 指到假目录;时间用 Date.now 打桩前进 11 分钟。
// 跑法:node tests/unit/check-q8-pricing-retry.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport, waitFor } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const base = join(HERE, 'q8-helpers', '.artifacts', 'pricing');
fs.rmSync(base, { recursive: true, force: true });
const home = join(base, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

const fetchCalls = [];
let hangHosts = new Set();
globalThis.fetch = (url) => {
  const u = String(url);
  fetchCalls.push(u);
  if ([...hangHosts].some((h) => u.includes(h))) return new Promise(() => {}); // 永不落地(模拟仍在飞)
  return Promise.reject(new TypeError('fetch failed (q8 offline stub)'));
};

const pc = await import('../../server/services/pricing-catalog.js');
const report = makeReport('check-q8-pricing-retry');
const KEY_IDS = ['deepseek-official', 'anthropic-official'];
const settled = (id) => waitFor(() => { const s = pc.getRefresh(id).run?.status; return s && s !== 'running' ? s : null; }, { timeoutMs: 20_000 });

await report.check('Q8-10a', '上一轮 failed 之后,同一批预设再次 startRefresh 必须开新一轮(新 refreshId 且真的再抓)', 'red', async () => {
  const r1 = pc.startRefresh(KEY_IDS);
  const s1 = await settled(r1.refreshId);
  assert.equal(s1, 'failed', `离线下第一轮应 failed,实际 ${s1}`);
  const before = fetchCalls.length;
  const r2 = pc.startRefresh(KEY_IDS);
  assert.notEqual(r2.refreshId, r1.refreshId, `再次刷新拿回了那个已 failed 的 refreshId(${r1.refreshId}):24h 内无法重试`);
  await waitFor(() => fetchCalls.length > before, { timeoutMs: 3_000 });
  assert.ok(fetchCalls.length > before, '再次刷新没有发出任何网络请求');
});

await report.check('Q8-10b', '反向:同一批仍在 running 时再 startRefresh 必须合并(同 refreshId、不重复发请求)', 'green', async () => {
  hangHosts = new Set(['openai.com']);
  const r3 = pc.startRefresh(['openai']);
  assert.equal(r3.status, 'running');
  const before = fetchCalls.length;
  const r4 = pc.startRefresh(['openai']);
  assert.equal(r4.refreshId, r3.refreshId, '在飞的同批刷新应合并成同一个 refreshId');
  assert.equal(fetchCalls.length, before, '合并后不应再发请求');
  hangHosts = new Set();
});

await report.check('Q8-10c', 'warmupIfStale:上一轮失败 11 分钟后必须重试(AUTO_RETRY_MIN_MS=10min 不能被 24h key 缓存架空)', 'red', async () => {
  pc.__resetForTests();
  const first = pc.warmupIfStale();
  assert.ok(first?.refreshId, '冷启动 warmupIfStale 应启动一轮刷新');
  const s = await settled(first.refreshId);
  assert.ok(s === 'failed' || s === 'partial', `离线下第一轮应 failed/partial,实际 ${s}`);
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000; // 时间前进 11 分钟(> 10min 自动重试间隔,< 24h)
  try {
    const again = pc.warmupIfStale();
    assert.ok(again && again.refreshId, '11 分钟后 warmupIfStale 返回 null:失败批次被 24h key 缓存挡住,10min 重试常量成死码');
    assert.notEqual(again.refreshId, first.refreshId, '应是新一轮 refreshId');
  } finally {
    Date.now = realNow;
  }
});

process.exit(report.finish());
