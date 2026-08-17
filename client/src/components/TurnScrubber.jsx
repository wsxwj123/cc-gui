import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { turnWaveWidth, layoutCompactPositions, distortPositions, buildTurnIndex, nearestTurnIndex, normalizePointerY } from '../utils/turnWave.js';

// 右侧竖向回合进度条(Claude Code/Codex 式线性波形 + macOS Dock 放大)。
// hover 线条向左拉长 + 浮窗显示该回合消息摘要,点击平滑滚动到该回合。
//
// r11-④(鱼眼版,对齐 dsh 效果):
//  · 布局:全部回合**等距紧凑**(不再按消息滚动位置比例分布),整簇垂直居中、永不
//    溢出容器(回合数×间距超高时整体压缩间距),所有回合始终全部渲染(无抽稀);
//  · 鱼眼:pointermove 时指针附近间距局部拉开(中心×3,高斯衰减 ±3 根内明显),
//    全簇重归一化 —— 总高/簇边界不变(distortPositions 纯函数,单测钉不变量);
//  · 命中:tooltip/点击/键盘步进全部在**变形后坐标**上二分解最近回合(所见即所得:
//    指针下那根 = 命中那根);波形宽度同样用变形后坐标距离;
//  · 工程:rAF 节流;线条 transform 过渡 ≤80ms 跟手;pointerleave 回弹等距;
//    卸载清理;role=slider + 上下键步进。
//
// 定位:作为 SessionDetail 根(position:relative)的 absolute 子元素,贴 right;
// 高度/纵向起点用 containerRef.offsetTop / offsetHeight(布局 px,与 CSS zoom 无关)
// —— 不用 fixed / getBoundingClientRect / window.innerWidth / --ui-zoom 换算,
// 因此在 GUI app 的缩放下也精确贴右缘,不会跑到中间挡文本。

