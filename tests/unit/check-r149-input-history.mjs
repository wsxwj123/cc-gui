#!/usr/bin/env node
// 单测:r149 S 组 —— 输入历史不再把本地存储占满(模块 client/src/utils/inputHistory.js)。
//
// 现象(用户实报):首页发消息被拦,「无法保存待发消息：本地存储空间不足…」。实测本地存储 5 MB 上限里,
// cgui-input-history:<会话键> 共 211 个键占 92%,其中 88% 的条目是旧全局键 cgui-input-history(100 条)的
// 原样副本。根因:本会话键为空时读历史会回落到旧全局键,而写入拿这份回落结果加上新条目整份写进本会话键 ——
// 每个新会话第一次发消息就把旧全局 100 条抄一份。
//
// 这里用一个带配额的假本地存储(超过配额 setItem 就抛错)真跑模块的每个函数:
//   S1 写入只基于本会话键自己的列表;上键 = 本会话在前、旧全局在后、去重
//   S2 瘦身:剔除会话键里与旧全局相同的条目,剔空则删键;幂等;不动别的键
//   S3 超过 4000 字符的单条不进输入历史
//   S4 写不进时腾空间重试:先瘦身;不够再按占用从大到小删"没有显示在任何窗格里的会话"的输入历史键
//   S5 删会话时删它的键
// 界面层见 tests/acceptance/r149-storage。
// Run: node tests/unit/check-r149-input-history.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
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
  };
  return st;
}
const LEGACY = 'cgui-input-history';
const P = 'cgui-input-history:';
const legacyList = Array.from({ length: 100 }, (_, i) => `旧全局第${i}条 ` + '升级之前留下的输入。'.repeat(18));
const historyChars = (st) => st.keys().filter((k) => k.startsWith(P)).reduce((n, k) => n + k.length + st.getItem(k).length, 0);
/** 修前每个新会话第一次发消息写出来的形态:自己的一条 + 旧全局 100 条的副本。 */
const copyKey = (st, i) => st.setItem(`${P}sid-copy-${i}`, JSON.stringify([`会话${i}自己发的一条`, ...legacyList]));

console.log('r149 输入历史不再占满本地存储');

let H = null;
await check('模块存在(client/src/utils/inputHistory.js)且导出约定的函数与常量', async () => {
  H = await import(root + 'client/src/utils/inputHistory.js');
  for (const fn of ['inputHistoryKey', 'readInputHistory', 'saveInputHistoryEntry', 'slimInputHistoryEntries', 'slimInputHistory', 'freeInputHistoryAndRetry', 'removeInputHistory']) {
    assert.equal(typeof H[fn], 'function', `缺少导出 ${fn}`);
  }
  assert.equal(H.LEGACY_INPUT_HISTORY_KEY, LEGACY);
  assert.equal(H.INPUT_HISTORY_PREFIX, P);
  assert.equal(H.INPUT_HISTORY_MAX_ENTRIES, 100);
  assert.equal(H.INPUT_HISTORY_MAX_ENTRY_CHARS, 4000);
  assert.equal(H.inputHistoryKey('abc'), `${P}abc`);
  assert.equal(H.inputHistoryKey(null), `${P}global`, '没有会话键时沿用原来的 global 键名');
});
const need = () => assert.ok(H, '模块不存在');

