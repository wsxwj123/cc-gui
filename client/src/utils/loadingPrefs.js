// r154:加载动画偏好(样式 + 转速)的默认值与 localStorage 读取(纯函数,storage 由调用方传入)。
// r159:新增「随机」模式(样式 id = 'random')的纯函数:pickRandomStyle / shouldReroll,
// 以及按回合记忆的 nextRollState / createScopedRollStore。
import { RANDOM_POOL } from './orbitVariants.js';

export const LOADING_SPEEDS = Object.freeze(['slow', 'normal', 'fast']);
// r165:默认转速由 slow(慢)改为 normal(标准)。只影响没存过转速、或存的值不合法的人;存过 slow / normal / fast 的人原样不变。
// 所有「没有转速时怎么办」的兜底都取这个常量(readLoadingSpeed、normalizeLoadingSpeed、转速选择器、Orbit、orbitTicker 的缺省因子),
// 别再在别处写死 'slow'。
export const DEFAULT_LOADING_SPEED = 'normal';
// r159:默认改为随机。只影响 localStorage 里还没有 cgui-loading-style 的人;
// 选过任何样式(包括 orbit3、cli)的人保持原值,readLoadingStyle 的读取行为不变。
// r164:readLoadingStyle 仍然只读;升级后「第一次打开」把所有人重置为随机的动作在 resolveLoadingStyle 里(状态库初始化用它)。
export const RANDOM_LOADING_STYLE = 'random';
export const DEFAULT_LOADING_STYLE = RANDOM_LOADING_STYLE;
export const LOADING_SPEED_KEY = 'cgui-loading-speed';
export const LOADING_STYLE_KEY = 'cgui-loading-style';
// r164:一次性重置的整数标记(档位)。localStorage 里没有、开头读不出数字(Number.parseInt 取开头的整数,'1abc' 按 1 算)、
// 或小于 LOADING_STYLE_EPOCH → 重置一次并写下标记;达到档位 → 不动,之后用户在主题弹窗里选什么都保留。
// 以后还想让所有人再重置一次:把 LOADING_STYLE_EPOCH +1,并同步改 tests/acceptance/r159-orbit-random/r164-style-reset.spec.mjs
// 里写死的标记值 '1'(U1 / U2 / U3 / U5 的期望与预置;验收按约定不 import 应用内部模块,所以不会自动跟着变)。
// (r154-ui-live-line / r157-orbit 两个套件预置的标记是 999,不会被将来的加档顶掉。)
export const LOADING_STYLE_EPOCH_KEY = 'cgui-loading-style-epoch';
export const LOADING_STYLE_EPOCH = 1;

export function normalizeLoadingSpeed(v) {
  return LOADING_SPEEDS.includes(v) ? v : DEFAULT_LOADING_SPEED;
}

export function readLoadingSpeed(storage) {
  try {
    return normalizeLoadingSpeed(storage ? storage.getItem(LOADING_SPEED_KEY) : null);
  } catch {
    return DEFAULT_LOADING_SPEED;
  }
}

export function readLoadingStyle(storage) {
  try {
    const v = storage ? storage.getItem(LOADING_STYLE_KEY) : null;
    return typeof v === 'string' && v ? v : DEFAULT_LOADING_STYLE;
  } catch {
    return DEFAULT_LOADING_STYLE;
  }
}

// r164:启动时决定用哪个加载动画样式。标记不到档位 → 把样式写成 random、再写标记(先样式后标记:中途出事只会下次再重置一遍,
// 不会漏掉),这一次返回 random;标记已到档位 → 等同 readLoadingStyle(用户选什么就是什么,一次都不写)。
// 只动样式键,转速键不碰。storage 为空 / 读不了 / 写不进去都不抛错,这一次仍按 random。
export function resolveLoadingStyle(storage) {
  let stale = false;
  try {
    if (storage) {
      const n = Number.parseInt(storage.getItem(LOADING_STYLE_EPOCH_KEY), 10);
      stale = (Number.isFinite(n) ? n : 0) < LOADING_STYLE_EPOCH;
    }
  } catch {
    return DEFAULT_LOADING_STYLE; // storage 读不了:readLoadingStyle 在这种情况下也回默认(random)
  }
  if (!stale) return readLoadingStyle(storage);
  try { storage.setItem(LOADING_STYLE_KEY, RANDOM_LOADING_STYLE); } catch { /* 写不进去:这一次仍按随机 */ }
  try { storage.setItem(LOADING_STYLE_EPOCH_KEY, String(LOADING_STYLE_EPOCH)); } catch { /* 同上 */ }
  return RANDOM_LOADING_STYLE;
}

