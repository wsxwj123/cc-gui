import React, { useEffect, useState, useRef } from 'react';
import { Server, Package, FolderOpen, RefreshCw, Plug, Activity, Check, X, Plus, Pencil, Trash2, Zap, Download, ArrowLeft, LogIn, LogOut, Search, ChevronRight } from 'lucide-react';
import { BUILTIN_PLUGINS } from '../utils/builtinPlugins.js';
import { findBuiltinMcp } from '../utils/builtinMcpServers.js';
import { McpForm } from './McpForm.jsx';
import { confirmDialog } from '../utils/confirmDialog.jsx';

// /api/mcp/:name/ping 结果 → 展示文案(PingButton 与「添加后自动探测」共用)。
// 失败时优先展示真实子进程 stderr(后端 spawn 抓的),这才是用户要看的"为什么连不上"。
function formatPingDetail(d) {
  const head = `${d.ms}ms${d.httpStatus ? ` · HTTP ${d.httpStatus}` : ''}${d.detail ? ' · ' + d.detail : ''}`;
  return d.status === 'ok'
    ? head
    : `${head}${d.stderr ? '\n\n' + d.stderr : '\n(未捕获到子进程报错;可能是命令静默挂起或网络超时)'}`;
}

function PingButton({ name }) {
  const [state, setState] = useState(null); // null | 'busy' | 'ok' | 'err'
  const [detail, setDetail] = useState('');
  const ping = async (e) => {
    e?.stopPropagation();
    setState('busy'); setDetail('');
    try {
      const r = await fetch(`/api/mcp/${encodeURIComponent(name)}/ping`);
      const d = await r.json();
      const ok = d.status === 'ok';
      setDetail(formatPingDetail(d));
      setState(ok ? 'ok' : 'err');
      if (ok) setTimeout(() => setState(null), 3000); // 成功才自动消失;失败保留让用户看清原因
    } catch (err) {
      setState('err'); setDetail(err.message);
    }
  };
  return (
    // 浮层锚定到整张服务器卡片(卡片有 relative)而非本按钮:锚按钮时 w-64 向左展开会越过
    // 面板左边界(Windows 用户实报溢出);left-0/right-0 撑满卡片宽,永不越界。
    <span className="inline-flex">
      <button onClick={ping}
        title={state === 'err' ? '连接失败 —— 见下方原因' : '点击测试 MCP 服务器连通性 (ping)'}
        className={`p-1 rounded transition-colors ${
          state === 'ok' ? 'text-success' :
          state === 'err' ? 'text-error' :
          state === 'busy' ? 'text-ink-muted' :
          'text-ink-faint hover:text-ink-muted'
        }`}>
        {state === 'busy' ? <Activity size={11} className="animate-pulse" />
          : state === 'ok' ? <Check size={11} />
          : state === 'err' ? <X size={11} />
          : <Activity size={11} />}
      </button>
      {/* 失败原因浮层:可见、可滚、手动关闭(不自动消失)—— 修"看不见报错" */}
      {state === 'err' && detail && (
        <div className="absolute left-0 right-0 top-full mt-1 z-[60] max-h-56 overflow-auto rounded-lg border border-error/30 bg-canvas shadow-2xl p-2.5"
          onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] text-error font-body font-medium">连接失败原因</span>
            <button onClick={(e) => { e.stopPropagation(); setState(null); }} className="text-ink-faint hover:text-ink"><X size={11} /></button>
          </div>
          <pre className="text-[10px] text-ink-soft font-mono whitespace-pre-wrap break-all leading-snug">{detail}</pre>
        </div>
      )}
    </span>
  );
}

