import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MessageSquare, Minus, Send, Trash2, Loader2 } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';
import { confirmDialog } from '../utils/confirmDialog.jsx';

// 旁问浮窗:右下角可拖动/可最小化的浮动小窗,把 /btw 的"我问→AI答→我再问"渲染成
// 一条连续线程(而非散落主对话流的独立气泡)。数据仍活在 SessionDetail 的 per-pane
// chatMessages(ownerKey 门控),本组件只是渲染层 + 输入入口 + 未读角标。
//
// 挂载点:SessionDetail 根(position:relative)内的 absolute 子元素 → 天然被 pane 裁剪、
// 跟随会话切换。常驻挂载(收起=折叠不 unmount)使未读基线连续;lastSeen 另按 sessionKey 重置
// 区分"切会话"vs"失焦",不踩 per-pane-window-effect-global-state-leak 家族坑。
//
// 布局遵循 sticky-fails-under-transform-modal-flex-column:flex 列三段,不用 sticky footer。
//
// 浮动窗固定宽 360;窄格吸附阈值 = 360(窗宽) + 26(rightInset 最小让位) + 8(左缘余量) ≈ 394,
// 取 400:所属窗格宽 < 400 时浮动放不下,切换成手机端同款底部抽屉形态;拖宽自动恢复浮动
// (pos 状态保留不丢)。
const BTW_W = 360;
const BTW_DOCK_W = 400;