const SHOW_DELAY = 220;
const HIDE_DELAY = 120;
const FISHEYE = { factor: 3 }; // sigma 缺省 = 3×平均间距(distortPositions 内部)
export default function TurnScrubber({ containerRef, turns, onNavigate }) {
  const rootRef = useRef(null);                // 本组件根,取其 offsetParent 作定位基准
  const [box, setBox] = useState(null);        // { top, height } 相对根
  const [pointerY, setPointerY] = useState(null);
  const [activeIdx, setActiveIdx] = useState(null); // 解算出的最近回合索引(hover/键盘共用)
  const activeIdxRef = useRef(null);                // rAF 回调里的同步判重(不吃 setState 时序)
  const [tipIdx, setTipIdx] = useState(null);
  const showTimer = useRef(0);
  const hideTimer = useRef(0);
  const pointerFrame = useRef(0);
  const pendingPointerY = useRef(null);
  const committedPointerY = useRef(null);

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    // box.top 必须是 containerRef 相对【本 scrubber 的 offsetParent】的偏移。此前直接用
    // el.offsetTop,但 containerRef 的 offsetParent(消息滚动列)与 scrubber 的 offsetParent
    // (面板根)不是同一个 → 差了标题栏高度(实测 79px),整条进度轨上移(#7)。累加 offsetTop
    // 到 scrubber 的定位基准(布局 px,与 zoom 无关)。rootRef 首帧未挂载时回落
    // el.offsetParent(旧行为),ResizeObserver 首个回调会带正确基准重算修正。
    const base = rootRef.current?.offsetParent || el.offsetParent;
    let top = 0, node = el;
    while (node && node !== base) { top += node.offsetTop; node = node.offsetParent; }
    setBox((prev) => (prev && prev.top === top && prev.height === el.offsetHeight)
      ? prev : { top, height: el.offsetHeight });
  }, [containerRef]);

  useLayoutEffect(() => { measure(); }, [measure]);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [containerRef, measure]);

  useEffect(() => () => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
    cancelAnimationFrame(pointerFrame.current);
  }, []);

  // 等距紧凑基线(px)与当前(可能变形后)坐标。渲染/命中/波形全用同一份 positions,
  // 保证所见即所得;无指针时 positions === base(等距原样)。
  const base = useMemo(
    () => layoutCompactPositions(turns.length, box?.height || 0),
    [turns.length, box?.height],
  );
  const positions = useMemo(
    () => (pointerY == null ? base : distortPositions(base, pointerY, FISHEYE)),
    [base, pointerY],
  );

  // 平滑滚动到回合。不用 scrollIntoView/scrollTo 的 behavior:'smooth' —— 实测某些
  // webview(含本 app 的 WKWebView)对程序化平滑滚动不响应。用 rAF 手动缓动,处处可用。
  const scrollToTurn = (uuid) => {
    const el = containerRef.current;
    const node = el?.querySelector(`[data-turn-uuid="${uuid}"]`);
    if (!el || !node) return;
    const target = Math.max(0, node.offsetTop - 8);
    const start = el.scrollTop;
    const dist = target - start;
    onNavigate?.();
    if (Math.abs(dist) < 2) return;
    const dur = 320;
    let t0 = null;
    const ease = (p) => 1 - Math.pow(1 - p, 3);
    const step = (ts) => {
      if (t0 == null) t0 = ts;
      const p = Math.min(1, (ts - t0) / dur);
      el.scrollTop = start + dist * ease(p);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  // 索引变化 → 武装 tooltip(首次入场延迟 SHOW_DELAY;tooltip 已可见则即时跟随)。
  const armTip = (i) => {
    clearTimeout(hideTimer.current);
    clearTimeout(showTimer.current);
    if (tipIdx != null) { setTipIdx(i); return; }
    showTimer.current = setTimeout(() => setTipIdx(i), SHOW_DELAY);
  };
  const leaveBar = () => {
    cancelAnimationFrame(pointerFrame.current);
    pointerFrame.current = 0;
    pendingPointerY.current = null;
    committedPointerY.current = null;
    setPointerY(null); // 回弹等距(positions 回落 base,transform 过渡自然收拢)
    activeIdxRef.current = null;
    setActiveIdx(null);
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setTipIdx(null), HIDE_DELAY);
  };
  const moveBar = (e) => {
    // r11-⑬:clientY/rect 是视觉像素,positions/box.height 是布局像素;字体档 zoom>1 时
    // 必须归一化(clientHeight/rect.height = 1/zoom),否则离顶越远命中偏移越大。
    const rect = e.currentTarget.getBoundingClientRect();
    pendingPointerY.current = normalizePointerY(e.clientY, rect, e.currentTarget.clientHeight);
    if (pointerFrame.current) return;
    pointerFrame.current = requestAnimationFrame(() => {
      pointerFrame.current = 0;
      const next = pendingPointerY.current;
      if (next == null) return;
      if (committedPointerY.current != null && Math.abs(next - committedPointerY.current) < 1) return;
      committedPointerY.current = next;
      setPointerY(next);
      // 单容器解算:在【变形后坐标】上二分最近回合(与本帧渲染同一 distort 输入,
      // 所见即所得),tooltip/点击/波形放大统一用该索引。
      const distorted = distortPositions(base, next, FISHEYE);
      const idx = nearestTurnIndex(buildTurnIndex(distorted), next);
      if (idx >= 0 && idx !== activeIdxRef.current) {
        activeIdxRef.current = idx;
        setActiveIdx(idx);
        armTip(idx);
      }
    });
  };
  // 容器级 click:按当前渲染帧的变形坐标解算(指针下那根=点中那根)。
  const clickBar = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // r11-⑬:与 moveBar 同一归一化(布局像素),zoom≠1 时点击命中与悬停一致。
    const y = normalizePointerY(e.clientY, rect, e.currentTarget.clientHeight);
    const anchor = committedPointerY.current ?? y;
    const idx = nearestTurnIndex(buildTurnIndex(distortPositions(base, anchor, FISHEYE)), y);
    const t = turns[idx];
    if (idx >= 0 && t) scrollToTurn(t.uuid);
  };
  // 键盘步进(role=slider):上下键逐回合移动并滚动到该回合。
  const keyBar = (e) => {
    const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!dir || turns.length === 0) return;
    e.preventDefault();
    const cur = activeIdx ?? tipIdx;
    const idx = cur == null
      ? (dir > 0 ? 0 : turns.length - 1)
      : Math.max(0, Math.min(turns.length - 1, cur + dir));
    activeIdxRef.current = idx;
    setActiveIdx(idx);
    setTipIdx(idx);
    const t = turns[idx];
    if (t) scrollToTurn(t.uuid);
  };

  if (!box || turns.length < 2) return null;

  return (
    <div
      ref={rootRef}
      onPointerMove={moveBar}
      onMouseLeave={leaveBar}
      onClick={clickBar}
      onKeyDown={keyBar}
      tabIndex={0}
      role="slider"
      aria-orientation="vertical"
      aria-label="回合导航"
      aria-valuemin={1}
      aria-valuemax={turns.length}
      aria-valuenow={(activeIdx ?? 0) + 1}
      aria-valuetext={`第 ${(activeIdx ?? 0) + 1} 回合`}
      style={{ position: 'absolute', right: 4, top: box.top, height: box.height, width: 18, zIndex: 45 }}
      className="max-md:hidden pointer-events-auto cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 rounded"
    >
      {positions.map((n, i) => {
        const t = turns[i];
        // positions 与 turns 同帧派生(turns.length),但守卫保留:极端时序下 turns[i]
        // 为 undefined 则跳过,避免 .uuid 抛错整页白屏。
        if (n == null || !t) return null;
        return (
        <div
          key={t.uuid || i}
          style={{
            position: 'absolute', top: 0, right: 0,
            // 鱼眼间距变化走 transform 过渡(≤80ms,跟手不粘滞);离开回弹同一通道。
            transform: `translateY(${n}px) translateY(-50%)`,
            transition: 'transform 70ms ease-out',
          }}
          className="w-[18px] flex items-center justify-end pointer-events-none"
        >
          <span
            data-turn-wave
            style={{
              // 波形距离用【变形后坐标】(鱼眼拉开后放大更明显)。
              width: pointerY == null ? 6 : turnWaveWidth(Math.abs(pointerY - n)),
              height: 2,
            }}
            className={`block transition-[width,background-color,opacity] duration-75 ease-out ${
              activeIdx === i ? 'bg-accent opacity-100' : 'bg-ink-faint/55 opacity-80'
            }`}
          />
        </div>
        );
      })}
      {tipIdx != null && positions[tipIdx] != null && turns[tipIdx] && (
        <div
          style={{ position: 'absolute', top: positions[tipIdx], right: '100%', marginRight: 8, transform: 'translateY(-50%)', maxWidth: 260, width: 'max-content' }}
          className="glass-popover rounded-lg px-3 py-2 shadow-lg pointer-events-none animate-fade-in"
        >
          <div className="text-[10px] text-ink-faint font-mono mb-0.5 flex items-center gap-1.5">
            <span>回合 {tipIdx + 1}</span>
          </div>
          <div className="text-[12px] text-ink leading-snug font-body" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {(turns[tipIdx].text || '(空消息)').slice(0, 200)}
          </div>
        </div>
      )}
    </div>
  );
}
