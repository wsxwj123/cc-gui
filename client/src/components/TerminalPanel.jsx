import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { takePendingTerminalCommand } from '../utils/terminalBus.js';
import {
  readTerminalTheme, subscribeTerminalTheme, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE,
} from '../utils/terminalTheme.js';
import { Plus, X } from './Icon.jsx';

// 内置终端面板:node-pty(服务端)↔ xterm.js(本组件)的 WS 桥,帧协议见
// server/routes/terminal.js(v3)。复用主 /ws 通道(term-* 前缀分流),本面板自己
// 开一条独立 ws 连接。
//
// R01 生命周期:收起面板/卸载 = term-detach(进程与输出保留),重新打开/刷新后
// 凭 sessionStorage 里的 {generation,resumeToken} 重连续看(resumeToken 是敏感
// shell 凭据,只进 sessionStorage,不进 localStorage/DOM/日志);只有标签 ✕ 显式
// term-close 才结束 shell。多标签:一条 ws 带多个终端 id,每标签独立实例。
// 复制标签页/新导航:模块加载时若未见 pagehide 标记则丢弃继承的凭据清单并建
// 新身份(不依赖浏览器"不会复制 sessionStorage"的假设)。
// 配色跟随 app 主题:真相源 = <html> 上的主题属性(data-theme + data-theme-system +
// data-cgui-theme)与皮肤内联变量,合成/订阅都在 utils/terminalTheme.js(R38)。
// 这里曾经自持两套写死的 5 键主题 + 本地 light/dark 二分:只认明暗档、同档换家族
// 不跟、也没有 ANSI 16 色(彩色输出在浅底/深底上糊)。

const TOKENS_KEY = 'cgui-term-credentials'; // { [id]: {generation, resumeToken} }
const PAGEHIDE_FLAG = 'cgui-term-pagehide';

// 页面级一次性判定:本 JS 上下文是合法刷新继承,还是复制标签/新导航。
// 刷新:pagehide 写标记 → load 时消费并保留凭据;复制标签:sessionStorage 副本
// 无标记 → 丢弃凭据(发任何帧前完成,继承能力不生效)。
let pageInherited = false;
(function initPageSession() {
  try {
    if (sessionStorage.getItem(PAGEHIDE_FLAG)) {
      sessionStorage.removeItem(PAGEHIDE_FLAG);
      pageInherited = true;
    } else {
      // 复制标签页/新导航:丢弃继承能力,建新身份
      sessionStorage.removeItem(TOKENS_KEY);
    }
  } catch { /* sessionStorage 不可用(隐私模式等):退化为不恢复 */ }
})();
try {
  window.addEventListener('pagehide', () => {
    try { sessionStorage.setItem(PAGEHIDE_FLAG, '1'); } catch {}
  });
} catch {}

