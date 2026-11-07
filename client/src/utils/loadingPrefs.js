// r154:加载动画偏好(样式 + 转速)的默认值与 localStorage 读取(纯函数,storage 由调用方传入)。
// r159:新增「随机」模式(样式 id = 'random')的两个纯函数:pickRandomStyle / shouldReroll。
import { RANDOM_POOL } from './orbitVariants.js';

export const LOADING_SPEEDS = Object.freeze(['slow', 'normal', 'fast']);
export const DEFAULT_LOADING_SPEED = 'slow';
// r159:默认改为随机。只影响 localStorage 里还没有 cgui-loading-style 的人;
// 选过任何样式(包括 orbit3、cli)的人保持原值,readLoadingStyle 的读取行为不变。
export const RANDOM_LOADING_STYLE = 'random';
export const DEFAULT_LOADING_STYLE = RANDOM_LOADING_STYLE;
export const LOADING_SPEED_KEY = 'cgui-loading-speed';
export const LOADING_STYLE_KEY = 'cgui-loading-style';

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
// phase 变了,或工具阶段里换了一次新的工具调用(key 变了);并且距上次抽取满 1.5 秒。
// text / stopping / compacting / connecting、同一阶段内部、不满 1.5 秒,一律不换(之后也不补换)。
export const REROLL_MIN_GAP_MS = 1500;
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
