#!/usr/bin/env node
// r80 复现测试:会话模型"变回全局默认(fable)"的两个发版级缺陷。
// 依据 .devflow/BUGREPORT-r80-model-pin-reset.md 的档 G / 档 H 实测。
//
//  缺陷①(档 G):Home(未选会话)时 headerPermKey 恒 null → setModelFor(null, m) 走
//    "只改内存 currentModel"分支,零落盘 → 刷新/重启必回全局默认。
//    修法 A1:Home 落到一个待发草稿键(HOME_DRAFT_KEY),Home 发首条消息时把 pin
//    交接给真 draft 键,再由既有 init 迁移落到真 sessionId。
//  缺陷②(档 H):providerEpoch 一旦写入永不清零,连官方 Anthropic 下完全合法的
//    claude 模型也被判死 → 老会话显示/发送一律回落全局默认。
//    修法 B1:官方 provider 下取消 epoch 门控;非官方原样保留(防 U1/U4 回归)。
//
// Run: node tests/unit/check-r80-model-pin.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveHistModel, resolveSelectorModel } from '../../client/src/utils/routing.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
const steer = readFileSync(join(root, 'client/src/utils/steerQueue.js'), 'utf8');
const sidebar = readFileSync(join(root, 'client/src/components/UnifiedSidebar.jsx'), 'utf8');

// 一次跑完列出全部红点(单条 assert 抛错会掩盖后面的条目,红态记录看不全)。
const failures = [];
const check = (name, fn) => {
  try { fn(); } catch (e) { failures.push(`${name}: ${e.message}`); }
};

// ── T1(B1 行为):epoch 门控加官方豁免 ──────────────────────────────
// 真机 epoch = 2026-08-31 09:03:07;此前所有无 pin 会话的历史模型被判死。
const EPOCH = Date.parse('2026-08-31T09:03:07Z');
const HIST = [{ model: 'claude-sonnet-4-6', timestamp: '2026-08-01T00:00:00Z' }];

check('T1a 官方 provider + epoch:合法 claude 历史模型不再判死', () => {
  assert.equal(resolveHistModel(HIST, EPOCH, true), 'claude-sonnet-4-6');
});
check('T1b 非官方 provider + epoch:门控原样保留(防 U1/U4 回归)', () => {
  assert.equal(resolveHistModel(HIST, EPOCH, false), null);
});
check('T1c 第三参默认 = 非官方(既有调用点行为不变)', () => {
  assert.equal(resolveHistModel(HIST, EPOCH), null);
});
check('T1d 官方豁免不越界:伪 id 照旧跳过', () => {
  assert.equal(resolveHistModel([{ model: '<synthetic>', timestamp: '2026-09-01T00:00:00Z' }], EPOCH, true), null);
});
check('T1e 官方豁免不影响 epoch=0 的既有语义', () => {
  assert.equal(resolveHistModel(HIST, 0, true), 'claude-sonnet-4-6');
});

