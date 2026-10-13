#!/usr/bin/env node
// 单测:r150 J 组 —— r149 本地存储修复的收尾(上一轮审查意见)。
//
//   J1 腾空间第②步(删别的会话的输入历史)全部删完仍写不进时,把删掉的写回去再返回 false(原来:白删)
//   J2 启动时的瘦身只在没跑过时跑一次(用一个标记键);存储写满时腾空间那条路仍然无条件瘦身。
//      原来每次启动都剔:用户在会话里重发过、又恰好在旧全局里的条目,重启后从第 1 位掉到后面
//   J3 运行中补一条「未发出的消息」(addOrphanDraftMessage)写不进时,同样先腾空间再重试一次
//   J4 没有附件时的报错文案补一句「输入内容仍在输入框中。」
//   J5 两处注释改对(源码锚)
// 上半部分真跑 client/src/utils/inputHistory.js 与界面状态库(stores/sessionStore.js),本地存储用带配额的假实现。
// Run: node tests/unit/check-r150-storage.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').slice(0, 14).join('\n      ')}`); }
};

/** 带配额的假本地存储:占用 = 所有键名 + 值的字符数;超过 quota 时 setItem 抛 QuotaExceededError。 */
function makeStorage(quota = Infinity) {
  const map = new Map();
  const st = {
    quota,
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      const value = String(v);
      const delta = k.length + value.length - (map.has(k) ? k.length + map.get(k).length : 0);
      if (st.used() + delta > st.quota) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
      map.set(k, value);
    },
    removeItem: (k) => { map.delete(k); },
    used: () => { let n = 0; for (const [k, v] of map) n += k.length + v.length; return n; },
    keys: () => [...map.keys()],
    snapshot: () => Object.fromEntries(map),
    clear: () => { map.clear(); },
  };
  return st;
}
const LEGACY = 'cgui-input-history';
const P = 'cgui-input-history:';
const legacyList = Array.from({ length: 100 }, (_, i) => `旧全局第${i}条 ` + '升级之前留下的输入。'.repeat(18));
const historySnapshot = (st) => Object.fromEntries(st.keys().filter((k) => k.startsWith(P)).map((k) => [k, st.getItem(k)]));

// 状态库要在加载之前就看到 localStorage(J3 用);J1 / J2 的模块级用例各用各的假存储
const storage = makeStorage();
globalThis.localStorage = storage;

console.log('r150 J 组:本地存储修复的收尾');

const H = await import(root + 'client/src/utils/inputHistory.js');

// ── J1 ────────────────────────────────────────────────────
await check('J1 腾不出空间(别的会话的输入历史全删了也不够):返回 false,别的会话的输入历史一条不少(原来:全被删掉)', async () => {
  const st = makeStorage();
  st.setItem('r150-ballast', 'b'.repeat(60_000));                       // 占满存储的不是输入历史
  st.setItem(`${P}open-sid`, JSON.stringify(['正在显示的会话自己的一条']));
  for (let i = 0; i < 8; i += 1) st.setItem(`${P}other-${i}`, JSON.stringify([`别的会话${i}的第一条`, `别的会话${i}的第二条 ` + 'x'.repeat(300 + i * 40)]));
  st.setItem(`${P}weird`, '这个值不是 JSON');                           // 解析不了的会话键:也在可删范围内,删了同样要写回
  st.setItem('cgui-draft:open-sid', '正在写的草稿');
  const before = st.snapshot();
  st.quota = st.used() + 5;
  const big = 'q'.repeat(50_000);                                       // 比所有输入历史加起来还大
  let attempts = 0;
  const attempt = () => { attempts += 1; try { st.setItem('r150-target', big); return true; } catch { return false; } };
  assert.equal(attempt(), false, '前提:这次写入本来就写不进');
  const ok = H.freeInputHistoryAndRetry(st, attempt, ['open-sid']);
  assert.equal(ok, false, '腾不出就该返回 false');
  assert.ok(attempts >= 3, '应当确实逐个删过、试过');
  assert.deepEqual(st.snapshot(), before, '返回 false 之后,存储应与调用前逐字相同(删掉的要写回去)');
  assert.equal(st.getItem('r150-target'), null);
});
await check('J1 经输入框的写入口(saveInputHistoryEntry)同样:腾不出时别的会话的输入历史不丢', async () => {
  const st = makeStorage();
  st.setItem('r150-ballast', 'b'.repeat(40_000));
  for (let i = 0; i < 5; i += 1) st.setItem(`${P}other-${i}`, JSON.stringify([`别的会话${i}的一条`]));
  // 本会话自己的输入历史已经很大:新写入要整份重写,需要的空间比别的会话加起来还多
  st.setItem(`${P}mine`, JSON.stringify(['m'.repeat(3000)]));
  const before = historySnapshot(st);
  st.quota = st.used() + 5;
  assert.equal(H.saveInputHistoryEntry(st, 'mine', 'n'.repeat(3900)), false);
  assert.deepEqual(historySnapshot(st), before, '所有会话的输入历史应与调用前相同');
});
await check('J1 对照:腾得出时照旧 —— 从占用最大的删起,够了就停,删掉的不写回,返回 true', async () => {
  const st = makeStorage();
  st.setItem('r150-ballast', 'b'.repeat(20_000));
  for (let i = 0; i < 6; i += 1) st.setItem(`${P}other-${i}`, JSON.stringify(['o'.repeat(1000 + i * 100)]));
  st.quota = st.used() + 5;
  const attempt = () => { try { st.setItem('r150-target', 't'.repeat(1400)); return true; } catch { return false; } };
  assert.equal(H.freeInputHistoryAndRetry(st, attempt, []), true);
  assert.equal(st.getItem(`${P}other-5`), null, '最大的那个被删');
  assert.ok(st.getItem(`${P}other-0`) !== null, '够了就停');
  assert.equal(st.getItem('r150-target').length, 1400);
});

