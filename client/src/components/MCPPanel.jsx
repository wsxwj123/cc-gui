import React, { useEffect, useState, useRef } from 'react';
import { Server, Package, FolderOpen, RefreshCw, Plug, Activity, Check, X } from 'lucide-react';

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
    <button onClick={ping} title={detail || '测试连接'}
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
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
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

  const handleToggle = async (index) => {
    const srv = servers[index];
    if (!srv) return;

    // Optimistic update — instant UI feedback
    const newEnabled = srv.enabled === false;
    setServers(prev => prev.map((s, i) =>
      i === index ? { ...s, enabled: newEnabled } : s
    ));
    setToggling(srv.name);

    // Fire CLI in background — don't block UI
    const endpoint = newEnabled
      ? `/api/mcp/${encodeURIComponent(srv.name)}/enable`
      : `/api/mcp/${encodeURIComponent(srv.name)}/disable`;

    fetch(endpoint, { method: 'PUT' })
      .then(res => {
        if (!res.ok) return res.json().then(e => { throw new Error(e.error); });
      })
      .catch(err => {
        // Revert on failure
        console.error('Toggle failed:', err);
        setServers(prev => prev.map((s, i) =>
          i === index ? { ...s, enabled: !newEnabled } : s
        ));
      })
      .finally(() => setToggling(null));
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
      {/* MCP Servers */}
      <div>
        <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3 flex items-center gap-1.5">
          <Server size={11} />
          MCP 服务器
        </h3>
        {servers.length > 0 ? (
          <div className="space-y-2">
            {servers.map((srv, index) => {
              const disabled = srv.enabled === false;
              return (
                <div
                  key={srv.name}
                  className={`bg-canvas-warm border rounded-lg p-3 transition-all duration-150 ${
                    disabled ? 'border-ink-ghost/30 opacity-50' : 'border-canvas-deep'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Plug size={12} className={disabled ? 'text-ink-ghost' : srv.status === 'connected' ? 'text-success' : 'text-ink-faint'} />
                    <span className={`text-xs font-medium font-body ${disabled ? 'text-ink-faint line-through' : 'text-ink'}`}>
                      {srv.name}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono">
                      {srv.transport}
                    </span>
                    <div className="flex-1" />
                    {!disabled && srv.status === 'connected' && (
                      <span className="text-[10px] text-success">✓</span>
                    )}
                    {!disabled && srv.status === 'disconnected' && (
                      <span className="text-[10px] text-error">✗</span>
                    )}
                    {disabled && (
                      <span className="text-[10px] text-ink-ghost">已禁用</span>
                    )}
                    <PingButton name={srv.name} />
                    <Toggle
                      enabled={!disabled}
                      loading={toggling === srv.name}
                      onToggle={() => handleToggle(index)}
                    />
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
            {plugins.map((plugin) => (
              <div key={plugin.name} className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Package size={12} className="text-warning/70" />
                  <span className="text-xs font-medium text-ink font-body">{plugin.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono">
                    v{plugin.version}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-ink-faint font-mono">
                  <span>scope: {plugin.scope}</span>
                  {plugin.installedAt && (
                    <span>安装: {new Date(plugin.installedAt).toLocaleDateString('zh-CN')}</span>
                  )}
                </div>
              </div>
            ))}
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
    </div>
  );
}
