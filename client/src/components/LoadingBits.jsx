import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../stores/sessionStore.js';
import { orbitTicker } from '../utils/orbitTicker.js';
import { ORBIT_VARIANTS, variantOf } from '../utils/orbitVariants.js';
import { DEFAULT_LOADING_STYLE, DEFAULT_LOADING_SPEED, RANDOM_LOADING_STYLE, pickRandomStyle, shouldReroll, createScopedRollStore } from '../utils/loadingPrefs.js';

// r161:状态行里旋转指示器的宽(CSS px)。整个动画(轨道 + 圆点)以 14px 为基准等比放大,所以改这一个数就是整体放大 / 缩小。
export const LIVE_INDICATOR_PX = 20;

// 加载指示件(spinner / 耗时),从 App.jsx 抽出共享:底部状态行 LiveStatusLine(主会话与
// 子代理视图共用)与主题「界面」页预览用同一套视觉物。状态词见 utils/liveStatus.js。

export const SPINNER_FRAMES = ['✻', '✶', '✷', '✸', '✹', '✺'];

// markProps 展开到最外层元素上(调用方可挂 data-* 锚点);className / style 与组件自己的合并。
function mergeMarkProps(markProps, className, style) {
  const mp = markProps || {};
  return {
    ...mp,
    className: mp.className ? `${className} ${mp.className}` : className,
    style: mp.style ? { ...style, ...mp.style } : style,
  };
}

// CLI ✻ 帧动画,~20px。颜色继承 currentColor(外层给 text-accent 跟随主题强调色),不写死品牌橙。
export function CliSpinner({ size = 20, markProps = null }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(id);
  }, []);
  return (
    <span {...mergeMarkProps(markProps, 'font-mono inline-block leading-none', { fontSize: size })}>
      {SPINNER_FRAMES[frame]}
    </span>
  );
}

// r154:三体 / 四体旋转。点位由全局唯一的 orbitTicker 每帧写到 <i> 上(React 不管 <i> 的 style);
// 转速只写进 data-speed,ticker 下一帧按新转速摆,不重建 DOM。
// r159:variant = orbitVariants 的 16 种 id 之一(缺省按 n 取 orbit3 / orbit4),点数取自变体。
// r172:换样式不再换 key 重建。<i> 圆点由 orbitTicker 建、增删(React 不渲染子元素),挂载时登记一次;
// 之后 variant 变化走 orbitTicker.retarget:先聚拢到中心、换样式与点数、再展开(data-switch = in / out)。
// enter:这个实例是伴随换样式出现的(状态行换位置的同时换了样式),从中心展开;只取挂载时的值。
// 用 useLayoutEffect:登记 / 换目标与 data-style 变化在同一次提交里落到页面,首帧就摆好位、带好过渡标记。
export function Orbit({ n = 3, variant = null, size = 20, markProps = null, enter = false }) {
  const v = variantOf(variant) || ORBIT_VARIANTS[n === 4 ? 'orbit4' : 'orbit3'];
  const variantId = v.id;
  const speed = useStore((s) => s.loadingSpeed) || DEFAULT_LOADING_SPEED;
  const ref = useRef(null);
  const mountRef = useRef({ variantId, n: v.n, enter });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const m = mountRef.current;
    // StrictMode 下这里会执行两遍(登记 → 注销 → 再登记):第二次沿用第一次补出来的 <i>,enter 取同一个挂载值
    return orbitTicker.register({ el, n: m.n, variant: m.variantId, enter: m.enter });
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) orbitTicker.retarget(el, variantId); // 与当前样式相同(含挂载时)= 什么都不做
  }, [variantId]);
  return (
    <span
      {...mergeMarkProps(markProps, 'orbit-mark', { width: size, height: size })}
      ref={ref}
      data-style={variantId}
      data-speed={speed}
      aria-hidden="true"
    />
  );
}

// r159:随机模式最近一次抽到的具体 id(所有实例共用),新实例挂载时避开它,相邻两次不重样。
let lastPickedRandomId = null;
function pickAndRemember(prevId) {
  const id = pickRandomStyle(prevId);
  lastPickedRandomId = id;
  return id;
}

// r159 D3b:按回合的抽取记忆(组件外)。状态行在工作组头行与底部之间换位置会卸载再挂载,
// 靠这里沿用同一回合已抽到的 id。分屏里几栏可同时生成,每个回合(rollScope)分别保存,
// 互不覆盖;最多保存 32 个回合,超出淘汰最久没用的。新回合避开最近一次抽到的 id。
const scopedRolls = createScopedRollStore();
function scopedRoll(scope, phase, key) {
  const res = scopedRolls.roll(scope, { phase, key, nowMs: Date.now() }, Math.random, lastPickedRandomId);
  lastPickedRandomId = res.id;
  return res;
}

