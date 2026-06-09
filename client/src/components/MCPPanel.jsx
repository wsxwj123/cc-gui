import React, { useEffect, useState, useRef } from 'react';
import { Server, Package, FolderOpen, RefreshCw, Plug, Activity, Check, X, Plus, Pencil, Trash2, Zap } from 'lucide-react';
import { McpForm } from './McpForm.jsx';
import { confirmDialog } from '../utils/confirmDialog.jsx';

function PingButton({ name }) {
  const [state, setState] = useState(null); // null | 'busy' | 'ok' | 'err'
  const [detail, setDetail] = useState('');
  const ping = async (e) => {
    e?.stopPropagation();
    setState('busy');
    try {
      const r = await fetch(`/api/mcp/${encodeURIComponent(name)}/ping`);
      const d = await r.json();
      setState(d.status === 'ok' ? 'ok' : 'err');
      setDetail(`${d.ms}ms${d.httpStatus ? ` · HTTP ${d.httpStatus}` : ''}${d.detail ? '\n' + d.detail : ''}`);
      setTimeout(() => setState(null), 3000);
    } catch (err) {
      setState('err'); setDetail(err.message);
    }
  };
  return (
    <button onClick={ping}
      title={detail ? `健康检查\n${detail}` : '点击测试 MCP 服务器连通性 (ping)'}
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
  const [form, setForm] = useState(null); // null | { add:true } | { name } (编辑)
  const mounted = useRef(true);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/mcp');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!mounted.current) return;
      setServers(data.mcpServers || []);
      setPlugins(data.plugins || []);
      setExternal(data.external || []);
    } catch (err) {
      if (mounted.current) setError(err.message);
    }
    if (mounted.current) setLoading(false);
  };

  useEffect(() => {
    mounted.current = true;
    fetchData();
    return () => { mounted.current = false; };
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
                      <button onClick={() => setForm({ name: srv.name })} title="编辑"
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

      <button
        onClick={fetchData}
        className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-ink-faint hover:text-ink-muted font-body transition-colors"
      >
        <RefreshCw size={12} />
        刷新
      </button>

      {form && (
        <McpForm
          editing={form.name ? { name: form.name } : null}
          onClose={() => setForm(null)}
          onSaved={fetchData}
        />
      )}
    </div>
  );
}
