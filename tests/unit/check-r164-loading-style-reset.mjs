#!/usr/bin/env node
// r164:升级后第一次打开,把「加载动画」重置为「随机」——不管旧版选过什么;之后用户自己选的不再被动。
//
// 机制:localStorage 里加一个整数标记 cgui-loading-style-epoch(当前档位 LOADING_STYLE_EPOCH = 1)。
// 打开应用时读它:没有 / 读不出整数 / 小于当前档位 → 把 cgui-loading-style 写成 random、再把标记写成当前档位;
// 标记 ≥ 当前档位 → 什么都不动(用户选过什么就是什么)。以后还想再让所有人重置一次,把档位 +1 即可。
//
// 锁的事:
//   R1  常量:键名、档位是 ≥ 1 的整数。
//   R2  旧版选过 orbit3、没有标记 → 返回 random,样式写成 random、标记写成当前档位,先写样式后写标记。
//   R3  各种旧选择(cli / ring / orbit4 / 未知 id / 空串 / 空格)第一次都被重置。
//   R4  已重置过(标记 = 当前档位)的环境:样式原样保留,一次都不写。
//   R5  重置后用户自己改选,再打开多少次都不会被改回,也不再写任何键。
//   R6  标记取值:没有 / 空 / 非数字 / 0 / 负数 → 重置;1 / 2 / 999 → 不动(预置超大值的环境永远不会被将来的重置顶掉)。
//   R7  全新存储(什么都没存过)→ random,并写下标记(这样之后用户的选择才不会被顶掉)。
//   R8  容错:storage 为空 / getItem 抛错 / setItem 抛错 / 只有标记写不进 / 没有 setItem,都不抛错,且这一次仍按 random。
//   R9  只动样式:转速键不碰;写入的键只有样式和标记两个。
//   R10 readLoadingStyle 行为不变(没存过 → random;存过什么读什么),重置后与 resolveLoadingStyle 的结果一致。
//   R11 状态库接线(真导入 client/src/stores/sessionStore.js):旧用户 → store.loadingStyle 是 random;
//       经真 setLoadingStyle 改选后「重开」仍是改选的样式;已重置过的保留;转速不被牵连。
//
// 跑法:node tests/unit/check-r164-loading-style-reset.mjs
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const P = await import(pathToFileURL(join(ROOT, 'client', 'src', 'utils', 'loadingPrefs.js')).href);
const report = makeReport('check-r164-loading-style-reset');

const STYLE = 'cgui-loading-style';
const SPEED = 'cgui-loading-speed';
const EPOCH = 'cgui-loading-style-epoch';

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

await report.check('R1', '常量:键名与档位', 'red', () => {
  assert.equal(P.LOADING_STYLE_EPOCH_KEY, EPOCH);
  assert.ok(Number.isInteger(P.LOADING_STYLE_EPOCH) && P.LOADING_STYLE_EPOCH >= 1, `档位应是 ≥ 1 的整数(实际 ${P.LOADING_STYLE_EPOCH})`);
  assert.equal(typeof P.resolveLoadingStyle, 'function');
});

await report.check('R2', '旧版选过 orbit3、没有标记:返回 random,先写样式后写标记', 'red', () => {
  const s = mem({ [STYLE]: 'orbit3' });
  assert.equal(P.resolveLoadingStyle(s), 'random');
  assert.equal(s.data[STYLE], 'random');
  assert.equal(s.data[EPOCH], String(P.LOADING_STYLE_EPOCH));
  assert.deepEqual(s.writes, [STYLE, EPOCH], '先写样式、后写标记(中途出事只会下次再重置一遍,不会漏掉)');
  assert.equal(P.readLoadingStyle(s), 'random', '重置之后再按老办法读,读到的也是 random');
});

await report.check('R3', '各种旧选择第一次都被重置', 'red', () => {
  for (const old of ['cli', 'ring', 'orbit4', 'orbit3', 'dots', 'typing', 'not-a-real-style', '', ' ', 'random']) {
    const s = mem({ [STYLE]: old });
    assert.equal(P.resolveLoadingStyle(s), 'random', `旧选择 ${JSON.stringify(old)}`);
    assert.equal(s.data[STYLE], 'random', `旧选择 ${JSON.stringify(old)} 之后存的样式`);
    assert.equal(s.data[EPOCH], String(P.LOADING_STYLE_EPOCH));
  }
});

await report.check('R4', '已重置过(标记 = 当前档位):样式原样保留,一次都不写', 'red', () => {
  for (const old of ['cli', 'ring', 'orbit4', 'orbit3', 'random']) {
    const s = mem({ [STYLE]: old, [EPOCH]: String(P.LOADING_STYLE_EPOCH) });
    assert.equal(P.resolveLoadingStyle(s), old, `已重置过 + 样式 ${old}`);
    assert.deepEqual(s.writes, [], '已重置过的环境不该有任何写入');
    assert.equal(s.data[STYLE], old);
  }
});

await report.check('R5', '重置后用户改选,再打开多少次都不会被改回', 'red', () => {
  const s = mem({ [STYLE]: 'orbit3' });
  assert.equal(P.resolveLoadingStyle(s), 'random'); // 升级后第一次打开
  s.setItem(STYLE, 'cli'); // 用户在主题弹窗里改选
  const before = s.writes.length;
  for (let i = 0; i < 6; i += 1) assert.equal(P.resolveLoadingStyle(s), 'cli', `第 ${i + 2} 次打开`);
  assert.equal(s.writes.length, before, '之后的打开不该再写任何键');
  assert.equal(s.data[STYLE], 'cli');
});

