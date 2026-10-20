#!/usr/bin/env node
// r151k ③:GUI 跨会话入站的默认值 —— 显式 card 才 card,其余(显式 auto / 没设置)都 auto。
//   normalizeXsPrefs:xsInbound 同时保留 'auto' 与 'card'(仍只收会话 id 形状的键);
//   inboundModeOf:列表 / 单条 / list_sessions / 自动处理判定共用的唯一映射口径(不分大小写);
//   readXsPrefsSync 端到端:显式 card 与未设置可区分,非法值按默认(未设置)。
// node tests/unit/check-r151k-inbound-default.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const HOME = mkdtempSync(join(tmpdir(), 'cgui-r151k-inbound-'));
const GUI_DIR = join(HOME, '.claude-gui');
const PREFS = join(GUI_DIR, 'prefs.json');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
mkdirSync(GUI_DIR, { recursive: true });

const { normalizeXsPrefs, inboundModeOf, readXsPrefsSync } = await import('../../server/routes/prefs.js');

let checks = 0;
const eq = (got, want, label) => { assert.deepEqual(got, want, label); checks += 1; };
const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const D = randomUUID();

try {
  // ── ① 归一化:auto 与 card 都保留,非法值/非会话 id 形状丢掉 ─────────────────
  {
    const n = normalizeXsPrefs({
      xsEnabled: true,
      xsEnabledAt: '2026-10-20T00:00:00.000Z',
      xsAutoPaused: true,
      xsInbound: {
        [A]: 'auto',
        [B]: 'card',
        [C.toUpperCase()]: 'card',
        [D]: 'CARD', // 大小写不宽容
        'not-a-session-id': 'auto',
        '12345678-1234-1234-1234-123456789012': 'auto', // 形状合法 → 保留
      },
    });
    eq(n.inbound, {
      [A]: 'auto',
      [B]: 'card',
      [C.toUpperCase()]: 'card',
      '12345678-1234-1234-1234-123456789012': 'auto',
    }, '显式 auto / card 都保留;非法 mode 与非 id 键丢掉');
    eq([n.enabled, n.enabledAt, n.autoPaused], [true, '2026-10-20T00:00:00.000Z', true], '其它键不受影响');
  }
  for (const raw of [undefined, null, [], 'x', 1, true]) {
    eq(normalizeXsPrefs({ xsInbound: raw }).inbound, {}, `xsInbound=${JSON.stringify(raw)} → {}`);
  }
  eq(normalizeXsPrefs({}).inbound, {}, '没有 xsInbound → {}');

  // ── ② 映射口径 ──────────────────────────────────────────────────────────────
  {
    const inbound = { [A]: 'auto', [B]: 'card', [C.toUpperCase()]: 'card' };
    eq(inboundModeOf(inbound, A), 'auto', '显式 auto → auto');
    eq(inboundModeOf(inbound, B), 'card', '显式 card → card');
    eq(inboundModeOf(inbound, C), 'card', '键大小写不同也认 card');
    eq(inboundModeOf(inbound, D), 'auto', '没设置 → auto(新的默认)');
    eq(inboundModeOf({}, A), 'auto', '空映射 → auto');
    eq(inboundModeOf(null, A), 'auto', 'null 映射 → auto');
    eq(inboundModeOf(undefined, A), 'auto', 'undefined 映射 → auto');
    eq(inboundModeOf({ [A]: 'bogus' }, A), 'auto', '非法值(理论上已被归一化丢掉)→ auto');
    eq(inboundModeOf(inbound, ''), 'auto', '空 sessionId → auto');
    eq(inboundModeOf(inbound, null), 'auto', 'null sessionId → auto');
  }

  // ── ③ 端到端读取:显式 card 不靠删键,未设置与显式 card 可区分 ───────────────
  {
    const prefs = { xsEnabled: true, xsInbound: { [A]: 'auto', [B]: 'card' } };
    writeFileSync(PREFS, JSON.stringify(prefs));
    const p = readXsPrefsSync();
    eq(p.inbound, { [A]: 'auto', [B]: 'card' }, '读盘保留 card 条目');
    eq(inboundModeOf(p.inbound, A), 'auto', 'A 显式 auto');
    eq(inboundModeOf(p.inbound, B), 'card', 'B 显式 card');
    eq(inboundModeOf(p.inbound, C), 'auto', 'C 没设置 → auto');
    eq(readFileSync(PREFS, 'utf8'), JSON.stringify(prefs), '读时不改写偏好文件');
  }

  console.log(`✓ r151k 入站默认单测全部通过(${checks} 项断言)`);
} finally {
  rmSync(HOME, { recursive: true, force: true });
}
