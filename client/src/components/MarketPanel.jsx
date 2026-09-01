// r73 统一「扩展市场」:三类扩展的**发现层**收进一个入口(已安装管理仍留在各自面板 ——
// 技能是文件三态、插件要新会话生效、MCP 有 ping/OAuth/单工具启停,语义差别太大,合并只会搅烂)。
//
// 三个页签全部复用既有数据与既有安装链路,本文件不新增任何执行通道:
//   技能 → 直接挂 SkillsPanel 的市场页(marketOnly),来源分面 / 导入链路一行没复制
//   插件 → GET /api/plugins/available(服务端按 installCount 降序),装走既有 POST /api/plugins/install
//          (= claude plugin CLI 通道),错误文案复用 pluginInstallErrorMessage
//   MCP  → GET /api/mcp/registry-search(空词=浏览首页,cursor 翻页),行动作只把条目**预填**
//          进既有 McpForm,不自动连接、不自动安装
//
// 注册表与插件目录返回的名称/描述/命令全是第三方外部数据,一律当纯文本渲染:
// 不走任何 HTML 注入或动态求值接口(单测把这条钉成断言)。
import { useState, useEffect, useMemo, useRef } from 'react';
import { Search, RefreshCw, Download, Check, Plus, Package, Server, Sparkles, ExternalLink } from './Icon.jsx';
import { SkillsPanel } from './SkillsPanel.jsx';
import { McpForm } from './McpForm.jsx';
import { confirmDialog } from '../utils/confirmDialog.jsx';
import { pluginInstallErrorMessage } from '../utils/builtinPlugins.js';
import { ALL_KINDS, KIND_LABELS, countByKind, filterByKind, appendPage } from '../utils/mcpBrowse.js';
import { openExternalUrl } from '../utils/openExternal.js';

// 长列表沿用 r71 的零依赖方案:浏览器原生 content-visibility 跳过视口外条目的渲染开销。
const ROW_CV = { contentVisibility: 'auto', containIntrinsicSize: 'auto 64px' };

const MARKET_TABS = [
  { id: 'skills', label: '技能', icon: Sparkles, hint: '搜索市场技能（名称 / 描述，多个词需全部命中）...' },
  { id: 'plugins', label: '插件', icon: Package, hint: '搜索插件（名称 / 描述 / 来源市场）...' },
  { id: 'mcp', label: 'MCP', icon: Server, hint: '搜索 MCP 服务器（留空浏览注册表）...' },
];
const LS_KEY = 'cgui-market-tab';

