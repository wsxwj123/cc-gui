// P2.0 组件抽离:ModelSelector / ProviderSwitcher / RemoteControlButton 从 App.jsx
// 迁出为独立文件 —— ChatInput(composer 工具行)与 App 都要用它们,而 App import
// ChatInput,留在 App.jsx 会形成循环 import。逻辑原样搬运,不改行为。
import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check, X, Settings, Server, Loader2, Smartphone } from 'lucide-react';
import { useStore } from '../stores/sessionStore.js';
import { ModelBadge } from './ModelBadge.jsx';
import { confirmDialog } from '../utils/confirmDialog.jsx';

const EMPTY_ARRAY = Object.freeze([]);

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
        active ? 'bg-green-50 text-green-700' : 'hover:bg-canvas-deep text-ink-muted'
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Smartphone size={13} />}
      {active ? '已激活' : '远程'}
    </button>
  );
}

// P2.1:Provider 切换列表(内嵌版)。原顶栏 ProviderSwitcher 弹层瘦身而来,现作为
// ModelSelector 弹层顶部的 provider 段渲染 —— "切 provider"与"选模型"同一决策链。
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

  const isCur = (p) => (activeId != null ? p.id === activeId : p.isCurrent);

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

  const openManager = () => {
    onSwitched?.();
    window.dispatchEvent(new CustomEvent('cgui:open-settings', { detail: { section: 'set-provider-manage' } }));
  };

  const row = (p, extra = null) => (
    <button key={p.id} disabled={switching} onClick={() => switchTo(p.id)}
      className={`w-full min-w-0 text-left px-3 py-1.5 flex items-center gap-2 hover:bg-canvas-warm transition-colors ${isCur(p) ? 'bg-accent-subtle' : ''} ${switching ? 'opacity-50' : ''}`}>
      <span className={`flex-1 text-xs font-body truncate ${isCur(p) ? 'text-accent font-medium' : 'text-ink'}`}>{p.name}</span>
      {extra}
      {isCur(p) && <Check size={12} className="text-accent shrink-0" />}
    </button>
  );
  const modelCountChip = (p) => (p.models?.length > 0
    ? <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{p.models.length} 模型</span>
    : null);

  return (
    <div>
      <p className="px-3 pt-1 text-[10px] text-ink-faint font-body leading-snug">
        切换会改写 <code className="font-mono">~/.claude/settings.json</code>（自动备份），<b>对新发的消息生效</b>。
      </p>
      {providers.filter((p) => !hiddenProviders.has(p.id)).map((p) => row(p))}
      {openaiProviders.filter((p) => !hiddenProviders.has(p.id)).length > 0 && (
        <div className="px-3 pt-2 pb-1 mt-1 border-t border-canvas-deep">
          <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body">OpenAI 格式 <span className="text-ink-ghost normal-case tracking-normal">· 经内置代理</span></div>
        </div>
      )}
      {openaiProviders.filter((p) => !hiddenProviders.has(p.id)).map((p) => row(p, modelCountChip(p)))}
      {customProviders.length > 0 && (
        <div className="px-3 pt-2 pb-1 mt-1 border-t border-canvas-deep">
          <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body">自定义</div>
        </div>
      )}
      {customProviders.map((p) => row(p, (
        <>
          {modelCountChip(p)}
          <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{p.type}</span>
        </>
      )))}
      <button onClick={openManager}
        className="w-full text-left px-3 py-2 mt-1 text-[11px] text-accent hover:bg-canvas-warm border-t border-canvas-deep font-body flex items-center gap-1.5">
        <Settings size={12} /> 管理 Provider（增删改 · 测试 · 隐藏 · 导入）→
      </button>
    </div>
  );
}

