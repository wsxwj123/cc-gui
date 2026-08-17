import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { turnWaveWidth } from '../utils/turnWave.js';

// 右侧竖向回合进度条(Claude Code/Codex 式线性波形 + macOS Dock 放大)。
// 每个用户回合一条横线;hover 按指针的实际纵向像素距离向左拉长 + 浮窗显示该回合消息摘要,
// 点击平滑滚动到该回合。
//
// 定位:作为 SessionDetail 根(position:relative)的 absolute 子元素,贴 right;
// 高度/纵向起点用 containerRef.offsetTop / offsetHeight(布局 px,与 CSS zoom 无关)
// —— 不用 fixed / getBoundingClientRect / window.innerWidth / --ui-zoom 换算,
// 因此在 GUI app 的缩放下也精确贴右缘,不会跑到中间挡文本。
// 点的纵向位置 = 该回合 DOM 节点 offsetTop / 内容 scrollHeight(0~1),与滚动无关。

const SHOW_DELAY = 220;
const HIDE_DELAY = 120;
export default function TurnScrubber({ containerRef, turns, onNavigate }) {
  const rootRef = useRef(null);                // 本组件根,取其 offsetParent 作定位基准
  const [box, setBox] = useState(null);        // { top, height } 相对根
  const [positions, setPositions] = useState([]); // 每个回合点 0~1
  const [pointerY, setPointerY] = useState(null);
  const [tipIdx, setTipIdx] = useState(null);
  const showTimer = useRef(0);
  const hideTimer = useRef(0);
  const pointerFrame = useRef(0);
  const pendingPointerY = useRef(null);
  const committedPointerY = useRef(null);
  // turns 经 ref 读取,使 measure 身份稳定 → ResizeObserver 不会每帧(流式每 token)重建。
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    // box.top 必须是 containerRef 相对【本 scrubber 的 offsetParent】的偏移。此前直接用
    // el.offsetTop,但 containerRef 的 offsetParent(消息滚动列)与 scrubber 的 offsetParent
    // (面板根)不是同一个 → 差了标题栏高度(实测 79px),整条进度轨上移、首点跑出消息区上方
    // (#7)。累加 offsetTop 到 scrubber 的定位基准(布局 px,与 zoom 无关)。rootRef 首帧未挂载
    // 时回落 el.offsetParent(旧行为),ResizeObserver 首个回调会带正确基准重算修正。
    const base = rootRef.current?.offsetParent || el.offsetParent;
    let top = 0, node = el;
    while (node && node !== base) { top += node.offsetTop; node = node.offsetParent; }
    setBox({ top, height: el.offsetHeight });
    const total = el.scrollHeight || 1;
    // 首末点映射进留边区间:首条 offsetTop≈0 → 原 top:0% + translate(-50%) 圆心落在轨道
    // 顶边、上半被裁 → 视觉上"缺首点"(#5,既有 bug)。上下各留 pad 让首末点完整可见。
    const pad = 0.02;
    setPositions(turnsRef.current.map((t) => {
      const node = el.querySelector(`[data-turn-uuid="${t.uuid}"]`);
      if (!node) return null;
      return Math.max(pad, Math.min(1 - pad, node.offsetTop / total));
    }));
  }, [containerRef]);

  // turns 变化(新增/裁剪回合)时重测一次;measure 本身稳定,不触发 observer 重建。
  // 依赖用稳定签名(回合数 + 末尾 uuid)而非数组引用:userTurns 每帧新建,若依赖引用则
  // 切焦点/流式每帧都跑 O(n) querySelector + 强制同步回流,×2 pane 阻塞列表高亮绘制(#9)。
  const turnsSig = turns.length + ':' + (turns[turns.length - 1]?.uuid || '');
  useLayoutEffect(() => { measure(); }, [measure, turnsSig]);

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

  const enterLine = (i) => {
    clearTimeout(hideTimer.current);
    clearTimeout(showTimer.current);
    showTimer.current = setTimeout(() => setTipIdx(i), SHOW_DELAY);
  };
  const leaveBar = () => {
    cancelAnimationFrame(pointerFrame.current);
    pointerFrame.current = 0;
    pendingPointerY.current = null;
    committedPointerY.current = null;
    setPointerY(null);
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setTipIdx(null), HIDE_DELAY);
  };
  const moveBar = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    pendingPointerY.current = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    if (pointerFrame.current) return;
    pointerFrame.current = requestAnimationFrame(() => {
      pointerFrame.current = 0;
      const next = pendingPointerY.current;
      if (next == null) return;
      if (committedPointerY.current != null && Math.abs(next - committedPointerY.current) < 1) return;
      committedPointerY.current = next;
      setPointerY(next);
    });
  };

  if (!box || turns.length < 2) return null;

  return (
    <div
      ref={rootRef}
      onPointerMove={moveBar}
      onMouseLeave={leaveBar}
      style={{ position: 'absolute', right: 4, top: box.top, height: box.height, width: 18, zIndex: 45 }}
      className="max-md:hidden pointer-events-auto"
    >
      {positions.map((n, i) => {
        const t = turns[i];
        // positions 比 turns 晚一帧更新:切到更短会话/回滚裁剪那一帧 positions 仍是旧的
        // 长数组,turns[i] 可能 undefined → 必须守卫,否则 .uuid 抛错整页白屏。
        if (n == null || !t) return null;
        return (
        <button
          key={t.uuid || i}
          onMouseEnter={() => enterLine(i)}
          onClick={() => scrollToTurn(t.uuid)}
          style={{
            position: 'absolute', top: `${n * 100}%`, right: 0,
            transform: 'translateY(-50%)',
          }}
          className="w-[18px] h-3 cursor-pointer flex items-center justify-end group"
          aria-label={`跳到第 ${i + 1} 个回合`}
        >
          <span
            data-turn-wave
            style={{
              width: pointerY == null ? 6 : turnWaveWidth(Math.abs(pointerY - n * box.height)),
              height: 2,
            }}
            className={`block transition-[width,background-color,opacity] duration-75 ease-out ${
              pointerY != null && Math.abs(pointerY - n * box.height) < 6 ? 'bg-accent opacity-100' : 'bg-ink-faint/55 opacity-80 group-hover:bg-accent'
            }`}
          />
        </button>
        );
      })}
      {tipIdx != null && positions[tipIdx] != null && turns[tipIdx] && (
        <div
          style={{ position: 'absolute', top: `${positions[tipIdx] * 100}%`, right: '100%', marginRight: 8, transform: 'translateY(-50%)', maxWidth: 260, width: 'max-content' }}
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