// ── J2 ────────────────────────────────────────────────────
await check('J2 模块导出 slimInputHistoryOnce 与标记键名;标记键不是输入历史键(不会被瘦身 / 腾空间当成会话历史)', async () => {
  assert.equal(typeof H.slimInputHistoryOnce, 'function', '缺少导出 slimInputHistoryOnce');
  assert.equal(typeof H.INPUT_HISTORY_SLIM_DONE_KEY, 'string', '缺少导出 INPUT_HISTORY_SLIM_DONE_KEY');
  assert.ok(!H.INPUT_HISTORY_SLIM_DONE_KEY.startsWith(P), '标记键不能落在 cgui-input-history:<会话键> 这个前缀下');
  assert.notEqual(H.INPUT_HISTORY_SLIM_DONE_KEY, LEGACY);
});
const needOnce = () => assert.equal(typeof H.slimInputHistoryOnce, 'function', '缺少导出 slimInputHistoryOnce');
await check('J2 启动两次:会话里重发过的旧全局同款条目仍在会话键里、仍排第 1 位(原来:第二次启动被剔掉)', async () => {
  needOnce();
  const st = makeStorage();
  st.setItem(LEGACY, JSON.stringify(legacyList));
  st.setItem(`${P}sid-a`, JSON.stringify(['会话A自己发的一条', ...legacyList]));   // 修前留下的副本形态
  // 第一次启动:瘦身(剔掉副本)
  const first = H.slimInputHistoryOnce(st);
  assert.ok(first && first.rewrittenKeys === 1, `第一次启动应瘦身(实得 ${JSON.stringify(first)})`);
  assert.deepEqual(JSON.parse(st.getItem(`${P}sid-a`)), ['会话A自己发的一条']);
  assert.ok(st.getItem(H.INPUT_HISTORY_SLIM_DONE_KEY) !== null, '应写下"已瘦身"的标记');
  // 用户在会话里重发了一条旧全局里也有的输入
  const resent = legacyList[7];
  assert.equal(H.saveInputHistoryEntry(st, 'sid-a', resent), true);
  assert.deepEqual(JSON.parse(st.getItem(`${P}sid-a`)), [resent, '会话A自己发的一条']);
  // 第二次启动
  const second = H.slimInputHistoryOnce(st);
  assert.equal(second, null, '已经跑过:第二次启动不再瘦身');
  assert.deepEqual(JSON.parse(st.getItem(`${P}sid-a`)), [resent, '会话A自己发的一条'], '重发的那条应仍在会话键里');
  assert.equal(H.readInputHistory(st, 'sid-a')[0], resent, '上键第一下翻出来的应是刚重发的那条');
});
await check('J2 只跑一次:第二次调用不执行瘦身函数;标记写不进也不抛', async () => {
  needOnce();
  const st = makeStorage();
  let runs = 0;
  const slim = () => { runs += 1; return { removedKeys: 0, rewrittenKeys: 0, freedChars: 0 }; };
  H.slimInputHistoryOnce(st, slim);
  H.slimInputHistoryOnce(st, slim);
  H.slimInputHistoryOnce(st, slim);
  assert.equal(runs, 1);
  const full = makeStorage();
  full.setItem('r150-ballast', 'b'.repeat(1000));
  full.quota = full.used();
  assert.doesNotThrow(() => H.slimInputHistoryOnce(full, slim));
});
await check('J2 存储写满时腾空间那条路仍然无条件瘦身(标记已在也照样剔副本)', async () => {
  needOnce();
  const st = makeStorage();
  st.setItem(LEGACY, JSON.stringify(legacyList));
  H.slimInputHistoryOnce(st);                                            // 启动时跑过了,标记已在
  // 之后又出现了带副本的会话键(例如另一个还在跑旧版的窗口写的)
  for (let i = 0; i < 30; i += 1) st.setItem(`${P}sid-${i}`, JSON.stringify([`会话${i}自己发的一条`, ...legacyList]));
  st.quota = st.used() + 5;
  const attempt = () => { try { st.setItem('r150-target', 't'.repeat(5000)); return true; } catch { return false; } };
  assert.equal(H.freeInputHistoryAndRetry(st, attempt, []), true);
  for (let i = 0; i < 30; i += 1) assert.deepEqual(JSON.parse(st.getItem(`${P}sid-${i}`)), [`会话${i}自己发的一条`], `会话 ${i}:只剔副本,自己的条目保留`);
});
await check('J2 接线:App.jsx 启动闸之后经 slimInputHistoryOnce 调瘦身(不再每次启动都直接跑)', async () => {
  const app = read('client/src/App.jsx');
  assert.match(app, /afterBoot\(\(\) => \{[^}]*slimInputHistoryOnce\(localStorage[^}]*\}\)/, 'App.jsx 的启动闸回调里没有 slimInputHistoryOnce(localStorage…)');
  assert.ok(!/afterBoot\(\(\) => \{\s*slimInputHistory\(localStorage\);?\s*\}\)/.test(app), 'App.jsx 里还在每次启动都直接跑 slimInputHistory(localStorage)');
});

