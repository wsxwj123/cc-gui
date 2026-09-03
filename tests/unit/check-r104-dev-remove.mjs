// r104 自测:移除「缓存优化」(exclude-dynamic)开关 + 与「静态系统提示快照」合并为单一
// 条目「缓存优化」。锁三件事:源码里该开关的字面全消失、chatCompatKey 去掉 xdyn 而其余
// 键序不变、老客户端仍传 excludeDynamicSystemPrompt 时被静默忽略(不报错、不换键)。
// 临时 HOME 隔离(照抄 check-r96-dev-compat-key.mjs),全程不读写真实 ~/.claude。
// 跑法:node tests/unit/check-r104-dev-remove.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REAL_HOME = process.env.HOME;
const REAL_PROFILE = process.env.USERPROFILE;
const home = mkdtempSync(join(tmpdir(), 'cgui-r104-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const proj = mkdtempSync(join(tmpdir(), 'cgui-r104-proj-'));
mkdirSync(join(home, '.claude'), { recursive: true });
writeFileSync(join(home, '.claude', 'settings.json'),
  JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://a/v1' } }));

const src = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');
const count = (text, re) => (text.match(re) || []).length;

const chat = await import('../../server/routes/chat.js');
const { chatCompatKey } = chat;

const base = {
  workingDir: proj, effort: 'high', appendSystemPrompt: '', promptSuggestions: false,
  globalRead: true, dirs: ['/'], maxBudgetUsd: null, acw: null, genui: true,
};

try {
  // ── A 源码锁:开关字面在四个落点各 0 次 ─────────────────────────────────
  const FILES = ['server/routes/chat.js', 'client/src/App.jsx',
    'client/src/stores/sessionStore.js', 'client/src/components/SettingsPanel.jsx'];
  for (const f of FILES) {
    const s = src(f);
    for (const re of [/excludeDynamic/gi, /\bxdyn\b/g, /exclude-dynamic-system-prompt/g, /set-cache-opt/g]) {
      assert.equal(count(s, re), 0, `A ${f} 仍残留 ${re}`);
    }
  }
  // 旧 prefs 键只许出现在"不再读取"的说明里,不许有 getItem/setItem 接线
  const store = src('client/src/stores/sessionStore.js');
  assert.equal(count(store, /Item\(['"]cgui-exclude-dynamic-prompt/g), 0, 'A2 store 仍在读写旧 prefs 键');
  // 服务端不再向 SDK 传 excludeDynamicSections、不再有 resolveExcludeDyn
  const CH = src('server/routes/chat.js');
  assert.equal(count(CH, /excludeDynamicSections/g), 0, 'A3 仍向 SDK 下发 excludeDynamicSections');
  assert.equal(count(CH, /resolveExcludeDyn/g), 0, 'A4 resolveExcludeDyn 未删净');
  assert.equal(chat.resolveExcludeDyn, undefined, 'A5 resolveExcludeDyn 不应再被导出');
  // 共用判据未受牵连:输入预测三态仍在,仍走 settingsProviderIsOfficial
  assert.equal(typeof chat.resolvePromptSuggestions, 'function', 'A6 resolvePromptSuggestions 被误删');
  assert.ok(/export function resolvePromptSuggestions\(v\) \{[\s\S]{0,160}settingsProviderIsOfficial\(\)/.test(CH),
    'A7 resolvePromptSuggestions 必须仍用 settingsProviderIsOfficial 判类别');
  assert.equal(typeof chat.settingsProviderIsOfficial, 'function', 'A8 settingsProviderIsOfficial 被误删');

  // ── B compatKey:无 xdyn,其余键与顺序一字不变 ─────────────────────────
  const key = chatCompatKey(base);
  const keys = Object.keys(JSON.parse(key));
  assert.deepEqual(keys, ['cwd', 'effort', 'append', 'suggest', 'gr', 'dirs', 'settingsFp',
    'permEpoch', 'disToolsMtime', 'projSettingsMtime', 'mcpStampMtime', 'budget', 'acw', 'genui'],
    'B1 compatKey 只许摘掉 xdyn,其余键与顺序不得变');
  assert.ok(!key.includes('xdyn'), 'B2 compatKey 仍含 xdyn');
  assert.ok(!/excludeDynamicSystemPrompt/.test(CH.slice(CH.indexOf('export function chatCompatKey'),
    CH.indexOf('export function closePersistentForSession'))), 'B3 chatCompatKey 签名仍收该字段');

  // ── C 老客户端兼容:多传该字段既不抛错也不换键 ─────────────────────────
  for (const v of [true, false, 'auto']) {
    assert.equal(chatCompatKey({ ...base, excludeDynamicSystemPrompt: v }), key,
      `C1 老客户端传 ${String(v)} 必须被静默忽略(键不变)`);
  }
  // 请求体解构不含该字段 → 不校验、不 400
  assert.ok(!/const \{[\s\S]{0,600}excludeDynamicSystemPrompt[\s\S]{0,200}\} = req\.body/.test(CH),
    'C2 请求体仍解构 excludeDynamicSystemPrompt');
  assert.equal(count(CH, /status\(400\)[^\n]*[Dd]ynamic/g), 0, 'C3 不许为该字段返回 400');

  // ── D 合并后的单一条目:标题「缓存优化」+ 文案含并入说明与真机数字 ───────
  const SP = src('client/src/components/SettingsPanel.jsx');
  assert.ok(/\{ id: 'set-prompt-snapshot', tab: 'session', title: '缓存优化'/.test(SP),
    'D1 搜索索引条目标题必须是「缓存优化」');
  assert.equal(count(SP, /title: '缓存优化'/g), 1, 'D2 索引里只许有一个「缓存优化」条目');
  assert.equal(count(SP, /ExcludeDynamicPromptToggle/g), 0, 'D3 旧开关组件/挂载未删净');
  const card = SP.slice(SP.indexOf('function PromptCacheSnapshotToggle'), SP.indexOf('// 自动压缩窗口'));
  assert.ok(/font-medium flex items-center gap-1\.5">缓存优化<EffectBadge/.test(card), 'D4 条目标题文案必须是「缓存优化」');
  assert.ok(/「缓存优化」[\s\S]{0,80}已并入本项/.test(card), 'D5 文案必须写明旧「缓存优化」已并入本项');
  for (const n of ['99.0%', '0.0%']) assert.ok(card.includes(n), `D6 文案必须给出真机对照数字 ${n}`);
  // r100 的实际值显示与 CLI 支持提示保留
  assert.ok(card.includes('prompt-cache-actual'), 'D7 实际值显示不得被删');
  assert.ok(card.includes('cliSnapshotSupported'), 'D8 CLI 支持提示不得被删');
  assert.ok(/\['auto', '自动'\], \['on', '开'\], \['off', '关'\]/.test(card), 'D9 三态选择器不得被改');
  assert.ok(SP.includes('<div id="set-prompt-snapshot"><PromptCacheSnapshotToggle /></div>'), 'D10 条目挂载丢失');

  console.log('✅ r104-dev-remove: A 源码锁 + B 键序 + C 老客户端兼容 + D 合并条目 全部通过');
} finally {
  process.env.HOME = REAL_HOME;
  if (REAL_PROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_PROFILE;
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
}
process.exit(0);