// phase / rollKey:只有生成中的状态行传。样式为 random 时,挂载时抽一个具体动画;
// 之后 phase / rollKey 变化按 shouldReroll 决定是否重抽(挂载那次算计时起点)。
// rollScope(回合起点时间戳):给了就按回合记忆抽取,跨挂载连续(子代理视图有自己的回合起点,各占一个槽);
// 没给(设置网格这类没有回合起点的场合)按实例内抽取。
export function LoadingMark({ size = 20, variant = null, markProps = null, phase = null, rollKey = null, rollScope = null }) {
  const chosen = useStore((s) => s.loadingStyle) || DEFAULT_LOADING_STYLE;
  const style = variant || chosen;
  const isRandom = style === RANDOM_LOADING_STYLE;
  const scoped = rollScope != null;
  // r172:挂载时的抽取结果另带 enter —— 这个回合之前已有指示器显示过别的样式、这次挂载换了(状态行换位置的同时换样式),
  // 新指示器从中心展开。scopedRolls 只在提交后由 markShown 更新「已显示」,所以初始化函数重复执行(StrictMode)答案不变。
  const [mountRoll] = useState(() => {
    if (!isRandom) return { id: null, enter: false };
    if (!scoped) return { id: pickAndRemember(lastPickedRandomId), enter: false };
    const res = scopedRoll(rollScope, phase, rollKey);
    return { id: res.id, enter: res.switchedFrom != null };
  });
  const [randomId, setRandomId] = useState(mountRoll.id);
  const rollRef = useRef({ phase, key: rollKey, lastRollMs: isRandom ? Date.now() : null });
  useEffect(() => {
    const roll = rollRef.current;
    const prevPhase = roll.phase;
    const prevKey = roll.key;
    roll.phase = phase;
    roll.key = rollKey;
    if (isRandom && scoped) {
      // 按回合记忆:挂载 / 阶段变化都经 scopedRolls(内部用 nextRollState 推进);同回合重新挂载不重抽
      const { id, mem } = scopedRoll(rollScope, phase, rollKey);
      roll.lastRollMs = mem.lastRollMs;
      if (id !== randomId) setRandomId(id);
      return;
    }
    if (!isRandom) {
      // 离开随机:清掉旧抽取,下次切回随机时重新抽
      if (randomId != null) setRandomId(null);
      roll.lastRollMs = null;
      return;
    }
    const nowMs = Date.now();
    if (randomId == null) {
      // 设置里从别的样式切到随机
      setRandomId(pickAndRemember(lastPickedRandomId));
      roll.lastRollMs = nowMs;
      return;
    }
    if (shouldReroll({ prevPhase, prevKey, phase, key: rollKey, nowMs, lastRollMs: roll.lastRollMs })) {
      setRandomId(pickAndRemember(randomId));
      roll.lastRollMs = nowMs;
    }
  }, [isRandom, scoped, rollScope, phase, rollKey, randomId]);
  // 刚切到随机、effect 还没抽时沿用最近一次抽到的 id,避免空一帧
  const shown = isRandom ? (randomId || lastPickedRandomId || 'orbit3') : style;
  // r172:提交到页面后记下这个回合已显示的 id,供下一次挂载判断「换位置的同时换了样式」
  useEffect(() => {
    if (isRandom && scoped && randomId) scopedRolls.markShown(rollScope, randomId);
  }, [isRandom, scoped, rollScope, randomId]);
  // 每个分支的最外层都带 data-style = 当前显示的具体样式 id,供外层识别;随机时另带 data-loading-mode
  const mp = { ...(markProps || {}), 'data-style': shown };
  if (isRandom) {
    mp['data-loading-mode'] = RANDOM_LOADING_STYLE;
    // r172:不再换 key 重建;换样式由 Orbit 原位过渡
    return <Orbit variant={shown} size={size} markProps={mp} enter={mountRoll.enter} />;
  }
  if (variantOf(style)) return <Orbit variant={style} size={size} markProps={mp} />;
  if (style === 'cli') return <CliSpinner size={size} markProps={mp} />;
  return (
    <span {...mergeMarkProps(mp, `loading-mark loading-${style}`, { width: size, height: size })}><span /></span>
  );
}

// CJ-4:流式/思考/connecting 时的实时耗时计数,每秒跳一次。startedAt=本回合发起时间戳。
export function ElapsedTime({ startedAt, className = '' }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const txt = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  return <span className={`font-mono text-[12px] text-ink-faint tabular-nums shrink-0 ${className}`}>{txt}</span>;
}