// 修正批#1:Provider 独立按钮(用户拍板:provider 与模型保持分开的按钮)。
// 弹层复用 ProviderSwitchList(切换真调 /api/provider/switch);`cgui:open-provider`
// 事件(错误回合"检查 Provider 设置"按钮)指向本弹层 —— respondOpenProvider 仅
// 活跃窗格为 true,避免分屏多实例同时弹。provider 显示名由 ModelSelector 的
// /api/model 加载写进 store(providerName),这里只读,不重复请求。
export function ProviderSwitcher({ hideLabel = false, tourAnchor = false, respondOpenProvider = false }) {
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

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative" data-tour={tourAnchor ? 'provider-selector' : undefined}>
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-canvas-deep transition-colors"
        title={`Provider: ${label} — 点击切换;增删改/测试在 通用 → Provider`}>
        <Server size={12} className="text-ink-muted shrink-0" />
        {!hideLabel && <span className="text-[11px] font-body text-ink-muted whitespace-nowrap max-w-[96px] truncate">{label}</span>}
        <ChevronDown size={10} className="text-ink-faint" />
      </button>
      {open && (
        <div className="glass-popover absolute left-0 bottom-full mb-2 w-72 max-w-[calc(var(--app-w,100vw)-1.5rem)] z-50 py-1 animate-glass-rise max-h-[min(60vh,calc(100dvh-6rem))] overflow-y-auto">
          <div className="px-3 py-1.5 text-[10px] text-ink-faint uppercase tracking-wider font-body border-b border-canvas-deep">
            Provider · 当前 <b className="normal-case">{label}</b>
          </div>
          <ProviderSwitchList onSwitched={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

// P2.1:composer 模型 chip(修正批#1:Provider 段移出为上方独立按钮,本弹层只管模型)。
export function ModelSelector({ compact = false, permKey = null, tourAnchor = false }) {
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
        if (data.available) useStore.setState({ availableModels: data.available });
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

  // Outside-click close. Document listener works regardless of transform
  // containing blocks (the fixed-inset trick would be trapped in header).
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

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
      {open && (
        <div className="glass-popover absolute left-0 bottom-full mb-2 w-80 max-w-[calc(var(--app-w,100vw)-1.5rem)] z-50 py-1 animate-glass-rise max-h-[min(60vh,calc(100dvh-6rem))] overflow-y-auto">
          <div className="px-3 py-2 sticky top-0 bg-canvas border-b border-canvas-deep">
            <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body flex items-center justify-between">
              <span>选择模型</span>
              {provider && provider !== 'Anthropic' && <span className="text-ink-ghost normal-case">{provider}</span>}
            </div>
            <p className="text-[10px] text-ink-faint font-body mt-1 leading-snug">
              <b>alias</b> = CLI 接收 <code className="font-mono">sonnet/opus/haiku</code> 简称，由 CLI 解析到当前 tier 最新模型。
              {provider && provider !== 'Anthropic' && (
                <span className="block text-amber-700 mt-0.5">
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
            {fetchNote && <div className="text-[10px] text-ink-faint font-body mt-1">{fetchNote}</div>}
          </div>
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
              has1m ? 'bg-accent text-white' : 'bg-canvas-deep text-ink-faint'}`}>
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
                      <span className="text-[8.5px] px-1 py-px bg-amber-50 text-amber-700 rounded font-mono"
                        title="CLI 解析的简称，实际模型由 CLI 决定">
                        alias
                      </span>
                    )}
                    {m.context1m && (
                      <span className="text-[8.5px] px-1 py-px bg-accent text-white rounded font-mono"
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
                  {m.context1m && <span className="text-[8.5px] px-1 py-px bg-accent text-white rounded font-mono">1M</span>}
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
          <div className="border-t border-canvas-deep mt-1 pt-1 px-3 pb-2">
            <div className="text-[10px] text-ink-faint mb-1 font-body">自定义模型 ID</div>
            <div className="flex gap-1.5">
              <input type="text" value={customInput} onChange={e => setCustomInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCustomSubmit()}
                placeholder="输入模型 ID..."
                className="flex-1 bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-xs font-mono text-ink focus:outline-none focus:border-accent/40" />
              <button onClick={handleCustomSubmit} disabled={!customInput.trim()}
                className="px-2 py-1 text-[10px] bg-accent text-white rounded hover:bg-accent-hover disabled:bg-canvas-deep disabled:text-ink-ghost transition-colors">
                应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
