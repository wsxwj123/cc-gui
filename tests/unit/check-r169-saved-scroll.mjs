#!/usr/bin/env node
// r169 修法 3:保存"跟随中"这个状态,而不是绝对位置。跟随中存「在底部」,在看历史时存位置(纯数字,
// 与旧格式相同);恢复时读到「在底部」→ 吸底并继续跟随,读到位置 → 照旧恢复并保持"在看历史";
// 旧格式(纯数字)照常读取,不报错、不清空。
// 运行:node tests/unit/check-r169-saved-scroll.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCROLL_SAVED_AT_BOTTOM, parseSavedScroll, scrollPersistAllowed, scrollStateToSave, scrollValueToWrite,
} from '../../client/src/utils/scroll.js';

// ── 发版前补丁 3:恢复读取之前、恢复待决(已读取、位置等下一帧才写回)期间都不写存档 ─────────────
{
  const A = 'p1:A';
  assert.equal(scrollPersistAllowed({ ownerKey: A, restoredOwner: A, restorePendingOwner: null }), true, '恢复完成后照常可写');
  assert.equal(scrollPersistAllowed({ ownerKey: A, restoredOwner: A, restorePendingOwner: A }), false, '恢复待决期间不写');
  assert.equal(scrollPersistAllowed({ ownerKey: A, restoredOwner: 'p1:B', restorePendingOwner: null }), false, '还没读取这个会话的存档前不写');
  assert.equal(scrollPersistAllowed({ ownerKey: A, restoredOwner: A, restorePendingOwner: 'p1:B' }), true, '别的会话遗留的待决标记不挡当前会话');
  assert.equal(scrollPersistAllowed({ ownerKey: null, restoredOwner: null, restorePendingOwner: null }), false);
  // 复盘审查指出的时序:存着数字位置 → 恢复 effect 同步读取并置位 → 下一帧才写回位置;中间容器观察吸底
  // 产生一个"没在看历史"的滚动事件。按 App.jsx 的口径模拟:这个事件不得把 '52000' 盖成「在底部」。
  const key = `cgui-scroll-${A}`;
  const store = new Map([[key, '52000']]);
  let restoredOwner = null;
  let pendingOwner = null;
  let lastSaved;
  const onScrollEvent = (reading, scrollTop) => {
    if (!scrollPersistAllowed({ ownerKey: A, restoredOwner, restorePendingOwner: pendingOwner })) return;
    const value = scrollValueToWrite({ lastSaved, reading, scrollTop });
    if (value === null) return;
    lastSaved = value;
    store.set(key, value);
  };
  onScrollEvent(false, 61383);          // 刚切到 A、还没读取:切换途中的事件
  assert.equal(store.get(key), '52000', '读取之前的事件不得写');
  lastSaved = store.get(key) ?? SCROLL_SAVED_AT_BOTTOM;   // 恢复 effect 同步阶段:播种基准、进入待决、置位
  pendingOwner = A;
  restoredOwner = A;
  onScrollEvent(false, 61383);          // 待决期间:容器观察吸底产生的滚动事件
  assert.equal(store.get(key), '52000', '恢复待决期间的吸底事件不得把数字位置盖成「在底部」');
  pendingOwner = null;                  // 下一帧:写回位置、置"在看历史"、解除待决
  onScrollEvent(true, 52000);
  assert.equal(store.get(key), '52000', '写回位置产生的事件与存档相同,不写');
  onScrollEvent(true, 51000);
  assert.equal(store.get(key), '51000', '恢复完成后照常写');
}

// ── 保存:跟随中 →「在底部」;在看历史 → 位置 ───────────────────────────────────────
assert.equal(scrollStateToSave({ reading: false, scrollTop: 61383 }), SCROLL_SAVED_AT_BOTTOM,
  '跟随中存「在底部」,不存当时的绝对位置');
assert.equal(scrollStateToSave({ reading: true, scrollTop: 5000 }), '5000', '在看历史存位置');
assert.equal(scrollStateToSave({ reading: true, scrollTop: 1234.5 }), '1234.5', '位置写法与旧格式一致(String)');