// ── S1 ────────────────────────────────────────────────────
await check('S1 新会话第一次写入:会话键里只有这一条(原来:这一条 + 旧全局 100 条)', async () => {
  need();
  const st = makeStorage();
  st.setItem(LEGACY, JSON.stringify(legacyList));
  assert.equal(H.saveInputHistoryEntry(st, 'sid-new', '第一条'), true);
  assert.deepEqual(JSON.parse(st.getItem(`${P}sid-new`)), ['第一条']);
  assert.deepEqual(JSON.parse(st.getItem(LEGACY)), legacyList, '旧全局键不许改');
});
await check('S1 上键翻历史:本会话的在前、旧全局的在后、去重;本会话没写过时仍翻得出旧全局', async () => {
  need();
  const st = makeStorage();
  st.setItem(LEGACY, JSON.stringify(['旧A', '共有', '旧B']));
  assert.deepEqual(H.readInputHistory(st, 'sid-x'), ['旧A', '共有', '旧B'], '升级后旧历史仍然翻得出来');
  H.saveInputHistoryEntry(st, 'sid-x', '新1');
  H.saveInputHistoryEntry(st, 'sid-x', '共有');
  assert.deepEqual(H.readInputHistory(st, 'sid-x'), ['共有', '新1', '旧A', '旧B']);
  assert.deepEqual(JSON.parse(st.getItem(`${P}sid-x`)), ['共有', '新1'], '写进去的只有本会话自己发过的');
  assert.deepEqual(H.readInputHistory(st, 'sid-other'), ['旧A', '共有', '旧B'], '别的会话看不到这个会话的条目');
});
await check('S1 重复的条目提到最前、不重复存;最多留 100 条;空白不写', async () => {
  need();
  const st = makeStorage();
  for (let i = 0; i < 130; i += 1) H.saveInputHistoryEntry(st, 's', `条目${i}`);
  H.saveInputHistoryEntry(st, 's', '条目50');
  assert.equal(H.saveInputHistoryEntry(st, 's', '   '), false);
  const list = JSON.parse(st.getItem(`${P}s`));
  assert.equal(list.length, 100);
  assert.equal(list[0], '条目50');
  assert.equal(list.filter((x) => x === '条目50').length, 1);
  assert.equal(list[1], '条目129');
});

// ── S3 ────────────────────────────────────────────────────
await check('S3 超过 4000 字符的单条不进输入历史;恰好 4000 的照写;存量超长条目不动', async () => {
  need();
  const st = makeStorage();
  const huge = '存'.repeat(14000);
  st.setItem(`${P}s`, JSON.stringify([huge, '短的']));
  assert.equal(H.saveInputHistoryEntry(st, 's', '长'.repeat(4001)), false);
  assert.deepEqual(JSON.parse(st.getItem(`${P}s`)), [huge, '短的'], '超长的没写进去,存量也没被动');
  assert.equal(H.saveInputHistoryEntry(st, 's', '长'.repeat(4000)), true);
  assert.deepEqual(JSON.parse(st.getItem(`${P}s`)), ['长'.repeat(4000), huge, '短的']);
});

