// r130:首页(单屏)的用量总览八卡 + 日历热力图。契约 .devflow/INTERFACE-r130.md §C;算法全在 utils/homeUsage.js,
// 这里只做取数 / 监听 / 三态 / 渲染 / 浮层。不读 store(分屏门控在 App.jsx HomeState 按 paneCount 决定挂不挂本组件)。
// HomeState 是长会话常驻组件:React.memo、回调 useCallback、mountedRef 防卸载后 setState、**不设周期轮询**
// (用量面板那份 30 s 轮询已经在;首页只在挂载 / 广播 / 回合结束 / stale 后 45 s 各取一次)。
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cardValues, cardCols, heatWeeks, heatmapGrid, isEmptyStats, tipText, localTodayKey } from '../utils/homeUsage.js';

const SLOW_MS = 3000;             // 首次请求超过 3 s 未返回 → 骨架加「正在统计全部会话…」(本机冷扫 40 s)
const STALE_REFETCH_MS = 45_000;  // 收到 stale 响应后的一次延迟静默重取(广播丢失的兜底;定时器单份)
const CELL = 11;                  // 格子边长 px;间距 2 → 每列 13 px(utils/homeUsage.js heatWeeks 按同一尺寸算周数)
const LEVEL_CLASS = ['bg-canvas-deep', 'bg-accent/25', 'bg-accent/45', 'bg-accent/70', 'bg-accent'];   // 随主题 accent 走
const ROW_LABELS = ['一', '', '三', '', '五', '', ''];
const GRID_STYLE = { display: 'grid', gridTemplateRows: `repeat(7, ${CELL}px)`, gridAutoFlow: 'column', gridAutoColumns: `${CELL}px`, gap: '2px' };
const LABEL_STYLE = { display: 'grid', gridTemplateRows: `repeat(7, ${CELL}px)`, gap: '2px', width: 18 };

