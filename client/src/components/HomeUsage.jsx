// r130:首页(单屏)的用量总览八卡 + 日历热力图。契约 .devflow/INTERFACE-r130.md §C;算法全在 utils/homeUsage.js,
// 这里只做取数 / 监听 / 三态 / 渲染 / 浮层。不读 store(分屏门控在 App.jsx HomeState 按 paneCount 决定挂不挂本组件)。
// HomeState 是长会话常驻组件:React.memo、回调 useCallback、mountedRef 防卸载后 setState、**不设周期轮询**
// (用量面板那份 30 s 轮询已经在;首页只在挂载 / 广播 / 回合结束 / stale 后 45 s 各取一次)。
// r131 追加:顶部「总览 | 模型」分页 + 「全部 | 30 天 | 7 天」范围切换(选中态落 localStorage),模型分页 =
// 按天堆叠柱状图 + 图例(纯 SVG,不引图表库)。**范围只改数字、图不裁**(照 CLI /stats 的行为);
// 分页/范围切换都在前端切数据,不发新请求(一次到手,见 .devflow/INTERFACE-r131.md §A)。
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  cardValuesFor, cardCols, heatWeeks, heatmapGrid, isEmptyStats, tipText, localTodayKey,
  snakePath,
  RANGE_KEYS, LEGEND_DEFAULT_ROWS, legendItems, stackedByDay, yTicks, xTickIndexes, chartTip, abbrevTokens,
} from '../utils/homeUsage.js';
import { aggregateCost, displayUsd, formatCost } from '../utils/pricing.js';
import { useStore } from '../stores/sessionStore.js';

const SLOW_MS = 3000;             // 首次请求超过 3 s 未返回 → 骨架加「正在统计全部会话…」(本机冷扫 40 s)
const STALE_REFETCH_MS = 45_000;  // 收到 stale 响应后的一次延迟静默重取(广播丢失的兜底;定时器单份)
const CELL = 11;                  // 格子边长 px
// C11 修法(用户实报:回合结束后 chat-done 会让会话列表重载 → 首屏组件重挂 → 刚挂载的用量块走
// "非静默首取" → 骨架闪一下)。这里留一份"上次的载荷":重挂时直接以 ready + 旧数据起步、只做静默刷新,
// 只有**真·第一次**加载才显示骨架。存模块级(不是 localStorage):页面刷新即重来,不留陈旧数据。
let lastStatsCache = null;   // { data, at } —— 带时间戳;太旧时静默失败要回落错误态

const SNAKE_LEN = 8;              // 蛇身段数(头 + 7 节尾)
const CELL_GAP = 2;              // 与 GRID_STYLE 的 gap 同一个值
const SNAKE_PITCH = CELL + CELL_GAP;
const LEVEL_CLASS = ['bg-canvas-deep', 'bg-accent/25', 'bg-accent/45', 'bg-accent/70', 'bg-accent'];   // 随主题 accent 走
const ROW_LABELS = ['一', '', '三', '', '五', '', ''];
const GRID_STYLE = { display: 'grid', gridTemplateRows: `repeat(7, ${CELL}px)`, gridAutoFlow: 'column', gridAutoColumns: `${CELL}px`, gap: '2px' };
const LABEL_STYLE = { display: 'grid', gridTemplateRows: `repeat(7, ${CELL}px)`, gap: '2px', width: 18 };

// 选中态落 localStorage(键名与项目其他 UI 偏好同前缀;读不到 / 值不合法 → 回默认,不抛)。
const TAB_KEY = 'cgui-usage-tab';
const RANGE_KEY = 'cgui-usage-range';
const TABS = [{ key: 'overview', label: '总览' }, { key: 'models', label: '模型' }];
const RANGES = [{ key: 'all', label: '全部' }, { key: '30d', label: '30 天' }, { key: '7d', label: '7 天' }];
const readPref = (key, allow, fallback) => {
  try { const v = localStorage.getItem(key); return allow.includes(v) ? v : fallback; } catch { return fallback; }
};
const writePref = (key, v) => { try { localStorage.setItem(key, v); } catch { /* 隐私模式 / 配额满:偏好丢了不影响功能 */ } };

