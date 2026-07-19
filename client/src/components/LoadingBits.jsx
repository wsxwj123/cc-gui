import { useEffect, useState } from 'react';
import { useStore } from '../stores/sessionStore.js';

// 加载指示三件套(spinner/动态词/耗时),从 App.jsx 抽出共享:主会话流式状态行与
// 子代理视图(SubagentView)用同一套视觉物,保证"子会话页面与主会话显示一致"(#2)。

export const SPINNER_FRAMES = ['✻', '✶', '✷', '✸', '✹', '✺'];
export const THINKING_VERBS = [
  'Frolicking', 'Pondering', 'Brewing', 'Cogitating', 'Mulling',
  'Conjuring', 'Crafting', 'Weaving', 'Synthesizing', 'Noodling',
  'Spelunking', 'Marinating', 'Percolating', 'Ruminating',
];

// Bigger, brand-colored spinner — Claude terracotta #D97757, ~20px default
// (was 14px and accent-blue). Matches Claude's official brand color so the
// "thinking..." indicator feels like Claude's own UI.
export function CliSpinner({ size = 20 }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      className="font-mono inline-block leading-none"
      style={{ fontSize: size, color: '#D97757' }}
    >
      {SPINNER_FRAMES[frame]}
    </span>
  );
}

export function LoadingMark({ size = 20, variant = null }) {
  const chosen = useStore((s) => s.loadingStyle) || 'cli';
  const style = variant || chosen;
  if (style === 'cli') return <CliSpinner size={size} />;
  return (
    <span
      className={`loading-mark loading-${style}`}
      style={{ width: size, height: size }}
    ><span /></span>
  );
}

export function useCyclingVerb() {
  const [i, setI] = useState(() => Math.floor(Math.random() * THINKING_VERBS.length));
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % THINKING_VERBS.length), 3000);
    return () => clearInterval(id);
  }, []);
  return THINKING_VERBS[i];
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