// 选择器侧(会话元数据那一环)同口径 —— 否则顶栏 chip 与徽章/发送解析分裂。
const S = (o) => ({
  modelBySession: {}, context1mBySession: {}, paneSessions: [], selectedSession: null,
  currentModel: 'fable', providerEpoch: 0, ...o,
});
check('T1f resolveSelectorModel:官方 + epoch 下会话元数据模型仍可信', () => {
  assert.equal(resolveSelectorModel(S({
    providerEpoch: EPOCH,
    currentProvider: { providerHint: 'anthropic' },
    selectedSession: { sessionId: 's1', model: 'claude-sonnet-4-6' },
  }), 's1'), 'claude-sonnet-4-6');
});
check('T1g resolveSelectorModel:非官方 + epoch 仍判死,回落全局', () => {
  assert.equal(resolveSelectorModel(S({
    providerEpoch: EPOCH,
    currentProvider: { providerHint: 'deepseek' },
    selectedSession: { sessionId: 's1', model: 'claude-sonnet-4-6' },
  }), 's1'), 'fable');
});
check('T1h 残余风险防线:官方下旧 provider 的模型仍由白名单挡住(不靠 epoch)', () => {
  assert.equal(resolveSelectorModel(S({
    providerEpoch: EPOCH,
    currentProvider: { providerHint: 'anthropic' },
    availableModels: [{ id: 'claude-sonnet-4-6' }, { id: 'claude-opus-4-8' }],
    selectedSession: { sessionId: 's1', model: 'mimo-v2.5-pro' },
  }), 's1'), 'fable');
});
check('T1i 发送链必须同口径:resolveHistModel 调用点要传官方标志', () => {
  assert.match(app, /resolveHistModel\(\s*getLocalMessages\(\)[^;]*official/i,
    'App.jsx 的发送侧 resolveHistModel 未传官方标志 → 显示放行、发送仍判死');
});

// B1 有三处实现,前两处(routing.js 的两个纯函数)由 T1a/T1f 行为咬死,第三处是
// App.jsx 的 historyModel —— 那条链的手写强化版(历史环扫 messages,routing.js 那份
// 拿不到 messages)。它正是档 H 症状的直接显示面:**会话内的模型徽章**。把这两处
// guardOfficial 豁免 revert 掉,其余 335 个测试全绿,就能静默回归成"顶栏 chip 显示
// sonnet、会话内徽章显示 fable"的分裂。纯函数测不到它,只能钉源码形态。
check('T1j 徽章 fresh():epoch 门控带官方豁免', () => {
  assert.match(app, /const fresh = \(m\) => !providerEpoch \|\| guardOfficial \|\|/,
    'App.jsx historyModel 的 fresh() 丢了 guardOfficial → 官方下老会话徽章又掉回全局默认');
});
check('T1k 徽章会话元数据分支:epoch 门控带官方豁免', () => {
  assert.match(app, /selectedSession\?\.model && \(!providerEpoch \|\| guardOfficial\)/,
    'messages 未加载时走的是这一支,丢了豁免 → 切入会话瞬间徽章闪回全局默认');
});
check('T1l guardOfficial 必须声明在 historyModel 之前(TDZ 红线)', () => {
  const decl = app.indexOf('const guardOfficial = useStore(');
  const use = app.indexOf('const historyModel = useMemo(');
  assert.ok(decl > 0 && use > 0 && decl < use,
    'guardOfficial 声明被移回 useMemo 之后 = 渲染期 TDZ 整页白屏(本仓烧过四个版本)');
});

// ── T2(A1 接线锁):Home 下模型选择器必须有落盘键 ──────────────────────
// 只改模型这一颗。力度选择器的 null 分支 setEffortFor(null,e) 本来就落盘(写全局
// cgui-effort),把它也改成 pin 键会把"在 Home 设全局默认力度"变成一次性 pin = 回归。
check('T2a 模型选择器不再绑 Home 恒 null 的那个键', () => {
  assert.ok(!/<ModelSelector[^>]*permKey=\{headerPermKey\}/.test(app),
    'ModelSelector 仍绑 headerPermKey → Home 时 setModelFor(null,…) 零落盘');
});
check('T2b 模型选择器 Home 分支指向待发草稿键 HOME_DRAFT_KEY', () => {
  assert.match(app, /headerModelKey\s*=\s*headerPane\s*\?\s*headerPermKey\s*:\s*HOME_DRAFT_KEY/,
    '缺 headerModelKey:Home 的模型选择没有落盘键');
  assert.match(app, /<ModelSelector[^>]*permKey=\{headerModelKey\}/,
    'ModelSelector 未绑 headerModelKey');
});
check('T2f 力度选择器仍绑 headerPermKey(Home 力度写全局,不许改成一次性 pin)', () => {
  assert.match(app, /<EffortSelector[^>]*permKey=\{headerPermKey\}/,
    'EffortSelector 被改绑 → Home 设的全局默认力度会退化成一次性 pin');
});
check('T2c HOME_DRAFT_KEY 由键构造单一来源 steerQueue.js 导出', () => {
  assert.match(steer, /export const HOME_DRAFT_KEY\s*=/,
    '键必须与 queueKeyFor 同处定义,不许在 App.jsx 里裸写字面量');
});
check('T2d Home 发首条消息时把 pin 交接给真 draft 键', () => {
  assert.match(app, /migrateSessionKey\(\s*HOME_DRAFT_KEY\s*,\s*queueKeyFor\(_homeDraft\)\s*,\s*true\s*\)/,
    '缺交接:Home 选的模型落在 HOME_DRAFT_KEY 上,发消息后到不了真会话');
});
check('T2e UnifiedSidebar 的 setModelFor(draftKey, \'\') 死代码已删', () => {
  // 行首锚定 st. → 只咬可执行语句,注释里提到这行(说明为何删)不算。
  assert.ok(!/^\s*st\.setModelFor\(draftKey,\s*''\)/m.test(sidebar),
    '该行被 setModelFor 首行 if(!model) return 吞掉,恒 no-op');
});

// ── T3(A1 行为,store 级防退化锁)────────────────────────────────────
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => { storage.set(k, String(v)); },
  removeItem: (k) => { storage.delete(k); },
};
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

