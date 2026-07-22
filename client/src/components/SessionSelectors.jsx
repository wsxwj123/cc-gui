// P2.0 组件抽离:ModelSelector / ProviderSwitcher / RemoteControlButton 从 App.jsx
// 迁出为独立文件 —— ChatInput(composer 工具行)与 App 都要用它们,而 App import
// ChatInput,留在 App.jsx 会形成循环 import。逻辑原样搬运,不改行为。
import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, X, Settings, Server, Loader2, Smartphone, Pencil } from 'lucide-react';
import { useStore } from '../stores/sessionStore.js';
import { ModelBadge } from './ModelBadge.jsx';
import { confirmDialog } from '../utils/confirmDialog.jsx';
import { mergeProviderLists, rowIsCurrent, SOURCE_BADGE } from '../utils/providerList.js';

const EMPTY_ARRAY = Object.freeze([]);

// 修正批#6:来源徽章(切换卡片/管理页/手机页共用)。官方不打徽章(它是基准项,
// 恒置顶);合并了同名 cc-switch 导入项的自定义条目加提示。
export function ProviderSourceBadge({ p }) {
  if (p.source === 'official') return null;
  const merged = (p.dupOf || []).some((d) => d.source === 'ccswitch' || d.source === 'openai');
  return (
    <span
      className="text-[9px] px-1 py-px bg-canvas-warm border border-canvas-deep text-ink-faint rounded font-body shrink-0"
      title={merged ? '同名的 cc-switch 导入项已合并进此条(以可编辑的自定义项为准)' : undefined}>
      {SOURCE_BADGE[p.source] || p.source}{merged ? '·含导入' : ''}
    </span>
  );
}