// ── S2 ────────────────────────────────────────────────────
await check('S2 纯函数 slimInputHistoryEntries:剔除与旧全局相同的条目;剔空的列为删除;没有重叠的不出现在结果里', async () => {
  need();
  const out = H.slimInputHistoryEntries({
    [`${P}a`]: ['自己1', '旧A', '旧B'],
    [`${P}b`]: ['旧A', '旧B'],
    [`${P}c`]: ['自己2', '自己3'],
  }, ['旧A', '旧B', '旧C']);
  assert.deepEqual(out.rewrite, { [`${P}a`]: ['自己1'] });
  assert.deepEqual(out.remove, [`${P}b`]);
});
await check('S2 按实测形态(211 个会话键,每个含旧全局 100 条的副本)瘦身:输入历史占用下降 70% 以上', async () => {
  need();
  const st = makeStorage();
  st.setItem(LEGACY, JSON.stringify(legacyList));
  for (let i = 0; i < 211; i += 1) copyKey(st, i);
  const before = historyChars(st);
  const r = H.slimInputHistory(st);
  const after = historyChars(st);
  assert.ok(after < before * 0.3, `占用 ${before} → ${after},只下降了 ${(100 - (after / before) * 100).toFixed(1)}%`);
  assert.equal(r.rewrittenKeys, 211);
  assert.deepEqual(JSON.parse(st.getItem(`${P}sid-copy-7`)), ['会话7自己发的一条'], '各会话自己的条目保留');
});
await check('S2 幂等、不动别的键:跑第二遍什么都不改;旧全局键、草稿、待发队列、标题、名字相近的键、解析不了的键都原样', async () => {
  need();
  const st = makeStorage();
  st.setItem(LEGACY, JSON.stringify(legacyList));
  for (let i = 0; i < 20; i += 1) copyKey(st, i);
  st.setItem(`${P}only-copies`, JSON.stringify(legacyList.slice(0, 40)));          // 剔完为空 → 删键
  st.setItem(`${P}broken`, '{不是 JSON');                                         // 解析不了:不敢动
  const others = {
    'cgui-draft:sid-copy-1': '一份草稿', 'cgui-message-queue': '{"q":[{"text":"待发"}]}', 'cgui-custom-titles': '{"a":"标题"}',
    'cgui-input-history-backup': JSON.stringify(legacyList), 'cgui-perm-mode:sid-copy-1': 'plan',
  };
  for (const [k, v] of Object.entries(others)) st.setItem(k, v);
  const first = H.slimInputHistory(st);
  assert.equal(first.removedKeys, 1);
  assert.equal(st.getItem(`${P}only-copies`), null);
  const afterFirst = st.snapshot();
  const second = H.slimInputHistory(st);
  assert.deepEqual(st.snapshot(), afterFirst, '第二遍不应改动任何东西');
  assert.equal(second.removedKeys + second.rewrittenKeys, 0);
  assert.equal(second.freedChars, 0);
  for (const [k, v] of Object.entries(others)) assert.equal(st.getItem(k), v, `${k} 不许被动`);
  assert.deepEqual(JSON.parse(st.getItem(LEGACY)), legacyList);
  assert.equal(st.getItem(`${P}broken`), '{不是 JSON');
});
await check('S2 没有旧全局键(新装的机器)时什么都不做', async () => {
  need();
  const st = makeStorage();
  st.setItem(`${P}a`, JSON.stringify(['自己1']));
  const before = st.snapshot();
  const r = H.slimInputHistory(st);
  assert.deepEqual(st.snapshot(), before);
  assert.equal(r.removedKeys + r.rewrittenKeys, 0);
});

