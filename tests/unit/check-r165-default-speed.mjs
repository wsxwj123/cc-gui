#!/usr/bin/env node
// r165:加载动画「转速」的默认值从「慢」改成「标准」(用户 2026-11-10 指令:默认转速改成标准)。
// 只影响「没存过转速、或存的值不合法」的人;选过慢 / 标准 / 快的人原样不变。
// 不碰 r164 的一次性重置:那个重置只动样式,不动转速。
//
// 锁的事:
//   D1 默认值是 normal,在三档之内;三档因子 0.7 / 1 / 1.4 不变。
//   D2 状态库(真导入 client/src/stores/sessionStore.js):没存过 → loadingSpeed 是 normal;存过 slow → 仍是 slow(选过慢的人不被改);
//      fast → fast;非法值 → normal;旧用户(样式 orbit3 + 转速 slow)经 r164 重置后,样式变 random、转速仍 slow。
//   D3 兜底取同一个常量,不再各写各的 'slow':orbitTicker 的缺省转速因子取默认转速那一档;
//      App.jsx 转速选择器与 LoadingBits.jsx 的 Orbit 在 store 值为空时兜底用 DEFAULT_LOADING_SPEED(源码里没有写死的 `|| 'slow'`)。
//
// 跑法:node tests/unit/check-r165-default-speed.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const src = (...p) => join(ROOT, 'client', 'src', ...p);
const P = await import(pathToFileURL(src('utils', 'loadingPrefs.js')).href);
const T = await import(pathToFileURL(src('utils', 'orbitTicker.js')).href);
const report = makeReport('check-r165-default-speed');

const STYLE = 'cgui-loading-style';
const SPEED = 'cgui-loading-speed';
// 带记录的假 storage:writes 按先后顺序记每次 setItem 的键。
const mem = (init = {}) => {
  const data = { ...init };
  const writes = [];
  return {
    data,
    writes,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { writes.push(k); data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
};

await report.check('D1', '默认转速是 normal,在三档之内;三档因子不变', 'red', () => {
  assert.equal(P.DEFAULT_LOADING_SPEED, 'normal');
  assert.ok(P.LOADING_SPEEDS.includes(P.DEFAULT_LOADING_SPEED));
  assert.deepEqual({ ...T.SPEED_FACTORS }, { slow: 0.7, normal: 1, fast: 1.4 });
});

// ───── D2 状态库接线:真导入 sessionStore.js,每个场景换一份假 localStorage、换一个模块实例 ─────
let loadSeq = 0;
async function loadStore(initial) {
  const storage = mem(initial);
  globalThis.localStorage = storage;
  const mod = await import(`${pathToFileURL(src('stores', 'sessionStore.js')).href}?r165=${++loadSeq}`);
  return { store: mod.useStore, storage };
}

await report.check('D2', '状态库:没存过 → normal;选过慢 / 快的保持;非法值 → normal;r164 重置不牵连转速', 'red', async () => {
  const fresh = await loadStore({});
  assert.equal(fresh.store.getState().loadingSpeed, 'normal', '没存过转速 → 标准');
  assert.equal(fresh.storage.getItem(SPEED), null, '应用自己不把默认转速写进存储(没选过的人以后跟着默认走,将来再改默认才会生效)');
  assert.ok(!fresh.storage.writes.includes(SPEED), '加载状态库期间不该写转速键');
  // 真 setter(它写的是调用那一刻的全局 localStorage,所以紧跟着 loadStore 用):用户改选后重开仍是改选的
  fresh.store.getState().setLoadingSpeed('fast');
  assert.equal(fresh.storage.data[SPEED], 'fast');
  const reopened = await loadStore({ ...fresh.storage.data });
  assert.equal(reopened.store.getState().loadingSpeed, 'fast', '改选后重开不该被默认值顶掉');
  const slow = await loadStore({ [SPEED]: 'slow' });
  assert.equal(slow.store.getState().loadingSpeed, 'slow', '选过慢的人保持慢');
  const fast = await loadStore({ [SPEED]: 'fast' });
  assert.equal(fast.store.getState().loadingSpeed, 'fast');
  const normal = await loadStore({ [SPEED]: 'normal' });
  assert.equal(normal.store.getState().loadingSpeed, 'normal');
  const bad = await loadStore({ [SPEED]: 'turbo' });
  assert.equal(bad.store.getState().loadingSpeed, 'normal', '非法值回落到默认(标准)');
  // 旧用户:样式 orbit3 + 转速 slow,没有 r164 的升级标记 → 样式被重置,转速不被牵连
  const old = await loadStore({ [STYLE]: 'orbit3', [SPEED]: 'slow' });
  assert.equal(old.store.getState().loadingStyle, 'random');
  assert.equal(old.store.getState().loadingSpeed, 'slow', '重置只动样式,选过慢的人转速仍是慢');
  assert.equal(old.storage.data[SPEED], 'slow');
});

await report.check('D3', '兜底取同一个常量:源码里没有写死的 || \'slow\' 与 SPEED_FACTORS.slow 缺省', 'red', () => {
  const ticker = readFileSync(src('utils', 'orbitTicker.js'), 'utf8');
  assert.ok(!/DEFAULT_FACTOR\s*=\s*SPEED_FACTORS\.slow\b/.test(ticker), 'orbitTicker 的缺省因子不该写死 slow');
  assert.ok(/DEFAULT_FACTOR\s*=\s*SPEED_FACTORS\[DEFAULT_LOADING_SPEED\]/.test(ticker), 'orbitTicker 的缺省因子应是 SPEED_FACTORS[DEFAULT_LOADING_SPEED]');
  for (const [name, text] of [['App.jsx', readFileSync(src('App.jsx'), 'utf8')], ['LoadingBits.jsx', readFileSync(src('components', 'LoadingBits.jsx'), 'utf8')]]) {
    assert.ok(!/loadingSpeed\)\s*(\|\||\?\?)\s*['"]slow['"]/.test(text), `${name}:读 store.loadingSpeed 之后的兜底不该写死 'slow'(|| 与 ?? 两种写法都查)`);
    assert.ok(/loadingSpeed\)\s*\|\|\s*DEFAULT_LOADING_SPEED\b/.test(text), `${name}:读 store.loadingSpeed 之后的兜底应是 || DEFAULT_LOADING_SPEED(不只是 import 了它)`);
  }
});

process.exit(report.finish());