// ── 读取:旧格式纯数字照常恢复 ───────────────────────────────────────────────────
assert.deepEqual(parseSavedScroll('61342'), { atBottom: false, top: 61342 }, '旧格式整数位置照常读取');
assert.deepEqual(parseSavedScroll('1234.5'), { atBottom: false, top: 1234.5 }, '旧格式小数位置照常读取');
assert.deepEqual(parseSavedScroll('0'), { atBottom: false, top: 0 }, '0 是合法位置(在顶部),不能当成空值');
assert.deepEqual(parseSavedScroll(SCROLL_SAVED_AT_BOTTOM), { atBottom: true }, '「在底部」');
// 空值 / 认不出的值 → 不恢复(不会把 NaN 写进 scrollTop 跳到顶)
for (const bad of [null, undefined, '', '   ', 'abc', 'NaN', 'Infinity', '{}']) {
  assert.equal(parseSavedScroll(bad), null, `认不出的值 ${JSON.stringify(bad)} 必须不恢复`);
}

// ── 往返:存下什么就读回什么 ─────────────────────────────────────────────────────
assert.deepEqual(parseSavedScroll(scrollStateToSave({ reading: false, scrollTop: 9999 })), { atBottom: true });
assert.deepEqual(parseSavedScroll(scrollStateToSave({ reading: true, scrollTop: 4321 })), { atBottom: false, top: 4321 });

// ── 用一个内存 localStorage 走一遍"跟随中离开 → 回来"与"看历史离开 → 回来"的存取 ─────────────
{
  const store = new Map();
  const key = 'cgui-scroll-pane-1:A';
  // 先手动上翻(存位置),再滚回底部恢复跟随(存「在底部」),之后跟随中内容继续变长 —— 不再写位置
  store.set(key, scrollStateToSave({ reading: true, scrollTop: 60000 }));
  store.set(key, scrollStateToSave({ reading: false, scrollTop: 61383 }));
  const back = parseSavedScroll(store.get(key));
  assert.equal(back.atBottom, true, '在底部跟随时离开,回来读到的必须是「在底部」而不是上翻时记下的旧位置');
  // 往上翻着离开 → 回来恢复原位
  store.set(key, scrollStateToSave({ reading: true, scrollTop: 52000 }));
  assert.deepEqual(parseSavedScroll(store.get(key)), { atBottom: false, top: 52000 });
  // 旧版本留下的纯数字(以及只按会话存的旧键)照常读取
  store.set('cgui-scroll-A', '48000');
  assert.deepEqual(parseSavedScroll(store.get('cgui-scroll-A')), { atBottom: false, top: 48000 });
}

