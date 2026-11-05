import { useEffect, useRef, useState } from 'react';
import { useStore } from '../stores/sessionStore.js';
import { orbitTicker } from '../utils/orbitTicker.js';
import { DEFAULT_LOADING_STYLE } from '../utils/loadingPrefs.js';

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
export function Orbit({ n = 3, size = 20, markProps = null }) {
  const count = n === 4 ? 4 : 3;
  const speed = useStore((s) => s.loadingSpeed) || 'slow';
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const kids = Array.from(el.children);
    return orbitTicker.register({ el, kids, n: kids.length });
  }, [count]);
  return (
    <span
      {...mergeMarkProps(markProps, 'orbit-mark', { width: size, height: size })}
      ref={ref}
      data-style={`orbit${count}`}
      data-speed={speed}
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, k) => <i key={k} />)}
    </span>
  );
}

export function LoadingMark({ size = 20, variant = null, markProps = null }) {
  const chosen = useStore((s) => s.loadingStyle) || DEFAULT_LOADING_STYLE;
  const style = variant || chosen;
  // 每个分支的最外层都带 data-style = 当前样式 id,供外层识别
  const mp = { ...(markProps || {}), 'data-style': style };
  if (style === 'orbit3' || style === 'orbit4') return <Orbit n={style === 'orbit4' ? 4 : 3} size={size} markProps={mp} />;
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