// ── J3 ────────────────────────────────────────────────────
const { useStore } = await import(root + 'client/src/stores/sessionStore.js');
const ORPHAN_KEY = 'cgui-orphan-draft-queues';
function scene() {
  storage.quota = Infinity;
  for (const k of storage.keys()) if (k.startsWith(P) || k === LEGACY || k.startsWith('r150-')) storage.removeItem(k);
  useStore.setState({ orphanDraftQueues: {}, paneSessions: [{ sessionId: 'open-sid', projectHash: 'p' }], paneCount: 1 });
  storage.setItem(ORPHAN_KEY, '{}');
}
await check('J3 存储被旧全局历史的副本占满:补一条「未发出的消息」—— 自动腾空间后重试成功(原来:返回 false,这条没留住)', async () => {
  scene();
  storage.setItem(LEGACY, JSON.stringify(legacyList));
  for (let i = 0; i < 40; i += 1) storage.setItem(`${P}sid-${i}`, JSON.stringify([`会话${i}自己发的一条`, ...legacyList]));
  storage.quota = storage.used() + 5;
  const ok = useStore.getState().addOrphanDraftMessage('draft:p:1', 'p', { queueId: 'q1', text: '回退中途没处放的一条', queuedAt: 1 });
  assert.equal(ok, true, 'addOrphanDraftMessage 返回了 false');
  assert.deepEqual(JSON.parse(storage.getItem(ORPHAN_KEY))['draft:p:1'].items.map((x) => x.text), ['回退中途没处放的一条'], '应已落盘');
  assert.deepEqual(useStore.getState().orphanDraftQueues['draft:p:1'].items.map((x) => x.text), ['回退中途没处放的一条']);
  assert.deepEqual(JSON.parse(storage.getItem(`${P}sid-3`)), ['会话3自己发的一条'], '只剔了副本');
});
await check('J3 腾不出(占满存储的不是输入历史):照旧返回 false、内存里的表不变、别的会话的输入历史一条不少', async () => {
  scene();
  storage.setItem('r150-ballast', 'b'.repeat(50_000));
  for (let i = 0; i < 4; i += 1) storage.setItem(`${P}other-${i}`, JSON.stringify([`别的会话${i}的一条`]));
  const before = historySnapshot(storage);
  storage.quota = storage.used() + 5;
  const ok = useStore.getState().addOrphanDraftMessage('draft:p:2', 'p', { queueId: 'q2', text: '这条存不进去'.repeat(200), queuedAt: 2 });
  assert.equal(ok, false);
  assert.equal(useStore.getState().orphanDraftQueues['draft:p:2'], undefined, '没落盘就不能进内存表(原有约定)');
  assert.deepEqual(historySnapshot(storage), before, '别的会话的输入历史应与调用前相同');
  storage.quota = Infinity;
});
await check('J1 经待发队列入口(enqueueMessage)同样:腾不出时别的会话的输入历史一条不少(原来:全被删掉,消息还是没排上)', async () => {
  scene();
  useStore.setState({ messageQueue: {} });
  storage.setItem('cgui-message-queue', '{}');
  storage.setItem('r150-ballast', 'b'.repeat(50_000));
  for (let i = 0; i < 6; i += 1) storage.setItem(`${P}other-${i}`, JSON.stringify([`别的会话${i}的一条`, `别的会话${i}的又一条`]));
  const before = historySnapshot(storage);
  storage.quota = storage.used() + 5;
  const queued = useStore.getState().enqueueMessage('open-sid', { text: '这条存不进去'.repeat(400), queuedAt: 3 });
  assert.equal(queued, null);
  assert.deepEqual(historySnapshot(storage), before, '别的会话的输入历史应与调用前相同');
  storage.quota = Infinity;
});