const TAB_BTN = 'px-2 py-0.5 rounded text-[11px] font-body transition-colors';
const TAB_ON = `${TAB_BTN} bg-accent text-on-accent`;
const TAB_OFF = `${TAB_BTN} text-ink-muted hover:text-ink hover:bg-canvas-deep`;
/** 范围切换:选中态实心、未选中态描边(比字号加粗更省横向空间,375px 下三个也放得下)。 */
const RANGE_BTN = 'px-2 py-0.5 rounded text-[11px] font-body transition-colors';
const RANGE_ON = `${RANGE_BTN} bg-accent text-on-accent`;
const RANGE_OFF = `${RANGE_BTN} text-ink-muted border border-canvas-deep hover:text-ink hover:bg-canvas-deep`;

/** 模型分页:柱状图高度与坐标轴留白(px)。柱子宽度由容器宽 / 天数算,不写死。
 *  窄屏用矮一点的图:375px 时"标题 + 图 + 图例(6 行)"会超过图区高度,多出来的部分会被裁;
 *  高度读容器的宽档(卡片的 cols 判据同源),不读窗口宽(分屏/缩放时以容器为准)。 */
const CHART_H_WIDE = 148;
const CHART_H_NARROW = 118;
const PAD_LEFT = 44;
const PAD_BOTTOM = 18;
const PAD_TOP = 6;
/** 一柱至少 2px 才有得看:容器宽 / 2 = 最多几根柱子(400 天窗口在 600px 下是 300 根)。 */
const barCapacity = (width) => Math.max(7, Math.floor(((width || 0) - PAD_LEFT) / 2));

/** x 轴标签:2026-09-29 → 9/29。 */
const shortDay = (day) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  return m ? `${Number(m[2])}/${Number(m[3])}` : String(day || '');
};

/** 一根柱子(定义在组件外:分页来回切时不重建组件类型)。段自下而上堆叠,颜色 = 序列色。 */
function Bar({ day, colorOf, onEnter, onLeave, onClick, leftPct, widthPct, plotH }) {
  let acc = 0;
  const segs = day.segments.map((s) => {
    const v = day.values[s.model] || 0;
    const h = ((v / (day.total || 1)) * plotH);
    const y = plotH - acc - h;
    acc += h;
    return { model: s.model, value: v, h, y };
  });
  return (
    <g
      data-testid="home-usage-chart-bar"
      data-day={day.day}
      data-total={day.total}
      className="cursor-pointer"
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onClick={onClick}
    >
      {/* 命中面:整柱高的透明矩形(含空格子),让 hover / tap 有一个真实可击的渲染面 */}
      <rect
        data-hit={day.day}
        x={`${leftPct}%`}
        y={PAD_TOP}
        width={`${widthPct}%`}
        height={plotH}
        fill="transparent"
      />
      {segs.map((s) => (
        <rect
          key={s.model}
          data-segment-model={s.model}
          data-value={s.value}
          fill="currentColor"
          fillOpacity={colorOf(s.model).opacity}
          className={`pointer-events-none ${colorOf(s.model).fill}`}
          x={`${leftPct}%`}
          y={PAD_TOP + s.y}
          width={`${widthPct}%`}
          height={Math.max(0, s.h)}
        />
      ))}
    </g>
  );
}