// ── 源码守卫 ─────────────────────────────────────────────────────────────────
// ── 发版前补丁 2:没有键 = 跟随在底部,只在底部跟随过的会话不留键(不占共用的 localStorage 配额) ──────
{
  // 按 App.jsx 的口径模拟:恢复读取时播种基准(saved ?? 在底部),之后每个滚动事件经 scrollValueToWrite 决定写不写
  const store = new Map();
  let writes = 0;
  const openSession = (key, legacyKey = null) => {
    const saved = store.get(key) ?? (legacyKey ? store.get(legacyKey) : undefined) ?? null;
    return { key, lastSaved: saved ?? SCROLL_SAVED_AT_BOTTOM };
  };
  const onScrollEvent = (s, reading, scrollTop) => {
    const value = scrollValueToWrite({ lastSaved: s.lastSaved, reading, scrollTop });
    if (value === null) return;
    s.lastSaved = value;
    store.set(s.key, value);
    writes += 1;
  };
  // 从没手动滚过的会话:一路跟随(程序吸底产生的每个滚动事件)→ 一条都不写
  const n = openSession('cgui-scroll-p1:N');
  for (let top = 1000; top < 61000; top += 500) onScrollEvent(n, false, top);
  assert.equal(store.has('cgui-scroll-p1:N'), false, '只在底部跟随过的会话不得留下键');
  assert.equal(writes, 0);
  // 同一会话:用户上翻 → 写位置(有键了);滚回底部 → 有键的照常更新成「在底部」;之后跟随不再写
  onScrollEvent(n, true, 52000);
  assert.equal(store.get('cgui-scroll-p1:N'), '52000');
  onScrollEvent(n, false, 61383);
  assert.equal(store.get('cgui-scroll-p1:N'), SCROLL_SAVED_AT_BOTTOM, '已经有键的,回到底部要更新成「在底部」');
  for (let top = 61383; top < 62000; top += 100) onScrollEvent(n, false, top);
  assert.equal(writes, 2, '跟随期间同值不重复写');
  // 旧版本留下的数字(本窗格的键)→ 跟随时更新成「在底部」,不得留着旧位置
  store.set('cgui-scroll-p1:A', '48000');
  const a = openSession('cgui-scroll-p1:A');
  onScrollEvent(a, false, 50000);
  assert.equal(store.get('cgui-scroll-p1:A'), SCROLL_SAVED_AT_BOTTOM, '旧格式的键照现在的规则更新');
  // 只有旧格式的会话键(按会话存、不分窗格)认不出时,本窗格没有键也算"已有键",照常写
  store.set('cgui-scroll-B', 'garbage');
  const b = openSession('cgui-scroll-p1:B', 'cgui-scroll-B');
  onScrollEvent(b, false, 9000);
  assert.equal(store.get('cgui-scroll-p1:B'), SCROLL_SAVED_AT_BOTTOM, '旧会话键存在时照常写');
  assert.equal(store.get('cgui-scroll-B'), 'garbage', '旧会话键只读不写、不删');
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
const pStart = app.indexOf('const persistScrollState = (el) => {');
assert.ok(pStart > 0, '必须有统一的保存函数');
const persist = app.slice(pStart, app.indexOf('const handleScroll = () => {', pStart));
{
  // r173:只认"有这次判断、三个字段都传了、不允许时提前返回",不认字段顺序与换行写法(原来逐字匹配,调个顺序就误报)
  const gate = /scrollPersistAllowed\(\{([\s\S]*?)\}\)/.exec(persist);
  assert.ok(gate, '保存前必须经 scrollPersistAllowed 判断(恢复读取之前、恢复待决期间都不得写)');
  for (const field of ['ownerKey: scrollOwnerKey', 'restoredOwner: scrollRestoredRef.current', 'restorePendingOwner: scrollRestorePendingRef.current']) {
    assert.ok(gate[1].includes(field), `scrollPersistAllowed 必须传 ${field}(切换途中的钳位 / 吸底事件会盖掉存着的位置)`);
  }
  assert.ok(/!scrollPersistAllowed\(\{[\s\S]*?\}\)\)\s*return;/.test(persist), '不允许保存时必须提前返回');
}
assert.ok(/scrollValueToWrite\(\{\s*lastSaved: last\?\.key === scrollPersistKey \? last\.value : undefined,\s*reading: userScrolledAwayRef\.current,\s*scrollTop: el\.scrollTop,\s*\}\)/.test(persist)
    && /if \(value === null\) return;/.test(persist),
  '按"是否在看历史"决定存「在底部」还是位置,与存储里现有的值(没有键按「在底部」)相同就不写');
assert.ok(/localStorage\.setItem\(scrollPersistKey, value\)/.test(persist));
assert.ok(app.indexOf('const scrollRestoredRef = useRef(null);') < pStart, 'scrollRestoredRef 要在保存函数之前声明');
assert.equal((app.match(/const scrollRestoredRef = useRef\(null\);/g) || []).length, 1, 'scrollRestoredRef 只声明一次');

const hs = app.slice(app.indexOf('const handleScroll = () => {'), app.indexOf('// Restore the saved scroll position'));
assert.ok(/if \(transactionResult\.handled\) \{ persistScrollState\(containerRef\.current\); return; \}/.test(hs),
  '程序滚动(吸底 / 补偿)造成的变化也要记下 —— 否则跟随中存下的永远是上次手动滚动的旧位置');
