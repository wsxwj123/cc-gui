import React, { useEffect, useState } from 'react';
import { BarChart3, Cpu, Database, Calendar, ArrowLeft, RefreshCw, FolderOpen, Download } from 'lucide-react';
import { ModelBadge } from './ModelBadge.jsx';

function decodeProjectHash(hash) {
  if (hash.startsWith('-')) return '/' + hash.slice(1).replace(/-/g, '/');
  return hash;
}

function downloadCSV(stats) {
  const lines = ['section,key,input_tokens,output_tokens,cache_read,calls'];
  for (const m of stats.byModel) lines.push(`model,${m.model},${m.input},${m.output},${m.cacheRead},${m.calls}`);
  for (const p of stats.byProject) lines.push(`project,${decodeProjectHash(p.hash)},${p.input},${p.output},${p.cacheRead},${p.calls}`);
  for (const d of stats.byDay) lines.push(`day,${d.day},${d.input},${d.output},${d.cacheRead},${d.calls}`);
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `claude-usage-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function BarRow({ label, value, max, color = 'var(--color-accent)' }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-ink-muted font-body truncate w-28 shrink-0" title={label}>
        {label}
      </span>
      <div className="flex-1 h-4 bg-canvas-deep rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.max(pct, 1)}%`, background: color }}
        />
      </div>
      <span className="text-xs text-ink-faint font-mono w-16 text-right shrink-0">
        {formatNum(value)}
      </span>
    </div>
  );
}

export function UsagePanel() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/usage');
      const data = await res.json();
      setStats(data);
    } catch (err) {
      console.error('Failed to fetch usage stats:', err);
    }
    setLoading(false);
  };

  useEffect(() => { fetchStats(); }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw size={16} className="text-ink-faint animate-spin" />
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="px-4 py-8 text-center text-xs text-ink-faint font-body">
        无法加载用量数据
      </div>
    );
  }

  const maxTokens = Math.max(...stats.byModel.map((m) => m.input + m.output), 1);
  const maxDayTokens = Math.max(...stats.byDay.map((d) => d.input + d.output), 1);

  return (
    <div className="px-4 py-4 space-y-5 overflow-y-auto h-full">
      {/* Total summary */}
      <div>
        <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3">
          总览
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
            <div className="text-[10px] text-ink-faint font-body mb-0.5">总输入</div>
            <div className="text-lg font-mono font-medium text-ink">{formatNum(stats.total.input)}</div>
          </div>
          <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
            <div className="text-[10px] text-ink-faint font-body mb-0.5">总输出</div>
            <div className="text-lg font-mono font-medium text-ink">{formatNum(stats.total.output)}</div>
          </div>
          <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
            <div className="text-[10px] text-ink-faint font-body mb-0.5">缓存命中</div>
            <div className="text-lg font-mono font-medium text-ink">{formatNum(stats.total.cacheRead)}</div>
          </div>
          <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
            <div className="text-[10px] text-ink-faint font-body mb-0.5">会话数</div>
            <div className="text-lg font-mono font-medium text-ink">{stats.total.sessionCount}</div>
          </div>
        </div>
      </div>

      {/* By model */}
      <div>
        <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3 flex items-center gap-1.5">
          <Cpu size={11} />
          按模型
        </h3>
        <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
          {stats.byModel.map((m) => (
            <div key={m.model} className="flex items-center gap-2 py-1.5">
              <ModelBadge model={m.model} compact />
              <div className="flex-1 h-3 bg-canvas-deep rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent/60 transition-all duration-500"
                  style={{ width: `${Math.max(((m.input + m.output) / maxTokens) * 100, 1)}%` }}
                />
              </div>
              <span className="text-[10px] text-ink-faint font-mono w-20 text-right">
                {formatNum(m.input + m.output)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* By project — top 10 */}
      {stats.byProject?.length > 0 && (
        <div>
          <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3 flex items-center gap-1.5">
            <FolderOpen size={11} />按项目
          </h3>
          <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
            {(() => {
              const maxP = Math.max(...stats.byProject.map((p) => p.input + p.output), 1);
              return stats.byProject.slice(0, 10).map((p) => {
                const path = decodeProjectHash(p.hash);
                const name = path.split('/').filter(Boolean).slice(-2).join('/');
                return (
                  <BarRow key={p.hash} label={name || p.hash} value={p.input + p.output}
                    max={maxP} color="var(--color-accent)" />
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* By day (recent 14) */}
      <div>
        <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3 flex items-center gap-1.5">
          <Calendar size={11} />最近用量
        </h3>
        <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
          {stats.byDay.slice(0, 14).map((d) => (
            <BarRow key={d.day} label={d.day.slice(5)} value={d.input + d.output} max={maxDayTokens} />
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={fetchStats}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs text-ink-muted hover:text-ink font-body transition-colors bg-canvas-warm border border-canvas-deep rounded-lg">
          <RefreshCw size={12} />刷新
        </button>
        <button onClick={() => downloadCSV(stats)}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs text-ink-muted hover:text-ink font-body transition-colors bg-canvas-warm border border-canvas-deep rounded-lg">
          <Download size={12} />导出 CSV
        </button>
      </div>
    </div>
  );
}
