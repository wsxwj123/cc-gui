import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

// 右侧竖向回合进度条(仿 gemini-voyager,加真·macOS Dock 邻居联动放大)。
// 每个用户回合一个点:hover 时按光标距离做 dock 放大 + 浮窗显示该回合消息摘要,
// 点击平滑滚动到该回合。
//
// 定位策略:不嵌进滚动容器(否则随内容滚),而是 fixed 到滚动容器的当前矩形
// (getBoundingClientRect),resize/scroll 时重测,天然对齐视口、兼容分屏与缩放。
// 点的纵向位置 = 该回合 DOM 节点在内容中的 offsetTop 归一化(0~1),与滚动无关。

const DOCK_RANGE = 70;   // 光标影响半径(px)
const DOCK_AMP = 0.9;    // 最近点额外放大量(scale 上限 1.9)
const SHOW_DELAY = 220;  // tooltip 出现防抖
const HIDE_DELAY = 120;

export default function TurnScrubber({ containerRef, turns }) {
  // 轨道相对视口的矩形(fixed 定位用)
  const [rect, setRect] = useState(null);
  // 每个回合点的归一化纵向位置 0~1(按内容 offsetTop)
  const [positions, setPositions] = useState([]);
  const [hover, setHover] = useState(null); // { index, x, y } for tooltip
  const barRef = useRef(null);
  const dotRefs = useRef([]);
  const rafRef = useRef(0);
  const showTimer = useRef(0);
  const hideTimer = useRef(0);

  // 测量轨道矩形(对齐滚动容器)
  const measureRect = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, height: r.height, right: window.innerWidth - r.right });
  }, [containerRef]);

  // 计算每个用户回合点的归一化位置(按 DOM 节点 offsetTop)
  const measurePositions = useCallback(() => {
    const el = containerRef.current;
    if (!el || turns.length === 0) { setPositions([]); return; }
    const total = el.scrollHeight || 1;
    const next = turns.map((t) => {
      const node = el.querySelector(`[data-turn-uuid="${t.uuid}"]`);
      if (!node) return null;
      // offsetTop 相对 offsetParent;用 scrollHeight 作分母(内容总高)
      const top = node.offsetTop;
      return Math.max(0, Math.min(1, top / total));
    });
    setPositions(next);
  }, [containerRef, turns]);

  useLayoutEffect(() => { measureRect(); measurePositions(); }, [measureRect, measurePositions]);

  // 容器尺寸/内容变化 → 重测(流式增长、折叠展开都覆盖)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { measureRect(); measurePositions(); });
    ro.observe(el);
    const onResize = () => { measureRect(); measurePositions(); };
    window.addEventListener('resize', onResize);
    // 滚动只影响轨道矩形(几乎不变),但分屏布局变动时也重测
    const onScroll = () => measureRect();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { ro.disconnect(); window.removeEventListener('resize', onResize); el.removeEventListener('scroll', onScroll); };
  }, [containerRef, measureRect, measurePositions]);

  // Dock 放大:mousemove 直接改 dot transform(不走 React re-render,避免抖动)
  const applyDock = useCallback((mouseY) => {
    const bar = barRef.current;
    if (!bar) return;
    const barTop = bar.getBoundingClientRect().top;
    const relY = mouseY - barTop;
    for (const dot of dotRefs.current) {
      if (!dot) continue;
      const dy = parseFloat(dot.dataset.py || '0');
      const dist = Math.abs(relY - dy);
      const scale = dist < DOCK_RANGE ? 1 + (1 - dist / DOCK_RANGE) * DOCK_AMP : 1;
      dot.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    }
  }, []);
  const resetDock = useCallback(() => {
    for (const dot of dotRefs.current) { if (dot) dot.style.transform = 'translate(-50%, -50%) scale(1)'; }
  }, []);

  const onBarMove = (e) => {
    const y = e.clientY;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => applyDock(y));
  };

  const scrollToTurn = (uuid) => {
    const el = containerRef.current;
    const node = el?.querySelector(`[data-turn-uuid="${uuid}"]`);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const enterDot = (i, e) => {
    clearTimeout(hideTimer.current);
    const x = rect ? window.innerWidth - rect.right : e.clientX;
    const y = e.clientY;
    clearTimeout(showTimer.current);
    showTimer.current = setTimeout(() => setHover({ index: i, x, y }), SHOW_DELAY);
  };
  const leaveDot = () => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHover(null), HIDE_DELAY);
  };

  useEffect(() => () => { clearTimeout(showTimer.current); clearTimeout(hideTimer.current); cancelAnimationFrame(rafRef.current); }, []);

  if (!rect || turns.length < 2) return null;

  const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;

  return createPortal(
    <>
      <div
        ref={barRef}
        onMouseMove={onBarMove}
        onMouseLeave={resetDock}
        style={{
          position: 'fixed',
          top: rect.top / z,
          right: rect.right / z,
          height: rect.height / z,
          width: 22,
          zIndex: 45,
        }}
        className="flex flex-col items-center justify-stretch pointer-events-auto"
      >
        {positions.map((n, i) => n == null ? null : (
          <button
            key={turns[i].uuid || i}
            ref={(el) => { dotRefs.current[i] = el; }}
            data-py={(n * (rect.height / z))}
            onMouseEnter={(e) => enterDot(i, e)}
            onMouseLeave={leaveDot}
            onClick={() => scrollToTurn(turns[i].uuid)}
            title=""
            style={{ position: 'absolute', top: `${n * 100}%`, left: '50%', transform: 'translate(-50%, -50%) scale(1)', transition: 'transform 0.12s ease, background-color 0.12s' }}
            className="w-[6px] h-[6px] rounded-full bg-ink-faint/50 hover:bg-accent cursor-pointer"
            aria-label={`跳到第 ${i + 1} 个回合`}
          />
        ))}
      </div>
      {hover != null && turns[hover.index] && (
        <div
          style={{
            position: 'fixed',
            top: hover.y / z,
            right: (rect.right + 26) / z,
            maxWidth: 260,
            transform: 'translateY(-50%)',
            zIndex: 46,
          }}
          className="glass-popover rounded-lg px-3 py-2 shadow-lg pointer-events-none animate-fade-in"
        >
          <div className="text-[10px] text-ink-faint font-mono mb-0.5">回合 {hover.index + 1}</div>
          <div className="text-[12px] text-ink leading-snug font-body" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {(turns[hover.index].text || '(空消息)').slice(0, 200)}
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
