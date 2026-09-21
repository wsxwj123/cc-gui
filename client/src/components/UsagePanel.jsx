import React, { useEffect, useState } from 'react';
import { Cpu, Calendar, RefreshCw, FolderOpen, Download, FileText } from './Icon.jsx';
import { ModelBadge, modelProvider } from './ModelBadge.jsx';
import { ArtifactPreview } from './ArtifactPreview.jsx';
import { aggregateCost, displayUsd, formatCost, hasPeriodQuote } from '../utils/pricing.js';
// 时段判定复用服务端规则模块(客户端已多处直接 import 这个目录,见 pricingCatalog.js);
// 自写一套时段判断迟早与历史回看、服务端分桶分叉。
import { periodFor, PERIOD_SCHEDULES, DEFAULT_SCHEDULE_KEY } from '../../../server/utils/pricing-rules.js';
import { quotaItemText, quotaUsedPercent, quotaTone, resetTooltip } from '../utils/quotaFormat.js';
import { useStore } from '../stores/sessionStore.js';
import { addCacheUsage, formatHitPct, formatHitPctOrDash, EMPTY_CACHE_USAGE } from '../utils/cacheStats.js';
import { getPricingCatalogCached, loadPricingCatalog, setPricingCatalog } from '../utils/pricingCatalog.js';

// R4-a:面板的费用口径 = 消息气泡的口径,只有 aggregateCost / computeCost 一个出口。
// 服务端把 byModel 聚合成 { input, output, cacheRead, cacheWrite, calls },aggregateCost
// 负责把它喂给 computeCost 并给出 金额 / 订阅内 / 「—」三态。
// 【删掉了什么】原先这里自带一套分档:/claude|opus|sonnet|haiku/ 一律当订阅藏掉(不看
// hasAuthKey,连官方 API key 付费用户的钱也藏)、只有 deepseek/mimo 算钱、其余一律「—」。
// 判官实测同一份真实历史:面板 ¥211.70 vs 气泡 ¥4,689.56,差 22 倍;差额全是
// gpt-5.6-sol / gpt-5.5 / moonshotai-kimi-k3 这类"面板显横杠、气泡显金额"的模型。
// provider 由组件从 store 取当前值透传,与气泡(useStore(s => s.currentProvider))同源。