export function MarketPanel() {
  const [tab, setTabState] = useState(() => {
    try { const v = localStorage.getItem(LS_KEY); return MARKET_TABS.some((t) => t.id === v) ? v : 'skills'; }
    catch { return 'skills'; }
  });
  const setTab = (id) => { setTabState(id); try { localStorage.setItem(LS_KEY, id); } catch {} };
  // 统一搜索框:一个输入框,作用于当前页签(三类的检索口径不同,故各页签自己消费它)。
  const [q, setQ] = useState('');

  // ── 插件页:GET /api/plugins/available(服务端缓存 CLI 输出 + 过滤 + 按热度排序)──
  const [pl, setPl] = useState(null);              // null | { total, items, cachedAt }
  const [plLoading, setPlLoading] = useState(false);
  const [plErr, setPlErr] = useState('');
  const [plFresh, setPlFresh] = useState(0);       // 刷新按钮:递增即重拉(fresh=1 绕后端缓存)
  const [installing, setInstalling] = useState('');
  const [justInstalled, setJustInstalled] = useState(() => new Set()); // 本次会话内装成功的(后端列表有缓存,不会立刻翻态)
  useEffect(() => {
    if (tab !== 'plugins') return;
    let alive = true;
    const t = setTimeout(async () => {
      setPlLoading(true); setPlErr('');
      try {
        const r = await fetch(`/api/plugins/available?q=${encodeURIComponent(q.trim())}${plFresh ? '&fresh=1' : ''}`);
        const d = await r.json();
        if (!alive) return;
        if (!r.ok) throw new Error(d.error || '获取插件列表失败');
        setPl(d);
      } catch (e) { if (alive) setPlErr(e.message); }
      if (alive) setPlLoading(false);
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [tab, q, plFresh]);

  const installPlugin = async (row) => {
    setInstalling(row.name); setPlErr('');
    try {
      const r = await fetch('/api/plugins/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: row.name, ...(row.marketplace ? { marketplace: row.marketplace } : {}) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(pluginInstallErrorMessage(d.error));
      setJustInstalled((p) => new Set(p).add(row.name));
      setInstalling(''); // 先停 spinner 再弹窗
      await confirmDialog(`插件「${row.name}」已安装(新会话生效)`, { confirmText: '知道了' });
    } catch (e) { setPlErr(`${row.name}: ${e.message}`); }
    setInstalling('');
  };

  // ── MCP 页:GET /api/mcp/registry-search(空词 = 浏览首页;cursor 浅翻)──────────
  const [mcpItems, setMcpItems] = useState([]);
  const [mcpCursor, setMcpCursor] = useState('');
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpErr, setMcpErr] = useState('');
  const [kind, setKind] = useState(ALL_KINDS);
  const [seed, setSeed] = useState(null);          // 选中要预填进 McpForm 的注册表条目
  const mcpReq = useRef(0);                        // 竞态:只认最后一次发起的请求
  const loadMcp = async (cursor = '') => {
    const my = ++mcpReq.current;
    setMcpLoading(true); setMcpErr('');
    try {
      const term = q.trim();
      const r = await fetch(`/api/mcp/registry-search?q=${encodeURIComponent(term)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const d = await r.json();
      if (my !== mcpReq.current) return;
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      // 翻页 = 追加;首页 = 替换。翻页失败时保留已加载条目(见下方 catch),不把列表清空。
      setMcpItems((prev) => (cursor ? appendPage(prev, d.items || []) : (d.items || [])));
      setMcpCursor(String(d.nextCursor || ''));
    } catch (e) {
      if (my === mcpReq.current) { setMcpErr(e.message); if (!cursor) { setMcpItems([]); setMcpCursor(''); } }
    }
    if (my === mcpReq.current) setMcpLoading(false);
  };
  useEffect(() => {
    if (tab !== 'mcp') return;
    const t = setTimeout(() => { loadMcp(''); }, 400); // 关键词去抖;空词即浏览首页
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q]);
  const kindCounts = useMemo(() => countByKind(mcpItems), [mcpItems]);
  const mcpView = useMemo(() => filterByKind(mcpItems, kind), [mcpItems, kind]);

  const active = MARKET_TABS.find((t) => t.id === tab) || MARKET_TABS[0];

  return (
    // flex 列三段:头部(页签+搜索)固定,正文自己滚 —— 面板容器带 transform 时 sticky 在
    // WKWebView 失效,一律用 flex 列(项目既有坑)。
    <div data-testid="ext-market" className="flex flex-col h-full">
      <div className="shrink-0 px-4 pt-4 pb-2 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-medium uppercase tracking-widest text-ink-faint font-body">扩展市场</h2>
          {tab === 'plugins' && (
            <button onClick={() => setPlFresh((v) => v + 1)} disabled={plLoading}
              title="刷新插件目录(重跑 claude plugin list --available,绕过服务端缓存)"
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-ink-faint hover:text-ink-muted hover:bg-canvas-warm font-body transition-colors disabled:opacity-50">
              <RefreshCw size={12} className={plLoading ? 'animate-spin' : ''} />刷新
            </button>
          )}
          {tab === 'mcp' && (
            <button onClick={() => loadMcp('')} disabled={mcpLoading}
              title="重新拉取注册表当前页"
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-ink-faint hover:text-ink-muted hover:bg-canvas-warm font-body transition-colors disabled:opacity-50">
              <RefreshCw size={12} className={mcpLoading ? 'animate-spin' : ''} />刷新
            </button>
          )}
        </div>
        <div role="tablist" aria-label="扩展市场分类" className="flex items-center gap-0.5 border-b border-canvas-deep -mx-4 px-4">
          {MARKET_TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} data-testid="ext-market-tab" data-tab={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-body transition-colors border-b-2 -mb-px ${
                tab === t.id ? 'border-accent text-ink font-medium' : 'border-transparent text-ink-muted hover:text-ink'}`}>
              <t.icon size={11} />{t.label}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-ghost" />
          <input
            type="text" value={q} onChange={(e) => setQ(e.target.value)} data-testid="ext-market-search"
            placeholder={active.hint}
            className="w-full bg-canvas border border-canvas-deep rounded-lg pl-8 pr-3 py-1.5 text-xs text-ink placeholder-ink-ghost focus:outline-none focus:border-accent/40 font-body" />
        </div>
      </div>

      {/* 技能页 = SkillsPanel 的市场页原件(自带滚动容器);其余两页由本面板滚动 */}
      <div className={`flex-1 min-h-0 ${tab === 'skills' ? '' : 'overflow-y-auto px-4 pb-4 space-y-2'}`}>
        {tab === 'skills' && <SkillsPanel marketOnly marketQuery={q} />}

        {tab === 'plugins' && (<>
          <div className="text-[10px] text-ink-faint font-body">
            来源为已配置的插件市场(claude plugin marketplace),不是全网清单;按安装量降序。安装执行 claude plugin install,新会话生效。
          </div>
          {plErr && <div className="text-[11px] text-error bg-error/10 border border-error/20 rounded px-2 py-1.5 break-all" data-testid="plugin-market-error">{plErr}</div>}
          {pl && (
            <div className="text-[10px] text-ink-faint font-body" data-testid="plugin-market-count">
              {q.trim() ? `命中 ${pl.total} 条` : `共 ${pl.total} 条可装插件`}
              {pl.total > pl.items.length ? `,仅显示前 ${pl.items.length} 条,请细化关键词` : ''}
            </div>
          )}
          {plLoading && !pl && <div className="flex items-center gap-1.5 text-[11px] text-ink-faint py-4 justify-center"><RefreshCw size={12} className="animate-spin" />加载中…</div>}
          {pl && pl.items.length === 0 && <div className="text-xs text-ink-faint font-body py-6 text-center bg-canvas-warm border border-canvas-deep rounded-lg" data-testid="plugin-market-empty">没有匹配的插件</div>}
          <div className="space-y-2" data-testid="plugin-market-list">
            {(pl?.items || []).map((row) => {
              const installed = row.installed || justInstalled.has(row.name);
              return (
                <div key={row.pluginId} data-testid="plugin-market-row" style={ROW_CV}
                  className="bg-canvas-warm border border-canvas-deep rounded-lg p-3 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {/* 面板比弹层窄:名称占满剩余宽(min-w-0 才会真截断),徽章 shrink-0 不被挤走 */}
                      <span className="min-w-0 flex-1 text-xs font-medium text-ink font-body truncate" title={row.pluginId}>{row.name}</span>
                      {row.installCount > 0 && (
                        <span className="shrink-0 text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono" data-testid="plugin-install-count"
                          title="安装次数(claude plugin list --available 提供)">
                          {row.installCount.toLocaleString('en-US')}
                        </span>
                      )}
                    </div>
                    {/* 描述最长两行:目录里有近千字的条目,铺开会把一屏挤成一条 */}
                    {row.description && <div className="text-[10px] text-ink-faint font-body leading-snug mt-0.5 line-clamp-2">{row.description}</div>}
                    {row.marketplace && <div className="text-[9px] text-ink-ghost font-mono mt-0.5 truncate">{row.marketplace}</div>}
                  </div>
                  {installed ? (
                    <span className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-[12px] font-medium text-success"><Check size={12} />已安装</span>
                  ) : (
                    <button onClick={() => installPlugin(row)} disabled={!!installing} data-testid="plugin-install-btn"
                      className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded text-[12px] font-medium text-on-accent bg-accent hover:bg-accent-hover disabled:opacity-50">
                      {installing === row.name ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}
                      {installing === row.name ? '安装中…' : '安装'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>)}

        {tab === 'mcp' && (<>
          <div className="text-[10px] text-ink-faint font-body">
            数据来自 registry.modelcontextprotocol.io。点「添加」只把配置预填进添加表单,不会自动连接或安装;确认或修改后由你提交。
          </div>
          {/* kind 分面:计数口径是**已加载**的条目(注册表按游标浅翻,拿不到全库统计) */}
          <div className="flex items-center gap-1.5 flex-wrap text-[11px] font-body" data-testid="mcp-kind-facet">
            {[[ALL_KINDS, '全部', mcpItems.length], ...Object.keys(KIND_LABELS).map((k) => [k, KIND_LABELS[k], kindCounts[k] || 0])].map(([v, label, n]) => (
              <button key={v} data-testid="mcp-kind-chip" data-kind={v} onClick={() => setKind(v)}
                className={`px-2 py-0.5 rounded-md border transition-colors ${
                  kind === v ? 'border-accent text-accent bg-accent/10' : 'border-canvas-deep text-ink-muted hover:text-ink'}`}>
                {label}<span className="ml-1 font-mono opacity-70" data-testid="mcp-kind-count">{n}</span>
              </button>
            ))}
            <span className="text-[10px] text-ink-faint">已加载 {mcpItems.length} 条内的分布</span>
          </div>
          {mcpErr && (
            <div className="text-[11px] text-error bg-error/10 border border-error/20 rounded px-2 py-1.5 break-all" data-testid="mcp-market-error">
              {mcpErr}
            </div>
          )}
          {mcpLoading && mcpItems.length === 0 && <div className="flex items-center gap-1.5 text-[11px] text-ink-faint py-4 justify-center"><RefreshCw size={12} className="animate-spin" />加载中…</div>}
          {!mcpLoading && mcpItems.length === 0 && !mcpErr && (
            <div className="text-xs text-ink-faint font-body py-6 text-center bg-canvas-warm border border-canvas-deep rounded-lg" data-testid="mcp-market-empty">
              {q.trim() ? `没有匹配「${q.trim()}」的 MCP 服务器` : '注册表暂无可预填条目'}
            </div>
          )}
          <div className="space-y-2" data-testid="mcp-market-list">
            {mcpView.map((it) => (
              <div key={it.name} data-testid="mcp-market-row" style={ROW_CV}
                className="bg-canvas-warm border border-canvas-deep rounded-lg p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-ink font-body truncate flex-1" title={it.name}>{it.id || it.name}</span>
                  <span className="shrink-0 text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-body" data-testid="mcp-row-kind">
                    {KIND_LABELS[it.kind] || it.kind}
                  </span>
                  {it.version && <span className="shrink-0 text-[10px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono">v{it.version}</span>}
                  <button onClick={() => setSeed(it)} data-testid="mcp-prefill-btn"
                    title="把该条目的配置预填进添加表单(不会自动连接)"
                    className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-accent/10 text-accent hover:bg-accent/20">
                    <Plus size={10} />添加
                  </button>
                </div>
                <div className="text-[10px] text-ink-faint font-mono truncate mt-1">{it.commandLine || it.url}</div>
                {it.description && <div className="text-[11px] text-ink-muted font-body mt-1 line-clamp-2">{it.description}</div>}
                {it.repository && (
                  // 注册表 repository 是第三方外部数据:不裸 href(javascript: 会透出),
                  // 走 openExternalUrl(/api/open-url 有 http/https 白名单);Tauri WebView
                  // 本就拦 target=_blank,裸链接在装机版是死链(判官 r73 建议级)。
                  <a href={it.repository} target="_blank" rel="noreferrer"
                    onClick={(e) => { e.preventDefault(); openExternalUrl(it.repository); }}
                    className="inline-flex items-center gap-1 text-[10px] text-ink-faint hover:text-accent font-mono mt-1">
                    <ExternalLink size={10} />{it.repository}
                  </a>
                )}
              </div>
            ))}
          </div>
          {mcpCursor && (
            <button onClick={() => loadMcp(mcpCursor)} disabled={mcpLoading} data-testid="mcp-market-more"
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-canvas-deep text-[12px] font-body text-ink-muted hover:text-ink hover:bg-canvas-deep disabled:opacity-50">
              {mcpLoading ? <RefreshCw size={13} className="animate-spin" /> : null}
              {mcpLoading ? '加载中…' : '加载更多'}
            </button>
          )}
        </>)}
      </div>

      {/* 预填的添加表单 = 既有 McpForm 原件(校验/提交/探测全走它自己的流程) */}
      {seed && <McpForm editing={null} seed={seed} onClose={() => setSeed(null)} onSaved={() => setSeed(null)} />}
    </div>
  );
}
