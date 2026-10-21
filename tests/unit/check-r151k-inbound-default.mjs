#!/usr/bin/env node
// r151k ③ / r151q 第 6 项:GUI 跨会话入站的默认值。
//   normalizeXsPrefs:xsInbound 同时保留 'auto' 与 'card'(仍只收会话 id 形状的键),并给出 inboundDefault;
//   inboundDefaultOf:xsInboundDefault('auto'|'card',不合法按没有)> 开过总开关(有 xsEnabledAt 键或总开关开着)→ card > auto;
//   inboundModeOf:列表 / 单条 / list_sessions / 自动处理判定共用的唯一映射口径(不分大小写;没设置 → 传入的默认,漏传按 card);
//   readXsPrefsSync 端到端:显式 card 与未设置可区分,非法值按默认(未设置);偏好文件读失败时默认一律 card。
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

const { normalizeXsPrefs, inboundModeOf, inboundDefaultOf, readXsPrefsSync, readXsPrefsDetailedSync } = await import('../../server/routes/prefs.js');

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
    for (const dflt of ['auto', 'card']) {
      eq(inboundModeOf(inbound, A, dflt), 'auto', `默认 ${dflt}:显式 auto → auto`);
      eq(inboundModeOf(inbound, B, dflt), 'card', `默认 ${dflt}:显式 card → card`);
      eq(inboundModeOf(inbound, C, dflt), 'card', `默认 ${dflt}:键大小写不同也认 card`);
      eq(inboundModeOf(inbound, D, dflt), dflt, `默认 ${dflt}:没设置 → 默认值`);
      eq(inboundModeOf({}, A, dflt), dflt, `默认 ${dflt}:空映射 → 默认值`);
      eq(inboundModeOf(null, A, dflt), dflt, `默认 ${dflt}:null 映射 → 默认值`);
      eq(inboundModeOf({ [A]: 'bogus' }, A, dflt), dflt, `默认 ${dflt}:非法值(理论上已被归一化丢掉)按没设置`);
      eq(inboundModeOf(inbound, '', dflt), dflt, `默认 ${dflt}:空 sessionId → 默认值`);
    }
    // 漏传 / 传错默认值只会更保守(卡片),不会放宽成自动处理
    eq(inboundModeOf(inbound, D), 'card', '漏传默认值:没设置 → card');
    eq(inboundModeOf(undefined, A), 'card', '漏传默认值:undefined 映射 → card');
    eq(inboundModeOf(inbound, D, 'AUTO'), 'card', '默认值不合法 → card');
    eq(inboundModeOf(inbound, A), 'auto', '漏传默认值不影响显式 auto');
  }

  // ── ②b 入站默认(r151q 第 6 项)──────────────────────────────────────────────
  {
    const AT = '2026-10-20T00:00:00.000Z';
    const cases = [
      [{}, 'auto', '从没开过总开关 → auto'],
      [{ xsEnabledAt: AT }, 'card', '有 xsEnabledAt(开过)→ card'],
      [{ xsEnabled: false, xsEnabledAt: AT }, 'card', '开过又关了 → card'],
      [{ xsEnabledAt: null }, 'card', 'xsEnabledAt 键在、值不合法 → 仍算开过(偏保守)'],
      [{ xsEnabled: true }, 'card', '总开关开着但没记启用时刻(一期升级用户,补记前/补记失败)→ 也算开过 → card'],
      [{ xsEnabled: false }, 'auto', '总开关关着、从没记过启用时刻 → auto'],
      [{ xsInboundDefault: 'auto', xsEnabled: true, xsEnabledAt: AT }, 'auto', '显式 xsInboundDefault=auto → auto'],
      [{ xsInboundDefault: 'card' }, 'card', '显式 xsInboundDefault=card → card'],
      [{ xsInboundDefault: 'bogus' }, 'auto', 'xsInboundDefault 不合法按没有:没开过 → auto'],
      [{ xsInboundDefault: 'AUTO', xsEnabledAt: AT }, 'card', 'xsInboundDefault 不合法按没有:开过 → card'],
      [{ xsInboundDefault: null, xsEnabledAt: AT }, 'card', 'xsInboundDefault=null 按没有'],
    ];
    for (const [prefs, want, label] of cases) {
      eq(inboundDefaultOf(prefs), want, label);
      eq(normalizeXsPrefs(prefs).inboundDefault, want, `normalizeXsPrefs 同口径:${label}`);
    }
    for (const bad of [undefined, null, [], 'x', 1]) eq(inboundDefaultOf(bad), 'auto', `偏好不是对象(${JSON.stringify(bad)})→ auto`);
  }

  // ── ③ 端到端读取:显式 card 不靠删键,未设置与显式 card 可区分 ───────────────
  {
    const prefs = { xsEnabled: true, xsEnabledAt: '2026-10-20T00:00:00.000Z', xsInbound: { [A]: 'auto', [B]: 'card' } };
    writeFileSync(PREFS, JSON.stringify(prefs));
    const p = readXsPrefsSync();
    eq(p.inbound, { [A]: 'auto', [B]: 'card' }, '读盘保留 card 条目');
    eq(p.inboundDefault, 'card', '老用户(开过、没有 xsInboundDefault)默认 card');
    eq(inboundModeOf(p.inbound, A, p.inboundDefault), 'auto', 'A 显式 auto');
    eq(inboundModeOf(p.inbound, B, p.inboundDefault), 'card', 'B 显式 card');
    eq(inboundModeOf(p.inbound, C, p.inboundDefault), 'card', 'C 没设置 → 老用户默认 card');
    eq(readFileSync(PREFS, 'utf8'), JSON.stringify(prefs), '读时不改写偏好文件');
    const fresh = { ...prefs, xsInboundDefault: 'auto' };
    writeFileSync(PREFS, JSON.stringify(fresh));
    const q = readXsPrefsSync();
    eq(inboundModeOf(q.inbound, C, q.inboundDefault), 'auto', '新用户(第一次打开时记了 xsInboundDefault=auto):C 没设置 → auto');
    eq(inboundModeOf(q.inbound, B, q.inboundDefault), 'card', '新用户:显式 card 照旧');
  }

  // ── ④ r151q:偏好文件在、却解析不了(例如写到一半)→ 没单独设置过的会话一律 card,不是 auto ───────────────
  {
    writeFileSync(PREFS, '{"xsEnabled": true, "xsInboundDefault": "auto", "xsInbound": {');
    const d = readXsPrefsDetailedSync();
    eq([d.readFailed, d.inboundDefault], [true, 'card'], '读失败 → readFailed 且默认 card(即使文件里半截写着 auto)');
    eq(inboundModeOf(d.inbound, C, d.inboundDefault), 'card', '读失败时没设置的会话 → card');
    const s = readXsPrefsSync();
    eq([s.inboundDefault, 'readFailed' in s], ['card', false], 'readXsPrefsSync(列表、list_sessions 用的)同样 card,不带 readFailed');
  }

  console.log(`✓ r151k 入站默认单测全部通过(${checks} 项断言)`);
} finally {
  rmSync(HOME, { recursive: true, force: true });
}