// 修正批#3:统一弹层壳。portal 到 body + fixed 定位 → 不受任何祖先 stacking
// context / transform 影响(已知陷阱:animate-glass-rise fill:both 残留 transform、
// glass 系列 isolation),恒在顶层(zIndex 9999,与 CtxBadge 明细弹层同层),弹层
// 背景为 .glass-popover 的全不透明 canvas 色 → 不透底。定位:锚点矩形量出后按
// drop/align 摆放,放不下先翻转到另一侧,仍不够则夹紧回视口(pad 8px);内容异步
// 变高(如 Provider 列表加载)由 ResizeObserver 触发重量。所有坐标按 --ui-zoom
// 折算(rect 是视觉px,fixed left/top 是布局px —— CtxBadge 同款修法)。
// outside-click/Esc 关闭由本组件统一处理(portal 后内容不在锚点 wrap 内,调用方
// 自己的 contains 判定会误关,调用方不要再挂自己的 document 监听)。
export function AnchoredPopover({ anchorRef, open, onRequestClose, drop = 'down', align = 'left', className = '', children }) {
  const elRef = useRef(null);
  const [pos, setPos] = useState(null);
  const [bump, setBump] = useState(0);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const a = anchorRef?.current, el = elRef.current;
    if (!a || !el) return;
    const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
    const pad = 8 * z, gap = 8 * z;
    const r = a.getBoundingClientRect();
    const m = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = align === 'right' ? r.right - m.width : r.left;
    let top = drop === 'up' ? r.top - gap - m.height : r.bottom + gap;
    // 越界翻转:首选方向放不下且另一侧放得下 → 翻。
    if (drop === 'up' && top < pad && r.bottom + gap + m.height <= vh - pad) top = r.bottom + gap;
    if (drop === 'down' && top + m.height > vh - pad && r.top - gap - m.height >= pad) top = r.top - gap - m.height;
    // 夹紧兜底(翻转后仍可能越界,如超高弹层)。
    left = Math.min(Math.max(left, pad), Math.max(pad, vw - pad - m.width));
    top = Math.min(Math.max(top, pad), Math.max(pad, vh - pad - m.height));
    setPos({ left: left / z, top: top / z });
  }, [open, drop, align, bump]);

  // 内容尺寸变化(异步列表加载)→ 重新定位。
  useLayoutEffect(() => {
    if (!open || !elRef.current) return;
    const ro = new ResizeObserver(() => setBump((n) => n + 1));
    ro.observe(elRef.current);
    return () => ro.disconnect();
  }, [open]);

  // 审计批挂账:窗口 resize(含旋屏/软键盘改变视口)→ 锚点矩形已变,重量重摆;
  // 原来只在打开瞬间定位,resize 后弹层悬在旧坐标上错位/悬空。
  useEffect(() => {
    if (!open) return;
    const onResize = () => setBump((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (elRef.current?.contains(e.target)) return;
      if (anchorRef?.current?.contains(e.target)) return;
      onRequestClose?.();
    };
    const onEsc = (e) => { if (e.key === 'Escape') onRequestClose?.(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div ref={elRef}
      style={{ position: 'fixed', left: pos ? pos.left : 0, top: pos ? pos.top : 0, zIndex: 9999, visibility: pos ? 'visible' : 'hidden' }}
      className={`glass-popover animate-glass-rise ${className}`}>
      {children}
    </div>,
    document.body,
  );
}

// Header button that hands the active session off to phone control. Like
// Claude Desktop, the server hosts `claude --remote-control --resume <id>` on a
// HIDDEN pseudo-terminal (node-pty) — no terminal window pops up. The Claude
// mobile app then takes over the SAME account/session via Anthropic's relay;
// the GUI keeps syncing via jsonl. While active, the composer is locked to
// avoid two processes writing the same session file. Clicking again reclaims.
// Disabled until the session exists (a sessionId is needed to --resume).
export function RemoteControlButton({ session }) {
  const [busy, setBusy] = useState(false);
  const sid = session?.sessionId || null;
  const cwd = session?.projectPath || null;
  const active = useStore((s) => (sid ? !!s.remoteControlled[sid] : false));

  const toggle = async () => {
    if (!sid || busy) return;
    setBusy(true);
    try {
      const url = active ? '/api/remote-control/stop' : '/api/remote-control';
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, cwd }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      useStore.getState().setRemoteControl(sid, !active);
    } catch (e) {
      confirmDialog((active ? '收回远程控制失败：' : '开启远程控制失败：') + e.message);
    }
    setBusy(false);
  };

  return (
    <button
      onClick={toggle}
      disabled={!sid || busy}
      title={sid
        ? (active
          ? '已在手机上远程控制此会话 · 点击收回控制'
          : '在手机上同账号控制此会话（用 Claude App 接管，需 Claude 账号、非 deepseek/mimo）')
        : '先发送一条消息创建会话，再开启远程控制'}
      className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors text-[11px] font-body ${
        active ? 'bg-success/15 text-success' : 'hover:bg-canvas-deep text-ink-muted'
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Smartphone size={13} />}
      {active ? '已激活' : '远程'}
    </button>
  );
}

// 修正批#6:Provider 切换列表 —— 单一列表(mergeProviderLists,与管理页同一数据
// 选择器):官方置顶、其余按名称序,来源用小徽章标注,不再按来源分组。
// 点行即切,当前项打勾;增删改/测试/隐藏/导入在 设置→Provider(底部直达链)。
export function ProviderSwitchList({ onSwitched }) {
  const [providers, setProviders] = useState([]);
  const [openaiProviders, setOpenaiProviders] = useState([]);
  const [customProviders, setCustomProviders] = useState([]);
  const [hiddenProviders, setHiddenProviders] = useState(new Set());
  const [switching, setSwitching] = useState(false);
  // Optimistic current id(cc-switch db 的 is_current 我们不写,切换后本地标记)。
  const [activeId, setActiveId] = useState(null);

  const load = () => {
    fetch('/api/providers').then((r) => r.json()).then((d) => {
      setProviders(Array.isArray(d.providers) ? d.providers : []);
      setOpenaiProviders(Array.isArray(d.openaiProviders) ? d.openaiProviders : []);
      setCustomProviders(Array.isArray(d.customProviders) ? d.customProviders : []);
    }).catch(() => {});
    fetch('/api/prefs/hidden-providers').then((r) => r.json())
      .then((d) => setHiddenProviders(new Set(Array.isArray(d.hidden) ? d.hidden : [])))
      .catch(() => {});
  };
  // 挂载即拉(本组件仅在 provider 段展开时挂载,展开即最新);外部改配置也跟着刷新。
  useEffect(() => {
    load();
    const onCh = () => load();
    window.addEventListener('cgui:provider-change', onCh);
    return () => window.removeEventListener('cgui:provider-change', onCh);
  }, []);

  // 审计批挂账:isCur 兼配 dupOf 里的 id(激活的是被合并的导入项时保留行照常高亮)。
  const isCur = (p) => rowIsCurrent(p, activeId);

  const switchTo = async (id, model) => {
    setSwitching(true);
    try {
      const r = await fetch('/api/provider/switch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model ? { id, model } : { id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '切换失败');
      setActiveId(id);
      useStore.getState().clearModelOverrides?.();
      useStore.getState().fetchProvider?.();
      useStore.getState().fetchModel?.();
      window.dispatchEvent(new CustomEvent('cgui:provider-change'));
      onSwitched?.();
    } catch (e) {
      confirmDialog('切换 provider 失败：' + e.message);
    }
    setSwitching(false);
  };

  // 修正批#7:「管理 Provider」不再跳设置(Provider tab 已删),改开独立管理弹窗
  // (App.jsx ProviderManagerModal 监听此事件)。
  const openManager = () => {
    onSwitched?.();
    window.dispatchEvent(new CustomEvent('cgui:open-provider-manager'));
  };
  // 行内编辑:直达管理弹窗并定位到该 provider(自定义项直接进编辑态;导入项的
  // 档位映射/模型管理本就在弹窗内联展开)。官方项无可编辑内容,不给按钮。
  // 手机端不派发此事件(管理走全屏页),按钮仅桌面显示。
  const openEdit = (p) => {
    onSwitched?.();
    window.dispatchEvent(new CustomEvent('cgui:open-provider-manager', { detail: { editId: p.id } }));
  };

  // 审计批挂账:hidden 传入选择器,在合并前过滤 —— 隐藏的导入项不参与吞并/不进「含导入」徽章。
  const rows = mergeProviderLists({ providers, openaiProviders, customProviders, hidden: hiddenProviders });

  return (
    <div>
      <p className="px-3 pt-1 text-[10px] text-ink-faint font-body leading-snug">
        切换会改写 <code className="font-mono">~/.claude/settings.json</code>（自动备份），<b>对新发的消息生效</b>。
      </p>
      {rows.map((p) => (
        <div key={p.id} className={`flex items-center group/prov ${isCur(p) ? 'bg-accent-subtle' : ''}`}>
          <button disabled={switching} onClick={() => switchTo(p.id)}
            className={`flex-1 min-w-0 text-left px-3 py-1.5 flex items-center gap-2 hover:bg-canvas-warm transition-colors ${switching ? 'opacity-50' : ''}`}>
            <span className={`flex-1 text-xs font-body truncate ${isCur(p) ? 'text-accent font-medium' : 'text-ink'}`}>{p.name}</span>
            {p.models?.length > 0 && <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{p.models.length} 模型</span>}
            {p.type && p.source === 'custom' && <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{p.type}</span>}
            <ProviderSourceBadge p={p} />
            {isCur(p) && <Check size={12} className="text-accent shrink-0" />}
          </button>
          {p.source !== 'official' && (
            <button onClick={() => openEdit(p)} title="编辑该 Provider"
              className="p-1 mr-1.5 text-ink-faint hover:text-accent shrink-0 opacity-0 group-hover/prov:opacity-100 group-focus-within/prov:opacity-100 transition-opacity max-md:hidden">
              <Pencil size={12} />
            </button>
          )}
        </div>
      ))}
      <button onClick={openManager}
        className="w-full text-left px-3 py-2 mt-1 text-[11px] text-accent hover:bg-canvas-warm border-t border-canvas-deep font-body flex items-center gap-1.5">
        <Settings size={12} /> 管理 Provider（增删改 · 测试 · 隐藏 · 导入）→
      </button>
    </div>
  );
}

// 修正批#1b:Provider 独立按钮(顶栏,与模型分开)。弹层复用 ProviderSwitchList
// (切换真调 /api/provider/switch);`cgui:open-provider` 事件(错误回合"检查
// Provider 设置"按钮)指向本弹层 —— 顶栏单实例,respondOpenProvider 恒开。
// provider 显示名由 ModelSelector 的 /api/model 加载写进 store(providerName),
// 这里只读,不重复请求。弹层走 AnchoredPopover(portal 顶层+夹紧)。
export function ProviderSwitcher({ hideLabel = false, tourAnchor = false, respondOpenProvider = false, drop = 'down' }) {
  const providerHint = useStore((s) => s.currentProvider?.providerHint || 'anthropic');
  const provider = useStore((s) => s.providerName || '');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const label = provider || (providerHint === 'anthropic' ? 'Anthropic' : providerHint);

  useEffect(() => {
    if (!respondOpenProvider) return;
    const onOpenProvider = () => setOpen(true);
    window.addEventListener('cgui:open-provider', onOpenProvider);
    return () => window.removeEventListener('cgui:open-provider', onOpenProvider);
  }, [respondOpenProvider]);

  return (
    <div ref={wrapRef} className="relative" data-tour={tourAnchor ? 'provider-selector' : undefined}>
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-canvas-deep transition-colors"
        title={`Provider: ${label} — 点击切换;增删改/测试在弹层底部「管理 Provider」`}>
        <Server size={12} className="text-ink-muted shrink-0" />
        {!hideLabel && <span className="text-[11px] font-body text-ink-muted whitespace-nowrap max-w-[96px] truncate">{label}</span>}
        <ChevronDown size={10} className="text-ink-faint" />
      </button>
      <AnchoredPopover anchorRef={wrapRef} open={open} onRequestClose={() => setOpen(false)} drop={drop}
        className="w-72 max-w-[calc(var(--app-w,100vw)-1.5rem)] py-1 max-h-[min(60vh,calc(var(--app-h,100dvh)-6rem))] overflow-y-auto">
        <div className="px-3 py-1.5 text-[10px] text-ink-faint uppercase tracking-wider font-body border-b border-canvas-deep">
          Provider · 当前 <b className="normal-case">{label}</b>
        </div>
        <ProviderSwitchList onSwitched={() => setOpen(false)} />
      </AnchoredPopover>
    </div>
  );
}

// 修正批#1b:模型 chip(顶栏,作用于活跃窗格的会话;Provider 为独立按钮,本弹层只管模型)。
export function ModelSelector({ compact = false, permKey = null, tourAnchor = false, drop = 'down' }) {
  const { availableModels } = useStore();
  const customModels = useStore((s) => s.customModels);
  const providerHint = useStore((s) => s.currentProvider?.providerHint || 'anthropic');
  // Per-session model: show/select THIS session's model (falls back to the
  // global resolved default when the session has no explicit pick). Picking
  // writes only the session override — never the global settings.json default.
  const currentModel = useStore((s) => (permKey && s.modelBySession[permKey]) || s.currentModel);
  const setModel = (id) => useStore.getState().setModelFor(permKey, id);
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [provider, setProvider] = useState('');
  const [fetchNote, setFetchNote] = useState('');
  const [fetching, setFetching] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
  // Live catalogue lives in the store (keyed by provider) so it auto-loads AND
  // survives closing/reopening the picker — instead of vanishing with this
  // component's local state every time it unmounts.
  const fetched = useStore((s) => s.fetchedByProvider[provider]) || EMPTY_ARRAY;
  const doFetch = async () => {
    setFetching(true); setFetchNote('');
    try {
      const r = await fetch('/api/provider/fetch-models', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '拉取失败');
      const models = Array.isArray(d.models) ? d.models : [];
      useStore.getState().setFetchedModels(provider, models);
      setFetchNote(d.note || (models.length ? `已拉取 ${models.length} 个` : '未返回模型'));
    } catch (e) { setFetchNote('拉取失败：' + e.message); }
    setFetching(false);
  };

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/model').then(r => r.json()).then(data => {
        if (cancelled) return;
        const prov = data.provider || '';
        setProvider(prov);
        // Provider 独立按钮(ProviderSwitcher)只读 store,不重复请求 /api/model。
        useStore.setState({ providerName: prov });
        // Seed the GLOBAL default only (never a per-session override) — this is
        // the resolved settings.json default, used as fallback for sessions
        // without an explicit pick.
        if (data.model) useStore.setState({ currentModel: data.model });
        if (Array.isArray(data.available)) useStore.setState({ availableModels: data.available });
        // effort 显示:用户没在 GUI 显式选过(localStorage 空)时,用 settings.json 的默认
        // 思考强度(CLAUDE_CODE_EFFORT_LEVEL)显示,免得"settings 设了 high 却显示默认"
        // (实际对话已是 high:GUI 不传 --effort → CLI 读 settings;这里只让显示一致)。
        try {
          if (!localStorage.getItem('cgui-effort') && data.defaultEffort) useStore.setState({ effort: data.defaultEffort });
          // 供 EffortSelector"默认"档显示真实落点(跟随全局 or 模型自适应),文案不再撒谎。
          useStore.setState({ defaultEffort: data.defaultEffort || '' });
        } catch {}
        // Auto-load the live catalogue once per provider so the latest models
        // (e.g. Opus 4.8) show up without a manual "拉取最新" click — and persist
        // in the store so they don't disappear when the picker is reopened.
        if (prov && !useStore.getState().fetchedByProvider[prov]) {
          fetch('/api/provider/fetch-models', { method: 'POST' })
            .then((r) => r.json())
            .then((d) => { if (!cancelled) useStore.getState().setFetchedModels(prov, Array.isArray(d.models) ? d.models : []); })
            .catch(() => {});
        }
      }).catch(() => {});
    };
    load();
    const onProviderChange = () => load();
    window.addEventListener('cgui:provider-change', onProviderChange);
    return () => {
      cancelled = true;
      window.removeEventListener('cgui:provider-change', onProviderChange);
    };
  }, []);

  const handleCustomSubmit = () => {
    const id = customInput.trim();
    if (id) { useStore.getState().addCustomModel(id); selectModel(id); setCustomInput(''); }
  };
  // Merge user-added ids that the server didn't already enumerate, so they show
  // as selectable rows (with a remove affordance).
  const q = query.trim().toLowerCase();
  const match = (id, name) => !q || id.toLowerCase().includes(q) || (name || '').toLowerCase().includes(q);
  const customRows = customModels
    .filter((id) => !availableModels.some((m) => m.id === id))
    .map((id) => ({ id, name: id.replace(/\[1m\]/i, ''), tier: '自定义', source: 'custom', context1m: /\[1m\]/i.test(id) }));
  const fetchedRows = fetched
    .filter((id) => !availableModels.some((m) => m.id === id) && !customModels.includes(id))
    .filter((id) => match(id, id))
    .map((id) => ({ id, name: id }));

  // 1M-context toggle: Claude Code enables the 1M beta via a `[1m]` suffix on
  // the model id (same thing the CLI's /model picker writes). Toggling just
  // adds/removes the suffix on whatever model is current.
  // `[1m]` 是 Claude Code 启用 1M 上下文的通用后缀约定。Anthropic(Opus 4.8/4.7/4.6、
  // Sonnet 4.6)和 MiMo(mimo-v2.5-pro[1m],见官方文档)等兼容 provider 都用它启用 1M。
  // 因此对所有模型开放——provider 若不支持会自行报错,由用户决定关掉。
  // 重装丢 pin 后 currentModel 回落全局(不带 [1m]),但服务端持久化的 context1mBySession
  // 仍记着该会话开了 1M → 叠加进 has1m,否则下拉开关显示"关"、与徽章/发送(都读 context1m
  // 兜底)反向,用户想关反而点成开。permKey 为 draft 时命中不到=不影响(draft 的 1m 在 pin 里)。
  const ctx1m = useStore((s) => !!(permKey && s.context1mBySession[permKey]));
  const has1m = ctx1m || /\[1m\]/i.test(currentModel || '');
  const toggle1m = () => {
    const base = (currentModel || '').replace(/\[1m\]/i, '');
    if (!base) return;
    setModel(has1m ? base : `${base}[1m]`);
  };
  // 切换模型时保留当前 1M 标记,避免换模型静默丢掉 1M 选择。
  const selectModel = (id) => {
    const base = id.replace(/\[1m\]/i, '');
    setModel(has1m ? `${base}[1m]` : base);
    setOpen(false);
  };

  if (!currentModel) return null;

  return (
    <div ref={wrapRef} className="relative" data-tour={tourAnchor ? 'model-selector' : undefined}>
      <button onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 px-2 py-1 rounded-md hover:bg-canvas-deep transition-colors ${compact ? '' : 'px-2.5'}`}
        title={`模型: ${currentModel}${providerHint !== 'anthropic' ? `（provider: ${provider || providerHint}）` : ''}`}>
        <ModelBadge model={currentModel} compact={compact} />
        {/* The vendor tag is redundant with the Claude model badge when on the
            official Anthropic endpoint — only show it for relays (DeepSeek/MiMo/
            OpenRouter) where it warns that aliases may be redirected. */}
        {provider && provider !== 'Anthropic' && !compact && (
          <span className="text-[9px] px-1 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono">{provider}</span>
        )}
        <ChevronDown size={10} className="text-ink-faint" />
      </button>
      {/* 审计批挂账:sticky 头改壳层 flex 列三段 —— AnchoredPopover 带 animate-glass-rise
          (fill:both 收尾残留 transform),WKWebView/WebView2 里 transform 滚动容器内的
          sticky top-0 失效(长列表滚动时搜索/自定义输入随内容滚走)。头 shrink-0 固定,
          列表段独立滚动。 */}
      <AnchoredPopover anchorRef={wrapRef} open={open} onRequestClose={() => setOpen(false)} drop={drop}
        className="w-80 max-w-[calc(var(--app-w,100vw)-1.5rem)] py-1 max-h-[min(60vh,calc(var(--app-h,100dvh)-6rem))] flex flex-col overflow-hidden">
          <div className="px-3 py-2 shrink-0 bg-canvas border-b border-canvas-deep">
            <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body flex items-center justify-between">
              <span>选择模型</span>
              {provider && provider !== 'Anthropic' && <span className="text-ink-ghost normal-case">{provider}</span>}
            </div>
            <p className="text-[10px] text-ink-faint font-body mt-1 leading-snug">
              <b>alias</b> = CLI 接收 <code className="font-mono">sonnet/opus/haiku</code> 简称，由 CLI 解析到当前 tier 最新模型。
              {provider && provider !== 'Anthropic' && (
                <span className="block text-warning mt-0.5">
                  ⚠ 当前 provider 是 <b>{provider}</b>，alias 可能被该 provider 重定向到其默认模型。建议用具体模型 ID。
                </span>
              )}
            </p>
            <div className="flex gap-1.5 mt-2">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模型…"
                className="flex-1 bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-xs text-ink focus:outline-none focus:border-accent/40" />
              <button onClick={doFetch} disabled={fetching}
                className="px-2 py-1 text-[10px] border border-accent text-accent rounded disabled:opacity-50 shrink-0">
                {fetching ? '拉取中…' : '拉取最新'}
              </button>
            </div>
            {/* 修正批#5:自定义模型 ID 输入框移到卡片顶部(sticky 头内),列表再长也不用滚着找。 */}
            <div className="flex gap-1.5 mt-1.5">
              <input type="text" value={customInput} onChange={e => setCustomInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCustomSubmit()}
                placeholder="自定义模型 ID..."
                className="flex-1 bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-xs font-mono text-ink focus:outline-none focus:border-accent/40" />
              <button onClick={handleCustomSubmit} disabled={!customInput.trim()}
                className="px-2 py-1 text-[10px] bg-accent text-on-accent rounded hover:bg-accent-hover disabled:bg-canvas-deep disabled:text-ink-ghost transition-colors shrink-0">
                应用
              </button>
            </div>
            {fetchNote && <div className="text-[10px] text-ink-faint font-body mt-1">{fetchNote}</div>}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
          {/* 1M context toggle — appends [1m] to the active model id.
              Claude Code 通用约定:Anthropic / MiMo 等兼容 provider 都用 [1m] 启用 1M。 */}
          <button onClick={toggle1m}
            className="w-full text-left px-3 py-2 hover:bg-canvas-warm transition-colors flex items-center gap-2 border-b border-canvas-deep">
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-ink font-body">1M 上下文</div>
              <div className="text-[10px] text-ink-faint font-body leading-snug">
                给当前模型追加 <code className="font-mono">[1m]</code> 后缀（1M tokens 上下文，需 provider 支持）
              </div>
            </div>
            <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono shrink-0 ${
              has1m ? 'bg-accent text-on-accent' : 'bg-canvas-deep text-ink-faint'}`}>
              {has1m ? '已开启' : '关闭'}
            </span>
          </button>
          {availableModels.filter((m) => match(m.id, m.name)).map((m) => {
            const isAlias = m.source === 'cli-alias';
            return (
              <button key={m.id} onClick={() => selectModel(m.id)}
                className={`w-full text-left px-3 py-2 hover:bg-canvas-warm transition-colors flex items-center gap-2 ${
                  (currentModel === m.id || currentModel === `${m.id}[1m]`) ? 'bg-accent-subtle/50' : ''}`}>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-ink font-body flex items-center gap-1.5">
                    {m.name}
                    {isAlias && (
                      <span className="text-[8.5px] px-1 py-px bg-warning/15 text-warning rounded font-mono"
                        title="CLI 解析的简称，实际模型由 CLI 决定">
                        alias
                      </span>
                    )}
                    {m.context1m && (
                      <span className="text-[8.5px] px-1 py-px bg-accent text-on-accent rounded font-mono"
                        title="1M tokens 上下文">
                        1M
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-ink-faint font-mono truncate">
                    {isAlias ? '由 CLI 解析到当前 tier 最新' : m.id}
                  </div>
                </div>
                <span className="text-[9px] px-1.5 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{m.tier}</span>
                {(currentModel === m.id || currentModel === `${m.id}[1m]`) && <Check size={12} className="text-accent shrink-0" />}
              </button>
            );
          })}
          {customRows.filter((m) => match(m.id, m.name)).map((m) => (
            <div key={m.id}
              className={`w-full px-3 py-2 hover:bg-canvas-warm transition-colors flex items-center gap-2 ${
                (currentModel === m.id || currentModel === `${m.id}[1m]`) ? 'bg-accent-subtle/50' : ''}`}>
              <button onClick={() => selectModel(m.id)} className="flex-1 min-w-0 text-left">
                <div className="text-xs font-medium text-ink font-body flex items-center gap-1.5">
                  {m.name}
                  <span className="text-[8.5px] px-1 py-px bg-accent-subtle text-accent rounded font-mono">自定义</span>
                  {m.context1m && <span className="text-[8.5px] px-1 py-px bg-accent text-on-accent rounded font-mono">1M</span>}
                </div>
                <div className="text-[10px] text-ink-faint font-mono truncate">{m.id}</div>
              </button>
              {(currentModel === m.id || currentModel === `${m.id}[1m]`) && <Check size={12} className="text-accent shrink-0" />}
              <button onClick={() => useStore.getState().removeCustomModel(m.id)} title="移除自定义模型"
                className="p-1 text-ink-faint hover:text-error shrink-0"><X size={12} /></button>
            </div>
          ))}
          {fetchedRows.map((m) => (
            <button key={`f-${m.id}`} onClick={() => selectModel(m.id)}
              className={`w-full text-left px-3 py-2 hover:bg-canvas-warm transition-colors flex items-center gap-2 ${
                (currentModel === m.id || currentModel === `${m.id}[1m]`) ? 'bg-accent-subtle/50' : ''}`}>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-ink font-body truncate">{m.name}</div>
                <div className="text-[10px] text-ink-faint font-mono truncate">实时拉取</div>
              </div>
              {(currentModel === m.id || currentModel === `${m.id}[1m]`) && <Check size={12} className="text-accent shrink-0" />}
            </button>
          ))}
          {/* 修正批#5:原底部「自定义模型 ID」块已上移到固定头(用户在长列表下找不到)。 */}
          </div>
      </AnchoredPopover>
    </div>
  );
}
