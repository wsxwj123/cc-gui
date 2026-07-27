import React, { useEffect, useState } from 'react';
import { Cpu, Calendar, RefreshCw, FolderOpen, Download, FileText } from 'lucide-react';
import { ModelBadge, modelProvider } from './ModelBadge.jsx';
import { ArtifactPreview } from './ArtifactPreview.jsx';
import { computeCost, formatCost } from '../utils/pricing.js';

// Differentiated billing for the usage panel:
//   Anthropic models (Max subscription) → no per-token charge ("订阅内")
//   third-party (deepseek / mimo via cc switch) → real per-token cost
// The server aggregates byModel as { input, output, cacheRead, cacheWrite, calls };
// adapt that into the usage shape computeCost expects.
function modelCost(model, m) {
  const lower = (model || '').toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(lower)) return { subscription: true };
  let provider = null;
  if (lower.includes('deepseek')) provider = { providerHint: 'deepseek', model };
  else if (lower.includes('mimo')) provider = { providerHint: 'mimo' };
  if (!provider) return { unknown: true };
  const c = computeCost(model, {
    input_tokens: m.input, output_tokens: m.output,
    cache_read_input_tokens: m.cacheRead, cache_creation_input_tokens: m.cacheWrite || 0,
  }, provider);
  return c ? { usd: c.totalUsd } : { unknown: true };
}

// Group flat byModel rows under their provider. Each group carries its model
// rows, summed tokens, summed third-party cost, and whether any member is an
// Anthropic subscription model (→ provider shows "订阅内" instead of a price).
function groupByProvider(byModel) {
  const map = new Map();
  for (const m of byModel) {
    const { key, label } = modelProvider(m.model);
    if (!map.has(key)) map.set(key, { key, label, models: [], tokens: 0, usd: 0, subscription: false });
    const g = map.get(key);
    g.models.push(m);
    g.tokens += m.input + m.output;
    const c = modelCost(m.model, m);
    if (c.subscription) g.subscription = true;
    if (c.usd) g.usd += c.usd;
  }
  // Paid providers first (by cost desc), then subscription/unknown by tokens.
  return [...map.values()].sort((a, b) => (b.usd - a.usd) || (b.tokens - a.tokens));
}

function decodeProjectHash(hash) {
  if (hash.startsWith('-')) return '/' + hash.slice(1).replace(/-/g, '/');
  return hash;
}