await report.check('R6', '标记取值:坏值 / 过旧 → 重置;当前档位及以上 → 不动', 'red', () => {
  for (const bad of [null, '', ' ', 'abc', 'NaN', '0', '-3', 'true']) {
    const init = bad === null ? { [STYLE]: 'cli' } : { [STYLE]: 'cli', [EPOCH]: bad };
    const s = mem(init);
    assert.equal(P.resolveLoadingStyle(s), 'random', `标记 ${JSON.stringify(bad)} 应重置`);
    assert.equal(s.data[EPOCH], String(P.LOADING_STYLE_EPOCH), `标记 ${JSON.stringify(bad)} 重置后应写成当前档位`);
  }
  for (const ok of [String(P.LOADING_STYLE_EPOCH), String(P.LOADING_STYLE_EPOCH + 1), '999']) {
    const s = mem({ [STYLE]: 'cli', [EPOCH]: ok });
    assert.equal(P.resolveLoadingStyle(s), 'cli', `标记 ${ok} 不该重置`);
    assert.deepEqual(s.writes, []);
  }
});

await report.check('R7', '全新存储:random,并写下标记', 'red', () => {
  const s = mem({});
  assert.equal(P.resolveLoadingStyle(s), 'random');
  assert.equal(s.data[EPOCH], String(P.LOADING_STYLE_EPOCH));
  // 之后用户选了别的,再打开不会被顶掉
  s.setItem(STYLE, 'ring');
  assert.equal(P.resolveLoadingStyle(s), 'ring');
});

await report.check('R8', '容错:不抛错,且这一次仍按 random', 'red', () => {
  const noGet = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
  const noSet = (init) => { const m = mem(init); m.setItem = () => { throw new Error('QuotaExceededError'); }; return m; };
  const epochWriteFails = (init) => {
    const m = mem(init);
    const real = m.setItem;
    m.setItem = (k, v) => { if (k === EPOCH) throw new Error('QuotaExceededError'); real(k, v); };
    return m;
  };
  assert.equal(P.resolveLoadingStyle(null), 'random');
  assert.equal(P.resolveLoadingStyle(undefined), 'random');
  assert.equal(P.resolveLoadingStyle(noGet), 'random');
  assert.equal(P.resolveLoadingStyle({ getItem: () => null }), 'random', '没有 setItem 的只读 storage');
  assert.equal(P.resolveLoadingStyle(noSet({ [STYLE]: 'cli' })), 'random', '写不进去:这一次也按随机');
  assert.equal(P.resolveLoadingStyle(epochWriteFails({ [STYLE]: 'cli' })), 'random', '标记写不进去:这一次也按随机');
});

await report.check('R9', '只动样式:转速不碰,写入的键只有样式与标记', 'red', () => {
  const s = mem({ [STYLE]: 'orbit3', [SPEED]: 'fast' });
  P.resolveLoadingStyle(s);
  assert.equal(s.data[SPEED], 'fast');
  assert.equal(P.readLoadingSpeed(s), 'fast');
  assert.deepEqual([...new Set(s.writes)].sort(), [EPOCH, STYLE].sort());
});

await report.check('R10', 'readLoadingStyle 行为不变(纯读取:不看标记、不写任何键)', 'green', () => {
  assert.equal(P.readLoadingStyle(mem({})), 'random');
  assert.equal(P.readLoadingStyle(mem({ [STYLE]: 'cli' })), 'cli');
  assert.equal(P.readLoadingStyle(mem({ [STYLE]: 'orbit3', [EPOCH]: '1' })), 'orbit3');
  const s = mem({ [STYLE]: 'orbit3' }); // 没有标记也不重置:重置只发生在 resolveLoadingStyle
  assert.equal(P.readLoadingStyle(s), 'orbit3');
  assert.deepEqual(s.writes, []);
});

// ───── R11 状态库接线:真导入 sessionStore.js,每个场景换一份假 localStorage、换一个模块实例 ─────
let loadSeq = 0;
async function loadStore(initial) {
  const storage = mem(initial);
  globalThis.localStorage = storage;
  const href = `${pathToFileURL(join(ROOT, 'client', 'src', 'stores', 'sessionStore.js')).href}?r164=${++loadSeq}`;
  const mod = await import(href);
  return { store: mod.useStore, storage };
}

await report.check('R11', '状态库接线:旧用户 → random;真 setter 改选后重开仍是改选的;已重置过的保留;转速不被牵连', 'red', async () => {
  // 旧用户:升级后第一次打开
  const a = await loadStore({ [STYLE]: 'orbit3', [SPEED]: 'fast' });
  assert.equal(a.store.getState().loadingStyle, 'random', '旧用户 store.loadingStyle 应是 random');
  assert.equal(a.store.getState().loadingSpeed, 'fast', '转速不被牵连');
  assert.equal(a.storage.data[STYLE], 'random');
  assert.equal(a.storage.data[EPOCH], String(P.LOADING_STYLE_EPOCH));
  // 用户经真 setter 改选 ring → 重开应用(换一份模块实例,沿用同一份存储内容)
  a.store.getState().setLoadingStyle('ring');
  assert.equal(a.storage.data[STYLE], 'ring');
  const b = await loadStore({ ...a.storage.data });
  assert.equal(b.store.getState().loadingStyle, 'ring', '改选后重开不该被改回 random');
  // 已重置过的环境:保留 cli
  const c = await loadStore({ [STYLE]: 'cli', [EPOCH]: String(P.LOADING_STYLE_EPOCH) });
  assert.equal(c.store.getState().loadingStyle, 'cli');
  // 全新环境
  const d = await loadStore({});
  assert.equal(d.store.getState().loadingStyle, 'random');
  assert.equal(d.storage.data[EPOCH], String(P.LOADING_STYLE_EPOCH));
});

process.exit(report.finish());