const { HOME_DRAFT_KEY } = await import('../../client/src/utils/steerQueue.js');
const { useStore } = await import('../../client/src/stores/sessionStore.js');
const pins = () => useStore.getState().modelBySession;
const lsPins = () => JSON.parse(storage.get('cgui-model-by-session') || '{}');

check('T3a HOME_DRAFT_KEY 是 draft- 形态(不同步服务端,与既有 draft 键语义一致)', () => {
  assert.equal(typeof HOME_DRAFT_KEY, 'string');
  assert.ok(HOME_DRAFT_KEY.startsWith('draft-'), `${HOME_DRAFT_KEY} 必须以 draft- 开头`);
});

check('T3b Home 选的模型落 localStorage(缺陷① 的直接对立面)', () => {
  useStore.setState({ modelBySession: {}, currentModel: 'fable' });
  useStore.getState().setModelFor(HOME_DRAFT_KEY, 'claude-opus-4-8');
  assert.equal(pins()[HOME_DRAFT_KEY], 'claude-opus-4-8', 'store 未记录');
  assert.equal(lsPins()[HOME_DRAFT_KEY], 'claude-opus-4-8', 'localStorage 未落盘 → 刷新即丢');
  assert.equal(useStore.getState().currentModel, 'fable', '不许改全局(分屏污染防线)');
});

check('T3c 交接链:HOME_DRAFT_KEY → 真 draft 键 → 真 sessionId', () => {
  const draftKey = 'draft-hash1-d1770000000-1';
  useStore.setState({ modelBySession: { [HOME_DRAFT_KEY]: 'claude-opus-4-8' } });
  useStore.getState().migrateSessionKey(HOME_DRAFT_KEY, draftKey, true);
  assert.equal(pins()[draftKey], 'claude-opus-4-8', '交接到 draft 键失败');
  assert.ok(!(HOME_DRAFT_KEY in pins()), '源键必须删除 —— 下一次 Home 才不继承旧选择');
  useStore.getState().migrateSessionKey(draftKey, 'real-sid-1');
  assert.equal(pins()['real-sid-1'], 'claude-opus-4-8', 'init 后未落到真 sessionId');
  assert.ok(!(draftKey in pins()), 'draft 键残留');
});

check('T3d setModelFor(key, \'\') 恒 no-op(所以删那行死代码零行为变化)', () => {
  useStore.setState({ modelBySession: {} });
  useStore.getState().setModelFor('draft-x-d1-1', '');
  assert.deepEqual(pins(), {}, '空串若能写入,删除 UnifiedSidebar 那行就不是零风险');
});

if (failures.length) {
  console.error(`check-r80-model-pin: ${failures.length} FAILED`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('check-r80-model-pin: all passed');
