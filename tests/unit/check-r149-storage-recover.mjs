#!/usr/bin/env node
// 单测:r149 S 组的接线 —— 待发队列存不进时自动腾空间重试(S4)、删会话清输入历史(S5)、
// 报错只在真的腾不出时出现且没有附件时不提附件(S6)、启动后瘦身一次(S2)、输入框走新模块(S1 / S3)。
//
// 上半部分真跑界面状态库(stores/sessionStore.js)的 enqueueMessage:它是首页发消息、会话里排队共用的
// 那条"先落盘成功才算排上"的路(persistQueueSnapshot(…, true))。本地存储用带配额的假实现。
// 下半部分是源码锚(界面外数不出的接线)。界面层见 tests/acceptance/r149-storage。
// Run: node tests/unit/check-r149-storage-recover.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').slice(0, 14).join('\n      ')}`); }
};

// 带配额的假本地存储(必须在加载状态库之前挂上)
const map = new Map();
const storage = {
  quota: Infinity,
  get length() { return map.size; },
  key: (i) => [...map.keys()][i] ?? null,
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem(k, v) {
    const value = String(v);
    const delta = k.length + value.length - (map.has(k) ? k.length + map.get(k).length : 0);
    if (storage.used() + delta > storage.quota) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
    map.set(k, value);
  },
  removeItem: (k) => { map.delete(k); },
  used: () => { let n = 0; for (const [k, v] of map) n += k.length + v.length; return n; },
};
globalThis.localStorage = storage;

const P = 'cgui-input-history:';
const LEGACY = 'cgui-input-history';
const legacyList = Array.from({ length: 100 }, (_, i) => `旧全局第${i}条 ` + '升级之前留下的输入。'.repeat(18));
const OTHERS = { 'cgui-draft:open-sid': '正在写的草稿', 'cgui-custom-titles': '{"open-sid":"我的标题"}', 'cgui-perm-mode:open-sid': 'plan' };

console.log('r149 存不进时腾空间重试 / 删会话清历史 / 报错文案 / 启动瘦身');

const { useStore } = await import(root + 'client/src/stores/sessionStore.js');
/** 重置场景:清掉输入历史与待发队列,窗格里显示 open-sid。 */
function scene() {
  storage.quota = Infinity;
  for (const k of [...map.keys()]) if (k.startsWith(P) || k === LEGACY || k.startsWith('r149-')) map.delete(k);
  useStore.setState({ messageQueue: {}, paneSessions: [{ sessionId: 'open-sid', projectHash: 'p' }], paneCount: 1 });
  storage.setItem('cgui-message-queue', '{}');
  for (const [k, v] of Object.entries(OTHERS)) storage.setItem(k, v);
}
const queuedTexts = () => (JSON.parse(storage.getItem('cgui-message-queue') || '{}')['open-sid'] || []).map((x) => x.text);

await check('S4 存储被旧全局历史的副本占满:排队一条消息 —— 自动瘦身后重试成功(原来:返回 null,界面报"本地存储空间不足")', async () => {
  scene();
  storage.setItem(LEGACY, JSON.stringify(legacyList));
  for (let i = 0; i < 80; i += 1) storage.setItem(`${P}sid-${i}`, JSON.stringify([`会话${i}自己发的一条`, ...legacyList]));
  storage.quota = storage.used() + 5;
  const queued = useStore.getState().enqueueMessage('open-sid', { text: '存储满时排队的一条', queuedAt: 1 });
  assert.ok(queued, 'enqueueMessage 返回了 null(没排上)');
  assert.deepEqual(queuedTexts(), ['存储满时排队的一条'], '应已落进持久化的待发队列');
  assert.deepEqual(useStore.getState().messageQueue['open-sid'].map((x) => x.text), ['存储满时排队的一条']);
  assert.deepEqual(JSON.parse(storage.getItem(`${P}sid-3`)), ['会话3自己发的一条'], '各会话自己的条目保留,只剔了副本');
  assert.deepEqual(JSON.parse(storage.getItem(LEGACY)), legacyList);
  for (const [k, v] of Object.entries(OTHERS)) assert.equal(storage.getItem(k), v, `${k} 不许被动`);
});

