// r122 · D 组:补两家中转站预设(INTERFACE D1–D3 / BRIEF R4)。
// D1 明说预设是一份公开数据 → 直接 import server/utils/builtin-providers.js 的 BUILTIN_PROVIDERS 当数据用(不读它的逻辑)。
// D2 用修前快照 helpers/builtin-providers.snapshot.json(43 家的 id/baseURL/type)逐条对照。
// D3 打隔离实例的 GET /api/pricing 看 providers[] 里有没有这两个 presetId。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { api } from './helpers/ui.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE = path.resolve(here, '..', '..', '..');
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(here, 'helpers', 'builtin-providers.snapshot.json'), 'utf8'));

const NEW_PRESETS = [
  { id: 'dmxapi', baseURL: 'https://www.dmxapi.cn/v1', type: 'openai' },
  { id: 'yunwu', baseURL: 'https://yunwu.ai/v1', type: 'openai' },
];
const PROVIDER_STATUS = ['fresh', 'partial', 'stale', 'source-unavailable', 'not-token-priced', 'unmapped'];

async function loadPresets() {
  const mod = await import(pathToFileURL(path.join(WORKTREE, 'server', 'utils', 'builtin-providers.js')).href);
  expect(Array.isArray(mod.BUILTIN_PROVIDERS), 'BUILTIN_PROVIDERS 应是数组').toBe(true);
  return mod.BUILTIN_PROVIDERS;
}

// ───────────────────────── D1 新增两条 ─────────────────────────

for (const want of NEW_PRESETS) {
  test(`D1 预设里有 ${want.id}:baseURL=${want.baseURL},type=openai`, async () => {
    const list = await loadPresets();
    const hit = list.filter((p) => p.id === want.id);
    expect(hit.length, `应恰好有一条 id=${want.id} 的预设,实际 ${hit.length} 条`).toBe(1);
    expect(hit[0].baseURL, `${want.id} 的基址`).toBe(want.baseURL);
    expect(hit[0].type, `${want.id} 的协议类型(OpenAI 兼容)`).toBe(want.type);
    expect(typeof hit[0].name === 'string' && hit[0].name.trim().length > 0, `${want.id} 应有显示名`).toBe(true);
  });
}

test('D1 两条新预设的说明(note)都写明「第三方」与「自备」', async () => {
  const list = await loadPresets();
  for (const want of NEW_PRESETS) {
    const p = list.find((x) => x.id === want.id);
    expect(p, `前提:预设 ${want.id} 存在`).toBeTruthy();
    expect(String(p.note || ''), `${want.id} 的 note 应含「第三方」`).toContain('第三方');
    expect(String(p.note || ''), `${want.id} 的 note 应含「自备」`).toContain('自备');
  }
});

test('D1/BRIEF R4-2 两条新预设的说明(note)都写明「非官方」', async () => {
  const list = await loadPresets();
  for (const want of NEW_PRESETS) {
    const p = list.find((x) => x.id === want.id);
    expect(p, `前提:预设 ${want.id} 存在`).toBeTruthy();
    expect(String(p.note || ''), `${want.id} 的 note 应含「非官方」`).toContain('非官方');
  }
});

// ───────────────────────── D2 既有预设一个不变 ─────────────────────────

test('D2 既有预设逐条对照修前快照:id / baseURL / type 一个不变,一条不少', async () => {
  const list = await loadPresets();
  expect(SNAPSHOT.providers.length, '自证:快照不是空的').toBeGreaterThan(40);
  const byId = new Map(list.map((p) => [p.id, p]));
  const diffs = [];
  for (const old of SNAPSHOT.providers) {
    const now = byId.get(old.id);
    if (!now) { diffs.push(`${old.id}: 不见了`); continue; }
    if (now.baseURL !== old.baseURL) diffs.push(`${old.id}: baseURL ${old.baseURL} → ${now.baseURL}`);
    if (now.type !== old.type) diffs.push(`${old.id}: type ${old.type} → ${now.type}`);
  }
  expect(diffs, `既有预设不得改动,发现:\n${diffs.join('\n')}`).toEqual([]);
});

test('D2 预设 id 唯一,且除了两条新增之外没有别的多出来', async () => {
  const list = await loadPresets();
  const ids = list.map((p) => p.id);
  expect(new Set(ids).size, `id 不得重复:${ids.filter((x, i) => ids.indexOf(x) !== i).join(',')}`).toBe(ids.length);
  const known = new Set([...SNAPSHOT.providers.map((p) => p.id), ...NEW_PRESETS.map((p) => p.id)]);
  const extra = ids.filter((id) => !known.has(id));
  expect(extra, `除 dmxapi / yunwu 外不应再多出别的预设:${extra.join(',')}`).toEqual([]);
});

// ───────────────────────── D3 价目目录里能看到 ─────────────────────────

for (const want of NEW_PRESETS) {
  test(`D3 GET /api/pricing 的 providers[] 里有 presetId=${want.id},状态如实标注、不伪造价格`, async () => {
    const res = await api('GET', '/api/pricing');
    expect(res.status).toBe(200);
    const providers = res.json?.providers || [];
    const hit = providers.filter((p) => p.presetId === want.id);
    expect(hit.length, `providers[] 里应恰好有一条 presetId=${want.id}`).toBe(1);
    expect(PROVIDER_STATUS, `status 应是已知状态之一(实际 ${hit[0].status})`).toContain(hit[0].status);
    // 不伪造价格:这一家的任何报价都必须带真实来源与币种
    const quotes = (res.json?.quotes || []).filter((q) => q.provider === want.id || (q.presetIds || []).includes(want.id));
    for (const q of quotes) {
      expect(typeof q.sourceUrl === 'string' && q.sourceUrl.length > 0, `${want.id} 的报价必须带来源 URL`).toBe(true);
      expect(typeof q.currency === 'string' && q.currency.length > 0, `${want.id} 的报价必须带币种`).toBe(true);
    }
    if (hit[0].status === 'unmapped') expect(quotes.length, '未映射来源就不该有任何报价').toBe(0);
  });
}
