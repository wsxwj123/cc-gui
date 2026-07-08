import React, { useEffect, useState, useRef } from 'react';
import { Server, Package, FolderOpen, RefreshCw, Plug, Activity, Check, X, Plus, Pencil, Trash2, Zap, Download, ArrowLeft } from 'lucide-react';
import { BUILTIN_PLUGINS } from '../utils/builtinPlugins.js';
import { McpForm } from './McpForm.jsx';
import { confirmDialog } from '../utils/confirmDialog.jsx';

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
      const head = `${d.ms}ms${d.httpStatus ? ` · HTTP ${d.httpStatus}` : ''}${d.detail ? ' · ' + d.detail : ''}`;
      // 失败时优先展示真实子进程 stderr(后端 spawn 抓的),这才是用户要看的"为什么连不上"。
      setDetail(ok ? head : `${head}${d.stderr ? '\n\n' + d.stderr : '\n(未捕获到子进程报错;可能是命令静默挂起或网络超时)'}`);
      setState(ok ? 'ok' : 'err');
      if (ok) setTimeout(() => setState(null), 3000); // 成功才自动消失;失败保留让用户看清原因
    } catch (err) {
      setState('err'); setDetail(err.message);
    }
  };
  return (
    <span className="relative inline-flex">
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
        <div className="absolute right-0 top-full mt-1 z-[60] w-64 max-w-[calc(100vw-1.5rem)] max-h-56 overflow-auto rounded-lg border border-error/30 bg-canvas shadow-2xl p-2.5"
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
  const [form, setForm] = useState(null); // null | { add:true } | srv对象 (编辑)
  const [restartHint, setRestartHint] = useState(false); // 增删改后提示需重启生效
  const mounted = useRef(true);

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
  const installPlugin = async (plugin) => {
    const id = plugin.id;
    setInstallingPlugin(id); setPluginErr('');
    try {
      const r = await fetch('/api/plugins/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // 非官方源插件(带 repo/marketplace)让后端先 marketplace add 再装。
        body: JSON.stringify({ name: id, ...(plugin.repo ? { repo: plugin.repo, marketplace: plugin.marketplace } : {}) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '安装失败');
      await fetchData(); // 刷新已安装列表
    } catch (e) { setPluginErr(`${id}: ${e.message}`); }
    setInstallingPlugin(null);
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
          onClick={fetchData}
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
          <span className="flex-1">配置已保存到 claude code。MCP 改动需<b>重启正在运行的会话</b>(或新建会话)才会被 claude 加载生效。</span>
          <button onClick={() => setRestartHint(false)} className="text-amber-700/70 hover:text-amber-700">✕</button>
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
              return (
                <div
                  key={srv.name}
                  className={`bg-canvas-warm border rounded-lg p-3 transition-all duration-150 ${
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
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-ink-faint font-body py-3 text-center bg-canvas-warm border border-canvas-deep rounded-lg">
            没有配置 MCP 服务器
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
                    <div className="ml-auto">
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
                  </div>
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
          onSaved={() => { fetchData(); setRestartHint(true); }}
        />
      )}

      {/* 添加插件弹层:官方推荐里尚未安装的项(Anthropic 自维护精选,claude-plugins-official)。
          交互对齐 McpForm 模态;安装逻辑复用 installPlugin,未改动。 */}
      {pluginAddOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in" onClick={() => setPluginAddOpen(false)}>
          <div className="glass-popover w-[560px] max-w-[calc(var(--app-w,100vw)-1.5rem)] max-h-[90vh] overflow-y-auto rounded-2xl shadow-2xl animate-glass-rise"
            onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-canvas-deep flex items-center gap-3 sticky top-0 bg-canvas z-10">
              <button onClick={() => setPluginAddOpen(false)} className="p-1 -ml-1 text-ink-faint hover:text-ink rounded transition-colors" title="返回"><ArrowLeft size={16} /></button>
              <div className="flex-1 text-[14px] font-medium text-ink font-body">添加插件</div>
              <button onClick={() => setPluginAddOpen(false)} className="p-1.5 hover:bg-canvas-warm rounded transition-colors"><X size={14} className="text-ink-faint" /></button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div className="text-[11px] text-ink-faint font-body leading-snug">
                Anthropic 官方精选,安装后无需配置,新会话生效。带 MCP 标记的插件安装时自动配好对应 MCP,无需再手填。
              </div>
              {pluginErr && <div className="text-[11px] text-error bg-error/10 border border-error/20 rounded px-2 py-1.5 break-all">{pluginErr}</div>}
              {BUILTIN_PLUGINS.filter((p) => !installedPluginIds.has(p.id)).length === 0 ? (
                <div className="text-xs text-ink-faint font-body py-3 text-center bg-canvas-warm border border-canvas-deep rounded-lg">
                  推荐插件均已安装
                </div>
              ) : (
                <div className="space-y-2">
                  {BUILTIN_PLUGINS.filter((p) => !installedPluginIds.has(p.id)).map((p) => {
                    const busy = installingPlugin === p.id;
                    return (
                      <div key={p.id} className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-ink font-body">{p.name}</span>
                            {p.mcp && <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded">MCP</span>}
                          </div>
                          <div className="text-[10px] text-ink-faint font-body truncate mt-0.5">{p.desc}</div>
                        </div>
                        <button onClick={() => installPlugin(p)} disabled={!!installingPlugin}
                          className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded text-[12px] font-medium text-white bg-accent hover:bg-accent-hover disabled:opacity-50">
                          {busy ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}
                          {busy ? '安装中…' : '安装'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