await check('S4 瘦身腾不出(全是各会话自己的内容):删别的会话的输入历史后重试成功;正在显示的会话(哪怕最大)一条不少', async () => {
  scene();
  const mine = ['m'.repeat(30000)];
  storage.setItem(`${P}open-sid`, JSON.stringify(mine));
  for (let i = 0; i < 10; i += 1) storage.setItem(`${P}other-${i}`, JSON.stringify(['o'.repeat(1000 + i * 100)]));
  storage.quota = storage.used() + 5;
  const queued = useStore.getState().enqueueMessage('open-sid', { text: '排队'.repeat(300), queuedAt: 2 });
  assert.ok(queued, 'enqueueMessage 返回了 null(没排上)');
  assert.deepEqual(JSON.parse(storage.getItem(`${P}open-sid`)), mine, '正在显示的会话的输入历史不许被删');
  assert.equal(storage.getItem(`${P}other-9`), null, '应从占用最大的别的会话删起');
  assert.ok(storage.getItem(`${P}other-0`) !== null, '够了就停,不该把别的会话的全删光');
  for (const [k, v] of Object.entries(OTHERS)) assert.equal(storage.getItem(k), v, `${k} 不许被动`);
});

await check('S4 占满存储的不是输入历史:腾不出,照旧返回 null、内存里的队列不变;别的键一个都没动', async () => {
  scene();
  storage.setItem('r149-ballast', 'b'.repeat(50000));
  storage.setItem(`${P}open-sid`, JSON.stringify(['只有正在显示的会话有输入历史']));
  storage.quota = storage.used() + 5;
  const queued = useStore.getState().enqueueMessage('open-sid', { text: '这条存不进去'.repeat(50), queuedAt: 3 });
  assert.equal(queued, null);
  assert.equal(useStore.getState().messageQueue['open-sid'], undefined, '没落盘就不能进内存队列(原有约定)');
  assert.equal(storage.getItem('r149-ballast').length, 50000);
  assert.ok(storage.getItem(`${P}open-sid`) !== null);
  for (const [k, v] of Object.entries(OTHERS)) assert.equal(storage.getItem(k), v, `${k} 不许被动`);
  storage.quota = Infinity;
});

// ── S6 文案 ───────────────────────────────────────────────
await check('S6 报错文案:没有附件时不提附件、客观陈述;有附件时保留原来的句子', async () => {
  const { queueSaveFailedNotice } = await import(root + 'client/src/utils/storageNotice.js');
  assert.equal(queueSaveFailedNotice({ hasAttachments: false }), '无法保存待发消息：本地存储已满。输入内容仍在输入框中。');
  assert.equal(queueSaveFailedNotice({ hasAttachments: false, inSession: true }), '无法保存待发消息：本地存储已满。输入内容仍在输入框中。');
  assert.equal(queueSaveFailedNotice({ hasAttachments: true }), '无法保存待发消息：本地存储空间不足。附件仍保留，请移除部分附件后重试。');
  assert.equal(queueSaveFailedNotice({ hasAttachments: true, inSession: true }), '无法保存待发消息：本地存储空间不足。附件与草稿仍保留，请处理后重试。');
});
await check('S6 两处报错(首页发送、会话里排队)都走这个函数,App.jsx 里不再有写死的句子', async () => {
  const app = read('client/src/App.jsx');
  assert.equal((app.match(/queueSaveFailedNotice\(/g) || []).length, 2, '应恰好两处调用');
  assert.ok(!app.includes('本地存储空间不足。附件'), 'App.jsx 里还有写死的"本地存储空间不足。附件…"');
});

// ── 接线锚 ────────────────────────────────────────────────
await check('S2 启动后瘦身一次,且不在首屏关键路径上(放在启动闸之后)', async () => {
  const app = read('client/src/App.jsx');
  assert.match(app, /afterBoot\(\(\) => \{[^}]*slimInputHistory\(localStorage\)[^}]*\}\)/, 'App.jsx 里没有"启动闸之后跑 slimInputHistory(localStorage)"');
});
await check('S1 / S3 / S4 输入框读写输入历史走新模块,不再自己拼"回落读旧全局再整份写回"', async () => {
  const chat = read('client/src/components/ChatInput.jsx');
  assert.match(chat, /readInputHistory\(localStorage, /, '读历史应走 readInputHistory');
  assert.match(chat, /saveInputHistoryEntry\(localStorage, /, '写历史应走 saveInputHistoryEntry');
  assert.ok(!/localStorage\.setItem\(historyKey/.test(chat), 'ChatInput 里还在直接往会话键写输入历史');
});
await check('S5 删会话的两条路(确认删除、离开页面时的兜底)都清它的输入历史', async () => {
  const side = read('client/src/components/UnifiedSidebar.jsx');
  const really = side.slice(side.indexOf('const reallyDelete = async'), side.indexOf('const reallyDelete = async') + 2200);
  const flush = side.slice(side.indexOf('const flushAllPending = ()'), side.indexOf('const flushAllPending = ()') + 900);
  assert.match(really, /removeInputHistory\(localStorage, session\.sessionId\)/, 'reallyDelete 里没有清输入历史');
  assert.match(flush, /removeInputHistory\(localStorage, p\.session\.sessionId\)/, 'flushAllPending 里没有清输入历史');
});

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
