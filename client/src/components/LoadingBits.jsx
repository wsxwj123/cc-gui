import { useEffect, useRef, useState } from 'react';
import { useStore } from '../stores/sessionStore.js';
import { orbitTicker } from '../utils/orbitTicker.js';
import { ORBIT_VARIANTS, variantOf } from '../utils/orbitVariants.js';
import { DEFAULT_LOADING_STYLE, RANDOM_LOADING_STYLE, pickRandomStyle, shouldReroll, nextRollState } from '../utils/loadingPrefs.js';

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
export function Orbit({ n = 3, variant = null, size = 20, markProps = null }) {
  const v = variantOf(variant) || ORBIT_VARIANTS[n === 4 ? 'orbit4' : 'orbit3'];
  const count = v.n;
  const variantId = v.id;
  const speed = useStore((s) => s.loadingSpeed) || 'slow';
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const kids = Array.from(el.children);
    return orbitTicker.register({ el, kids, n: kids.length, variant: variantId });
  }, [variantId]);
  return (
    <span
      {...mergeMarkProps(markProps, 'orbit-mark', { width: size, height: size })}
      ref={ref}
      data-style={variantId}
      data-speed={speed}
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, k) => <i key={k} />)}
    </span>
  );
}

// r159:随机模式最近一次抽到的具体 id(所有实例共用),新实例挂载时避开它,相邻两次不重样。
let lastPickedRandomId = null;
function pickAndRemember(prevId) {
  const id = pickRandomStyle(prevId);
  lastPickedRandomId = id;
  return id;
}

// r159 D3b:按回合的抽取记忆(组件外,单个)。同一时间只有一个生成中的主会话状态行;
// 它在工作组头行与底部之间换位置会卸载再挂载,靠这里沿用同一回合已抽到的 id。新 scope = 新回合。
let scopedRollMem = null;
function scopedRoll(scope, phase, key) {
  const res = nextRollState(scopedRollMem, { scope, phase, key, nowMs: Date.now() });
  scopedRollMem = res.mem;
  lastPickedRandomId = res.id;
  return res.id;
}

// phase / rollKey:只有生成中的状态行传。样式为 random 时,挂载时抽一个具体动画;
// 之后 phase / rollKey 变化按 shouldReroll 决定是否重抽(挂载那次算计时起点)。
// rollScope(回合起点时间戳):给了就按回合记忆抽取,跨挂载连续;没给(子代理无起点、设置网格)按实例内抽取。
export function LoadingMark({ size = 20, variant = null, markProps = null, phase = null, rollKey = null, rollScope = null }) {
  const chosen = useStore((s) => s.loadingStyle) || DEFAULT_LOADING_STYLE;
  const style = variant || chosen;
  const isRandom = style === RANDOM_LOADING_STYLE;
  const scoped = rollScope != null;
  const [randomId, setRandomId] = useState(() => {
    if (!isRandom) return null;
    return scoped ? scopedRoll(rollScope, phase, rollKey) : pickAndRemember(lastPickedRandomId);
  });
  const rollRef = useRef({ phase, key: rollKey, lastRollMs: isRandom ? Date.now() : null });
  useEffect(() => {
    const roll = rollRef.current;
    const prevPhase = roll.phase;
    const prevKey = roll.key;
    roll.phase = phase;
    roll.key = rollKey;
    if (isRandom && scoped) {
      // 按回合记忆:挂载 / 阶段变化都走 nextRollState;同回合重新挂载不重抽
      const id = scopedRoll(rollScope, phase, rollKey);
      roll.lastRollMs = scopedRollMem.lastRollMs;
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
  // 每个分支的最外层都带 data-style = 当前显示的具体样式 id,供外层识别;随机时另带 data-loading-mode
  const mp = { ...(markProps || {}), 'data-style': shown };
  if (isRandom) {
    mp['data-loading-mode'] = RANDOM_LOADING_STYLE;
    return <Orbit key={shown} variant={shown} size={size} markProps={mp} />;
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