function downloadCSV(stats) {
  const lines = ['section,key,input_tokens,output_tokens,cache_read,cache_write,calls'];
  for (const m of stats.byModel) lines.push(`model,${m.model},${m.input},${m.output},${m.cacheRead},${m.cacheWrite || 0},${m.calls}`);
  for (const p of stats.byProject) lines.push(`project,${decodeProjectHash(p.hash)},${p.input},${p.output},${p.cacheRead},${p.cacheWrite || 0},${p.calls}`);
  for (const d of stats.byDay) lines.push(`day,${d.day},${d.input},${d.output},${d.cacheRead},${d.cacheWrite || 0},${d.calls}`);
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

// W7:官方订阅额度卡片。数据来自 GET /api/subscription-usage(server 调官方
// api/oauth/usage,60s 缓存)。非官方 provider 返回 official:false → 整卡不渲染。
// degraded:true = 凭证刷新窗口/限流,展示的是上次数据 —— 温和橙色提示,不走报错样式。
function SubscriptionUsageCard() {
  const [data, setData] = useState(null);
  const load = () => fetch('/api/subscription-usage').then((r) => r.json()).then(setData).catch(() => {});
  useEffect(() => {
    load();
    const onChatDone = () => load();
    window.addEventListener('cgui:chat-done', onChatDone);
    const id = setInterval(load, 120_000);
    return () => { window.removeEventListener('cgui:chat-done', onChatDone); clearInterval(id); };
  }, []);
  if (!data || data.official === false) return null;
  // degraded 时 error 只是降级说明,下面照常渲染上次数据。
  if (data.error && !data.degraded) {
    return (
      <div>
        <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3">订阅额度</h3>
        <div className="text-[11px] text-ink-faint font-body bg-canvas-warm border border-canvas-deep rounded-lg p-3">{data.error}</div>
      </div>
    );
  }
  const rows = [
    { label: '5 小时窗口', seg: data.session },
    { label: '本周 · 全模型', seg: data.weekAll },
    // 第三档的模型由服务端定(现为 Fable),标签跟随接口回传的 label,不写死。
    { label: `本周 · ${data.weekScoped?.label || '当前模型'}`, seg: data.weekScoped },
  ].filter((r) => r.seg);
  if (!rows.length) return null;
  const tone = (p) => (p >= 90 ? 'var(--color-error,#dc2626)' : p >= 70 ? '#d97706' : 'var(--color-accent)');
  return (
    <div>
      <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3">
        订阅额度（官方用量接口）
      </h3>
      <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 space-y-2">
        {data.degraded && (
          <div className="text-[10px] font-body leading-snug" style={{ color: '#d97706' }}>{data.error}</div>
        )}
        {rows.map((r) => (
          <div key={r.label}>
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-xs text-ink-muted font-body">{r.label}</span>
              <span className="text-xs font-mono text-ink">{r.seg.percent}%</span>
            </div>
            <div className="h-2 w-full rounded-full bg-canvas-deep overflow-hidden">
              <div className="h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, Math.max(r.seg.percent, 1))}%`, background: tone(r.seg.percent) }} />
            </div>
            <div className="text-[10px] text-ink-faint font-body mt-0.5">重置：{r.seg.resetText}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 使用报告(/insights)。点击后 server spawn `claude -p /insights` 生成 HTML 报告,
// 返回内容用 ArtifactPreview(沙箱 iframe)内联预览,可停靠/全屏。生成较慢(数十秒)。
function InsightsReportCard() {
  const [loading, setLoading] = useState(false);
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');

  const generate = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/insights-report', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setHtml(data.html || '');
    } catch (e) {
      setError(e.message || '生成失败');
    }
    setLoading(false);
  };

  return (
    <div>
      <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3 flex items-center gap-1.5">
        <FileText size={11} />使用报告
      </h3>
      <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
        <p className="text-[11px] text-ink-faint font-body leading-snug mb-2.5">
          调用 CLI 的 /insights 分析本机 Claude Code 会话，生成一份 HTML 使用报告。生成需数十秒。
        </p>
        <button
          onClick={generate}
          disabled={loading}
          className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-ink-muted hover:text-ink font-body transition-colors bg-canvas border border-canvas-deep rounded-lg disabled:opacity-50"
        >
          {loading ? <RefreshCw size={12} className="animate-spin" /> : <FileText size={12} />}
          {loading ? '生成中…（请稍候）' : '生成使用报告'}
        </button>
        {error && <div className="mt-2 text-[11px] text-error font-body">{error}</div>}
        {html && <ArtifactPreview lang="html" code={html} />}
      </div>
    </div>
  );
}

export function UsagePanel() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/usage');
      const data = await res.json();
      setStats(data);
    } catch (err) {
      console.error('Failed to fetch usage stats:', err);
    }
    if (!silent) setLoading(false);
  };

  useEffect(() => {
    fetchStats();
    // Auto-refresh when a chat turn finishes — silent so the panel doesn't
    // flicker through its loading state.
    const onChatDone = () => fetchStats(true);
    window.addEventListener('cgui:chat-done', onChatDone);
    // Also poll every 30s as fallback (covers external claude invocations).
    const id = setInterval(() => fetchStats(true), 30_000);
    return () => {
      window.removeEventListener('cgui:chat-done', onChatDone);
      clearInterval(id);
    };
  }, []);

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

  const maxDayTokens = stats.byDay.reduce((m, d) => Math.max(m, d.input + d.output), 1);

  return (
    <div className="px-4 py-4 space-y-5 overflow-y-auto h-full">
      {/* W7:官方订阅额度(非官方 provider 自动隐藏) */}
      <SubscriptionUsageCard />
      {/* 使用报告(/insights)——按需生成 HTML 报告 */}
      <InsightsReportCard />
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
            <div className="text-[10px] text-ink-faint font-body mb-0.5">缓存写入</div>
            <div className="text-lg font-mono font-medium text-ink">{formatNum(stats.total.cacheWrite || 0)}</div>
          </div>
          <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
            <div className="text-[10px] text-ink-faint font-body mb-0.5">会话数</div>
            <div className="text-lg font-mono font-medium text-ink">{stats.total.sessionCount}</div>
          </div>
        </div>
      </div>

      {/* By provider → models. Provider header shows total cost (no tokens);
          each model row underneath shows its tokens + per-model cost. */}
      <div>
        <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3 flex items-center gap-1.5">
          <Cpu size={11} />
          按 Provider · 模型
        </h3>
        <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 space-y-3">
          {/* CQ批次4:provider 级用量柱状图(沿用 BarRow,零依赖)。付费=主色,订阅/免费=灰。 */}
          {(() => {
            const groups = groupByProvider(stats.byModel);
            if (groups.length < 2) return null;
            const maxTok = Math.max(...groups.map((g) => g.tokens), 1);
            return (
              <div className="pb-2 mb-1 border-b border-canvas-deep">
                {groups.map((g) => (
                  <BarRow key={`bar-${g.key}`} label={g.label} value={g.tokens} max={maxTok}
                    color={g.usd > 0 ? 'var(--color-accent)' : 'color-mix(in srgb, var(--color-ink-faint) 60%, transparent)'} />
                ))}
              </div>
            );
          })()}
          {groupByProvider(stats.byModel).map((g) => (
            <div key={g.key}>
              {/* Provider header — name + total cost (订阅内 / $x / —). */}
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[11px] font-semibold text-ink font-body">{g.label}</span>
                <span className="text-[9px] text-ink-ghost font-mono">{g.models.length} 模型</span>
                <div className="flex-1" />
                {g.usd > 0 ? (
                  <span className="text-[11px] text-accent font-mono">{formatCost(g.usd)}</span>
                ) : g.subscription ? (
                  <span className="text-[10px] text-ink-faint font-body" title="Anthropic 订阅额度内，不按 token 计费">订阅内</span>
                ) : (
                  <span className="text-[10px] text-ink-ghost font-mono" title="无定价数据">—</span>
                )}
              </div>
              {/* Model rows */}
              <div className="pl-2 border-l border-canvas-deep space-y-1.5">
                {g.models.map((m) => {
                  const cost = modelCost(m.model, m);
                  return (
                    <div key={m.model} className="flex items-center gap-2">
                      <ModelBadge model={m.model} compact />
                      <span className="text-[10px] font-mono text-ink-soft truncate flex-1" title={m.model}>
                        {m.model}
                      </span>
                      <span className="text-[10px] text-ink-faint font-mono shrink-0 w-16 text-right">
                        {formatNum(m.input + m.output)}
                      </span>
                      {cost.subscription ? (
                        <span className="text-[10px] text-ink-faint font-body shrink-0 w-14 text-right">订阅内</span>
                      ) : cost.usd != null ? (
                        <span className="text-[10px] text-accent font-mono shrink-0 w-14 text-right">{formatCost(cost.usd)}</span>
                      ) : (
                        <span className="text-[10px] text-ink-ghost font-mono shrink-0 w-14 text-right">—</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {(() => {
            const total = stats.byModel.reduce((acc, m) => acc + (modelCost(m.model, m).usd || 0), 0);
            if (total <= 0) return null;
            return (
              <div className="mt-1 pt-2 border-t border-canvas-deep flex items-center justify-between">
                <span className="text-[10px] text-ink-faint font-body">第三方计费合计 · Anthropic 走订阅</span>
                <span className="text-[11px] text-accent font-mono">{formatCost(total)}</span>
              </div>
            );
          })()}
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
                const name = path.split(/[/\\]+/).filter(Boolean).slice(-2).join('/');
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
