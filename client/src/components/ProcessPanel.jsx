import React, { useEffect, useState } from 'react';
import { Activity, Cpu, Clock, MapPin, RefreshCw, Zap, AlertCircle } from 'lucide-react';

export function ProcessPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchProcesses = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/processes');
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error('Failed to fetch processes:', err);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchProcesses();
    const interval = setInterval(fetchProcesses, 10000); // refresh every 10s
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw size={16} className="text-ink-faint animate-spin" />
      </div>
    );
  }

  const sessions = data?.sessionProcesses || [];
  const claudeProcs = data?.claudeProcesses || [];

  return (
    <div className="px-4 py-4 space-y-5 overflow-y-auto h-full">
      {/* Session processes */}
      <div>
        <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3 flex items-center gap-1.5">
          <Activity size={11} />
          会话进程
        </h3>
        {sessions.length === 0 ? (
          <div className="text-xs text-ink-faint font-body py-4 text-center">
            没有活跃的会话进程
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.map((proc, i) => (
              <div
                key={proc.sessionId || i}
                className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 animate-fade-up"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className={`w-2 h-2 rounded-full ${proc.alive ? 'bg-success' : 'bg-ink-ghost'}`} />
                  <span className="text-xs font-mono text-ink-soft">
                    PID {proc.pid || '?'}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${proc.alive ? 'bg-green-50 text-success' : 'bg-canvas-deep text-ink-faint'}`}>
                    {proc.alive ? '运行中' : '已结束'}
                  </span>
                </div>
                {proc.cwd && (
                  <div className="flex items-center gap-1.5 text-[11px] text-ink-faint font-mono mb-1">
                    <MapPin size={10} />
                    <span className="truncate">{proc.cwd}</span>
                  </div>
                )}
                {proc.psInfo && (
                  <div className="flex gap-3 text-[10px] text-ink-faint font-mono mt-1.5">
                    <span>CPU {proc.psInfo.cpu}%</span>
                    <span>MEM {proc.psInfo.mem}%</span>
                    <span>运行 {proc.psInfo.elapsed}</span>
                  </div>
                )}
                {proc.sessionId && (
                  <div className="text-[10px] text-ink-ghost font-mono mt-1 truncate">
                    {proc.sessionId}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Claude processes from ps */}
      {claudeProcs.length > 0 && (
        <div>
          <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3 flex items-center gap-1.5">
            <Cpu size={11} />
            Claude 进程
          </h3>
          <div className="space-y-1.5">
            {claudeProcs.map((proc, i) => (
              <div key={proc.pid || i} className="bg-canvas-warm border border-canvas-deep rounded-lg p-2.5">
                <div className="flex items-center gap-2">
                  <Zap size={11} className="text-warning/60" />
                  <span className="text-xs font-mono text-ink-soft">PID {proc.pid}</span>
                  <span className="text-[10px] text-ink-faint font-mono">
                    CPU {proc.cpu}% · MEM {proc.mem}% · {proc.elapsed}
                  </span>
                </div>
                <div className="text-[10px] text-ink-ghost font-mono mt-1 truncate pl-[19px]">
                  {proc.command}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Refresh */}
      <button
        onClick={fetchProcesses}
        className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-ink-faint hover:text-ink-muted font-body transition-colors"
      >
        <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        刷新
      </button>
    </div>
  );
}