export const HomeUsage = React.memo(function HomeUsage() {
  const [stats, setStats] = useState(() => (lastStatsCache ? lastStatsCache.data : null));
  const [status, setStatus] = useState(() => (lastStatsCache ? 'ready' : 'loading'));   // 'loading' | 'error' | 'ready'
  const [slow, setSlow] = useState(false);
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState(null);               // { day, pinned } —— 热力图
  const [tipPos, setTipPos] = useState(null);
  const [tab, setTab] = useState(() => readPref(TAB_KEY, ['overview', 'models'], 'overview'));
  const [range, setRange] = useState(() => readPref(RANGE_KEY, RANGE_KEYS, 'all'));
  const [ctip, setCtip] = useState(null);             // { day, pinned } —— 柱状图
  const [ctipPos, setCtipPos] = useState(null);
  const [ctipRev, setCtipRev] = useState(0);          // 浮层/容器尺寸变化 → +1,让定位 effect 重算
  const [legendOpen, setLegendOpen] = useState(false);
  const [snakeOff, setSnakeOff] = useState({ x: 0, y: 0 });
  const [reduceMotion, setReduceMotion] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false));
  const mountedRef = useRef(false);
  const bootedRef = useRef(false);
  const rootRef = useRef(null);
  const heatRef = useRef(null);
  const gridRef = useRef(null);
  const snakeRef = useRef(null);
  const tipRef = useRef(null);
  const chartWrapRef = useRef(null);
  const ctipRef = useRef(null);
  const staleTimerRef = useRef(null);
  // 与用量面板同源:金额只有一个出口(utils/pricing.js 的 aggregateCost),provider 透传保证两处口径一致。
  const provider = useStore((s) => s.currentProvider);

  // silent = 静默重取:不闪骨架;失败时保留手上的数据(只有非静默的首取 / 重试失败才进错误态)。
  const fetchStats = useCallback(async (silent) => {
    if (!silent) { setStatus('loading'); setSlow(false); }
    try {
      const res = await fetch('/api/usage');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!mountedRef.current) return;
      lastStatsCache = { data, at: Date.now() };
      setStats(data);
      setStatus('ready');
    } catch {
      if (!mountedRef.current) return;
      // H2(独立审查重要):静默失败平时保留手上数据,但**手上数据已陈旧(>5 分钟)**时不能再装没事 ——
      // 否则服务端挂掉后首页永远显示旧数字、连重试入口都没有。
      const stale = !lastStatsCache || (Date.now() - lastStatsCache.at) > 5 * 60 * 1000;
      if (!silent || stale) setStatus('error');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // 挂载取一次。bootedRef:React.StrictMode(dev)把 effect 挂载→卸载→再挂载跑两遍,没有这道守卫 dev 下
    // 首屏会打两次 /api/usage(生产 build 不会);ref 在模拟重挂载时保留,生产路径行为不变。
    if (!bootedRef.current) { bootedRef.current = true; fetchStats(!!lastStatsCache); }   // 有缓存 → 首取也是静默的(不闪骨架)
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
  const chartH = cols === 2 ? CHART_H_NARROW : CHART_H_WIDE;   // 与卡片列数同一档判据(< 480 → 窄)
  const plotH = chartH - PAD_TOP - PAD_BOTTOM;
  const ready = status === 'ready' && !!stats;
  const empty = ready && isEmptyStats(stats);
  const cards = useMemo(() => (ready ? cardValuesFor(stats, range, todayKey) : []), [ready, stats, range, todayKey]);
  const grid = useMemo(() => (ready && !empty ? heatmapGrid({ byDay: stats.byDay, todayKey, weeks }) : null), [ready, empty, stats, todayKey, weeks]);
  // r135:贪吃蛇(用户要"一直循环")—— 访问顺序是纯函数算的,动画只改内联 transform/opacity,
  // **不进 React 状态**,所以每 45ms 一步不会重渲任何格子(400 个格子重渲会明显掉帧)。
  const snakeTotal = grid ? weeks * 7 : 0;   // 格子数(路径长度 ≥ 它,退回步骤会多走几步)
  const snakeOn = ready && !empty && !!grid && !reduceMotion;
  useEffect(() => {
    const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (!mq) return undefined;
    const on = () => setReduceMotion(!!mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  useEffect(() => {
    if (!snakeOn || !grid || !snakeTotal) return undefined;
    const layer = snakeRef.current;
    const gridEl = gridRef.current;
    if (!layer || !gridEl) return undefined;
    setSnakeOff({ x: gridEl.offsetLeft, y: gridEl.offsetTop });
    const segs = [...layer.querySelectorAll('[data-snake-seg]')];
    // snk 的做法:蛇经过的**有色格子被吃掉**(从图上消失),一轮走完再全部长回来。
    // 直接改真实格子的 visibility(不进 React 状态),所以每步都不会重渲。
    const cells = new Map([...gridEl.querySelectorAll('[data-cell-index]')].map((el) => [Number(el.dataset.cellIndex), el]));
    const eatenList = [];
    // 45ms 一步;窗口上的 __cguiSnakeMs 是**验收测试的加速缝**(生产不设它 → 默认 45)
    const stepMs = Math.min(2000, Math.max(8, Math.round(Number(typeof window !== 'undefined' && window.__cguiSnakeMs) || 45)));
    let path = snakePath(weeks);      // 每趟重新随机:同一屏里看不到两条一样的路径
    layer.dataset.snakeTotal = String(path.length);
    let step = 0;
    const eatenSet = new Set();
    let timer = null;
    const tick = () => {
      if (step === 0) {
        for (const el of eatenList) el.style.visibility = '';   // 新一轮:格子全部长回来
        eatenList.length = 0;
        eatenSet.clear();
        path = snakePath(weeks);
        layer.dataset.snakeTotal = String(path.length);
      }
      const idx = path[step];
      const target = cells.get(idx);
      if (target && grid.cells[idx] && grid.cells[idx].level > 0 && !eatenSet.has(idx)) { target.style.visibility = 'hidden'; eatenList.push(target); eatenSet.add(idx); }
      for (let i = 0; i < segs.length; i += 1) {
        const cell = grid.cells[path[Math.max(0, step - i)]]   // H1:不环绕 —— 环绕会取到新路径末尾,头身散架;
        segs[i].style.transform = `translate(${cell.col * SNAKE_PITCH}px, ${cell.row * SNAKE_PITCH}px)`;
      }
      layer.dataset.snakeStep = String(step);
      step = (step + 1) % path.length;
    };
    tick();
    timer = setInterval(tick, stepMs);
    return () => {
      clearInterval(timer);
      // M1(独立审查必修):数据每次刷新都会让 grid 变成新对象 → effect 重跑、step 归零,
      // 而新闭包里的 eatenList 是空的 → 不复原就会永久留下上一轮的吃痕(React 按 key 复用 DOM,
      // 内联 visibility 不会被重渲冲掉)。所以 cleanup 必须把格子放出来。
      for (const el of eatenList) el.style.visibility = '';
      eatenList.length = 0;
    };
  }, [snakeOn, grid, snakeTotal]);
  const tipCell = useMemo(() => (tip && grid ? grid.cells.find((c) => c.day === tip.day) || null : null), [tip, grid]);
  // 模型分页的数据:图例(按范围)与图(全部历史,不随范围裁)。data 为空时不算,免得刚 mount 就白算一遍。
  const showModels = ready && !empty && tab === 'models';
  const legend = useMemo(() => (ready ? legendItems(stats, range, todayKey) : []), [ready, stats, range, todayKey]);
  const chartData = useMemo(() => (ready ? stackedByDay(stats, { maxBar: barCapacity(width) }) : { series: [], days: [], max: 0 }), [ready, stats, width]);
  const yt = useMemo(() => yTicks(chartData.max), [chartData.max]);
  const xt = useMemo(() => xTickIndexes(chartData.days.length, chartData.days.length), [chartData.days.length]);
  const ctipDay = useMemo(() => (ctip ? chartData.days.find((d) => d.day === ctip.day) || null : null), [ctip, chartData.days]);
  const chartTipData = useMemo(() => (ctipDay ? chartTip(ctipDay) : null), [ctipDay]);
  const legendRows = legendOpen ? legend : legend.slice(0, LEGEND_DEFAULT_ROWS);
  const hiddenLegend = legend.length - legendRows.length;

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
  const onBarEnter = useCallback((e) => {
    if (e.pointerType !== 'mouse') return;
    const day = e.currentTarget.dataset.day;
    setCtip((t) => (t?.pinned || (t && t.day === day) ? t : { day, pinned: false }));
  }, []);
  const onBarLeave = useCallback((e) => {
    if (e.pointerType !== 'mouse') return;
    setCtip((t) => (t && !t.pinned ? null : t));
  }, []);
  const onBarClick = useCallback((e) => { setCtip({ day: e.currentTarget.dataset.day, pinned: true }); }, []);
  const closeCtip = useCallback(() => setCtip(null), []);
  useEffect(() => {
    if (!tip?.pinned && !ctip?.pinned) return undefined;
    const onDown = (e) => {
      if (tip?.pinned && !heatRef.current?.contains(e.target)) closeTip();
      if (ctip?.pinned && !chartWrapRef.current?.contains(e.target)) closeCtip();
    };
    // Escape 挂 window 捕获 + stopPropagation(同 AnchoredPopover):只在钉住期间吞这一击,不冒到会话级监听。
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeTip(); closeCtip(); } };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onEsc, true);
    return () => { document.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onEsc, true); };
  }, [tip?.pinned, ctip?.pinned, closeTip, closeCtip]);

  // 分页 / 范围切换时收起另一种浮层(切走的那个视图的浮层不该留在屏幕上)。
  useEffect(() => { setTip(null); setCtip(null); }, [tab, range]);

  // 浮层定位:格子 offsetLeft/offsetTop 相对热力图根(relative,同坐标系,不涉 zoom 标定);水平夹在根内,
  // 上方放不下就放下方。不复用 AnchoredPopover(portal + fixed + 标定 + 入场动画,扫过几十格会闪)。
  useLayoutEffect(() => {
    const root = heatRef.current;
    const el = tipRef.current;
    if (!tipCell || !root || !el) { setTipPos(null); return; }
    // day 正常是 YYYY-MM-DD(日期算术保证);万一缓存被改坏带了引号/括号,直接进选择器会抛
    // SyntaxError 把整块用量渲染搞崩。先守格式(不匹配就不定位;tooltip 仍由 React 文本节点渲染)。
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(tipCell.day))) { setTipPos(null); return; }
    const cellEl = root.querySelector(`[data-testid="home-usage-cell"][data-day="${tipCell.day}"]`);
    if (!cellEl) { setTipPos(null); return; }
    const cx = cellEl.offsetLeft + cellEl.offsetWidth / 2;
    const left = Math.max(0, Math.min(Math.round(cx - el.offsetWidth / 2), root.clientWidth - el.offsetWidth));
    let top = cellEl.offsetTop - el.offsetHeight - 6;
    if (top < 0) top = cellEl.offsetTop + cellEl.offsetHeight + 6;
    setTipPos({ left, top });
  }, [tipCell]);

  // 柱状图浮层定位。这一条是本轮返工最多的地方,把结论写全(免得下一个人再踩):
  //
  // **单位必须统一,而且不许假设两者的比值**。浮层的 `left/top` 是 CSS 布局像素;`getBoundingClientRect()`
  // 与 `offsetWidth` 在本仓库的引擎里**不是同一个坐标系**(实测同一容器:rect.width = 720、offsetWidth = 600;
  // 界面缩放 1.0 / 1.2 / 0.8 三档都验过)→ 混算会整块偏几十像素(仓库里已有两次同根因事故:
  // App.jsx 的回滚菜单、MessageBubble.jsx 的菜单)。现在的做法:柱心与浮层尺寸都取自 rect(同一坐标系),
  // 再用**容器自身**的 rect/offset 比值换算回布局像素 —— 比值是量出来的,不写死 1.2。
  // 另外三个坑:① 拿有内边距的外层 wrap 当参考系(内边距被算两遍);② 用 SVG 元素的 offsetLeft
  // (SVG 没有布局盒,恒为 0);③ 量完不重跑(悬停本身会触发横向滚动,量到的是滚动前的坐标)。
  //
  // 布局策略(判据来自 `.devflow/WINDOWS-REVIEW-0.2.401.md` 必修-2:三档缩放 × 最左/中/最右柱):
  // **居中优先** —— 能居中的柱必须居中(三档缩放实测偏差 0.36/0.48/0.05/0.48/−0.27/−0.23px);
  // 只有"居中的话浮层会整个跑出容器"时才贴边:贴边会让浮层与柱子偏心,但比溢出好 ——
  // 容器外面一圈是 `overflow:auto` 的 `home-usage-slot`,溢出会被裁掉或长出横滚条(实测强制居中会越界 26–36px)。
  // 贴边柱的实测偏差与"不溢出"的数见 `r131-c-ui.spec.mjs` 的 C10d 与 `.devflow/INTERFACE-r131.md`。
  useLayoutEffect(() => {
    const wrap = chartWrapRef.current;
    const el = ctipRef.current;
    if (!ctipDay || !wrap || !el) { setCtipPos(null); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ctipDay.day))) { setCtipPos(null); return; }
    const hitEl = wrap.querySelector(`[data-testid="home-usage-chart-bar"][data-day="${ctipDay.day}"] [data-hit]`);
    const boxEl = el.parentElement;   // 浮层的绝对定位父级 = 图表容器(相对定位那层)
    if (!hitEl || !boxEl) { setCtipPos(null); return; }
    const boxRect = boxEl.getBoundingClientRect();
    const barRect = hitEl.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    // 视觉 → 布局:容器自己的比值(界面缩放是施加在 <html> 上的 zoom,容器会跟着放大)
    const k = boxRect.width && boxEl.offsetWidth ? boxRect.width / boxEl.offsetWidth : 1;
    const boxW = boxEl.offsetWidth;
    const vw = elRect.width / k;
    const vh = elRect.height / k;
    const cx = (barRect.left + barRect.width / 2 - boxRect.left) / k;   // 柱心(布局像素,相对容器)
    let left = cx - vw / 2;                                             // 居中优先
    // 贴边的柱子在几何上做不到"既居中又不溢出":浮层宽 ≈180 布局px,而最右柱柱心离容器右缘只有 ~60px。
    // 取舍:**偏心优于溢出**(溢出会被容器裁掉、还会盖住邻柱;偏心至少整条可见,且文案里的日期是准的)。
    if (left + vw > boxW && left >= 0) left = Math.max(0, boxW - vw);    // 居中的话右边溢出 → 贴右缘
    else if (left < 0 && left + vw <= boxW) left = 0;                    // 左边溢出 → 贴左缘
    const barTop = (barRect.top - boxRect.top) / k;
    const barH = barRect.height / k;
    let top = barTop - vh - 6;
    if (top < 0) top = barTop + barH + 6;
    setCtipPos({ left: Math.round(left), top: Math.round(top) });
  }, [ctipDay, chartH, ctipRev]);

  // 尺寸一变就重定位一次。为什么需要:上面那条 effect 只在 ctipDay / 图表高度变化时算一次,
  // 而**浮层自己的布局宽度会随界面缩放档位变**(实测同一内容:1.0 档 185 布局px、1.2 档 180 布局px,
  // WebKit 对 zoom 下的文本取整所致),容器宽度也会随窗口拖动而变 —— 定位时量到的宽度/柱心一旦过期,
  // 浮层就会偏心几个像素,直到用户移开再悬停才自愈(C10d 在"半路换缩放档"的场景抓到过 2.6px)。
  // 这里只做一件事:尺寸变化时把 counter +1 去触发上面那条 effect 重算;判据与算法仍只有一份。
  useEffect(() => {
    const el = ctipRef.current;
    const box = el?.parentElement;
    if (!ctipDay || !el || !box || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setCtipRev((n) => n + 1));
    ro.observe(el);
    ro.observe(box);
    return () => ro.disconnect();
  }, [ctipDay]);

  // 格子数组只随 grid 变(回调都是稳定引用):hover 的 setTip 只重渲浮层节点,不重建几百个格子。
  const cellNodes = useMemo(() => (grid ? grid.cells.map((cell, i) => (cell.future
    ? <div key={`f${cell.col}-${cell.row}`} data-testid="home-usage-cell-future" className="rounded-[2px] bg-canvas-deep/40" aria-hidden="true" />
    : (
      <button
        key={cell.day}
        type="button"
        data-testid="home-usage-cell"
        data-cell-index={i}
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

  // 绘图区的三个纯计算量必须声明在 barNodes **之前**(barNodes 的依赖数组里有 barGap;
  // 写到后面会 TDZ: Cannot access 'barGap' before initialization,而渲染期抛错会被 ErrorBoundary
  // 兜成"用量块整块不渲染"——外面只看到几条 UI 用例红、看不到真正的错(我踩过一次)。
  const plotW = Math.max(1, (width || 0) - PAD_LEFT);
  const barW = chartData.days.length ? plotW / chartData.days.length : plotW;
  const barGap = barW >= 4 ? 1 : 0;
  // 柱子的颜色按序列(占比排名)取:同一模型在所有柱里颜色一致,与图例色块同源。
  const colorOf = useMemo(() => {
    const map = new Map(chartData.series.map((s) => [s.model, { fill: s.fill, opacity: s.opacity }]));
    return (model) => map.get(model) || { fill: 'text-accent', opacity: 0.25 };
  }, [chartData.series]);
  // 柱子节点 memo 掉(同 cellNodes 的手法):悬停柱子会 setCtip 重渲,不 memo 的话每动一下鼠标
  // 都要重建最多 400 根柱子 × 每柱模型数个 <rect>(代码审查 R3;安全审计也点了"DOM 无界放大")。
  const barNodes = useMemo(() => (chartData.days.length === 0 ? null : (
    <svg width="100%" height={chartH} role="img" aria-label="按天的模型用量堆叠图">
      <g>
        {chartData.days.map((d, i) => (
          <Bar
            key={d.day}
            day={d}
            plotH={plotH}
            colorOf={colorOf}
            onEnter={onBarEnter}
            onLeave={onBarLeave}
            onClick={onBarClick}
            leftPct={(i * 100) / chartData.days.length}
            widthPct={(100 / chartData.days.length) * (barGap ? 0.92 : 1)}
          />
        ))}
      </g>
    </svg>
  )), [chartData.days, chartH, plotH, colorOf, barGap, onBarEnter, onBarLeave, onBarClick]);

  const gridCols = cols === 2 ? 'grid-cols-2' : 'grid-cols-4';
  const stale = ready && !!stats.meta?.stale;
  const pickTab = (k) => { setTab(k); writePref(TAB_KEY, k); };
  const pickRange = (k) => { setRange(k); writePref(RANGE_KEY, k); };
  return (
    <div ref={rootRef} data-testid="home-usage" className="w-full min-w-0">
      <div className="flex flex-wrap items-center gap-2 mb-2 min-w-0">
        {/* r133:去掉「用量总览」四个字(用户要求) —— 分页控件自带「总览」，标题是多余的。
            这一行现在由「总览 | 模型」开头,验收里的"用量块顶部行"锚点改指 home-usage-tabs。 */}
        {/* 左:分页;右:范围。375px 下两者都要放得下 → 分组控件本身不换行,由父级的 min-w-0 收窄。 */}
        <div data-testid="home-usage-tabs" role="tablist" className="flex items-center gap-0.5 shrink-0">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              data-testid={`home-usage-tab-${t.key}`}
              aria-selected={tab === t.key}
              onClick={() => pickTab(t.key)}
              className={tab === t.key ? TAB_ON : TAB_OFF}
            >{t.label}</button>
          ))}
        </div>
        <div data-testid="home-usage-ranges" className="flex items-center gap-0.5 shrink-0 ml-auto">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              data-testid={`home-usage-range-${r.key}`}
              aria-pressed={range === r.key}
              onClick={() => pickRange(r.key)}
              className={range === r.key ? RANGE_ON : RANGE_OFF}
            >{r.label}</button>
          ))}
          {/* meta.stale:磁盘回放的旧值,服务端正在核对;如实说明,不把旧数当新数(与用量面板同一句)。 */}
          {stale && (
            <span data-testid="home-usage-stale" className="ml-1 text-[10px] text-ink-ghost font-body hidden sm:inline"
              title="先显示本机缓存的统计,服务端正在核对期间是否有新写入;核对完成后自动刷新。">统计中，数据可能略旧</span>
          )}
        </div>
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
      {ready && !empty && tab === 'overview' && (
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
              <div ref={gridRef} style={GRID_STYLE} className="shrink-0">{cellNodes}</div>
            </div>
            {/* r135:贪吃蛇覆盖层 —— 绝对定位盖在网格上方,pointer-events-none 不吃任何鼠标事件;
                系统开了"减少动态效果"就不渲染。格子本身一个类都不加(测试与真人都读同一套 data-*)。 */}
            {snakeOn && (
              <div ref={snakeRef} data-testid="home-usage-snake" data-snake-total={snakeTotal}
                className="absolute pointer-events-none z-10" aria-hidden="true"
                style={{ left: snakeOff.x, top: snakeOff.y, width: Math.max(0, weeks * SNAKE_PITCH - 2), height: 7 * SNAKE_PITCH - 2 }}>
                {Array.from({ length: SNAKE_LEN }).map((_, i) => (
                  <div key={`s${i}`} data-snake-seg={i} className="absolute w-[11px] h-[11px] rounded-[2px] bg-accent"
                    style={{ left: 0, top: 0, opacity: i === 0 ? 1 : 0.82 }} />
                ))}
              </div>
            )}
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
      {showModels && (
        <div className="w-full">
          <div ref={chartWrapRef} data-testid="home-usage-chart" className="relative w-full" data-days={chartData.days.length}>
            {chartData.days.length === 0 ? (
              <div className="py-8 text-center text-[12px] text-ink-faint font-body">这些天的用量没有模型明细</div>
            ) : (
              <>
                <div className="relative w-full" style={{ height: chartH }}>
                  {/* y 轴刻度:纯文本 div(不是 SVG text),这样测试与用户读到的都是同一套缩写字符串 */}
                  {yt.map((t) => (
                    <div
                      key={t.value}
                      data-testid="home-usage-chart-ytick"
                      className="absolute text-[9px] leading-none text-ink-faint font-body text-right select-none pointer-events-none"
                      style={{ left: 0, width: PAD_LEFT - 6, top: PAD_TOP + plotH - (t.value / (yt[yt.length - 1].value || 1)) * plotH - 4 }}
                    >{t.text}</div>
                  ))}
                  <div className="absolute" style={{ left: PAD_LEFT, right: 0, top: 0, height: chartH }}>
                    {barNodes}
                  </div>
                  {/* x 轴标签:等距(每 1–2 周一个)。用 flex + space-between 让**布局引擎均分间隔** ——
                      绝对定位 + translateX(-50%) 时 WebKit 对每个文本块各自取整,相邻间隔实测会差 1–3px
                      (C5b 的"标签等距"抓到过三次)。两端各溢出约半个标签宽:父级 overflow 不裁、不产生横滚。 */}
                  <div
                    className="absolute flex items-start justify-between text-[9px] leading-none text-ink-faint font-body select-none pointer-events-none"
                    style={{ left: PAD_LEFT, width: Math.max(0, plotW), top: chartH - PAD_BOTTOM + 4 }}
                  >
                    {xt.map((i) => (
                      <span key={`x${chartData.days[i].day}`} data-testid="home-usage-chart-xtick" className="whitespace-nowrap">
                        {shortDay(chartData.days[i].day)}
                      </span>
                    ))}
                  </div>
                </div>
                {ctipDay && (
                  <div ref={ctipRef} role="tooltip" data-testid="home-usage-chart-tip"
                    className="glass-popover absolute z-30 px-2 py-1 text-[11px] font-mono text-ink whitespace-nowrap pointer-events-none"
                    style={{ left: ctipPos ? ctipPos.left : 0, top: ctipPos ? ctipPos.top : 0, visibility: ctipPos ? 'visible' : 'hidden' }}>
                    <div className="text-ink-soft">{chartTipData.day} · {chartTipData.total}</div>
                    {chartTipData.rows.map((r) => (
                      <div key={r.model} className="flex items-center justify-between gap-3 whitespace-nowrap">
                        <span className="truncate max-w-[160px]" title={r.model}>{r.name}</span>
                        <span className="shrink-0">{r.value.toLocaleString('en-US')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          {legend.length > 0 && (
            <div data-testid="home-usage-legend" className="w-full mt-3">
              {legendRows.map((m) => {
                const cost = aggregateCost(m.model, m, provider);
                return (
                  <div key={m.model} data-testid="home-usage-legend-row" data-model={m.model} data-share={m.share.toFixed(2)} data-block={m.block}
                    className="flex items-center justify-between gap-1 py-1 min-w-0"
                    title={`${m.model} · ${abbrevTokens(m.input)} in · ${abbrevTokens(m.output)} out · ${m.share.toFixed(1)}% · ${cost.subscription ? '订阅内' : cost.usd != null ? formatCost(displayUsd(cost.usd, cost.currency)) + (cost.partial ? ' *' : '') : '无定价数据'}`}>
                    <span className={`inline-block w-2.5 h-2.5 rounded-[2px] shrink-0 ${m.shade}`} style={{ opacity: m.opacity }} aria-hidden="true" />
                    <span data-testid="home-usage-legend-name" title={m.model}
                      className="flex-1 min-w-0 truncate text-[11px] font-body text-ink">{m.name}</span>
                    <span className="shrink-0 text-[10px] font-mono text-ink-faint whitespace-nowrap">
                      {abbrevTokens(m.input)} in · {abbrevTokens(m.output)} out
                    </span>
                    <span className="shrink-0 w-10 text-right text-[10px] font-mono text-ink-muted">{m.share.toFixed(1)}%</span>
                    {cost.subscription ? (
                      <span className="hidden sm:inline shrink-0 w-14 text-right text-[10px] font-body text-ink-faint" title="按订阅或套餐计费，不按 token 计价">订阅内</span>
                    ) : cost.usd != null ? (
                      <span className="hidden sm:inline shrink-0 w-14 text-right text-[10px] font-mono text-accent"
                        title={cost.partial ? '该行含无法定价的部分（如缺 TTL 分配的写量 / 时段未知的调用），显示的是已知小计' : undefined}>
                        {formatCost(displayUsd(cost.usd, cost.currency))}{cost.partial ? ' *' : ''}
                      </span>
                    ) : (
                      <span className="hidden sm:inline shrink-0 w-14 text-right text-[10px] font-mono text-ink-ghost" title="无定价数据">—</span>
                    )}
                  </div>
                );
              })}
              {legend.length > LEGEND_DEFAULT_ROWS && (
                <button
                  type="button"
                  data-testid="home-usage-legend-more"
                  onClick={() => setLegendOpen((v) => !v)}
                  className="mt-1 px-2 py-0.5 rounded text-[11px] font-body text-ink-muted border border-canvas-deep hover:text-ink hover:bg-canvas-deep"
                >{legendOpen ? '收起' : `显示其余 ${hiddenLegend} 个`}</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