// r159:从 RANDOM_POOL 里挑一个具体动画 id。池大于 1 时绝不等于 prevId(prevId 为空或不在池里时任取)。
// rng 返回 [0, 1),可注入以得到确定结果。
export function pickRandomStyle(prevId, rng = Math.random) {
  const pool = RANDOM_POOL.length > 1 && RANDOM_POOL.includes(prevId)
    ? RANDOM_POOL.filter((id) => id !== prevId)
    : RANDOM_POOL;
  const r = Number(rng());
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * pool.length)));
  return pool[idx];
}

// r159:随机模式下状态行是否重抽。只在「进入」思考或工具阶段时换:
// phase 变了,或工具阶段里换了一次新的工具调用(key 变了);并且距上次抽取满 4 秒。
// text / stopping / compacting / connecting、同一阶段内部、不满 4 秒,一律不换(之后也不补换)。
// r172:1.5 秒 → 4 秒。换样式本身有 2 秒过渡(聚拢 1 秒 + 展开 1 秒,orbitTicker.js),间隔必须比它长,否则连续调用工具时圆点一直在过渡。
export const REROLL_MIN_GAP_MS = 4000;
const REROLL_PHASES = new Set(['thinking', 'tool']);
export function shouldReroll({ prevPhase, prevKey, phase, key, nowMs, lastRollMs }) {
  if (!REROLL_PHASES.has(phase)) return false;
  const entered = phase !== prevPhase || (phase === 'tool' && key !== prevKey);
  if (!entered) return false;
  if (lastRollMs == null) return true;
  return nowMs - lastRollMs >= REROLL_MIN_GAP_MS;
}

// r159 D3b:按回合(scope)保持随机抽取的连续性。状态行在工作组头行与底部之间换位置会重新挂载,
// 抽取记忆放在组件外,同一回合内重新挂载沿用已抽到的 id,阶段变化照 shouldReroll 判断。
// mem = { scope, current, phase, key, lastRollMs } 或 null;返回新的 mem(不改入参)与要显示的 id。
// scope 不同(新回合)或还没抽过 → 必抽,且避开上一回合最后那个;之后 phase / key 总更新为最近一次看到的。
export function nextRollState(mem, { scope, phase, key, nowMs }, rng = Math.random) {
  if (!mem || mem.scope !== scope || !mem.current) {
    const id = pickRandomStyle(mem?.current ?? null, rng);
    return { mem: { scope, current: id, phase, key, lastRollMs: nowMs }, id, rolled: true };
  }
  const rolled = shouldReroll({ prevPhase: mem.phase, prevKey: mem.key, phase, key, nowMs, lastRollMs: mem.lastRollMs });
  const id = rolled ? pickRandomStyle(mem.current, rng) : mem.current;
  return {
    mem: { scope, current: id, phase, key, lastRollMs: rolled ? nowMs : mem.lastRollMs },
    id,
    rolled,
  };
}

// r159:按回合分别保存的抽取记忆。分屏里几栏可以同时在生成,每栏的回合(scope)各占一个槽,
// 互不覆盖。roll(scope, …) 对已有的 scope 照 nextRollState 推进;新 scope 算新回合:必抽,且避开 avoidId。
// 每次读写把该 scope 挪到最近使用;超过 cap 淘汰最久没用的,被淘汰的 scope 再来按新回合处理。
// 返回 { id, mem, rolled }。
const NEW_ROUND_SCOPE = Object.freeze({}); // 占位 scope,不等于任何真实 scope
export function createScopedRollStore(cap = 32) {
  const limit = Math.max(1, Math.floor(Number(cap)) || 1);
  const slots = new Map(); // scope → mem;Map 按插入顺序,最前面的是最久没用的
  return {
    roll(scope, { phase, key, nowMs }, rng = Math.random, avoidId = null) {
      const prev = slots.has(scope)
        ? slots.get(scope)
        : (avoidId ? { scope: NEW_ROUND_SCOPE, current: avoidId } : null);
      const res = nextRollState(prev, { scope, phase, key, nowMs }, rng);
      slots.delete(scope);
      slots.set(scope, res.mem);
      while (slots.size > limit) slots.delete(slots.keys().next().value);
      return res;
    },
    get size() { return slots.size; },
  };
}