function Toggle({ enabled, onToggle, loading }) {
  return (
    <button
      onClick={onToggle}
      disabled={loading}
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 overflow-hidden ${
        enabled ? 'bg-success' : 'bg-canvas-sunken'
      } ${loading ? 'opacity-50' : ''}`}
    >
      <div
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
          enabled ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

export function MCPPanel() {
  const [servers, setServers] = useState([]);
  const [plugins, setPlugins] = useState([]);
  const [external, setExternal] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toggling, setToggling] = useState(null);
  const [pluginActioning, setPluginActioning] = useState(null); // 更新/卸载进行中的 plugin.name
  const [form, setForm] = useState(null); // null | { add:true } | srv对象 (编辑)
  const [restartHint, setRestartHint] = useState(false); // 增删改后提示生效时机
  // 添加后自动探测:null | { name, busy:true } | { name, detail }(失败详情,含子进程 stderr)
  const [probe, setProbe] = useState(null);
  const mounted = useRef(true);

  // 新添加的 server 自动 ping 一次:失败立刻把真实原因(stderr)摆出来,不用等用户手动点测试。
  const autoProbe = async (name) => {
    setProbe({ name, busy: true });
    try {
      const r = await fetch(`/api/mcp/${encodeURIComponent(name)}/ping`);
      const d = await r.json();
      if (!mounted.current) return;
      if (d.status === 'ok') setProbe(null);
      else setProbe({ name, detail: formatPingDetail(d) });
    } catch (err) {
      if (mounted.current) setProbe({ name, detail: err.message });
    }
  };

  // silent=true:不显示加载态,用于后台静默刷新(拉取后端补好的在线状态)。
  // force=true:?fresh=1 绕过后端 5min 缓存,手动「刷新」按钮用 —— 否则刚 `claude mcp add`
  // 的服务器要等缓存过期才出现(用户报「刷新看不到新加的 MCP」根因)。
  const fetchData = async (silent = false, force = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch(force ? '/api/mcp?fresh=1' : '/api/mcp');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!mounted.current) return;
      setServers(data.mcpServers || []);
      setPlugins(data.plugins || []);
      setExternal(data.external || []);
    } catch (err) {
      if (mounted.current && !silent) setError(err.message);
    }
    if (mounted.current && !silent) setLoading(false);
  };

  useEffect(() => {
    mounted.current = true;
    fetchData();
    // 冷加载首屏秒回但在线状态(连接/断开)由后端后台健康检查补;5s 后静默再拉一次
    // 把状态点更新过来,无需用户手动刷新(慢机器仍可点刷新按钮)。
    const t = setTimeout(() => { if (mounted.current) fetchData(true); }, 5000);
    return () => { mounted.current = false; clearTimeout(t); };
  }, []);

  // Toggle by name (not array index): the rendered list is sorted enabled-first,
  // so the map index no longer matches the state array index.
  const handleTogglePlugin = async (plugin) => {
    if (!plugin) return;
    const { name } = plugin;
    const newEnabled = plugin.enabled === false;
    setPlugins((prev) => prev.map((p) => p.name === name ? { ...p, enabled: newEnabled } : p));
    setToggling(name);
    const endpoint = newEnabled
      ? `/api/plugins/${encodeURIComponent(name)}/enable`
      : `/api/plugins/${encodeURIComponent(name)}/disable`;
    fetch(endpoint, { method: 'PUT' })
      .then((r) => { if (!r.ok) return r.json().then((e) => { throw new Error(e.error); }); })
      .catch((err) => {
        console.error('Plugin toggle failed:', err);
        setPlugins((prev) => prev.map((p) => p.name === name ? { ...p, enabled: !newEnabled } : p));
      })
      .finally(() => setToggling(null));
  };

  const handleToggle = async (srv) => {
    if (!srv) return;
    const { name } = srv;

    // Optimistic update — instant UI feedback
    const newEnabled = srv.enabled === false;
    setServers(prev => prev.map((s) => s.name === name ? { ...s, enabled: newEnabled } : s));
    setToggling(name);

    // Fire CLI in background — don't block UI
    const endpoint = newEnabled
      ? `/api/mcp/${encodeURIComponent(name)}/enable`
      : `/api/mcp/${encodeURIComponent(name)}/disable`;

    fetch(endpoint, { method: 'PUT' })
      .then(res => {
        if (!res.ok) return res.json().then(e => { throw new Error(e.error); });
      })
      .catch(err => {
        // Revert on failure
        console.error('Toggle failed:', err);
        setServers(prev => prev.map((s) => s.name === name ? { ...s, enabled: !newEnabled } : s));
      })
      .finally(() => setToggling(null));
  };

  // OAuth 登录:执行 claude mcp login,会打开系统浏览器完成授权;进行中按钮转 spinner,
  // 完成后 ?fresh=1 重拉列表刷新状态(needs-auth → connected)。
  const [loggingIn, setLoggingIn] = useState(null);
  const handleLogin = async (srv) => {
    setLoggingIn(srv.name);
    try {
      const r = await fetch(`/api/mcp/${encodeURIComponent(srv.name)}/login`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      await fetchData(false, true);
    } catch (err) {
      await confirmDialog(`登录「${srv.label || srv.name}」失败:\n${err.message}`, { confirmText: '知道了' });
    }
    setLoggingIn(null);
  };

  // OAuth 退出登录:清除该服务器已存储的凭证(claude mcp logout),之后需重新登录才能使用。
  const [loggingOut, setLoggingOut] = useState(null);
  const handleLogout = async (srv) => {
    const ok = await confirmDialog(`退出「${srv.label || srv.name}」的登录?\n\n将执行 claude mcp logout 清除已存储的授权凭证,之后需重新登录才能使用。`, { danger: true, confirmText: '退出登录' });
    if (!ok) return;
    setLoggingOut(srv.name);
    try {
      const r = await fetch(`/api/mcp/${encodeURIComponent(srv.name)}/logout`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      await fetchData(false, true);
    } catch (err) {
      await confirmDialog(`退出登录「${srv.label || srv.name}」失败:\n${err.message}`, { confirmText: '知道了' });
    }
    setLoggingOut(null);
  };

  const handleDelete = async (srv) => {
    if (!(await confirmDialog(`删除 MCP 服务器「${srv.label || srv.name}」?\n会执行 claude mcp remove,不可撤销。`, { danger: true, confirmText: '删除' }))) return;
    setServers((prev) => prev.filter((s) => s.name !== srv.name));
    try {
      const r = await fetch(`/api/mcp/${encodeURIComponent(srv.name)}`, { method: 'DELETE' });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.status); }
    } catch (err) {
      console.error('MCP delete failed:', err);
      fetchData(); // 失败回拉真实状态
    }
  };

  // Enabled first, disabled last; stable within each group (Array.sort is
  // stable). Re-sorts automatically when a toggle flips `enabled` in state.
  const byEnabled = (a, b) => (a.enabled === false ? 1 : 0) - (b.enabled === false ? 1 : 0);
  const sortedServers = [...servers].sort(byEnabled);
  const sortedPlugins = [...plugins].sort(byEnabled);

  // 官方插件一键安装:已装名(去掉 @marketplace 后缀)用于过滤"添加插件"弹层的推荐项。
  const installedPluginIds = new Set(plugins.map((p) => String(p.name).split('@')[0]));
  const [installingPlugin, setInstallingPlugin] = useState(null);
  const [pluginErr, setPluginErr] = useState('');
  // 对齐 MCP 的交互:推荐插件收进"添加"按钮打开的弹层,列表只展示已安装项。
  const [pluginAddOpen, setPluginAddOpen] = useState(false);
  // 折叠式"全市场搜索"(默认收起,不占密度):走 GET /api/plugins/available(后端缓存
  // `claude plugin list --available --json`);query 变化去抖 350ms 再拉,后端内存过滤。
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState(null); // null | { total, items }
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchErr, setSearchErr] = useState('');
  useEffect(() => {
    if (!searchOpen) return;
    let alive = true;
    const t = setTimeout(async () => {
      setSearchLoading(true); setSearchErr('');
      try {
        const r = await fetch(`/api/plugins/available?q=${encodeURIComponent(searchQuery.trim())}`);
        const d = await r.json();
        if (!alive) return;
        if (!r.ok) throw new Error(d.error || '获取失败');
        setSearchResult(d);
      } catch (e) { if (alive) { setSearchErr(e.message); setSearchResult(null); } }
      if (alive) setSearchLoading(false);
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [searchOpen, searchQuery]);
  const installPlugin = async (plugin) => {
    const id = plugin.id;
    setInstallingPlugin(id); setPluginErr('');
    try {
      const r = await fetch('/api/plugins/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // 非官方源插件(带 repo)让后端先 marketplace add 再装;marketplace 单独带上,
        // 供市场搜索结果(已配置 marketplace、无 repo)装 `name@marketplace` 而非误落官方源。
        body: JSON.stringify({ name: id, ...(plugin.repo ? { repo: plugin.repo } : {}), ...(plugin.marketplace ? { marketplace: plugin.marketplace } : {}) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '安装失败');
      await fetchData(); // 刷新已安装列表
      setInstallingPlugin(null); // 先停 spinner 再弹窗
      // 与插件更新一致:安装成功弹窗提示(新会话生效);有 usage 的追加用法说明。
      await confirmDialog(
        `插件「${plugin.name || id}」已安装${d.needsRestart === false ? '' : '(新会话生效)'}${plugin.usage ? '\n\n' + plugin.usage : ''}`,
        { confirmText: '知道了' },
      );
    } catch (e) { setPluginErr(`${id}: ${e.message}`); }
    setInstallingPlugin(null);
  };

  // 更新插件到最新版(claude plugin update,需新会话生效)。
  const handleUpdatePlugin = async (plugin) => {
    setPluginActioning(plugin.name); setPluginErr('');
    try {
      const r = await fetch(`/api/plugins/${encodeURIComponent(plugin.name)}/update`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '更新失败');
      setRestartHint(true);
      await fetchData();
      setPluginActioning(null); // 更新已完成,先停 spinner 再弹窗
      // 版本号更新前后没变 → 明确显示"无更新",不再误报"已更新为 vX"。
      const pn = plugin.name.split('@')[0];
      await confirmDialog(
        d.changed === false
          ? `插件「${pn}」已是最新,无更新${d.version ? `(v${d.version})` : ''}`
          : d.version
            ? `插件「${pn}」已更新为 v${d.version}\n(新会话生效)`
            : `插件「${pn}」已更新到最新(新会话生效)`,
        { confirmText: '知道了' },
      );
    } catch (e) { setPluginErr(`${plugin.name}: ${e.message}`); }
    setPluginActioning(null);
  };

  // 插件带来物清单:展开查看某插件提供的 skills / 命令 / agents(GET /api/plugins/:name/contents,
  // best-effort 读插件缓存目录)。首次展开才拉取,之后开合复用已拉数据。
  const [pluginContents, setPluginContents] = useState({}); // name -> { open, loading?, data?, err? }
  const togglePluginContents = async (plugin) => {
    const cur = pluginContents[plugin.name];
    if (cur?.open) { setPluginContents((m) => ({ ...m, [plugin.name]: { ...cur, open: false } })); return; }
    if (cur?.data || cur?.err) { setPluginContents((m) => ({ ...m, [plugin.name]: { ...cur, open: true } })); return; }
    setPluginContents((m) => ({ ...m, [plugin.name]: { open: true, loading: true } }));
    try {
      const r = await fetch(`/api/plugins/${encodeURIComponent(plugin.name)}/contents`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setPluginContents((m) => ({ ...m, [plugin.name]: { open: true, data: d } }));
    } catch (e) {
      setPluginContents((m) => ({ ...m, [plugin.name]: { open: true, err: e.message } }));
    }
  };

  // 卸载插件(claude plugin uninstall);卸载后在「添加」列表回到未安装态可重装。
  const handleDeletePlugin = async (plugin) => {
    const ok = await confirmDialog(`卸载插件「${plugin.name}」?\n\n将执行 claude plugin uninstall。卸载后可在「添加」里重新安装。`, { danger: true, confirmText: '卸载' });
    if (!ok) return;
    setPluginActioning(plugin.name); setPluginErr('');
    try {
      const r = await fetch(`/api/plugins/${encodeURIComponent(plugin.name)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '卸载失败');
      await fetchData();
      setPluginActioning(null); // 先停 spinner 再弹窗
      await confirmDialog(`插件「${plugin.name.split('@')[0]}」已卸载`, { confirmText: '知道了' });
    } catch (e) { setPluginErr(`${plugin.name}: ${e.message}`); }
    setPluginActioning(null);
  };

  if (loading && servers.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw size={16} className="text-ink-faint animate-spin" />
      </div>
    );
  }

  if (error && servers.length === 0) {
    return (
      <div className="px-4 py-8 text-center space-y-3">
        <Server size={24} className="text-ink-ghost mx-auto" />
        <p className="text-xs text-ink-faint font-body">加载 MCP 信息失败</p>
        <p className="text-[10px] text-ink-ghost font-mono">{error}</p>
        <button
          onClick={() => fetchData()}
          className="text-xs text-accent hover:text-accent-hover font-body transition-colors"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="px-4 py-4 space-y-5 overflow-y-auto h-full">
      {/* CQ批次4:刷新按钮移到顶部(原来在最底部要滚到底才点得到)。强制 ?fresh=1 重读 ~/.claude.json。 */}
      <div className="flex items-center justify-between -mb-1">
        <h2 className="text-[11px] font-medium uppercase tracking-widest text-ink-faint font-body">MCP / 插件</h2>
        <button onClick={() => fetchData(false, true)} title="刷新(重读配置，看到刚用 claude mcp add / plugin install 添加的项)"
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-ink-faint hover:text-ink-muted hover:bg-canvas-warm font-body transition-colors">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />刷新
        </button>
      </div>
      {restartHint && (
        <div className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          <span className="flex-1">配置已保存到 claude code,将在每个会话的<b>下条消息</b>自动生效,无需重启会话。</span>
          <button onClick={() => setRestartHint(false)} className="text-amber-700/70 hover:text-amber-700">✕</button>
        </div>
      )}
      {/* 添加后自动探测结果:进行中 / 失败(含子进程 stderr 真因),成功不打扰 */}
      {probe?.busy && (
        <div className="flex items-center gap-2 text-[11px] text-ink-faint bg-canvas-warm border border-canvas-deep rounded-lg px-3 py-2">
          <Activity size={11} className="animate-pulse" />正在测试「{probe.name}」连通性…
        </div>
      )}
      {probe && !probe.busy && (
        <div className="rounded-lg border border-error/30 bg-error/5 px-3 py-2 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-error font-body font-medium">「{probe.name}」已添加,但连接测试失败</span>
            <button onClick={() => setProbe(null)} className="text-ink-faint hover:text-ink"><X size={11} /></button>
          </div>
          <pre className="text-[10px] text-ink-soft font-mono whitespace-pre-wrap break-all leading-snug max-h-40 overflow-auto">{probe.detail}</pre>
        </div>
      )}
      {/* MCP Servers */}
      <div>
        <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3 flex items-center gap-1.5">
          <Server size={11} />
          MCP 服务器
          <div className="flex-1" />
          <button onClick={() => setForm({ add: true })}
            className="flex items-center gap-1 px-2 py-1 rounded-md bg-accent text-white text-[10px] font-medium hover:bg-accent/90 transition-colors normal-case tracking-normal">
            <Plus size={11} />添加
          </button>
        </h3>
        {servers.length > 0 ? (
          <div className="space-y-2">
            {sortedServers.map((srv) => {
              const disabled = srv.enabled === false;
              // 未连接且内置目录声明了该 server 需要的 env → 行内提示缺什么、去哪填。
              // 列表数据只有 env 键名没有值,故按目录声明提示"可能缺"而非断言。
              const tplEnvKeys = (!disabled && srv.status === 'disconnected')
                ? (findBuiltinMcp(srv.name)?.env || []).map((e) => e.k)
                : [];
              return (
                <div
                  key={srv.name}
                  className={`relative bg-canvas-warm border rounded-lg p-3 transition-all duration-150 ${
                    disabled ? 'border-ink-ghost/30 opacity-50' : 'border-canvas-deep'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    {/* 左侧:图标+名称+徽章。min-w-0 让长名称截断而不是把右侧操作组挤出
                        卡片边界(toggle 溢出的根因 #1)。 */}
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <Plug
                        size={12}
                        className={`shrink-0 ${disabled ? 'text-ink-ghost' : srv.status === 'connected' ? 'text-success' : 'text-ink-faint'}`}
                        aria-label="服务器图标"
                      />
                      <span className={`text-xs font-medium font-body truncate ${disabled ? 'text-ink-faint line-through' : 'text-ink'}`}
                        title={srv.label ? `ID: ${srv.name}` : (srv.source || srv.name)}>
                        {srv.label || srv.name}
                      </span>
                      <span className="shrink-0 text-[10px] px-1.5 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono"
                        title="传输协议 (stdio = 子进程, http = HTTP MCP)">
                        {srv.transport}
                      </span>
                      {srv.autoApprove && (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded font-body flex items-center gap-0.5"
                          title="自动执行工具:该服务器的工具调用免确认直接放行">
                          <Zap size={9} />免确认
                        </span>
                      )}
                    </div>
                    {/* 右侧操作组:shrink-0 永不被挤出,确保 toggle 始终在卡片内。 */}
                    <div className="flex items-center gap-1 shrink-0">
                      {!disabled && srv.status === 'connected' && (
                        <span className="text-[10px] text-success" title="已连接（claude mcp list 显示 connected）">✓</span>
                      )}
                      {!disabled && srv.status === 'disconnected' && (
                        <span className="text-[10px] text-error" title="未连接">✗</span>
                      )}
                      {disabled && (
                        <span className="text-[10px] text-ink-ghost" title="已禁用（CLI 不会启动此 MCP）">已禁用</span>
                      )}
                      {/* 退出登录:仅 http/sse(OAuth 型)已连接的服务器。stdio 无登录态不显示。 */}
                      {!disabled && srv.status === 'connected' && srv.transport !== 'stdio' && (
                        <button onClick={() => handleLogout(srv)} disabled={loggingOut === srv.name}
                          title="退出登录:执行 claude mcp logout 清除已存储的授权凭证"
                          className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-body text-ink-faint hover:text-ink-muted hover:bg-canvas-deep transition-colors disabled:opacity-60">
                          {loggingOut === srv.name ? <RefreshCw size={10} className="animate-spin" /> : <LogOut size={10} />}
                          退出登录
                        </button>
                      )}
                      {!disabled && srv.status === 'needs-auth' && (
                        <button onClick={() => handleLogin(srv)} disabled={loggingIn === srv.name}
                          title="该服务器需要 OAuth 授权。点击执行 claude mcp login，会打开系统浏览器完成授权。"
                          className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-body bg-amber-50 text-amber-700 hover:bg-amber-500/20 transition-colors disabled:opacity-60">
                          {loggingIn === srv.name ? <RefreshCw size={10} className="animate-spin" /> : <LogIn size={10} />}
                          {loggingIn === srv.name ? '等待授权…' : '登录'}
                        </button>
                      )}
                      <PingButton name={srv.name} />
                      <button onClick={() => setForm(srv)} title="编辑"
                        className="p-1 rounded text-ink-faint hover:text-accent hover:bg-canvas-warm transition-colors"><Pencil size={11} /></button>
                      <button onClick={() => handleDelete(srv)} title="删除"
                        className="p-1 rounded text-ink-faint hover:text-error hover:bg-canvas-warm transition-colors"><Trash2 size={11} /></button>
                      <Toggle
                        enabled={!disabled}
                        loading={toggling === srv.name}
                        onToggle={() => handleToggle(srv)}
                      />
                    </div>
                  </div>
                  <div className="text-[11px] text-ink-muted font-mono truncate">
                    {srv.command}{srv.args?.length > 0 ? ' ' + srv.args.join(' ') : ''}
                  </div>
                  {srv.env?.length > 0 && (
                    <div className="text-[10px] text-ink-faint mt-1">
                      环境变量: {srv.env.join(', ')}
                    </div>
                  )}
                  {tplEnvKeys.length > 0 && (
                    <div className="text-[10px] text-amber-700 mt-1 font-body">
                      可能缺 {tplEnvKeys.join(' / ')},点编辑填写。
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-ink-faint font-body py-4 text-center bg-canvas-warm border border-canvas-deep rounded-lg space-y-2">
            <div>没有配置 MCP 服务器</div>
            {/* 空态 CTA:直接打开添加表单(内含内置推荐模板,选模板自动填好命令/env) */}
            <button onClick={() => setForm({ add: true })}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-accent text-white text-[11px] font-medium hover:bg-accent/90 transition-colors">
              <Plus size={11} />添加 MCP 服务器(含内置推荐)
            </button>
          </div>
        )}
      </div>

      {/* Plugins */}
      <div>
        <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3 flex items-center gap-1.5">
          <Package size={11} />
          已安装插件
          <div className="flex-1" />
          {/* 对齐 MCP 服务器的交互:推荐安装项收进"添加"弹层,不再平铺在面板上 */}
          <button onClick={() => { setPluginErr(''); setPluginAddOpen(true); }}
            className="flex items-center gap-1 px-2 py-1 rounded-md bg-accent text-white text-[10px] font-medium hover:bg-accent/90 transition-colors normal-case tracking-normal">
            <Plus size={11} />添加
          </button>
        </h3>
        {!pluginAddOpen && pluginErr && <div className="text-[11px] text-error bg-error/10 border border-error/20 rounded px-2 py-1.5 break-all mb-2 normal-case tracking-normal">{pluginErr}</div>}
        {plugins.length > 0 ? (
          <div className="space-y-2">
            {sortedPlugins.map((plugin) => {
              const disabled = plugin.enabled === false;
              return (
                <div
                  key={plugin.name}
                  className={`bg-canvas-warm border rounded-lg p-3 transition-opacity ${
                    disabled ? 'border-ink-ghost/30 opacity-50' : 'border-canvas-deep'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Package size={12} className={disabled ? 'text-ink-ghost' : 'text-warning/70'} />
                    <span className={`text-xs font-medium font-body ${disabled ? 'text-ink-faint line-through' : 'text-ink'}`}>
                      {plugin.name}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono">
                      v{plugin.version}
                    </span>
                    <div className="ml-auto flex items-center gap-1">
                      <button onClick={() => handleUpdatePlugin(plugin)} disabled={!!pluginActioning}
                        title="更新到最新版(claude plugin update,新会话生效)"
                        className="p-1 rounded text-ink-faint hover:text-accent hover:bg-accent/10 disabled:opacity-50">
                        {pluginActioning === plugin.name ? <RefreshCw size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      </button>
                      <button onClick={() => handleDeletePlugin(plugin)} disabled={!!pluginActioning}
                        title="卸载(claude plugin uninstall,卸载后可在「添加」重装)"
                        className="p-1 rounded text-ink-faint hover:text-error hover:bg-error/10 disabled:opacity-50">
                        <Trash2 size={12} />
                      </button>
                      <Toggle
                        enabled={!disabled}
                        loading={toggling === plugin.name}
                        onToggle={() => handleTogglePlugin(plugin)}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-ink-faint font-mono">
                    <span>scope: {plugin.scope}</span>
                    {plugin.installedAt && (
                      <span>安装: {new Date(plugin.installedAt).toLocaleDateString('zh-CN')}</span>
                    )}
                    <button onClick={() => togglePluginContents(plugin)}
                      className="ml-auto font-body text-ink-faint hover:text-accent transition-colors">
                      {pluginContents[plugin.name]?.open ? '收起' : '查看内容'}
                    </button>
                  </div>
                  {/* 带来物清单:该插件提供的 skills(前缀调用名)/ 命令 / agents */}
                  {pluginContents[plugin.name]?.open && (() => {
                    const pc = pluginContents[plugin.name];
                    if (pc.loading) return <div className="mt-2 pt-2 border-t border-canvas-deep/60 text-[10px] text-ink-faint font-body">读取中…</div>;
                    if (pc.err) return <div className="mt-2 pt-2 border-t border-canvas-deep/60 text-[10px] text-ink-faint font-body">无法解析插件目录({pc.err})</div>;
                    const d = pc.data;
                    const empty = !d.skills.length && !d.commands.length && !d.agents.length && !d.hasMcp;
                    return (
                      <div className="mt-2 pt-2 border-t border-canvas-deep/60 space-y-1 text-[10px] font-body">
                        {empty && <div className="text-ink-faint">未在插件目录发现 skills / 命令 / agents。</div>}
                        {d.skills.length > 0 && (
                          <div className="text-ink-faint break-all">
                            skill(以 <span className="font-mono">{d.bare}:</span> 前缀调用):
                            <span className="font-mono text-ink-muted"> {d.skills.map((s) => `${d.bare}:${s}`).join('、')}</span>
                          </div>
                        )}
                        {d.commands.length > 0 && (
                          <div className="text-ink-faint break-all">命令:<span className="font-mono text-ink-muted">{d.commands.join('、')}</span></div>
                        )}
                        {d.agents.length > 0 && (
                          <div className="text-ink-faint break-all">agents:<span className="font-mono text-ink-muted">{d.agents.join('、')}</span></div>
                        )}
                        {d.hasMcp && <div className="text-ink-faint">内含 MCP server(随插件自动配置)。</div>}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-ink-faint font-body py-3 text-center bg-canvas-warm border border-canvas-deep rounded-lg">
            没有已安装的插件
          </div>
        )}
      </div>

      {/* External */}
      {external.length > 0 && (
        <div>
          <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3 flex items-center gap-1.5">
            <FolderOpen size={11} />
            外部 MCP 项目
          </h3>
          <div className="space-y-2">
            {external.map((ext) => (
              <div key={ext.name} className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <FolderOpen size={12} className="text-warning/70" />
                  <span className="text-xs font-medium text-ink font-body">{ext.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono">
                    {ext.type}
                  </span>
                </div>
                {ext.files?.length > 0 && (
                  <div className="text-[10px] text-ink-faint font-mono truncate">
                    {ext.files.slice(0, 5).join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {form && (
        <McpForm
          editing={form.add ? null : form}
          onClose={() => setForm(null)}
          onSaved={(savedName, isNew) => { fetchData(); setRestartHint(true); if (isNew && savedName) autoProbe(savedName); }}
        />
      )}

      {/* 添加插件弹层:官方推荐里尚未安装的项(Anthropic 自维护精选,claude-plugins-official)。
          交互对齐 McpForm 模态;安装逻辑复用 installPlugin,未改动。 */}
      {pluginAddOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in" onClick={() => setPluginAddOpen(false)}>
          <div className="glass-popover w-[560px] max-w-[calc(var(--app-w,100vw)-1.5rem)] max-h-[90vh] flex flex-col overflow-hidden rounded-2xl shadow-2xl animate-glass-rise"
            onClick={(e) => e.stopPropagation()}>
            {/* flex 列三段:animate-glass-rise 收尾留 transform,其内 sticky 头在 WKWebView 失效
                (长列表滚动时头部含关闭按钮会跟着滚走)→ 头/尾 shrink-0 + 正文 flex-1 滚动。 */}
            <div className="shrink-0 px-5 py-4 border-b border-canvas-deep flex items-center gap-3 bg-canvas">
              <button onClick={() => setPluginAddOpen(false)} className="p-1 -ml-1 text-ink-faint hover:text-ink rounded transition-colors" title="返回"><ArrowLeft size={16} /></button>
              <div className="flex-1 text-[14px] font-medium text-ink font-body">添加插件</div>
              <button onClick={() => setPluginAddOpen(false)} className="p-1.5 hover:bg-canvas-warm rounded transition-colors"><X size={14} className="text-ink-faint" /></button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 px-5 py-4 space-y-3">
              <div className="text-[11px] text-ink-faint font-body leading-snug">
                Anthropic 官方精选,安装后无需配置,新会话生效。带 MCP 标记的插件安装时自动配好对应 MCP,无需再手填。
              </div>
              {pluginErr && <div className="text-[11px] text-error bg-error/10 border border-error/20 rounded px-2 py-1.5 break-all">{pluginErr}</div>}
              {/* 全部内置插件都列出,已装的标「已安装」而非整条隐藏 —— 否则用户装过的插件
                  (如 superpowers)从列表消失,以为"缺失"(用户实报)。 */}
              <div className="space-y-2">
                {BUILTIN_PLUGINS.map((p) => {
                  const busy = installingPlugin === p.id;
                  const installed = installedPluginIds.has(p.id);
                  return (
                    <div key={p.id} className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-ink font-body">{p.name}</span>
                          {p.mcp && <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded">MCP</span>}
                        </div>
                        {/* 不 truncate:关键说明(如 superpowers 的 skill 命名规则)被单行截断会看不到 */}
                        <div className="text-[10px] text-ink-faint font-body leading-snug mt-0.5">{p.desc}</div>
                      </div>
                      {installed ? (
                        <span className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-[12px] font-medium text-success">
                          <Check size={12} />已安装
                        </span>
                      ) : (
                        <button onClick={() => installPlugin(p)} disabled={!!installingPlugin}
                          className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded text-[12px] font-medium text-white bg-accent hover:bg-accent-hover disabled:opacity-50">
                          {busy ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}
                          {busy ? '安装中…' : '安装'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* 折叠式全市场搜索(高级):默认收起,不占密度。展开后从已配置 marketplace
                  动态搜索全部可装插件。精选清单外的插件可能需 key/Docker/LSP,装了未必即用。 */}
              <div className="border-t border-canvas-deep pt-3">
                <button
                  onClick={() => setSearchOpen((v) => !v)}
                  className="w-full flex items-center gap-1.5 text-[12px] font-medium text-ink-faint hover:text-ink transition-colors">
                  <ChevronRight size={13} className={`transition-transform ${searchOpen ? 'rotate-90' : ''}`} />
                  <Search size={12} />
                  从全部 marketplace 搜索(高级)
                </button>
                {searchOpen && (
                  <div className="mt-3 space-y-2">
                    <div className="relative">
                      <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
                      <input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="按名称 / 描述 / 来源过滤,留空列出全部"
                        className="w-full pl-8 pr-3 py-1.5 text-[12px] bg-canvas-warm border border-canvas-deep rounded-lg text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent" />
                    </div>
                    {searchErr && <div className="text-[11px] text-error bg-error/10 border border-error/20 rounded px-2 py-1.5 break-all">{searchErr}</div>}
                    {searchLoading && <div className="flex items-center gap-1.5 text-[11px] text-ink-faint"><RefreshCw size={11} className="animate-spin" />搜索中…</div>}
                    {!searchLoading && searchResult && (
                      <>
                        {searchResult.items.length === 0 && <div className="text-[11px] text-ink-faint py-1">无匹配插件。</div>}
                        {searchResult.total > searchResult.items.length && (
                          <div className="text-[10px] text-ink-faint">共 {searchResult.total} 项,仅显示前 {searchResult.items.length} 项,请细化关键词。</div>
                        )}
                        <div className="space-y-2">
                          {searchResult.items.map((r) => {
                            const busy = installingPlugin === r.name;
                            const installed = installedPluginIds.has(r.name) || r.installed;
                            return (
                              <div key={r.pluginId} className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 flex items-center gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium text-ink font-body">{r.name}</span>
                                    {r.marketplace && <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded shrink-0">{r.marketplace}</span>}
                                  </div>
                                  {r.description && <div className="text-[10px] text-ink-faint font-body leading-snug mt-0.5">{r.description}</div>}
                                </div>
                                {installed ? (
                                  <span className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-[12px] font-medium text-success">
                                    <Check size={12} />已安装
                                  </span>
                                ) : (
                                  <button onClick={() => installPlugin({ id: r.name, name: r.name, marketplace: r.marketplace })} disabled={!!installingPlugin}
                                    className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded text-[12px] font-medium text-white bg-accent hover:bg-accent-hover disabled:opacity-50">
                                    {busy ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}
                                    {busy ? '安装中…' : '安装'}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