export const HomeUsage = React.memo(function HomeUsage() {
  const [stats, setStats] = useState(null);
  const [status, setStatus] = useState('loading');   // 'loading' | 'error' | 'ready'
  const [slow, setSlow] = useState(false);
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState(null);               // { day, pinned }
  const [tipPos, setTipPos] = useState(null);
  const mountedRef = useRef(false);
  const bootedRef = useRef(false);
  const rootRef = useRef(null);
  const heatRef = useRef(null);
  const tipRef = useRef(null);
  const staleTimerRef = useRef(null);

  // silent = 静默重取:不闪骨架;失败时保留手上的数据(只有非静默的首取 / 重试失败才进错误态)。
  const fetchStats = useCallback(async (silent) => {
    if (!silent) { setStatus('loading'); setSlow(false); }
    try {
      const res = await fetch('/api/usage');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!mountedRef.current) return;
      setStats(data);
      setStatus('ready');
    } catch {
      if (!silent && mountedRef.current) setStatus('error');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // 挂载取一次。bootedRef:React.StrictMode(dev)把 effect 挂载→卸载→再挂载跑两遍,没有这道守卫 dev 下
    // 首屏会打两次 /api/usage(生产 build 不会);ref 在模拟重挂载时保留,生产路径行为不变。
    if (!bootedRef.current) { bootedRef.current = true; fetchStats(false); }
    const onRefresh = () => fetchStats(true);
    window.addEventListener('cgui:usage-updated', onRefresh);   // 服务端重算落地(WS 转发,既有)
    window.addEventListener('cgui:chat-done', onRefresh);       // 本端回合结束(与 UsagePanel 同一事件)
    return () => {
      mountedRef.current = false;
      window.removeEventListener('cgui:usage-updated', onRefresh);
      window.removeEventListener('cgui:chat-done', onRefresh);
      if (staleTimerRef.current) { clearTimeout(staleTimerRef.current); staleTimerRef.current = null; }
    };
  }, [fetchStats]);

  // 3 s 慢态(只对非静默的加载态计时)。
  useEffect(() => {
    if (status !== 'loading') return undefined;
    const id = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(id);
  }, [status]);

  // stale 响应 → 单份 45 s 延迟静默重取;新的 stale 响应重排,stale=false 清除;卸载由上面的 cleanup 清。
  useEffect(() => {
    if (staleTimerRef.current) { clearTimeout(staleTimerRef.current); staleTimerRef.current = null; }
    if (!stats?.meta?.stale) return;
    staleTimerRef.current = setTimeout(() => { staleTimerRef.current = null; fetchStats(true); }, STALE_REFETCH_MS);
  }, [stats, fetchStats]);

  // 量容器宽:useLayoutEffect 先同步量一次(否则首帧按 0 宽 = 8 周 / 两列闪一下),再由 ResizeObserver 跟随。
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth || 0);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const todayKey = localTodayKey();   // 每次渲染重取:跨午夜后的下一次渲染自然换日
  const weeks = heatWeeks(width);
  const cols = cardCols(width);
  const ready = status === 'ready' && !!stats;
  const empty = ready && isEmptyStats(stats);
  const cards = useMemo(() => (ready ? cardValues(stats, todayKey) : []), [ready, stats, todayKey]);
  const grid = useMemo(() => (ready && !empty ? heatmapGrid({ byDay: stats.byDay, todayKey, weeks }) : null), [ready, empty, stats, todayKey, weeks]);
  const tipCell = useMemo(() => (tip && grid ? grid.cells.find((c) => c.day === tip.day) || null : null), [tip, grid]);

  // 浮层按事件 pointerType 分支(不是媒体查询 / 视口宽:iPad 横屏是触屏、桌面窄窗口有鼠标):
  // 鼠标进入显示、离开隐藏(钉住除外);任意指针 click 钉住;钉住后点图外 / Escape 关闭。
  const onCellEnter = useCallback((e) => {
    if (e.pointerType !== 'mouse') return;
    const day = e.currentTarget.dataset.day;
    setTip((t) => (t?.pinned || (t && t.day === day) ? t : { day, pinned: false }));
  }, []);
  const onCellLeave = useCallback((e) => {
    if (e.pointerType !== 'mouse') return;
    setTip((t) => (t && !t.pinned ? null : t));
  }, []);
  const onCellClick = useCallback((e) => { setTip({ day: e.currentTarget.dataset.day, pinned: true }); }, []);
  const closeTip = useCallback(() => setTip(null), []);
  useEffect(() => {
    if (!tip?.pinned) return undefined;
    const onDown = (e) => { if (!heatRef.current?.contains(e.target)) closeTip(); };
    // Escape 挂 window 捕获 + stopPropagation(同 AnchoredPopover):只在钉住期间吞这一击,不冒到会话级监听。
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeTip(); } };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onEsc, true);
    return () => { document.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onEsc, true); };
  }, [tip?.pinned, closeTip]);

  // 浮层定位:格子 offsetLeft/offsetTop 相对热力图根(relative,同坐标系,不涉 zoom 标定);水平夹在根内,
  // 上方放不下就放下方。不复用 AnchoredPopover(portal + fixed + 标定 + 入场动画,扫过几十格会闪)。
  useLayoutEffect(() => {
    const root = heatRef.current;
    const el = tipRef.current;
    if (!tipCell || !root || !el) { setTipPos(null); return; }
    const cellEl = root.querySelector(`[data-testid="home-usage-cell"][data-day="${tipCell.day}"]`);
    if (!cellEl) { setTipPos(null); return; }
    const cx = cellEl.offsetLeft + cellEl.offsetWidth / 2;
    const left = Math.max(0, Math.min(Math.round(cx - el.offsetWidth / 2), root.clientWidth - el.offsetWidth));
    let top = cellEl.offsetTop - el.offsetHeight - 6;
    if (top < 0) top = cellEl.offsetTop + cellEl.offsetHeight + 6;
    setTipPos({ left, top });
  }, [tipCell]);

  // 格子数组只随 grid 变(回调都是稳定引用):hover 的 setTip 只重渲浮层节点,不重建几百个格子。
  const cellNodes = useMemo(() => (grid ? grid.cells.map((cell) => (cell.future
    ? <div key={`f${cell.col}-${cell.row}`} data-testid="home-usage-cell-future" className="rounded-[2px] bg-canvas-deep/40" aria-hidden="true" />
    : (
      <button
        key={cell.day}
        type="button"
        data-testid="home-usage-cell"
        data-day={cell.day}
        data-tokens={cell.tokens}
        data-level={cell.level}
        data-today={cell.today ? '1' : undefined}
        aria-label={tipText(cell)}
        className={`block w-[11px] h-[11px] p-0 border-0 rounded-[2px] cursor-pointer ${LEVEL_CLASS[cell.level]}${cell.today ? ' ring-1 ring-ink/60' : ''}`}
        onPointerEnter={onCellEnter}
        onPointerLeave={onCellLeave}
        onClick={onCellClick}
      />
    ))) : null), [grid, onCellEnter, onCellLeave, onCellClick]);

  const gridCols = cols === 2 ? 'grid-cols-2' : 'grid-cols-4';
  const stale = ready && !!stats.meta?.stale;
  return (
    <div ref={rootRef} data-testid="home-usage" className="w-full min-w-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[11px] text-ink-muted font-body">用量总览</span>
        {/* meta.stale:磁盘回放的旧值,服务端正在核对;如实说明,不把旧数当新数(与用量面板同一句)。 */}
        {stale && (
          <span data-testid="home-usage-stale" className="text-[10px] text-ink-ghost font-body"
            title="先显示本机缓存的统计,服务端正在核对期间是否有新写入;核对完成后自动刷新。">统计中，数据可能略旧</span>
        )}
      </div>
      {status === 'loading' && (
        <div data-testid="home-usage-loading" data-slow={slow ? '1' : undefined} className="w-full" aria-busy="true">
          <div className={`grid gap-2 ${gridCols}`}>
            {Array.from({ length: 8 }, (_, i) => <div key={i} className="h-[52px] rounded-lg bg-canvas-warm border border-canvas-deep animate-pulse" />)}
          </div>
          <div className="h-[104px] mt-3 rounded-lg bg-canvas-warm/60 animate-pulse" />
          {slow && <div className="mt-2 text-[11px] text-ink-faint font-body">正在统计全部会话…</div>}
        </div>
      )}
      {status === 'error' && (
        <div data-testid="home-usage-error" className="w-full flex items-center gap-2 text-[12px] text-ink-muted font-body">
          <span>无法加载用量数据</span>
          <button type="button" data-testid="home-usage-retry" onClick={() => fetchStats(false)}
            className="px-2 py-0.5 rounded border border-canvas-deep hover:bg-canvas-deep text-[11px] text-ink">重试</button>
        </div>
      )}
      {ready && empty && (
        <div data-testid="home-usage-empty" className="w-full py-6 text-center text-[12px] text-ink-faint font-body">还没有用量记录</div>
      )}
      {ready && !empty && (
        <>
          <div data-testid="home-usage-cards" data-cols={cols} className={`grid gap-2 w-full ${gridCols}`}>
            {cards.map((c) => (
              <div key={c.key} data-testid={`home-usage-card-${c.key}`} data-value={c.value} className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 min-w-0">
                <div className="text-[10px] text-ink-faint font-body mb-0.5">{c.label}</div>
                <div className="text-lg font-mono font-medium text-ink truncate" title={c.text}>{c.text}</div>
              </div>
            ))}
          </div>
          <div ref={heatRef} data-testid="home-usage-heatmap" data-weeks={weeks} className="relative w-full mt-3">
            <div className="flex items-start justify-center gap-1">
              <div style={LABEL_STYLE} className="shrink-0 text-[9px] leading-[11px] text-ink-faint font-body text-right select-none" aria-hidden="true">
                {ROW_LABELS.map((l, i) => <span key={i}>{l}</span>)}
              </div>
              <div style={GRID_STYLE} className="shrink-0">{cellNodes}</div>
            </div>
            {tipCell && (
              <div ref={tipRef} role="tooltip" data-testid="home-usage-tip"
                className="glass-popover absolute z-30 px-2 py-1 text-[11px] font-mono text-ink whitespace-nowrap pointer-events-none"
                style={{ left: tipPos ? tipPos.left : 0, top: tipPos ? tipPos.top : 0, visibility: tipPos ? 'visible' : 'hidden' }}>
                {tipText(tipCell)}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
});