// ── S4 ────────────────────────────────────────────────────
await check('S4 存储被旧全局副本占满:腾空间只靠瘦身就够,重试成功;没有删任何会话自己的内容', async () => {
  need();
  const st = makeStorage();
  st.setItem(LEGACY, JSON.stringify(legacyList));
  for (let i = 0; i < 60; i += 1) copyKey(st, i);
  st.quota = st.used() + 5;                                   // 已经写不进一条待发消息
  const attempt = () => { try { st.setItem('cgui-message-queue', JSON.stringify({ s: [{ text: '待发的一条消息'.repeat(20) }] })); return true; } catch { return false; } };
  assert.equal(attempt(), false, '前提:此刻写不进');
  assert.equal(H.freeInputHistoryAndRetry(st, attempt, []), true);
  assert.ok(st.getItem('cgui-message-queue').includes('待发的一条消息'));
  for (let i = 0; i < 60; i += 1) assert.deepEqual(JSON.parse(st.getItem(`${P}sid-copy-${i}`)), [`会话${i}自己发的一条`], '会话自己的条目一条不少');
});
await check('S4 瘦身腾不出(全是各会话自己的内容):按占用从大到小删没显示的会话的输入历史,够了就停', async () => {
  need();
  const st = makeStorage();
  const sizes = { small: 300, big: 9000, mid: 3000, open: 20000 };
  for (const [name, n] of Object.entries(sizes)) st.setItem(`${P}${name}`, JSON.stringify([`${name} 的内容 ` + 'x'.repeat(n)]));
  st.setItem('cgui-draft:big', '草稿不许动');
  st.quota = st.used() + 5;
  const payload = 'q'.repeat(8000);
  const attempt = () => { try { st.setItem('cgui-message-queue', payload); return true; } catch { return false; } };
  assert.equal(H.freeInputHistoryAndRetry(st, attempt, ['open']), true);
  assert.equal(st.getItem(`${P}big`), null, '最大的那个没显示的会话应先被删');
  assert.ok(st.getItem(`${P}mid`) !== null && st.getItem(`${P}small`) !== null, '删掉最大的已经够了,其余不该再删');
  assert.ok(st.getItem(`${P}open`) !== null, '正在某个窗格里显示的会话,哪怕占用最大也不删');
  assert.equal(st.getItem('cgui-draft:big'), '草稿不许动');
  assert.equal(st.getItem('cgui-message-queue'), payload);
});
await check('S4 一个不够就继续删下一个大的;显示中的会话始终不动', async () => {
  need();
  const st = makeStorage();
  for (let i = 0; i < 6; i += 1) st.setItem(`${P}k${i}`, JSON.stringify(['y'.repeat(1000 * (i + 1))]));   // 1k…6k
  st.setItem(`${P}open`, JSON.stringify(['o'.repeat(50000)]));
  st.quota = st.used() + 5;
  const payload = 'q'.repeat(10500);                          // 要删 6k + 5k 才放得下
  const attempt = () => { try { st.setItem('cgui-message-queue', payload); return true; } catch { return false; } };
  assert.equal(H.freeInputHistoryAndRetry(st, attempt, ['open']), true);
  assert.deepEqual(st.keys().filter((k) => k.startsWith(P)).sort(), [`${P}k0`, `${P}k1`, `${P}k2`, `${P}k3`, `${P}open`].sort());
});
await check('S4 没有可删的了仍写不进:返回 false;草稿、待发队列、标题、权限模式等一个都没动', async () => {
  need();
  const st = makeStorage();
  const others = { 'cgui-draft:a': 'd'.repeat(5000), 'cgui-custom-titles': 't'.repeat(3000), 'cgui-perm-mode:a': 'plan', 'cgui-message-queue': '{"a":[]}' };
  for (const [k, v] of Object.entries(others)) st.setItem(k, v);
  st.setItem(`${P}open`, JSON.stringify(['o'.repeat(4000)]));
  st.quota = st.used() + 5;
  const attempt = () => { try { st.setItem('r149-new', 'n'.repeat(2000)); return true; } catch { return false; } };
  assert.equal(H.freeInputHistoryAndRetry(st, attempt, ['open']), false);
  for (const [k, v] of Object.entries(others)) assert.equal(st.getItem(k), v, `${k} 不许被动`);
  assert.ok(st.getItem(`${P}open`) !== null);
});
await check('S4 saveInputHistoryEntry 自己写不进时也腾空间重试(显示中的会话由调用方告知)', async () => {
  need();
  const st = makeStorage();
  st.setItem(LEGACY, JSON.stringify(legacyList));
  for (let i = 0; i < 30; i += 1) copyKey(st, i);
  st.quota = st.used() + 5;
  assert.equal(H.saveInputHistoryEntry(st, 'sid-now', '存储满的时候发的这条', { openSessionKeys: ['sid-now'] }), true);
  assert.deepEqual(JSON.parse(st.getItem(`${P}sid-now`)), ['存储满的时候发的这条']);
});

// ── S5 ────────────────────────────────────────────────────
await check('S5 removeInputHistory 只删这个会话的输入历史键', async () => {
  need();
  const st = makeStorage();
  st.setItem(`${P}gone`, '["a"]'); st.setItem(`${P}stay`, '["b"]'); st.setItem('cgui-draft:gone', 'd'); st.setItem(LEGACY, '["l"]');
  H.removeInputHistory(st, 'gone');
  assert.deepEqual(st.keys().sort(), ['cgui-draft:gone', LEGACY, `${P}stay`].sort());
  H.removeInputHistory(st, '');          // 没有会话键:什么都不做(不误删 global 键之外的东西)
  H.removeInputHistory(st, null);
  assert.equal(st.getItem(`${P}stay`), '["b"]');
});

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