assert.ok(/persistScrollState\(containerRef\.current\);\s*\n\s*\};/.test(hs), '用户滚动后同样保存');
assert.ok(!/localStorage\.setItem\(scrollPersistKey, String\(scrollTop\)\)/.test(app), '旧的"只存绝对位置"写法必须已替换');

const rStart = app.indexOf('// Restore the saved scroll position');
const restore = app.slice(rStart, app.indexOf('scrollRestoredRef.current = scrollOwnerKey;', rStart));
assert.ok(/const restore = parseSavedScroll\(saved\);/.test(restore), '恢复必须经统一的解析(兼容旧格式)');
assert.ok(/if \(el && restore\.atBottom\) \{[\s\S]{0,260}writeProgrammaticScroll\(el, Math\.max\(0, el\.scrollHeight - el\.clientHeight\), 'follow'\);[\s\S]{0,80}userScrolledAwayRef\.current = false;/.test(restore),
  '读到「在底部」→ 吸底(follow 目标随内容增长)并恢复跟随');
assert.ok(/Math\.min\(Math\.max\(0, restore\.top\)/.test(restore) && /userScrolledAwayRef\.current = away;/.test(restore),
  '读到位置 → 照旧恢复,离底 ≥ 120 保持"在看历史"');
assert.ok(/ownSaved \?\? \(legacyKey \? localStorage\.getItem\(legacyKey\)/.test(restore) && !/localStorage\.setItem\(legacyKey/.test(app),
  '旧的只按会话存的键只读不写');
assert.ok(!/localStorage\.removeItem\(scrollPersistKey/.test(app), '认不出的值也不清空');
const seedIdx = restore.indexOf('persistedScrollRef.current = { key: scrollPersistKey, value: saved ?? SCROLL_SAVED_AT_BOTTOM };');
assert.ok(seedIdx > 0 && seedIdx < restore.indexOf('if (restore) {'),
  '恢复读取时就播种写入基准,且不论有没有可恢复的值:两个键都没有按「在底部」算');
assert.ok(!/removeItem\([^)]*cgui-scroll/.test(app), '本次不新增删除 / 清理存储的代码');
{
  const ifIdx = restore.indexOf('if (restore) {');
  const pendIdx = restore.indexOf('scrollRestorePendingRef.current = pendingOwner;');
  const rafIdx = restore.indexOf('requestAnimationFrame(() => {');
  const clearIdx = restore.indexOf('if (scrollRestorePendingRef.current === pendingOwner) scrollRestorePendingRef.current = null;');
  assert.ok(ifIdx > 0 && ifIdx < pendIdx && pendIdx < rafIdx,
    '只有存档可恢复时才进入待决,并且在排下一帧之前(没有存档的会话不进入待决,读取后照常可写)');
  assert.ok(clearIdx > restore.indexOf("writeProgrammaticScroll(el, target, 'restore');")
      && clearIdx > restore.indexOf('userScrolledAwayRef.current = away;')
      && clearIdx > restore.indexOf('userScrolledAwayRef.current = false;'),
    '位置与跟随状态都写回之后才解除待决(两个分支都覆盖)');
  // 置位仍在同步阶段、rAF 之外:防止这一帧里重复读取,也让没有存档的会话读取后立即可写
  assert.ok(/\}\);\s*\n\s*\}\s*\n\s*$/.test(restore) && app.startsWith('scrollRestoredRef.current = scrollOwnerKey;', rStart + restore.length),
    'scrollRestoredRef 在 rAF 之外同步置位');
  // r173:不认赋值个数(try/finally、分支里多清一次都是合理写法),只认"至少一设一清,而且都在恢复 effect 里,别处不得改它"
  const effectEnd = rStart + restore.length;
  const assigns = [...app.matchAll(/scrollRestorePendingRef\.current = /g)].map((m) => m.index);
  assert.ok(assigns.length >= 2 && assigns.every((i) => i > rStart && i < effectEnd), '待决标记只在恢复 effect 里设与清');
}

console.log('✓ check-r169-saved-scroll: 跟随中存「在底部」/ 看历史存位置 / 旧格式数字照常恢复');