// Group flat byModel rows under their provider. Each group carries its model
// rows, summed tokens, summed cost, and whether any member is billed by
// subscription / plan (→ provider shows "订阅内" instead of a price).
function groupByProvider(byModel, provider) {
  const map = new Map();
  for (const m of byModel) {
    const { key, label } = modelProvider(m.model);
    if (!map.has(key)) map.set(key, { key, label, models: [], tokens: 0, usd: 0, priced: false, subscription: false });
    const g = map.get(key);
    g.models.push(m);
    g.tokens += m.input + m.output;
    const c = aggregateCost(m.model, m, provider);
    if (c.subscription) g.subscription = true;
    // priced 与行里的 `cost.usd != null` 同判据:算得出金额就算"有价",哪怕金额是 0
    // (免费模型 / token 极少)。原先只看 `if (c.usd)`,0 元的组在组头显「—」(无定价数据)
    // 而行里显 `<¥0.001`,同一份数据两种说法。
    // 归一到展示口径再相加:官方 CNY 报价是原币种数字,不同币种的数字不能直接相加。
    if (c.usd != null) { g.usd += displayUsd(c.usd, c.currency); g.priced = true; }
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

// R28:官方订阅额度卡片。数据来自 GET /api/subscription-usage(服务端经 CLI 自己的
// /usage 控制通道取,60s 缓存;GUI 不接触凭证)。
//
// 【R41:按身份条件显示】渲染形态由「服务端可用数据 > 客户端身份判定 > 失败方向多显示」
// 三级决定(唯一权威表述,见 resolveSubscriptionCardMode):
//   官方订阅(anthropic ∧ hasAuthKey=false)/ 身份未知 → 现状卡(三段进度条);
//   Claude API 按量(anthropic ∧ hasAuthKey=true) → 只留外壳/标题/状态行/入口 + 一行说明;
//   第三方 → 整块不渲染(但请求照发,服务端带回可用额度即改渲染现状卡)。
// 【为什么非官方 provider 下仍要请求】额度卡是用户判断"还剩多少额度"的唯一入口,删卡或整块
// 写死不可用都不可接受(合同明令)。身份判不出的情况一律照常显示,宁可多显示不可误藏。
// 三段数字缺失一律 null,不显示 0;status=stale 时展示的是上次数据,橙色提示原因,不走报错样式。
const USAGE_ENTRY_TEXT = '在官方CLI查看 /usage';
// R41:Claude API 按量档的正文说明行(契约 §C.3 规范值)。该档没有订阅额度是因为按 API Key
// 计费,额度卡本身也给不出余额 → 保留卡片外壳与 /usage 入口,只把正文换成这一行。
const API_KEY_NOTE_TEXT = '当前 provider 使用 API Key 按量计费，没有官方订阅额度；余额请在 Anthropic Console 查看';

/**
 * R41:决定「订阅额度（官方）」卡按哪种形态渲染。契约 §C.1 的判定表,命中即返回。
 *
 * @param provider  store 的 currentProvider(形状 `{ providerHint?, baseUrl?, model?, protocol?, hasAuthKey? }`),可缺失
 * @param subscription  本次 GET /api/subscription-usage 的响应体,或 null(请求未回/失败)
 * @returns 'subscription' | 'api-key' | 'third-party' | 'unknown'
 *
 * 优先级(唯一权威表述,不得倒置):服务端可用数据 > 客户端身份判定 > 失败方向多显示。
 * 第 0 行是红线兜底(F2):客户端口径(GUI provider 视角)与服务端 isOfficial()
 * (~/.claude/settings.json baseURL 视角)是两套、允许分歧 —— 只要服务端确实拿到了额度,
 * 就必须按现状卡渲染,绝不允许身份判定把真订阅入口藏掉。
 * 任何输入都不抛:非对象/缺字段一律走"未知"(= 显示现状卡,失败方向多显示)。
 */
export function resolveSubscriptionCardMode(provider, subscription) {
  const status = subscription && typeof subscription === 'object' && !Array.isArray(subscription)
    ? subscription.status : undefined;
  if (status === 'available' || status === 'stale') return 'subscription';
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return 'unknown';
  // hasAuthKey 非布尔 = 身份未知(store 初值无该字段、请求失败/未回)→ 照常显示,不误藏。
  if (typeof provider.hasAuthKey !== 'boolean') return 'unknown';
  // providerHint 缺失按 'anthropic'(与 pricing.js 的 isSubscriptionBilling 同口径)。
  if ((provider.providerHint || 'anthropic') !== 'anthropic') return 'third-party';
  if (provider.hasAuthKey === true) return 'api-key';
  return 'subscription';
}

function SubscriptionUsageCard() {
  const [data, setData] = useState(null);
  const [copied, setCopied] = useState(false);
  // R41:身份只走 store 这一条机制(不额外监听 cgui:provider-change —— 事件回调会在
  // fetchProvider 尚未 resolve 时读到旧值;store 订阅天然在数据落地后触发重判)。
  const provider = useStore((s) => s.currentProvider);
  const load = () => fetch('/api/subscription-usage').then((r) => r.json()).then(setData).catch(() => {});
  useEffect(() => {
    // 始终挂载、始终发起:同一份响应既是现状卡的数据源,也是第 0 行破例的唯一输入。
    // 第三方档也发(不是白跑),否则服务端真有额度时无从知道。
    load();
    const onChatDone = () => load();
    window.addEventListener('cgui:chat-done', onChatDone);
    const id = setInterval(load, 120_000);
    return () => { window.removeEventListener('cgui:chat-done', onChatDone); clearInterval(id); };
  }, []);
  // 复制 /usage 给用户贴进官方 CLI —— 官方额度的权威读数只在那里,这里只是入口。
  const copyEntry = async () => {
    try {
      await navigator.clipboard.writeText('/usage');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { setCopied(false); }
  };
  // hooks 全部在这个 return 之前执行 —— 数据/请求不受渲染形态影响。
  const mode = resolveSubscriptionCardMode(provider, data);
  // 第三方档整块不渲染。响应未回(data===null、身份判成第三方)时暂不渲染,避免闪一下再消失;
  // 服务端一旦带回 available/stale,第 0 行破例会把 mode 翻成 'subscription',立刻改渲染现状卡。
  if (mode === 'third-party') return null;
  const apiKeyMode = mode === 'api-key';
  const rows = [
    { label: '5 小时窗口', seg: data?.session },
    { label: '本周 · 全模型', seg: data?.weekAll },
    // 第三档的模型由服务端定,标签跟随接口回传的 label,不写死。
    { label: `本周 · ${data?.weekScoped?.label || '当前模型'}`, seg: data?.weekScoped },
  ].filter((r) => r.seg);
  const tone = (p) => (p >= 90 ? 'var(--color-error,#dc2626)' : p >= 70 ? '#d97706' : 'var(--color-accent)');
  const unavailableText = (() => {
    if (!data) return '额度查询中…';
    if (data.status === 'available' || data.status === 'stale') return data.error || '';
    // r122:CLI 未登录 ≠ 账户没订阅 —— 明说未登录并给办法(文案由界面给,不依赖服务端 error 的措辞)。
    if (data.status === 'not-logged-in') return '额度暂不可用：官方命令行工具未登录任何账户；在终端运行 claude auth login 登录后再试';
    if (data.status === 'not-subscribed') return '额度暂不可用：该账户没有官方订阅额度（CLI 报告 plan 限额不适用）';
    if (data.code === 'NOT_OFFICIAL_PROVIDER') return '额度暂不可用：当前 provider 不是官方订阅，未查询官方额度';
    return `额度暂不可用：${data.error || data.code || '官方 CLI 未返回额度'}`;
  })();

  return (
    <div>
      <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3">
        订阅额度（官方）
      </h3>
      <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 space-y-2">
        {data?.degraded && (
          <div className="text-[10px] font-body leading-snug" style={{ color: '#d97706' }}>
            {data.error || '临时失败，显示上次数据'}
          </div>
        )}
        {apiKeyMode ? (
          // 按量计费档:不显示订阅进度条(没有订阅额度可言),但保留卡片外壳与说明行 ——
          // 卡片凭空消失比"没有额度"更难懂。
          <div className="text-[11px] text-ink-faint font-body leading-snug">{API_KEY_NOTE_TEXT}</div>
        ) : (
          <>
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
                <div className="text-[10px] text-ink-faint font-body mt-0.5">
                  重置：{r.seg.resetText || '—'}{data?.fetchedAt && data.status === 'stale' ? ` · 数据更新于 ${shortTime(data.fetchedAt)}` : ''}
                </div>
              </div>
            ))}
            {!rows.length && (
              <div className="text-[11px] text-ink-faint font-body leading-snug">{unavailableText}</div>
            )}
          </>
        )}
        <div className="flex items-center gap-2 pt-0.5">
          <button
            type="button"
            onClick={copyEntry}
            title="复制 /usage 命令，在终端里跑官方 CLI 查看权威读数"
            className="px-2 py-1 rounded border border-canvas-deep text-[11px] text-ink-soft hover:bg-canvas-deep/60 font-body"
          >{copied ? '已复制 /usage，请贴入终端' : USAGE_ENTRY_TEXT}</button>
          {data?.status && (
            <span className="text-[10px] text-ink-ghost font-body">
              {/* 状态词单独成一个元素:契约 §C.3 的公开文案(可用/过期（显示上次数据）/不可用)是
                  可被逐字取到的锚点,与 code 挤在同一个文本节点里就取不到了(实测)。 */}
              <span>{data.status === 'available' ? '可用' : data.status === 'stale' ? '过期（显示上次数据）' : '不可用'}</span>
              {data.code ? ` · ${data.code}` : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// r16-2:第三方 provider 的额度/余额卡,与上面的订阅额度卡**互斥**(官方 provider 返回
// official:true → 本卡不渲染,那张卡接管;第三方则反过来)。数据来自 /api/provider-quota
// (服务端探测候选端点 + 60s 缓存)。刷新节奏抄订阅卡:120s 轮询 + chat-done 事件,另加
// provider-change(切了 provider 额度当然要重查)。
// 查不到额度时**明写原因**(note),不留空白 —— 留空用户会以为查询坏了。
function ProviderQuotaCard() {
  const [data, setData] = useState(null);
  // r26-J9:自家 /api/provider-quota 失败(网络异常/非 2xx)要显示错误卡 + 重试,
  // 不能 catch 后 data 留 null 整卡消失 —— 用户会以为这张卡本来就不存在。
  const [loadFailed, setLoadFailed] = useState(false);
  const load = () => fetch('/api/provider-quota')
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((d) => { setData(d); setLoadFailed(false); })
    .catch(() => setLoadFailed(true));
  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener('cgui:chat-done', onRefresh);
    window.addEventListener('cgui:provider-change', onRefresh);
    const id = setInterval(load, 120_000);
    return () => {
      window.removeEventListener('cgui:chat-done', onRefresh);
      window.removeEventListener('cgui:provider-change', onRefresh);
      clearInterval(id);
    };
  }, []);
  // 失败卡只在【确实失败】时显示;官方 provider(official:true)照旧整卡不渲染。
  if (loadFailed && (!data || !data.official)) {
    return (
      <div>
        <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3">
          {`额度 · ${data?.providerName || '当前 Provider'}`}
        </h3>
        <div className="text-[11px] text-ink-faint font-body bg-canvas-warm border border-canvas-deep rounded-lg p-3 flex items-center gap-2">
          <span className="flex-1">额度查询失败{data?.note ? `：${data.note}` : '（网络异常或服务端错误）'}</span>
          <button
            type="button"
            onClick={load}
            className="shrink-0 px-2 py-1 rounded border border-canvas-deep text-[11px] text-ink-soft hover:bg-canvas-deep/60 flex items-center gap-1"
          ><RefreshCw size={11} />重试</button>
        </div>
      </div>
    );
  }
  if (!data || data.official) return null;
  const heading = `额度 · ${data.providerName || '当前 Provider'}`;
  const title = (
    <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3">{heading}</h3>
  );
  const items = data.ok && Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    return (
      <div>
        {title}
        <div className="text-[11px] text-ink-faint font-body bg-canvas-warm border border-canvas-deep rounded-lg p-3">
          {data.note || '暂时查不到该 provider 的额度'}
        </div>
      </div>
    );
  }
  return (
    <div>
      {title}
      <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 space-y-2">
        {/* 有 note 就显示:degraded 回放是"这不是新鲜结果",OpenAI 的 codex 通道则是
            "这是本机账户的额度、与当前 API key 无绑定"(服务端随成功 payload 一起给)。 */}
        {data.note && (
          <div className="text-[10px] font-body leading-snug" style={{ color: '#d97706' }}>{data.note}</div>
        )}
        {items.map((it, i) => {
          const used = quotaUsedPercent(it);
          const tip = [used === null ? '' : `已用 ${Math.round(used)}%`, resetTooltip(it.resetAt)].filter(Boolean).join(' · ');
          return (
            <div key={`${it.label}-${i}`} title={tip || undefined}>
              {/* 方向词(已用/剩余)与周期必须同时出现:三家接口方向不一致,只写数字必被读反 */}
              <div className="text-xs text-ink-muted font-body mb-1">{quotaItemText(it, data.currency)}</div>
              {used !== null && (
                <div className="h-2 w-full rounded-full bg-canvas-deep overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(100, Math.max(used, 1))}%`, background: quotaTone(used) }} />
                </div>
              )}
            </div>
          );
        })}
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

// R24:价格与来源区。展示官方价目的逐家状态(成功/部分/失败/未映射)、来源 URL、抓取时间、
// 币种与原币种报价;「刷新价格」逐家列出结果,不给一个总成功就完事。
// 数据来自 GET /api/pricing(schemaVersion:2),刷新走 POST /api/pricing/refresh + refreshId 轮询。
const PRICE_STATUS_TEXT = {
  fresh: '已更新（成功）',
  partial: '部分取得（partial）',
  stale: '已过期（stale）',
  'source-unavailable': '来源不可用（失败）',
  'not-token-priced': '套餐/积分计价（不用 token 单价）',
  unmapped: '未映射来源（未知计价）',
};

const CURRENCY_SYMBOL = { USD: '$', CNY: '¥', EUR: '€' };

// 只刷当前 provider 时,刷新完那行补充说明 —— 解释两件「看起来像坏了」的现有行为,都不是新功能:
// ① 24h 同批去重(同一家 24 小时内再点不会重抓,直接回放上次结果);② 这家没有可自动抓取的
// 官方价目(套餐/未映射),顶层状态会是 failed/completed 但没有任何价格被更新。
// 只在「只刷当前」这次范围内解释:全量刷新里的 unmapped/套餐计价是别家的事,不能按当前 provider 说。
function currentScopeNote(catalog, clickedAt, scopeIds) {
  const refresh = catalog?.refresh;
  // 只按本次范围的家说话:GET /api/pricing 上的 refresh 是「最近一次刷新」,而自动预热
  // (warmupIfStale)可能在我这次刷新之后又起了一批 —— 那种批次的 unmapped/套餐计价是别家的事,
  // 不能算到当前 provider 头上(过滤后为空就什么都不说)。
  const wanted = new Set(scopeIds || []);
  const entries = (refresh?.providers || []).filter((e) => !wanted.size || wanted.has(e.presetId));
  if (!entries.length) return '';
  const started = Date.parse(refresh.startedAt || '');
  if (Number.isFinite(started) && started < clickedAt - 5_000) {
    return '24 小时内这一家已经抓过，本次直接显示上次结果（没有重新请求）。';
  }
  const unmapped = entries.filter((e) => e.status === 'unmapped').map((e) => e.presetId);
  if (unmapped.length) return `${unmapped.join('、')} 没有可自动抓取的官方价目（未映射来源），本次没有更新价格。`;
  const plan = entries.filter((e) => e.status === 'not-token-priced').map((e) => e.presetId);
  if (plan.length) return `${plan.join('、')} 是套餐/积分计价，没有逐 token 单价可抓。`;
  return '';
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function shortTime(value) {
  if (!value) return '—';
  const t = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(t)) return String(value);
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function PricingCard() {
  const [data, setData] = useState(getPricingCatalogCached());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshNote, setRefreshNote] = useState('');

  // 当前 provider 的价目身份(服务端判:前端手里的 baseUrl 是回环代理地址,自己匹配必然空手)。
  // 单开一个端点拿它:GET /api/pricing 的顶层键集合合同锁死(7 个键),加字段会红。
  const [current, setCurrent] = useState(null);

  const load = () => loadPricingCatalog()
    .then((d) => { setData(d); setError(''); })
    .catch((e) => setError(`价目读取失败：${e.message}`));
  const loadCurrent = () => fetch('/api/pricing/current')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d?.ok) setCurrent(d); })
    .catch(() => {});

  // 身份只在挂载取一次是不够的:面板开着时在顶栏切 provider,范围行与 currentScopeNote 的过滤
  // 集合都还写着上一家(服务端每次现算,错的是这段说明文案在骗人)。刷新节奏抄上面额度卡:
  // chat-done + provider-change 两个事件都重取身份。
  useEffect(() => {
    load(); loadCurrent();
    const onRefresh = () => loadCurrent();
    window.addEventListener('cgui:chat-done', onRefresh);
    window.addEventListener('cgui:provider-change', onRefresh);
    return () => {
      window.removeEventListener('cgui:chat-done', onRefresh);
      window.removeEventListener('cgui:provider-change', onRefresh);
    };
  }, []);

  // scope: 'current' 只刷当前 provider(默认),'all' = 全预设(保留入口,行为不变)。
  const refresh = async (scope) => {
    setBusy(true);
    setRefreshNote('刷新中…');
    const clickedAt = Date.now();
    try {
      const res = await fetch('/api/pricing/refresh', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(scope === 'current' ? { scope: 'current' } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.refreshId) throw new Error(body.error || `HTTP ${res.status}`);
      const id = body.refreshId;
      for (let i = 0; i < 120; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const poll = await fetch(`/api/pricing?refreshId=${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (!poll?.refresh) break;
        setData(setPricingCatalog(poll));
        if (poll.refresh.status !== 'running') break;
      }
      const last = await loadPricingCatalog().catch(() => null);
      if (last) setData(last);
      setRefreshNote(scope === 'current' ? currentScopeNote(last, clickedAt, current?.presetIds) : '');
    } catch (e) {
      setRefreshNote(`刷新失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) {
    return (
      <div>
        <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3">价格与来源</h3>
        <div className="text-[11px] text-ink-faint font-body bg-canvas-warm border border-canvas-deep rounded-lg p-3">{error}</div>
      </div>
    );
  }
  if (!data) return null;

  const providers = data.providers || [];
  const quotes = data.quotes || [];
  const priced = quotes.filter((q) => typeof q.prices?.input === 'number' || typeof q.prices?.output === 'number');
  const byCurrency = new Map();
  for (const quote of priced) {
    if (!byCurrency.has(quote.currency)) byCurrency.set(quote.currency, []);
    byCurrency.get(quote.currency).push(quote);
  }
  const refreshEntries = data.refresh?.providers || [];
  const attn = providers.filter((p) => p.status !== 'fresh');
  const symbol = (cur) => CURRENCY_SYMBOL[cur] || '';
  // 身份还没取到(旧服务端没有这个端点)时退回原行为:按钮 = 全预设刷新,不显示「范围」行。
  const scoped = !!current?.resolved;

  return (
    <div>
      <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3 flex items-center gap-1.5">
        <RefreshCw size={11} />价格与来源
      </h3>
      <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 space-y-2.5">
        <div className="flex items-center gap-2">
          {/* 主按钮名「刷新价格」是合同锁定的字面量,不改。默认范围 = 当前 provider(范围说明收在
              「逐家来源与状态」折叠里);当前 provider 判不出价目身份(自建/中转地址不在预设表里)时
              禁用并在下一行写明原因 —— 这种情况按家刷新无从谈起,悄悄回落全预设等于把请求面又拉回 45 家。 */}
          <button onClick={() => refresh(scoped ? 'current' : 'all')} disabled={busy || (current && !scoped)}
            title={current && !scoped ? current.reason : undefined}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs text-ink-muted hover:text-ink font-body transition-colors bg-canvas border border-canvas-deep rounded-lg disabled:opacity-50">
            <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />{busy ? '刷新中…' : '刷新价格'}
          </button>
        </div>
        {/* r122(用户 2026-09-21):按钮与折叠项之间原有四行说明(范围 / 价目抓取时间 / 各状态计数 /
            原币种条数)不再直接显示,收进对应折叠项(前三行 → 「逐家来源与状态」顶部;原币种那行 →
            「原币种报价」顶部)。此前"状态与币种的概览不藏在折叠里,过期/未映射一眼可见"的决定由用户
            推翻:常态下只留标题、按钮、三个折叠项。
            唯一例外:主按钮因判不出价目身份而禁用时,原因与「刷新全部」出路必须留在折叠外 —— 否则用户
            面对一个点不了的按钮无从下手。 */}
        {current && !scoped && (
          <div className="text-[10px] text-ink-faint font-body">
            {current.reason}
            {' · '}
            <button onClick={() => refresh('all')} disabled={busy}
              className="underline decoration-dotted hover:text-ink-muted disabled:opacity-50">
              刷新全部 {providers.length} 家
            </button>
          </div>
        )}
        {refreshNote && <div className="text-[10px] text-ink-faint font-body">{refreshNote}</div>}
        {/* R40:原先这里是默认展开的普通 <div> —— 刷新一次 45 家逐条铺开,太长。改为与同卡片
            另两个折叠块同款的原生 <details>(默认折叠、用户需要时再展开)。
            计数取 refreshEntries.length(= 本次刷新条目数),不是 providers.length(全部预设,语义不同)。
            开合态依附 DOM 节点:这里不给 key、不用受控 open、块本身的 `N > 0` 条件也不随刷新状态切换
            —— 刷新中每秒 setData 重渲染时 React 走同节点更新,展开态得以保留。 */}
        {refreshEntries.length > 0 && (
          <details>
            <summary className="text-[10px] text-ink-faint font-body cursor-pointer">
              本次刷新逐家结果（{refreshEntries.length} 家 · {data.refresh?.status || '—'}）
            </summary>
            <div className="mt-1.5 space-y-0.5">
              {refreshEntries.map((entry) => (
                <div key={`r-${entry.presetId}`} className="text-[10px] text-ink-muted font-body">
                  {entry.presetId} · {PRICE_STATUS_TEXT[entry.status] || entry.status}{entry.errorCode ? ` · ${entry.errorCode}` : ''}
                </div>
              ))}
            </div>
          </details>
        )}
        {/* 下面两个 <details> 同样不给 key、不受控 open:r122 把说明行挪进来后,它们的子内容随刷新
            每秒变,但 <details> 节点本身位置与条件都不变,展开态照旧保留。 */}
        <details>
          <summary className="text-[10px] text-ink-faint font-body cursor-pointer">逐家来源与状态（{providers.length} 家）</summary>
          <div className="mt-1.5 space-y-1">
            {/* r122:范围行(含「刷新全部」入口)。身份还没取到(旧服务端没有这个端点)时按原行为不显示范围行,
                主按钮本身就是全预设刷新;判不出身份的情况在折叠外(见上)。 */}
            {current && scoped && (
              <div className="text-[10px] text-ink-faint font-body">
                {`范围：当前 provider${current.label ? `（${current.label}）` : ''}`}
                {' · '}
                <button onClick={() => refresh('all')} disabled={busy}
                  className="underline decoration-dotted hover:text-ink-muted disabled:opacity-50">
                  刷新全部 {providers.length} 家
                </button>
              </div>
            )}
            <div className="text-[10px] text-ink-faint font-body">
              价目抓取时间 {shortTime(data.fetchedAt)} · 官方来源 {providers.filter((p) => p.status === 'fresh').length}/{providers.length} 家已更新
              {refreshEntries.length ? ` · 本次刷新 ${refreshEntries.length} 家（其余为上次结果）` : ''}
              {attn.length ? ` · 其余 ${attn.length} 家见下方逐家状态` : ''}
            </div>
            <div className="text-[10px] text-ink-faint font-body">
              {['fresh', 'partial', 'stale', 'source-unavailable', 'not-token-priced', 'unmapped'].map((key) => {
                const count = providers.filter((p) => p.status === key).length;
                if (!count) return null;
                const label = { fresh: '已更新', partial: '部分取得', stale: '已过期（stale）', 'source-unavailable': '来源不可用', 'not-token-priced': '套餐计价', unmapped: '未映射（计价未知）' }[key];
                return <span key={key} className="mr-2">{label} {count}</span>;
              })}
            </div>
            {providers.map((p) => (
              <div key={p.presetId} className="text-[10px] font-body leading-snug">
                <span className="text-ink-muted">{p.presetId}</span>
                <span className="text-ink-faint"> · {PRICE_STATUS_TEXT[p.status] || p.status}</span>
                {p.errorCode && <span className="text-ink-ghost"> · {p.errorCode}</span>}
                {p.fetchedAt && <span className="text-ink-ghost"> · 抓取于 {shortTime(p.fetchedAt)}</span>}
                {p.sourceUrl && (
                  <a className="text-accent underline decoration-dotted ml-1" href={p.sourceUrl} target="_blank" rel="noreferrer">
                    {hostOf(p.sourceUrl)}
                  </a>
                )}
              </div>
            ))}
          </div>
        </details>
        <details>
          <summary className="text-[10px] text-ink-faint font-body cursor-pointer">
            原币种报价（{byCurrency.size} 种币种 / {priced.length} 条）
          </summary>
          <div className="mt-1.5 space-y-2">
            {/* r122:各币种条数那句说明从折叠外挪到这里(信息不丢)。 */}
            <div className="text-[10px] text-ink-faint font-body">
              原币种 {[...byCurrency.entries()].map(([currency, list]) => `${currency} ${list.length} 条`).join(' · ') || '暂无'}
              <span className="text-ink-ghost">（分别标价，不折算成单一币种；未知维度按 null 留空，不写 0）</span>
            </div>
            {[...byCurrency.entries()].map(([currency, list]) => (
              <div key={currency}>
                <div className="text-[10px] text-ink-muted font-body">{currency} · {list.length} 条（单位：每百万 token，不折算成单一币种）</div>
                {list.slice(0, 8).map((q) => (
                  <div key={q.quoteId} className="text-[10px] text-ink-faint font-mono truncate">
                    {q.modelId || q.displayName} · 输入 {symbol(currency)}{q.prices?.input ?? '未知'} / 输出 {symbol(currency)}{q.prices?.output ?? '未知'}
                    {q.prices?.cacheRead != null ? ` / 读 ${symbol(currency)}${q.prices.cacheRead}` : ''}
                    {q.prices?.cacheWrite5m != null ? ` / 写(5m) ${symbol(currency)}${q.prices.cacheWrite5m}` : ''}
                  </div>
                ))}
                {list.length > 8 && <div className="text-[10px] text-ink-ghost font-body">…另有 {list.length - 8} 条</div>}
              </div>
            ))}
            {!priced.length && (
              <div className="text-[10px] text-ink-faint font-body">
                当前没有取到可用报价（来源不可用或未映射）。缺数据就标未知，不编价、不写 0。
              </div>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 时段表的星期集合 → 可读文案(连续的收成「周一至周五」,断开的分段列)。 */
function weekdayLabel(days) {
  // 周一=1 … 周日=7(周六 6、周日 0 → 7),连续段只看数字是否挨着
  const sorted = [...new Set(days)].map((d) => (d === 0 ? 7 : d)).sort((a, b) => a - b);
  const runs = [];
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (last && day === last[1] + 1) last[1] = day;
    else runs.push([day, day]);
  }
  return runs.map(([from, to]) => (
    from === to ? WEEKDAY_NAMES[from % 7] : `${WEEKDAY_NAMES[from % 7]}至${WEEKDAY_NAMES[to % 7]}`
  )).join('、');
}

/** 高峰时间窗 → 可读文案(当天第几分钟 → HH:MM)。 */
function windowLabel(windows) {
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return windows.map(([start, end]) => `${hhmm(start)}–${hhmm(end)}`).join('、');
}

/** UTC 偏移分钟 →「UTC+08:00」。 */
function offsetLabel(minutes) {
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  return `UTC${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

/**
 * 用量面板的「当前计价时段」行 —— 面板正在展示的模型里有峰谷(分时段)报价时才出现。
 *
 * 【什么时候显示】展示的模型里至少一个带分时段报价(hasPeriodQuote,与计价同一判据)。
 * 不按 provider 名字白名单:第二家出峰谷价时这里自动跟着生效,不用改代码。
 * 【档位怎么来】periodFor(本机此刻),判定逻辑零新增;判不出(非法时刻)整行不显示 ——
 * 宁缺勿猜,不显示「未知」糊过去。
 * 【刷新】只用默认参数;时刻在每次重渲染时重新取,跟着面板既有的 30s 轮询与
 * usage-updated 广播走,不新开定时器(跨时段边界最多延迟一个轮询周期)。
 * 【口径必须写清】下方金额是每条记录按**它自己时间戳**所属档位各计价后相加(见
 * pricing.js 的 aggregateCost),与此刻是哪一档无关 —— 不写这句必被误读成"金额随当前档位变"。
 * 【时区】判定固定按北京时间(+08:00),与本机时区可能不同,行内标明。
 *
 * @param byModel  服务端 /api/usage 的 stats.byModel
 * @param nowMs    判定时刻(epoch 毫秒);默认本机此刻,测试用固定时刻打桩
 */
export function UsagePeriodNote({ byModel, nowMs = Date.now() }) {
  const rows = Array.isArray(byModel) ? byModel : [];
  if (!rows.some((m) => hasPeriodQuote(m?.model))) return null;
  const period = periodFor(nowMs);
  if (period.key !== 'peak' && period.key !== 'off-peak') return null;
  const schedule = PERIOD_SCHEDULES[DEFAULT_SCHEDULE_KEY];
  const peak = period.key === 'peak';
  return (
    <div className="mb-2 space-y-0.5 text-[10px] leading-relaxed text-ink-faint font-body">
      <div>
        当前计价时段（北京时间 {offsetLabel(schedule.utcOffsetMinutes)}）：
        <span className="text-ink font-medium">{peak ? '高峰' : '空闲'}</span>
      </div>
      <div>
        高峰为{weekdayLabel(schedule.weekdays)} {windowLabel(schedule.peakWindows)}，其余时间为空闲。
      </div>
      <div>
        下方金额按每条记录自身时间戳所属的时段分档计价后相加（高峰档用高峰价、空闲档用空闲价；时段未知的记录不计入），不按当前时段计算。
      </div>
    </div>
  );
}

export function UsagePanel() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  // R4-a:与消息气泡同源的 provider,透传给 aggregateCost —— 两个视图必须用同一个判据,
  // 否则又会出现"面板和气泡对同一批数据给两个数"。
  const provider = useStore((s) => s.currentProvider);

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
    // 服务端用量统计的后台重算落地即广播(cgui:usage-updated)→ 静默重取。打开面板时
    // 看到的可能是磁盘回放的旧值,没有这条就只能等下面那一轮 30 秒轮询才收敛。
    const onUsageUpdated = () => fetchStats(true);
    window.addEventListener('cgui:usage-updated', onUsageUpdated);
    // Also poll every 30s as fallback (covers external claude invocations).
    const id = setInterval(() => fetchStats(true), 30_000);
    return () => {
      window.removeEventListener('cgui:chat-done', onChatDone);
      window.removeEventListener('cgui:usage-updated', onUsageUpdated);
      clearInterval(id);
    };
  }, []);

  if (loading) {
    // R24:价格与来源区不依赖用量统计(/api/usage 要扫全部会话,慢),别把它压在一次
    // 全量统计后面 —— 面板一打开就先给价目、口径名与逐家状态,统计数字随后填。
    return (
      <div className="px-4 py-4 space-y-5 overflow-y-auto h-full">
        <PricingCard />
        <div>
          <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3">总览</h3>
          <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 flex items-center gap-2 text-[11px] text-ink-faint font-body">
            <RefreshCw size={12} className="animate-spin" />
            正在统计全部会话…（会话累计命中率的加权分母要等这份统计回来）
          </div>
        </div>
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
      {/* 刷新/导出提到顶部:原在最底,每次要滑到底才能点(用户实报)。按钮原样上移,零行为变化。 */}
      {/* R24:价格与来源区(逐家状态 + 「刷新价格」)放最前,刷新入口一眼可见。 */}
      <PricingCard />
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
      {/* W7/R41:官方订阅额度卡 —— 按 provider 身份条件显示(旧注释"非官方 provider 自动隐藏"与
          代码不符,一直是错的):官方订阅/身份未知 → 现状卡;Claude API 按量 → 说明卡;第三方 → 不渲染。
          身份判据与优先级在 SubscriptionUsageCard 的 resolveSubscriptionCardMode 里。 */}
      <SubscriptionUsageCard />
      {/* r16-2:第三方 provider 额度/余额(官方 provider 自动隐藏,与上面那张互斥) */}
      <ProviderQuotaCard />
      {/* 使用报告(/insights)——按需生成 HTML 报告 */}
      <InsightsReportCard />
      {/* Total summary */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body">
            总览
          </h3>
          {/* meta.stale=true:这份数是磁盘回放的旧值,服务端正在核对期间有没有新会话。
              如实说明,不把旧数当新数;核对/重算一落地服务端就广播 usage-updated,这里自动消失。 */}
          {stats.meta?.stale && (
            <span className="text-[10px] text-ink-ghost font-body"
              title="打开面板时先显示本机缓存的统计,服务端正在核对期间是否有新写入;核对完成后会自动刷新。">
              统计中，数据可能略旧
            </span>
          )}
        </div>
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
          {/* r89:累计缓存命中率与累计未命中 token。命中率 = 缓存命中 /(输入+缓存命中+缓存写入);
              未命中 = 输入 + 缓存写入,即按未命中价计费的那部分提示 token(第三方 provider 上
              未命中价常是命中价的一二十倍,这个数字直接对应花掉的钱)。 */}
          {(() => {
            const c = addCacheUsage(EMPTY_CACHE_USAGE, {
              input_tokens: stats.total.input,
              cache_read_input_tokens: stats.total.cacheRead,
              cache_creation_input_tokens: stats.total.cacheWrite || 0,
            });
            return (
              <>
                <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3"
                  title="会话累计命中率 = 缓存命中 /（普通 input + 缓存命中 + 缓存写入）。统计口径为全部已落盘会话的加权累计值（先加总量再算比例，不是按次平均）；分母为 0 时显示 —。">
                  <div className="text-[10px] text-ink-faint font-body mb-0.5">会话累计命中率</div>
                  <div className="text-lg font-mono font-medium text-ink">{formatHitPctOrDash(c.hitPct, c.total)}</div>
                </div>
                <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3"
                  title="未命中 = 输入 + 缓存写入，即按未命中价计费的提示 token 累计量。">
                  <div className="text-[10px] text-ink-faint font-body mb-0.5">未命中 token</div>
                  <div className="text-lg font-mono font-medium text-ink">{formatNum(c.miss)}</div>
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {/* By provider → models. Provider header shows total cost (no tokens);
          each model row underneath shows its tokens + per-model cost. */}
      <div>
        <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body mb-3 flex items-center gap-1.5">
          <Cpu size={11} />
          按 Provider · 模型
        </h3>
        {/* 峰谷计价模型在场时才出这一行(判据在组件内:hasPeriodQuote + periodFor) */}
        <UsagePeriodNote byModel={stats.byModel} />
        <div className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 space-y-3">
          {/* CQ批次4:provider 级用量柱状图(沿用 BarRow,零依赖)。付费=主色,订阅/免费=灰。 */}
          {(() => {
            const groups = groupByProvider(stats.byModel, provider);
            if (groups.length < 2) return null;
            const maxTok = Math.max(...groups.map((g) => g.tokens), 1);
            return (
              <div className="pb-2 mb-1 border-b border-canvas-deep">
                {groups.map((g) => (
                  <BarRow key={`bar-${g.key}`} label={g.label} value={g.tokens} max={maxTok}
                    color={g.priced ? 'var(--color-accent)' : 'color-mix(in srgb, var(--color-ink-faint) 60%, transparent)'} />
                ))}
              </div>
            );
          })()}
          {groupByProvider(stats.byModel, provider).map((g) => (
            <div key={g.key}>
              {/* Provider header — name + total cost (订阅内 / $x / —). */}
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[11px] font-semibold text-ink font-body">{g.label}</span>
                <span className="text-[9px] text-ink-ghost font-mono">{g.models.length} 模型</span>
                <div className="flex-1" />
                {g.priced ? (
                  <span className="text-[11px] text-accent font-mono">{formatCost(g.usd)}</span>
                ) : g.subscription ? (
                  <span className="text-[10px] text-ink-faint font-body" title="按订阅或套餐计费，不按 token 计价">订阅内</span>
                ) : (
                  <span className="text-[10px] text-ink-ghost font-mono" title="无定价数据">—</span>
                )}
              </div>
              {/* Model rows */}
              <div className="pl-2 border-l border-canvas-deep space-y-1.5">
                {g.models.map((m) => {
                  const cost = aggregateCost(m.model, m, provider);
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
                        <span
                          className="text-[10px] text-accent font-mono shrink-0 w-14 text-right"
                          title={cost.partial ? '该行含无法定价的部分（如缺 TTL 分配的写量 / 时段未知的调用），显示的是已知小计' : undefined}
                        >
                          {formatCost(displayUsd(cost.usd, cost.currency))}{cost.partial ? ' *' : ''}
                        </span>
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
            const total = stats.byModel.reduce((acc, m) => {
              const c = aggregateCost(m.model, m, provider);
              return acc + (c.usd != null ? displayUsd(c.usd, c.currency) : 0);
            }, 0);
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

    </div>
  );
}