export default function BtwWindow({
  thread, onSend, onClearThread,
  sessionKey, paneIsActive = true, suppressed = false, mobile = false, openSignal = 0, toggleSignal = 0, onUnreadChange,
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [pos, setPos] = useState(null);       // {left,top} pane-local px;null=默认右下角
  const [input, setInput] = useState('');
  const [lastSeen, setLastSeen] = useState(0);
  const rootRef = useRef(null);
  const bodyRef = useRef(null);
  const dragRef = useRef(null);
  const atBottomRef = useRef(true);   // #4:仅当用户贴底才自动跟随新答,上滚后不抢回底

  const answered = thread.filter((m) => !m.pending && !m.error).length;
  const pending = thread.some((m) => m.pending);

  // 让路:非聚焦 pane、有挂起授权/问题交互(suppressed)、或手动收起 → 只留浮标,不盖住授权卡。
  const expanded = !collapsed && paneIsActive && !suppressed;
  const unread = expanded ? 0 : Math.max(0, answered - lastSeen);

  // 展开(或保持展开)时把已读基线追平当前已答数 → 角标清零。
  useEffect(() => { if (expanded) setLastSeen(answered); }, [expanded, answered]);

  // 未读数上报给宿主(收起态入口已移到输入框工具行的「旁问」按钮,角标显示在那)。
  useEffect(() => { onUnreadChange?.(unread); }, [unread, onUnreadChange]);

  // 切会话:位置复位 + 已读基线归到新线程当前已答数(避免 A 的已读数套到 B),空线程默认收起。
  // 用 useLayoutEffect(非 useEffect):在 sessionKey 变的同帧、绘制前收起,消除"展开着的空窗"
  // 闪现一帧(#2);B 有旁问则不收、保持展开显示 B 的线程。
  useLayoutEffect(() => {
    setPos(null);
    setLastSeen(thread.filter((m) => !m.pending && !m.error).length);
    if (thread.length === 0) setCollapsed(true);
    atBottomRef.current = true; // 新会话展开时贴底跟随(#4)
    // 只在会话键变时跑;thread 每次渲染新引用,不入依赖(仅取初值)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  // 外部信号(主输入框 /btw 或窗口内发送)→ 展开。ref 初值=当前 openSignal:挂载那次为
  // no-op —— btwOpenSignal 是持久只增计数器,切会话时主窗格 loading 使本窗卸载重挂,挂载时
  // 此 effect 会读到持久正值误 setCollapsed(false)=「切会话旁问窗自动弹出」根因,故需 guard。
  const openSeenRef = useRef(openSignal);
  useEffect(() => {
    if (openSignal && openSignal !== openSeenRef.current) { openSeenRef.current = openSignal; setCollapsed(false); }
  }, [openSignal]);
  // toggle 信号(输入框「旁问」按钮每点一次 +1)→ 切换 collapsed(展开↔收起)。ref guard 保证每个
  // signal 值只处理一次:函数式 setCollapsed(c=>!c) 非幂等,若 StrictMode/重复触发使 effect 跑两
  // 次会互相抵消(实测点按钮不收起的根因)。/btw 与窗口内发送仍走 openSignal 强制展开(非 toggle)。
  const toggleSeenRef = useRef(toggleSignal); // 初值=当前值:挂载 no-op,同款防切会话重挂误触发
  useEffect(() => {
    if (toggleSignal && toggleSignal !== toggleSeenRef.current) {
      toggleSeenRef.current = toggleSignal;
      setCollapsed((c) => !c);
    }
  }, [toggleSignal]);

  // #1 浮窗右缘对齐输入框右缘:输入框是居中定宽列(--content-max),浮窗贴 pane 右缘天生
  // 不齐。按 offsetParent(=SessionDetail 根)宽算内容列右缘距 pane 右缘的内边距,夹到 ≥26
  // 以让开右缘 TurnScrubber(right:4 width:18)。pane 拖拽/窗口缩放都要重算 → ResizeObserver。
  const [rightInset, setRightInset] = useState(26);
  // 展开窗:浮在输入框上方(bottomInset,主动打开的浮层,可短暂遮消息)。收起态入口已移到输入框
  // 工具行的「旁问」按钮(方案A),不再有右下角浮标——从结构上避开与消息队列条/横幅抢右下角地皮。
  const [bottomInset, setBottomInset] = useState(12);
  // 所属窗格宽度(布局 px):分屏拖窄 < BTW_DOCK_W 时切吸附形态。0=未测(首帧当浮动,
  // useLayoutEffect 在 paint 前测好,不闪)。per-pane 本地 state,分屏各格互不干扰。
  const [paneW, setPaneW] = useState(0);
  const docked = mobile || (paneW > 0 && paneW < BTW_DOCK_W);
  // useLayoutEffect(非 useEffect):收起态 rootRef 未挂载、inset 停在默认;每个 pane 首次展开时
  // 若用 useEffect(paint 后跑),首帧会用 bottomInset=12 把窗口贴 pane 底盖住输入框、随后才上移
  // 修正=闪跳。改 layout effect 在 paint 前测好位置,首帧即正确。
  useLayoutEffect(() => {
    if (mobile) return;
    const parent = rootRef.current?.offsetParent;
    if (!parent) return;
    const calc = () => {
      const pw = parent.clientWidth || 0;
      if (!pw) return;
      setPaneW(pw);
      // 越界夹紧:分屏布局/窗格尺寸变化后,把拖拽过的浮动窗夹回窗格可见区(症状:开分屏后
      // 旁问窗停在旧绝对坐标被格边界裁掉)。按固定宽/封顶高常量算,不读 el 实测(吸附态
      // el 宽=格宽-16,用实测会污染保留着的浮动坐标)。
      const ph = parent.clientHeight || 0;
      const bh = Math.min(460, ph * 0.6);
      setPos((p) => {
        if (!p) return p;
        const left = Math.max(0, Math.min(pw - BTW_W, p.left));
        const top = Math.max(0, Math.min(ph - bh, p.top));
        return (left === p.left && top === p.top) ? p : { left, top };
      });
      // --content-max 是 clamp(...) 表达式,parseFloat 取不到 px;用 probe(挂到 pane 内、同为
      // 布局 px、与 pw 同单位不受 app 缩放影响)读 clientWidth 解析出真实 content-max。
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;height:0;width:var(--content-max)';
      parent.appendChild(probe);
      const cmax = probe.clientWidth || pw;
      probe.remove();
      setRightInset(Math.max(26, (pw - Math.min(cmax, pw - 32)) / 2));
      // 输入框顶相对 pane 底的布局 px 距离:累加 offsetTop 到 pane(与 clientHeight 同为 CSS px、
      // 不受 zoom 影响,不用 rect)。找不到输入框(无会话)回落 12。浮窗底 = 该距离 + 12 间距。
      const composer = parent.querySelector('.chat-composer');
      if (composer) {
        let ot = 0, node = composer;
        while (node && node !== parent) { ot += node.offsetTop; node = node.offsetParent; }
        setBottomInset(Math.max(12, parent.clientHeight - ot + 12)); // 展开窗:输入框上方
      } else setBottomInset(12);
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(parent);
    // 输入框多行变高时 pane 尺寸不变、只观测 parent 的 RO 不触发 → bottomInset 过期、间距被
    // 吃掉甚至压框(#5 边角回退)。一并观测输入框外壳(.chat-input-shell 稳定、高度随行数变)。
    const shell = parent.querySelector('.chat-input-shell');
    if (shell) ro.observe(shell);
    return () => ro.disconnect();
  }, [expanded, mobile]);

  // 新内容滚到底 —— 但仅当用户已贴底才自动跟随(抄主聊天区门控)。thread 每次渲染新引用会
  // 让此 effect 每重渲都跑,原无条件 scrollTop=scrollHeight 会把上滚看历史的用户拽回底(#4)。
  const onBodyScroll = () => {
    const el = bodyRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  useEffect(() => {
    if (expanded && atBottomRef.current && bodyRef.current)
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [thread, expanded]);

  const submit = () => {
    const q = input.trim();
    if (!q) return;
    setInput('');
    setCollapsed(false);
    onSend(q);
  };

  // 拖动:pointer 事件 + setPointerCapture(webview 惯例)。限制在 pane 内(clamp)。
  const startDrag = (e) => {
    if (docked) return;
    const el = rootRef.current;
    const parent = el?.offsetParent;
    if (!el || !parent) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      sx: e.clientX, sy: e.clientY, left: el.offsetLeft, top: el.offsetTop,
      pw: parent.clientWidth, ph: parent.clientHeight, w: el.offsetWidth, h: el.offsetHeight,
    };
  };
  const onDrag = (e) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({
      left: Math.max(0, Math.min(d.pw - d.w, d.left + e.clientX - d.sx)),
      top: Math.max(0, Math.min(d.ph - d.h, d.top + e.clientY - d.sy)),
    });
  };
  const endDrag = (e) => { dragRef.current = null; e.currentTarget.releasePointerCapture?.(e.pointerId); };

  // 收起态:不渲染任何浮层 —— 入口(「旁问」按钮 + 未读角标)已移到输入框工具行(方案A),宿主
  // 经 onUnreadChange 拿未读数、点击时用 openSignal 展开。组件仍挂载,hooks 继续算 unread 并上报。
  if (!expanded) return null;

  // 展开态:桌面浮窗(可拖) / 手机底部抽屉。z-46:高于子代理面板(z-40),低于全局授权 modal(z-50+)。
  // #7 固定高度、内部滚动:原 maxHeight 让窗口随问答变多而长高(用户困惑"越来越大")。改
  // 固定 height(占面板 60%、封顶 460px),内容超出在窗内滚动,高度稳定不跳。
  // docked(手机 或 窄分屏格 < BTW_DOCK_W):底部抽屉形态,放弃自由浮动;pos 保留,格子拖宽恢复。
  const posStyle = docked
    ? { position: 'absolute', left: 8, right: 8, bottom: 8, height: '68%', zIndex: 46 }
    : pos
    ? { position: 'absolute', left: pos.left, top: pos.top, width: BTW_W, height: 'min(60%, 460px)', zIndex: 46 }
    : { position: 'absolute', right: rightInset, bottom: bottomInset, width: BTW_W, height: 'min(60%, 460px)', zIndex: 46 };

  return (
    <div ref={rootRef} style={posStyle}
      className="flex flex-col rounded-[1.625rem] border border-canvas-deep bg-canvas shadow-xl overflow-hidden animate-fade-up">
      {/* 头部(拖动手柄) */}
      <div
        onPointerDown={startDrag} onPointerMove={onDrag} onPointerUp={endDrag}
        className={`shrink-0 flex items-center gap-2 px-3 py-2 border-b border-canvas-deep bg-canvas-warm/60 select-none ${docked ? '' : 'cursor-move'}`}
      >
        <MessageSquare size={13} className="text-accent shrink-0" />
        <span className="text-[12px] font-body text-ink flex-1">旁问</span>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={async () => {
            if (thread.length === 0) return;
            // 文案必须与实情一致:清空只删本浮窗这几条问答记录(前端数组),旁问永远
            // --resume 主会话取上下文,主会话那部分清不掉也不该清 —— 与 CLI 原生 /btw
            // 一致(共享上下文、独立回答)。旧文案称清空后不再带此前上下文,与实情不符。
            if (!(await confirmDialog('清空本浮窗的旁问记录？\n清空后下一次旁问不再携带这些问答；主会话的上下文仍会带上（与 CLI 原生 /btw 一致）。', { danger: true }))) return;
            onClearThread();
          }}
          title="清空旁问线程" className="shrink-0 text-ink-faint hover:text-red-500">
          <Trash2 size={13} />
        </button>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={() => setCollapsed(true)}
          title="收起" className="shrink-0 text-ink-faint hover:text-ink">
          <Minus size={14} />
        </button>
      </div>

      {/* 线程正文 */}
      <div ref={bodyRef} onScroll={onBodyScroll} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3">
        {thread.length === 0 ? (
          <div className="text-[12px] text-ink-faint font-body py-4 text-center">
            旁问一个问题——不打断当前工作、不写入会话历史。
          </div>
        ) : thread.map((m) => (
          <div key={m.uuid} className="space-y-1">
            <div className="text-[12px] font-body text-ink bg-canvas-warm/60 rounded-lg px-2.5 py-1.5">{m.question}</div>
            <div className="text-[13px] font-body pl-1">
              {m.pending
                ? <span className="text-ink-faint animate-pulse inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" />思考中…</span>
                : m.error
                ? <span className="text-red-600/90">{m.text}</span>
                : <MarkdownRenderer content={m.text} />}
            </div>
          </div>
        ))}
      </div>

      {/* 输入框 */}
      <div className="shrink-0 flex items-end gap-2 px-3 py-2 border-t border-canvas-deep">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          rows={1}
          placeholder="继续旁问…（Enter 发送）"
          className="flex-1 resize-none max-h-24 text-[13px] font-body bg-transparent outline-none placeholder:text-ink-faint"
        />
        <button onClick={submit} disabled={!input.trim()} title="发送 (Enter)"
          className="shrink-0 text-accent disabled:text-ink-faint hover:opacity-80 pb-0.5">
          <Send size={15} />
        </button>
      </div>
      <div className="shrink-0 px-3 pb-1.5 text-[10px] text-ink-faint font-body">
        旁问不写入会话历史，刷新后消失{pending ? ' · 回答中…' : ''}
      </div>
    </div>
  );
}