// ── J4 ────────────────────────────────────────────────────
await check('J4 没有附件时的报错文案:「无法保存待发消息：本地存储已满。输入内容仍在输入框中。」;有附件的两句不变', async () => {
  const { queueSaveFailedNotice } = await import(root + 'client/src/utils/storageNotice.js');
  const plain = '无法保存待发消息：本地存储已满。输入内容仍在输入框中。';
  assert.equal(queueSaveFailedNotice({ hasAttachments: false }), plain);
  assert.equal(queueSaveFailedNotice({ hasAttachments: false, inSession: true }), plain);
  assert.equal(queueSaveFailedNotice(), plain);
  assert.equal(queueSaveFailedNotice({ hasAttachments: true }), '无法保存待发消息：本地存储空间不足。附件仍保留，请移除部分附件后重试。');
  assert.equal(queueSaveFailedNotice({ hasAttachments: true, inSession: true }), '无法保存待发消息：本地存储空间不足。附件与草稿仍保留，请处理后重试。');
});

// ── J5 注释 ───────────────────────────────────────────────
await check('J5 pricingCatalog.js:ensurePricingCatalog 的说明不再写"首页用量块"会调它(实际只有打开会话时与启动闸之后两处)', async () => {
  const src = read('client/src/utils/pricingCatalog.js');
  const at = src.indexOf('export function ensurePricingCatalog');
  const doc = src.slice(src.lastIndexOf('/**', at), at);
  assert.ok(!doc.includes('首页用量块'), '说明里还写着"首页用量块"');
  assert.ok(doc.includes('打开了一条会话') || doc.includes('打开一条会话'), '说明应写明真实的调用处');
});
await check('J5 inputHistory.js:腾空间第②步写明"不看值内容,解析不了的会话键也会删,只限输入历史键"', async () => {
  const src = read('client/src/utils/inputHistory.js');
  const at = src.indexOf('export function freeInputHistoryAndRetry');
  const doc = src.slice(src.lastIndexOf('/**', at), at);
  assert.ok(doc.includes('不看值'), '第②步应写明不看值内容');
  assert.ok(doc.includes('解析不了'), '第②步应写明解析不了的会话键也会删');
  assert.ok(doc.includes('写回'), '第③步应写明删掉的会写回去(J1)');
});

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