function loadStoredCredentials() {
  try {
    const raw = sessionStorage.getItem(TOKENS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function saveStoredCredentials(map) {
  try { sessionStorage.setItem(TOKENS_KEY, JSON.stringify(map)); } catch {}
}

// 页面级高熵终端 id(合同:逻辑 terminalId 随页面首次创建产生高熵值,不能把 t1
// 当身份 —— 可预测 id 会与残留分离终端/其他页面撞车)。保留 't' 前缀便于日志辨认。
function makeTabId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 64);
}

// 初始标签清单 + 活动 id(一次计算,同源):优先恢复本页遗留凭据对应的标签
// (同页 remount/合法刷新;复制页已被模块头清空)。
function initialTabs() {
  const creds = loadStoredCredentials();
  const ids = Object.keys(creds);
  const tabs = ids.length ? ids.map((id) => ({ id, exited: false })) : [{ id: makeTabId(), exited: false }];
  return { tabs, activeId: tabs[tabs.length - 1].id };
}

export function TerminalPanel() {
  const hostRefs = useRef(new Map());   // tabId -> 挂载 div(每 tab 常驻 DOM,滚回不丢)
  const termsRef = useRef(new Map());   // tabId -> { term, fit }
  const wsRef = useRef(null);
  const stateRef = useRef('init');
  const mountedRef = useRef(true);
  const credsRef = useRef(new Map());   // tabId -> { generation, resumeToken }(活终端凭据)
  // tabId -> 已退出代际(R03):「重新连接」凭它发 term-restart 在同一 id 上开新 shell
  // (自然退出即撤销 resume 能力,旧 token 不再可用)。记录过期(TERM_NOT_FOUND)时
  // 提示「记录已过期,请新建终端」,不自动拿别的东西顶替。
  const exitedGensRef = useRef(new Map());
  const pendingOpenRef = useRef(new Set()); // 已发 term-open/term-restart 待回执的 id(帧过滤用)
  // ws/终端未就绪期间的键入缓冲(按 tabId 分桶):打开面板即抢焦点,opened 后一次性
  // 落进**该标签**的 shell,避免"面板开了但连接未建立"这几百毫秒里的输入丢失。
  // 曾经是全局单串:任意标签 term-opened 都会把整串冲进那个 shell —— 某个 shell 退出后
  // 用户继续敲的命令(无回显),会被下一个新 shell 拿去执行,与 R03「退出后键入不回灌」
  // 直接矛盾;多标签并存时也会把 A 标签的键入送进 B 的 shell。
  const pendingInputRef = useRef(new Map()); // tabId -> 待落键入

  // 初始标签/活动 id 必须同源(只算一次):两个 useState 各自调 makeTabId 会产生
  // 两个不同 id,实例 effect 找不到活动标签的挂载点,xterm 永远建不出来。
  // activeIdRef 是同一份真相的 ref 镜像(事件回调里读它避免闭包旧值),初值也必须
  // 来自这里 —— 硬编码 't1' 会与真实高熵 id 失步:面板已 live 时点代码块「运行」
  // 取不到 generation,命令被取走又静默丢弃;ResizeObserver/聚焦/closeTab 判据同病。
  const initRef = useRef(null);
  if (!initRef.current) initRef.current = initialTabs();
  const activeIdRef = useRef(initRef.current.activeId);
  const [tabs, setTabs] = useState(initRef.current.tabs);
  const [activeId, setActiveId] = useState(initRef.current.activeId);
  const [state, setState] = useState('init'); // init | connecting | live | unavailable | ws-dead
  const [error, setError] = useState('');

  const goState = useCallback((s) => { stateRef.current = s; setState(s); }, []);
  const goActive = useCallback((id) => { activeIdRef.current = id; setActiveId(id); }, []);

  const send = useCallback((obj) => {
    const ws = wsRef.current;
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {}
  }, []);

  const openQueueRef = useRef(new Map()); // id -> 待发的 term-open 帧(ws 未就绪时排队)
  // term-open 帧发送:ws 未就绪(握手/断线中)先排队,onopen 时统一补发
  const sendOpen = useCallback((id, frame) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      pendingOpenRef.current.add(id);
      try { ws.send(JSON.stringify(frame)); } catch {}
    } else {
      openQueueRef.current.set(id, frame);
    }
  }, []);

  // 主题变更 → 重算主题并推给所有已建实例(挂载时先做一次,覆盖早于订阅建立的实例)。
  // 每次 readTerminalTheme() 都是新对象:xterm 的 options.theme 按引用比较,同一引用
  // 赋回不生效(实测 S5/S6)。底座底色不用手动同步 —— xterm 自己写 .xterm-scrollable-element
  // 的行内背景(实测 S7)。
  useEffect(() => {
    const applyTheme = () => {
      const theme = readTerminalTheme();
      for (const [, { term }] of termsRef.current) {
        try { term.options.theme = theme; } catch {}
      }
    };
    applyTheme();
    return subscribeTerminalTheme(applyTheme);
  }, []);

  // ── 终端实例:活动标签缺实例即创建(不等 ws —— 打开面板后焦点必须立刻就绪,
  // 否则"点开面板马上打字"的前几个字符会落在 body 上丢失;xterm 是纯前端对象,
  // term-open 帧由 sendOpen 缓冲到 ws 就绪后补发)──
  useEffect(() => {
    if (state === 'unavailable') return;
    const id = activeId;
    if (termsRef.current.has(id)) {
      const t = termsRef.current.get(id);
      setTimeout(() => { try { t.fit.fit(); t.term.focus(); } catch {} }, 30);
      return;
    }
    const host = hostRefs.current.get(id);
    if (!host) return;
    const term = new Terminal({
      fontSize: TERMINAL_FONT_SIZE,      // 13px,与 CodeBlock 的 text-[13px] 一致
      fontFamily: TERMINAL_FONT_FAMILY,  // 与 --font-mono 同一 fallback 链
      cursorBlink: true,
      scrollback: 5000,
      theme: readTerminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termsRef.current.set(id, { term, fit });
    term.onData((data) => {
      // 已退出的标签:shell 不再接受输入,更不能攒着等「重新连接」后打进新 shell(R03)
      if (exitedGensRef.current.has(id)) return;
      const gen = credsRef.current.get(id);
      if (!gen) {
        pendingInputRef.current.set(id, (pendingInputRef.current.get(id) || '') + data);
        return;
      }
      send({ type: 'term-in', id, generation: gen.generation, data });
    });
    term.onResize(({ cols, rows }) => {
      const gen = credsRef.current.get(id);
      if (gen) send({ type: 'term-resize', id, generation: gen.generation, cols, rows });
    });
    term.open(host);
    try { fit.fit(); } catch {}
    // 字体就绪后补一次 fit(幂等):webfont 晚于首次 fit 就绪会改变 cell 度量 → 行列数错,
    // 而容器尺寸没变、ResizeObserver 不会触发,首屏列数不会自动纠正。
    try {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          if (!mountedRef.current) return;
          if (termsRef.current.get(id)?.fit !== fit) return; // 实例已换代/已销毁
          try { fit.fit(); } catch {}
        }).catch(() => {});
      }
    } catch {}
    try { term.focus(); } catch {}
    const cred = credsRef.current.get(id);
    const exitedGen = exitedGensRef.current.get(id);
    const frame = cred
      ? // 重连:凭 sessionStorage 凭据恢复同一 shell(服务端会回放缓冲)
        { type: 'term-open', id, generation: cred.generation, resumeToken: cred.resumeToken }
      : exitedGen != null
        ? // 退出后重启:同一 id 开新 generation/新 pid(旧 token 已撤销,不能 resume)
          { type: 'term-restart', id, generation: exitedGen }
        : { type: 'term-open', id, cols: term.cols, rows: term.rows };
    sendOpen(id, frame);
  }, [activeId, state, tabs.length, send, sendOpen]);

  // ── ws 生命周期 ──
  const teardownConnections = useCallback(() => {
    try { wsRef.current?.close(); } catch {}
    wsRef.current = null;
    for (const { term } of termsRef.current.values()) { try { term.dispose(); } catch {} }
    termsRef.current.clear();
    for (const [, el] of hostRefs.current) { if (el) el.textContent = ''; }
  }, []);

  const connect = useCallback(() => {
    teardownConnections();
    setError('');
    goState('connecting');
    // status 探测与 ws 建立并行:等 status 会把"打开面板→焦点就绪"拖慢一个 RTT
    fetch('/api/terminal/status').then((r) => r.json()).then((st) => {
      if (!mountedRef.current) return;
      if (!st.available) {
        goState('unavailable');
        setError(st.error || 'node-pty 不可用');
        teardownConnections();
      }
    }).catch((e) => {
      if (!mountedRef.current) return;
      goState('unavailable');
      setError(e.message);
      teardownConnections();
    });
    {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        // 补发排队中的 term-open(实例创建早于 ws 就绪的场景)
        if (openQueueRef.current.size) {
          for (const [id, frame] of openQueueRef.current) {
            pendingOpenRef.current.add(id);
            try { ws.send(JSON.stringify(frame)); } catch {}
          }
          openQueueRef.current.clear();
        }
        goState('live');
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (typeof m?.id !== 'string') return;
        // 只认本面板的终端帧:id 高熵唯一,必须命中本页的实例/凭据/待回执集合,
        // 其他页面(高熵 id 各自独立)与残留终端的帧不会误入。
        if (!termsRef.current.has(m.id) && !credsRef.current.has(m.id) && !pendingOpenRef.current.has(m.id)) return;
        const entry = termsRef.current.get(m.id);
        if (m.type === 'term-opened') {
          pendingOpenRef.current.delete(m.id);
          // 记住该终端的凭据(内存 + sessionStorage,刷新/重开面板后重连用)
          credsRef.current.set(m.id, { generation: m.generation, resumeToken: m.resumeToken });
          saveStoredCredentials(Object.fromEntries(credsRef.current));
          // 重启成功(或本就是从死进程恢复):该标签回到运行态
          exitedGensRef.current.delete(m.id);
          setTabs((prev) => prev.map((t) => (t.id === m.id && t.exited ? { ...t, exited: false, exitCode: undefined } : t)));
          // opened 前缓冲的键入此刻落进 shell(只取本标签那一桶);代码块 ▶ 运行的待执行命令也在此消费
          const buffered = pendingInputRef.current.get(m.id) || '';
          pendingInputRef.current.delete(m.id);
          const pending = takePendingTerminalCommand();
          const payload = `${buffered}${pending ? `${pending}\r` : ''}`;
          if (payload) send({ type: 'term-in', id: m.id, generation: m.generation, data: payload });
          if (m.id === activeIdRef.current) {
            setTimeout(() => { const t = termsRef.current.get(m.id); if (t) { try { t.fit.fit(); t.term.focus(); } catch {} } }, 50);
          }
        } else if (m.type === 'term-out') {
          entry?.term.write(String(m.data ?? ''));
        } else if (m.type === 'term-exit') {
          setTabs((prev) => prev.map((t) => (t.id === m.id ? { ...t, exited: true, exitCode: m.exitCode } : t)));
          credsRef.current.delete(m.id); // 自然退出即能力撤销(旧 token 不能再 resume)
          saveStoredCredentials(Object.fromEntries(credsRef.current));
          exitedGensRef.current.set(m.id, m.generation); // 「重新连接」凭此发 term-restart
          // 退出时清掉该标签已攒的键入,不回灌到下次重启的 shell(合同:退出后 shell 不再接受输入)
          pendingInputRef.current.delete(m.id);
          entry?.term.write(`\r\n\x1b[2m[进程已退出,exit=${m.exitCode},点「重新连接」开新 shell]\x1b[0m\r\n`);
        } else if (m.type === 'term-error') {
          pendingOpenRef.current.delete(m.id);
          // 退出记录已过期/不可重启(超 6h 或归属他人):明确提示新建,不静默重建
          if (exitedGensRef.current.has(m.id) && ['TERM_NOT_FOUND', 'TERM_RESTART_CONFLICT', 'TERM_FORBIDDEN'].includes(m.code)) {
            exitedGensRef.current.delete(m.id);
            setError('记录已过期,请新建终端');
            return;
          }
          // 分离期间 shell 自然退出(服务端已移出存活表):resume 能力撤销,但服务端留了
          // 只读退出记录(退出前输出 + term-restart 归属)。这里**不能**按"凭据失效"降级
          // 新建 —— 新建会用同一 id 覆盖该记录,使「重新连接」路径永远不可达。标成退出态,
          // 由「重新连接」发 term-restart 在同一标签上开新 shell(记录超 6h 时服务端回
          // TERM_NOT_FOUND,走上面的"记录已过期,请新建终端"分支)。
          if (m.code === 'TERM_TOKEN_REVOKED' && credsRef.current.has(m.id)) {
            const cred = credsRef.current.get(m.id);
            credsRef.current.delete(m.id);
            saveStoredCredentials(Object.fromEntries(credsRef.current));
            exitedGensRef.current.set(m.id, cred.generation);
            setTabs((prev) => prev.map((t) => (t.id === m.id ? { ...t, exited: true } : t)));
            setError('该终端已在分离期间退出,点「重新连接」开新 shell');
            return;
          }
          // 其余凭据失效(刷新太久/服务重启/记录已过期):降级为新建,不让用户卡死。
          // 仅当此前确有凭据(是 resume 被拒)才自动重建;新建被拒(如满额)不循环。
          if (['TERM_TOKEN_REQUIRED', 'TERM_STALE', 'TERM_NOT_FOUND', 'TERM_EXPIRED'].includes(m.code) && credsRef.current.has(m.id)) {
            // 分离超 6h 被回收:明确告知,再降级新建(不让用户对着死标签干等)
            if (m.code === 'TERM_EXPIRED') setError('该终端分离超 6 小时已被回收,已新建终端');
            credsRef.current.delete(m.id);
            saveStoredCredentials(Object.fromEntries(credsRef.current));
            const t = termsRef.current.get(m.id);
            pendingOpenRef.current.add(m.id);
            send({ type: 'term-open', id: m.id, cols: t?.term.cols ?? 100, rows: t?.term.rows ?? 30 });
            return;
          }
          setError(String(m.error || m.code || '终端错误'));
        }
      };
      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        if (stateRef.current !== 'unavailable') goState('ws-dead');
      };
    }
  }, [send, teardownConnections, goState]);

  // ── 标签操作 ──
  const addTab = useCallback(() => {
    if (stateRef.current !== 'live') return;
    const id = makeTabId();
    setTabs((prev) => [...prev, { id, exited: false }]);
    goActive(id);
  }, [goState]);

  const closeTab = useCallback((id) => {
    // 标签 ✕ = 显式关闭:结束该 shell 并撤销凭据(R01 合同:只有显式 close 才杀);
    // 已退出的标签用退出代际关闭,释放服务端只读记录
    const gen = credsRef.current.get(id);
    const exitedGen = exitedGensRef.current.get(id);
    if (gen) send({ type: 'term-close', id, generation: gen.generation });
    else if (exitedGen != null) send({ type: 'term-close', id, generation: exitedGen });
    credsRef.current.delete(id);
    exitedGensRef.current.delete(id);
    pendingOpenRef.current.delete(id);
    pendingInputRef.current.delete(id);
    saveStoredCredentials(Object.fromEntries(credsRef.current));
    const t = termsRef.current.get(id);
    try { t?.term.dispose(); } catch {}
    termsRef.current.delete(id);
    hostRefs.current.delete(id);
    setTabs((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      const next = prev.filter((x) => x.id !== id);
      if (id === activeIdRef.current && next.length) {
        goActive(next[Math.max(0, idx - 1)].id);
      }
      return next;
    });
  }, [send, goActive]);

  // ▶ 运行:live 态直接打进当前活动标签(消费 pending);非 live 留给 term-opened 流程
  useEffect(() => {
    const onRun = () => {
      if (stateRef.current !== 'live') return;
      const cmd = takePendingTerminalCommand();
      const gen = credsRef.current.get(activeIdRef.current);
      if (cmd && gen) send({ type: 'term-in', id: activeIdRef.current, generation: gen.generation, data: `${cmd}\r` });
    };
    window.addEventListener('cgui-run-in-terminal', onRun);
    return () => window.removeEventListener('cgui-run-in-terminal', onRun);
  }, [send]);

  // 挂载即抢焦点(useLayoutEffect 早于浏览器绘制),配合输入缓冲兜住
  // "点开面板立刻打字"的竞态;活动标签容器尺寸变化 → fit 活动实例
  useLayoutEffect(() => {
    const t = termsRef.current.get(activeIdRef.current);
    if (t) { try { t.term.focus(); } catch {} }
  }, [activeId]);
  useEffect(() => {
    mountedRef.current = true;
    // 凭据补水:remount(收起→重新展开)后内存 credsRef 是空的,但 sessionStorage
    // 里还留着 detach 前的凭据 —— 补进来才能走 resume(而非误发新建被拒)。
    for (const [id, c] of Object.entries(loadStoredCredentials())) {
      if (!credsRef.current.has(id)) credsRef.current.set(id, c);
    }
    connect();
    const ro = new ResizeObserver(() => {
      const t = termsRef.current.get(activeIdRef.current);
      if (t) { try { t.fit.fit(); } catch {} }
    });
    if (hostRefs.current.get(activeId)) ro.observe(hostRefs.current.get(activeId));
    return () => {
      mountedRef.current = false;
      ro.disconnect();
      // 收起面板/卸载 = detach:只分离显示,shell 与缓冲保留(R01);显式 ✕ 才 close。
      // 凭据清单留在 sessionStorage,重新打开面板凭 token 重连续看。
      for (const [id, gen] of credsRef.current) send({ type: 'term-detach', id, generation: gen.generation });
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
      openQueueRef.current.clear();
      pendingOpenRef.current.clear();
      for (const { term } of termsRef.current.values()) { try { term.dispose(); } catch {} }
      termsRef.current.clear();
    };
  }, [connect, send]);

  const alive = state === 'live';

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 标签条:与编辑器同款(标签 + ✕ + 尾部 +);连接级状态在条右侧 */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-canvas-deep shrink-0 overflow-x-auto">
        {tabs.map((t, i) => (
          <span
            key={t.id}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-body cursor-pointer transition-colors whitespace-nowrap ${
              t.id === activeId ? 'bg-canvas-deep/30 text-ink' : 'text-ink-muted hover:bg-canvas-warm'
            }`}
            onClick={() => goActive(t.id)}
            title={t.exited ? `已退出(exit=${t.exitCode ?? '?'})` : '运行中'}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${t.exited ? 'bg-ink-ghost' : 'bg-green-500'}`} />
            终端 {i + 1}{t.exited ? '(退)' : ''}
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
              className="p-0.5 rounded hover:bg-black/10 text-ink-faint hover:text-ink"
              title="关闭此标签(结束对应进程)"
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <button
          onClick={addTab}
          disabled={!alive}
          title={alive ? '新建标签' : '连接未就绪'}
          className="p-1 rounded hover:bg-canvas-warm text-ink-muted disabled:opacity-40 shrink-0"
        >
          <Plus size={12} />
        </button>
        <span className="flex-1" />
        {state === 'live' && <span className="text-[10px] text-green-600 font-body shrink-0">● {tabs.filter((t) => !t.exited).length} 运行</span>}
        {(state === 'ws-dead' || tabs.some((t) => t.exited)) && (
          <button onClick={connect} className="px-2 py-0.5 rounded border border-canvas-deep hover:bg-canvas-warm text-[10px] font-body shrink-0">
            重新连接
          </button>
        )}
      </div>
      {state === 'unavailable' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-[12px] text-ink-muted font-body text-center">
          <span>终端不可用</span>
          <span className="text-ink-ghost break-all">{error}</span>
          <span className="text-ink-ghost">通常为 node-pty 原生模块与当前 Node 版本不匹配,其余功能不受影响</span>
        </div>
      )}
      {/* 每个 tab 常驻 DOM(隐藏而非卸载,滚回/状态不丢);fit 只在显示时做 */}
      <div className="flex-1 min-h-0 relative">
        {tabs.map((t) => (
          <div
            key={t.id}
            ref={(el) => { hostRefs.current.set(t.id, el); }}
            className="absolute inset-0 px-1.5 py-1 overflow-hidden"
            style={{ display: t.id === activeId && state !== 'unavailable' ? 'block' : 'none' }}
          />
        ))}
      </div>
      {/* 终端的可读错误(重启记录过期、被拒等):面板内联提示,不静默吞掉 */}
      {state !== 'unavailable' && error && (
        <div className="px-3 py-1.5 text-[11px] text-amber-600 font-body border-t border-canvas-deep">{error}</div>
      )}
      {state === 'ws-dead' && (
        <div className="px-3 py-2 text-[11px] text-ink-muted font-body border-t border-canvas-deep">
          连接已断开。终端进程仍在后台运行,点上方「重新连接」恢复查看(输入会继续送达)。
        </div>
      )}
    </div>
  );
}
