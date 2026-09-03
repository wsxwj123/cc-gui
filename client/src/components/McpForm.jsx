import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Trash2, RefreshCw, ExternalLink, ArrowLeft, Search, ChevronRight } from './Icon.jsx';
import { BUILTIN_MCP_SERVERS, findBuiltinMcp } from '../utils/builtinMcpServers.js';
import { openExternalUrl } from '../utils/openExternal.js';

// MCP 服务器 添加/编辑 表单(模态)。
//  - editing=null → 新增;editing={name} → 编辑(挂载时拉 /config 回填)。
//  - 命令行按 claude code 官方配置拆成 command + args[](后端 parseCommandLine)。
//  - http/sse 类型时"命令"变为 URL。
//  - 自动执行工具 = 该 server 工具自动放行(写入 mcp-autoapprove.json)。
const TRANSPORTS = [
  { v: 'stdio', label: '命令行 (stdio)' },
  { v: 'http', label: 'HTTP 请求 (http)' },
  { v: 'sse', label: 'SSE 请求 (sse, 不推荐)' },
];
const SCOPES = [
  { v: 'user', label: 'user · 所有项目可用' },
  { v: 'project', label: 'project · 仅当前项目(.mcp.json)' },
  { v: 'local', label: 'local · 仅本机当前项目' },
];

// 请求头键名校验:RFC 7230 token 字符集。与 server/routes/mcp.js 的 HEADER_KEY_RE 同一
// 口径 —— server 对非法键静默丢弃(仅响应带 warning),这里在提交前即时标红,改任一侧必须同步另一侧。
const HEADER_KEY_RE = /^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/;

// seed:r73 扩展市场的 MCP 行点「添加」时带进来的注册表条目 —— 挂载即预填表单
// (与面板内注册表搜索选中同一条路径),用户确认后才走下方「添加」提交,不自动连接/安装。
export function McpForm({ editing, seed, onClose, onSaved }) {
  const isEdit = !!editing;
  // 不再用全屏 spinner 阻塞:编辑时立即用列表已有的 command/transport 回填,表单秒开可编辑。
  // env/scope/autoApprove/label 这些列表里没有的字段后台拉 /config 补齐(claude mcp get 冷启动 ~3s)。
  const seedTransport = editing?.transport || 'stdio';
  const seedCmd = editing?.command
    ? (editing.command + (editing.args?.length ? ' ' + editing.args.join(' ') : ''))
    : '';
  const [refining, setRefining] = useState(isEdit); // 后台补全中
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState(''); // 保存成功但 server 丢弃了非法请求头键时的响应 warning

  const [name, setName] = useState(editing?.name || '');
  const [label, setLabel] = useState('');
  const [transport, setTransport] = useState(seedTransport);
  const [commandLine, setCommandLine] = useState(seedTransport === 'stdio' ? seedCmd : '');
  const [url, setUrl] = useState(seedTransport !== 'stdio' ? seedCmd : '');
  const [scope, setScope] = useState('user');
  const [autoApprove, setAutoApprove] = useState(false);
  const [envRows, setEnvRows] = useState([]); // [{k,v}]
  const [headerRows, setHeaderRows] = useState([]); // [{k,v,hint}] 仅 http/sse:自定义请求头(claude mcp add -H "Key: Value")
  // 工具管理(仅编辑现有 server):列出该 server 暴露的工具,逐个启用/禁用(禁用=模型看不到,
  // 走 SDK disallowedTools)。解决 paper-search 这类一 server 十几工具、模型乱选 crossref 的噪音。
  const [toolsState, setToolsState] = useState({ open: false, loading: false, list: null, err: '', note: '' });
  const [toolsBusy, setToolsBusy] = useState(''); // 正在切换的工具名(防重复点)
  const [tplMeta, setTplMeta] = useState(null); // 选模板后的提示:{ note, needsArg, repo, docs }
  // uvx 型模板(Fetch / Paper Search)需要本机有 uv。选中时实时检测,缺失则内联引导安装。
  const [uvStatus, setUvStatus] = useState('idle'); // idle|checking|ok|missing|launched

  const checkUv = async () => {
    setUvStatus('checking');
    try {
      const r = await fetch('/api/env-check', { cache: 'no-store' });
      const d = await r.json();
      setUvStatus(d?.uv?.installed ? 'ok' : 'missing');
    } catch { setUvStatus('idle'); } // server 异常不阻断,按未知处理
  };
  const installUv = async () => {
    try {
      const r = await fetch('/api/env-check/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'uv' }),
      });
      const d = await r.json();
      if (d.ok) setUvStatus('launched');
    } catch {}
  };
  // 用户一旦改过命令/URL,后台补全就不再覆盖这两个字段,避免边输入边被刷掉。
  const dirtyRef = React.useRef(false);

  // 注册表搜索(仅新增态,折叠式,交互对齐插件面板的全市场搜索):关键词去抖 400ms 后
  // GET /api/mcp/registry-search(后端 15min 缓存)。选中条目 → applyRegistryItem 预填表单,
  // 用户可改可取消,最终仍走下方「添加」按钮的现有提交流程。
  const [regOpen, setRegOpen] = useState(false);
  const [regQuery, setRegQuery] = useState('');
  const [regItems, setRegItems] = useState(null); // null | []
  const [regLoading, setRegLoading] = useState(false);
  const [regErr, setRegErr] = useState('');
  useEffect(() => {
    // 早退也要复位 regLoading:在飞请求的完成回调被 alive=false 跳过,不复位则"搜索中"常驻。
    if (!regOpen || !regQuery.trim()) { setRegItems(null); setRegErr(''); setRegLoading(false); return; }
    let alive = true;
    const t = setTimeout(async () => {
      setRegLoading(true); setRegErr('');
      try {
        const r = await fetch(`/api/mcp/registry-search?q=${encodeURIComponent(regQuery.trim())}`);
        const d = await r.json();
        if (!alive) return;
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        setRegItems(d.items || []);
      } catch (e) { if (alive) { setRegErr(e.message); setRegItems(null); } }
      if (alive) setRegLoading(false);
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [regOpen, regQuery]);
  // 注册表条目内容是外部数据,仅作为表单初值填入,不自动提交安装。
  const applyRegistryItem = (it) => {
    setName(it.id || '');
    setLabel('');
    setTransport(it.transport || 'stdio');
    if (it.transport === 'stdio') { setCommandLine(it.commandLine || ''); setUrl(''); }
    else { setUrl(it.url || ''); setCommandLine(''); }
    setEnvRows((it.env || []).map((e) => ({ k: e.k, v: '', hint: e.hint || '' })));
    // 条目声明的请求头只预填键名,值留空由用户填(isSecret 等提示在 hint 里)。
    setHeaderRows((it.headers || []).map((h) => ({ k: h.k, v: '', hint: h.hint || '' })));
    setTplMeta(it.repository ? { note: '来自 MCP 注册表,配置已预填,确认或修改后点「添加」。', repo: it.name, docs: it.repository } : null);
    if (/^uvx?\s/.test(it.commandLine || '')) checkUv(); else setUvStatus('idle');
    dirtyRef.current = true;
    setErr('');
  };

  // 外部带入的注册表条目:仅挂载时预填一次(之后用户的编辑不被覆盖)。
  useEffect(() => { if (!isEdit && seed) applyRegistryItem(seed); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 选内置模板自动回填字段;需密钥的把 env 占位 key 填好(value 留空,用户补)。
  const applyTemplate = (id) => {
    const t = findBuiltinMcp(id);
    if (!t) return;
    setName(t.id);
    setLabel(t.name);
    setTransport(t.transport);
    if (t.transport === 'stdio') { setCommandLine(t.commandLine || ''); setUrl(''); }
    else { setUrl(t.url || ''); setCommandLine(''); }
    // 保留目录里的 hint(如「在 tavily.com 申请」):作为 value 输入框 placeholder 告诉用户去哪拿。
    setEnvRows((t.env || []).map((e) => ({ k: e.k, v: '', hint: e.hint || '' })));
    setHeaderRows([]); // 内置模板不声明请求头,换模板时清掉上一次预填
    setTplMeta({ note: t.note, needsArg: t.needsArg, repo: t.repo, docs: t.docs });
    // uvx/uv 开头的命令需要 uv;选中即检测,其余模板清掉 uv 提示。
    if (/^uvx?\s/.test(t.commandLine || '')) checkUv(); else setUvStatus('idle');
    dirtyRef.current = true;
    setErr('');
  };

  // 编辑:后台拉结构化配置补全(env/scope 等),不阻塞已可编辑的表单。
  useEffect(() => {
    if (!isEdit) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/mcp/${encodeURIComponent(editing.name)}/config`);
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(d.error || '读取配置失败');
        setName(d.name || editing.name);
        setLabel(d.label || '');
        setScope(d.scope || 'user');
        setAutoApprove(!!d.autoApprove);
        setEnvRows(Object.entries(d.env || {}).map(([k, v]) => ({ k, v: String(v) })));
        setHeaderRows(Object.entries(d.headers || {}).map(([k, v]) => ({ k, v: String(v) })));
        // 命令/URL/类型:仅当用户尚未编辑时用权威值校正(列表里的种子通常已正确)。
        if (!dirtyRef.current) {
          setTransport(d.transport || 'stdio');
          setCommandLine(d.commandLine || '');
          setUrl(d.url || '');
        }
      } catch (e) {
        if (!cancelled) setErr(e.message);
      } finally {
        if (!cancelled) setRefining(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isEdit, editing]);

  const setEnv = (i, key, val) => setEnvRows((rows) => rows.map((r, idx) => idx === i ? { ...r, [key]: val } : r));
  const addEnv = () => setEnvRows((rows) => [...rows, { k: '', v: '' }]);
  const delEnv = (i) => setEnvRows((rows) => rows.filter((_, idx) => idx !== i));
  const setHeader = (i, key, val) => setHeaderRows((rows) => rows.map((r, idx) => idx === i ? { ...r, [key]: val } : r));
  const addHeader = () => setHeaderRows((rows) => [...rows, { k: '', v: '' }]);
  const delHeader = (i) => setHeaderRows((rows) => rows.filter((_, idx) => idx !== i));

  const loadTools = async () => {
    setToolsState((s) => ({ ...s, open: true, loading: true, err: '', note: '' }));
    try {
      // 编辑:按已配置的 server 名查;添加:按表单草稿配置直接握手预览(添加前就能看到工具清单)。
      const r = isEdit
        ? await fetch(`/api/mcp/${encodeURIComponent(editing.name)}/tools`)
        : await fetch('/api/mcp/preview-tools', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transport, commandLine, env: Object.fromEntries(envRows.filter((x) => x.k.trim()).map((x) => [x.k.trim(), x.v ?? ''])) }),
          });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `${r.status}`);
      setToolsState({ open: true, loading: false, list: d.tools, err: '', note: d.note || '' });
    } catch (e) {
      setToolsState({ open: true, loading: false, list: null, err: e.message, note: '' });
    }
  };
  // 切换单个工具启用态 → 即时 PUT 保存该 server 的禁用清单(独立于配置保存,下个回合生效)。
  const toggleTool = async (toolName, nextEnabled) => {
    if (toolsBusy) return;
    setToolsBusy(toolName);
    const nextList = toolsState.list.map((t) => t.name === toolName ? { ...t, enabled: nextEnabled } : t);
    const disabled = nextList.filter((t) => !t.enabled).map((t) => t.name);
    try {
      const r = await fetch(`/api/mcp/${encodeURIComponent(editing.name)}/tools`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ disabled }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `${r.status}`); }
      setToolsState((s) => ({ ...s, list: nextList }));
    } catch (e) {
      setToolsState((s) => ({ ...s, err: `保存失败:${e.message}` }));
    } finally { setToolsBusy(''); }
  };

  const isStdio = transport === 'stdio';

  // 模板/注册表声明的 env、请求头(带 hint)值为空 → 内联警告。不阻断保存(允许先添加稍后补填)。
  const emptyHinted = (rows) => rows.filter((r) => r.hint && r.k.trim() && !String(r.v || '').trim()).map((r) => r.k.trim());
  const emptyTplEnvKeys = [...emptyHinted(envRows), ...(isStdio ? [] : emptyHinted(headerRows))];
  // 非法请求头键名(server 保存时会丢弃)→ 提交前即时标红提示,不阻断保存(与 server 行为一致)。
  const badHeaderKeys = isStdio ? [] : headerRows.map((r) => r.k.trim()).filter((k) => k && !HEADER_KEY_RE.test(k));

  const save = async () => {
    setErr('');
    setWarn('');
    if (!name.trim()) { setErr('ID 不能为空'); return; }
    if (isStdio && !commandLine.trim()) { setErr('命令不能为空'); return; }
    if (!isStdio && !url.trim()) { setErr('URL 不能为空'); return; }
    const env = {};
    for (const { k, v } of envRows) { if (k.trim()) env[k.trim()] = v; }
    const headers = {};
    if (!isStdio) for (const { k, v } of headerRows) { if (k.trim()) headers[k.trim()] = v; }
    const body = { name: name.trim(), transport, commandLine, url, scope, autoApprove, label, env, headers };
    setSaving(true);
    try {
      const r = isEdit
        ? await fetch(`/api/mcp/${encodeURIComponent(editing.name)}/config`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          })
        : await fetch('/api/mcp', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '保存失败');
      onSaved?.(name.trim(), !isEdit); // 传回名称 + 是否新增,供面板对新 server 自动探测连通性
      // 保存成功但 server 丢弃了非法请求头键(warning),或命令不在 PATH 需改绝对路径(hint,Windows 常见)
      // → 留在表单里内联展示(自动关掉用户就看不见了)。两者可同时出现,换行并列,谁也不顶掉谁。
      if (d.warning || d.hint) { setWarn([d.warning, d.hint].filter(Boolean).join('\n')); return; }
      onClose?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full bg-canvas-warm border border-canvas-deep rounded-lg px-3 py-2 text-[13px] text-ink font-body focus:outline-none focus:border-accent/50';
  const labelCls = 'text-[12px] font-medium text-ink font-body';
  const hintCls = 'text-[11px] text-ink-faint font-body';

  // 审计批E2:portal 到 body —— 宿主面板 animate-glass-rise 收尾残留 transform 会把
  // fixed inset-0 遮罩困在面板内(盖不满全屏、卡片被裁),portal 后不受任何祖先
  // stacking context 影响(参照 FileExplorerPanel 右键菜单同手法)。点外/内部按钮
  // 关闭逻辑不变(React 合成事件沿 React 树冒泡,不依赖 DOM 祖先)。
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-soft animate-fade-in" onClick={onClose}>
      <div data-cgui-panel className="glass-popover w-[560px] max-w-[calc(var(--app-w,100vw)-1.5rem)] max-h-[min(90vh,calc(var(--app-h,100dvh)-2rem))] flex flex-col overflow-hidden rounded-panel shadow-popover animate-glass-rise"
        onClick={(e) => e.stopPropagation()}>
        {/* flex 列布局:头/底 shrink-0 固定,中间主体独立滚动。原来是「整卡滚动 + sticky footer」,
            但 glassRise 动画以 scale(1)+fill:both 收尾使卡片永久带 transform,WKWebView/WebView2 里
            transform 滚动容器内的 sticky bottom-0 失效 → 长表单滚不到底、看不到「添加」按钮。 */}
        <div className="px-5 py-4 border-b border-canvas-deep flex items-center gap-3 shrink-0 bg-canvas">
          <button onClick={onClose} className="p-1 -ml-1 text-ink-faint hover:text-ink rounded transition-colors" title="返回"><ArrowLeft size={16} /></button>
          <div className="flex-1 text-[14px] font-medium text-ink font-body">{isEdit ? '编辑 MCP 服务器' : '添加 MCP 服务器'}</div>
          <button onClick={onClose} className="p-1.5 hover:bg-canvas-warm rounded transition-colors"><X size={14} className="text-ink-faint" /></button>
        </div>

        {(
          <div className="px-5 py-4 space-y-4 flex-1 overflow-y-auto min-h-0">
            {isEdit && refining && (
              <div className="flex items-center gap-2 text-[11px] text-ink-faint">
                <RefreshCw size={11} className="animate-spin" /> 正在载入完整配置(环境变量等)…
              </div>
            )}
            {/* 快速模板(仅新增态):选常用 MCP 自动回填字段 */}
            {!isEdit && (
              <div className="space-y-1.5">
                <div className={labelCls}>快速模板 · 可选</div>
                <select defaultValue="" onChange={(e) => { applyTemplate(e.target.value); e.target.value = ''; }} className={inputCls}>
                  <option value="">— 选常用 MCP 自动填写 —</option>
                  <optgroup label="选了即用(无需配置)">
                    {BUILTIN_MCP_SERVERS.filter((m) => !m.needsSetup).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </optgroup>
                  <optgroup label="需配置后才能用">
                    {BUILTIN_MCP_SERVERS.filter((m) => m.needsSetup).map((m) => <option key={m.id} value={m.id}>{m.name}{m.setupTag ? ` · ${m.setupTag}` : ''}</option>)}
                  </optgroup>
                </select>
                {tplMeta && (
                  <div className={hintCls}>
                    {[tplMeta.note, tplMeta.needsArg].filter(Boolean).join(' ')}
                    {tplMeta.repo && (
                      <a
                        onClick={(e) => { e.preventDefault(); openExternalUrl(tplMeta.docs); }}
                        title="在浏览器打开该 MCP 的 GitHub 项目"
                        className="text-accent hover:underline inline-flex items-center gap-0.5 cursor-pointer ml-1 align-baseline"
                      >{tplMeta.repo}<ExternalLink size={10} /></a>
                    )}
                  </div>
                )}
                {/* uvx 型模板缺 uv 时的内联引导(全平台扫描见后端 detectUv) */}
                {(uvStatus === 'missing' || uvStatus === 'launched') && (
                  <div className="rounded-lg bg-amber-500/10 border border-amber-500/25 px-3 py-2 text-[11px] text-ink-soft font-body leading-snug">
                    {uvStatus === 'launched' ? (
                      <span className="text-success">已在终端启动 uv 安装,装完回来重选该模板即可。</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="flex-1">此 MCP 用 <code className="font-mono">uvx</code> 运行,本机未检测到 <code className="font-mono">uv</code>。装上后即可使用(uv 会自动备好 Python)。</span>
                        <button onClick={installUv}
                          className="shrink-0 px-2.5 py-1 rounded text-on-accent bg-accent hover:bg-accent-hover text-[11px] font-medium">安装 uv</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 注册表搜索(仅新增态,折叠式):搜官方 MCP 注册表,选中预填表单,仍走下方「添加」提交 */}
            {!isEdit && (
              <div className="space-y-1.5">
                <button
                  onClick={() => setRegOpen((v) => !v)}
                  className="w-full flex items-center gap-1.5 text-[12px] font-medium text-ink-faint hover:text-ink transition-colors">
                  <ChevronRight size={13} className={`transition-transform ${regOpen ? 'rotate-90' : ''}`} />
                  <Search size={12} />
                  从 MCP 注册表搜索
                </button>
                {regOpen && (
                  <div className="space-y-2">
                    <div className="relative">
                      <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
                      <input
                        value={regQuery}
                        onChange={(e) => setRegQuery(e.target.value)}
                        placeholder="输入关键词搜索官方注册表,如 github / fetch"
                        className={`${inputCls} pl-8`} />
                    </div>
                    <div className={hintCls}>数据来自 registry.modelcontextprotocol.io。选中条目后配置预填入下方表单,确认或修改后点「添加」。</div>
                    {regErr && <div className="text-[11px] text-error bg-error/10 border border-error/20 rounded px-2 py-1.5 break-all">{regErr}</div>}
                    {regLoading && <div className="flex items-center gap-1.5 text-[11px] text-ink-faint"><RefreshCw size={11} className="animate-spin" />搜索中…</div>}
                    {!regLoading && !regErr && regItems && regItems.length === 0 && (
                      <div className="text-[11px] text-ink-faint py-1">无匹配结果,换个关键词。</div>
                    )}
                    {!regLoading && regItems && regItems.length > 0 && (
                      <div className="max-h-[220px] overflow-y-auto rounded-lg border border-canvas-deep divide-y divide-canvas-deep/60">
                        {regItems.map((it) => (
                          <button key={it.name} onClick={() => applyRegistryItem(it)}
                            title="选中后将该条目的配置预填入下方表单"
                            className="w-full text-left px-3 py-2 hover:bg-canvas-warm transition-colors">
                            <div className="flex items-center gap-2">
                              <span className="text-[12px] font-medium text-ink font-body truncate">{it.id || it.name}</span>
                              <span className="shrink-0 text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono">
                                {it.kind === 'remote' ? `远程 ${it.transport}` : it.kind}
                              </span>
                              {it.version && <span className="shrink-0 text-[9px] text-ink-ghost font-mono">v{it.version}</span>}
                            </div>
                            {it.description && <div className="text-[10px] text-ink-faint font-body leading-snug mt-0.5 line-clamp-2">{it.description}</div>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 类型 */}
            <div className="space-y-1.5">
              <div className={labelCls}>类型</div>
              <select value={transport} onChange={(e) => setTransport(e.target.value)} className={inputCls}>
                {TRANSPORTS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </select>
            </div>

            {/* 名称 + ID */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <div className={labelCls}>名称</div>
                <div className={`${hintCls} truncate`}>便于识别 · 可选</div>
                <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls} placeholder="例如 文件管理" />
              </div>
              <div className="space-y-1.5">
                <div className={labelCls}>ID</div>
                <div className={`${hintCls} truncate`} title="模型识别用的唯一 ID, 不可重复">模型识别用 · 唯一</div>
                <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} font-mono`} placeholder="my-mcp-server" />
              </div>
            </div>

            {/* 命令 / URL */}
            <div className="space-y-1.5">
              <div className={labelCls}>{isStdio ? '命令' : 'URL'}</div>
              {isStdio ? (
                <>
                  <textarea value={commandLine} onChange={(e) => { dirtyRef.current = true; setCommandLine(e.target.value); }} rows={2}
                    className={`${inputCls} font-mono resize-y`} placeholder="npx -y mcp-server-xxx --arg1 value1" />
                  <div className={hintCls}>整行命令会按空格(尊重引号)拆成 command + 参数，等价 claude code 的 <code className="font-mono">command</code> / <code className="font-mono">args</code>。</div>
                </>
              ) : (
                <input value={url} onChange={(e) => { dirtyRef.current = true; setUrl(e.target.value); }} className={`${inputCls} font-mono`} placeholder="https://example.com/mcp" />
              )}
            </div>

            {/* scope + 自动执行 */}
            <div className="grid grid-cols-2 gap-3 items-start">
              <div className="space-y-1.5">
                <div className={labelCls}>作用域 (scope)</div>
                <select value={scope} onChange={(e) => setScope(e.target.value)} className={inputCls}>
                  {SCOPES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
                </select>
              </div>
              <label className="flex items-center gap-2 pt-7 cursor-pointer select-none">
                <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} className="accent-accent" />
                <span className="text-[13px] text-ink font-body">自动执行工具</span>
                <span className={hintCls} title="勾选后该服务器的工具调用不再弹权限确认，直接放行">(免确认)</span>
              </label>
            </div>

            {/* 环境变量 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className={labelCls}>环境变量</span>
                <button onClick={addEnv} className="p-0.5 rounded hover:bg-canvas-warm text-ink-faint hover:text-accent"><Plus size={13} /></button>
              </div>
              {envRows.length === 0 && <div className={hintCls}>无。点 + 添加 KEY=VALUE。</div>}
              {envRows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={row.k} onChange={(e) => setEnv(i, 'k', e.target.value)} placeholder="KEY"
                    className={`${inputCls} font-mono flex-1`} />
                  <span className="text-ink-faint">=</span>
                  <input value={row.v} onChange={(e) => setEnv(i, 'v', e.target.value)} placeholder="value"
                    className={`${inputCls} font-mono flex-1`} />
                  <button onClick={() => delEnv(i)} className="p-1 text-ink-faint hover:text-error shrink-0"><Trash2 size={13} /></button>
                </div>
              ))}
              {/* 内置目录带的 env 说明(去哪申请 key 等):独立成区,不塞进窄的 value 输入框(会显示不全)。 */}
              {envRows.some((r) => r.hint) && (
                <div className="rounded-lg bg-canvas-warm/60 border border-canvas-deep px-3 py-2 text-[11px] text-ink-muted font-body leading-snug space-y-1">
                  {envRows.filter((r) => r.hint).map((r, i) => (
                    <div key={i}><span className="font-mono text-ink-soft">{r.k || 'KEY'}</span>:{r.hint}</div>
                  ))}
                </div>
              )}
              {emptyTplEnvKeys.length > 0 && (
                <div className="rounded-lg bg-amber-500/10 border border-amber-500/25 px-3 py-2 text-[11px] text-amber-700 font-body leading-snug">
                  未填 {emptyTplEnvKeys.join('、')},该 server 可能无法连接。可先保存,稍后编辑补填。
                </div>
              )}
            </div>

            {/* 请求头(仅 http/sse):每对写成 claude mcp add 的 -H "Key: Value"。远程 server
                (如 smithery 系)常需 Authorization: Bearer xxx 才能连上。 */}
            {!isStdio && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className={labelCls}>请求头 (headers)</span>
                  <button onClick={addHeader} className="p-0.5 rounded hover:bg-canvas-warm text-ink-faint hover:text-accent"><Plus size={13} /></button>
                </div>
                {headerRows.length === 0 && <div className={hintCls}>无。若该 server 需要认证,点 + 添加,如 Authorization = Bearer xxx。</div>}
                {headerRows.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    {/* 非法键名(server 保存时会丢弃)即时标红:直接替换 border 类,不靠 !important 竞争 */}
                    <input value={row.k} onChange={(e) => setHeader(i, 'k', e.target.value)} placeholder="Header-Name"
                      className={`${row.k.trim() && !HEADER_KEY_RE.test(row.k.trim()) ? inputCls.replace('border-canvas-deep', 'border-error') : inputCls} font-mono flex-1`} />
                    <span className="text-ink-faint">:</span>
                    {/* 请求头的值多为 Bearer token 等密钥,按敏感值处理:密码框显示。 */}
                    <input type="password" autoComplete="off" value={row.v} onChange={(e) => setHeader(i, 'v', e.target.value)} placeholder="value"
                      className={`${inputCls} font-mono flex-1`} />
                    <button onClick={() => delHeader(i)} className="p-1 text-ink-faint hover:text-error shrink-0"><Trash2 size={13} /></button>
                  </div>
                ))}
                {badHeaderKeys.length > 0 && (
                  <div className="text-[11px] text-error font-body leading-snug">
                    键名 {badHeaderKeys.join('、')} 含非法字符(仅允许字母数字与 {'!#$%&\'*+.^_`|~-'}),保存时该请求头将被忽略。
                  </div>
                )}
                {/* 注册表条目声明的请求头说明(必填/密钥等),布局同 env 的 hint 区。 */}
                {headerRows.some((r) => r.hint) && (
                  <div className="rounded-lg bg-canvas-warm/60 border border-canvas-deep px-3 py-2 text-[11px] text-ink-muted font-body leading-snug space-y-1">
                    {headerRows.filter((r) => r.hint).map((r, i) => (
                      <div key={i}><span className="font-mono text-ink-soft">{r.k || 'Header'}</span>:{r.hint}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 工具管理:编辑时可逐个启用/禁用;添加时按草稿配置预览清单(添加前就能看这个 server 有什么工具)。 */}
            {(isEdit || (isStdio && commandLine.trim())) && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className={labelCls}>工具</span>
                  {!toolsState.open && (
                    <button onClick={loadTools}
                      className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded text-accent hover:bg-accent/10">
                      <RefreshCw size={11} />{isEdit ? '查看工具（可单独启用/禁用）' : '查看工具（按当前配置连一次预览）'}
                    </button>
                  )}
                  {toolsState.open && !toolsState.loading && (
                    <button onClick={loadTools} className="p-0.5 rounded hover:bg-canvas-warm text-ink-faint hover:text-accent" title="刷新">
                      <RefreshCw size={12} />
                    </button>
                  )}
                </div>
                {toolsState.loading && <div className={hintCls}>正在连接 server 拉取工具清单…（约几秒)</div>}
                {toolsState.err && <div className="text-[11px] text-error">{toolsState.err}</div>}
                {toolsState.note && <div className={hintCls}>{toolsState.note}</div>}
                {toolsState.open && !toolsState.loading && Array.isArray(toolsState.list) && (
                  <div className="max-h-[220px] overflow-y-auto rounded-lg border border-canvas-deep divide-y divide-canvas-deep/60">
                    {toolsState.list.length === 0 && <div className="px-3 py-2 text-[11px] text-ink-faint">该 server 未暴露工具。</div>}
                    {toolsState.list.map((t) => (
                      <div key={t.name} className="flex items-start gap-2 px-3 py-1.5">
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] font-mono text-ink truncate">{t.name}</div>
                          {t.description && <div className="text-[10px] text-ink-faint leading-snug line-clamp-2">{t.description}</div>}
                        </div>
                        {isEdit && (
                          <button onClick={() => toggleTool(t.name, !t.enabled)} disabled={toolsBusy === t.name}
                            className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                              t.enabled ? 'text-accent hover:bg-accent/10' : 'text-ink-faint bg-canvas-warm hover:text-ink'
                            } disabled:opacity-40`}>
                            {t.enabled ? '已启用' : '已禁用'}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className={hintCls}>{isEdit ? '禁用的工具模型将看不到（不再误选）。改动下个回合生效。' : '预览仅供查看;添加完成后可在编辑页逐个启用/禁用工具。'}</div>
              </div>
            )}

            {err && <div className="text-[12px] text-error bg-error/10 border border-error/20 rounded px-3 py-2 whitespace-pre-wrap break-all">{err}</div>}
            {/* 保存已成功但 server 丢弃了非法请求头键:琥珀色警告(非错误),用户修正键名重新保存即可。 */}
            {warn && (
              <div className="text-[12px] text-amber-700 bg-amber-500/10 border border-amber-500/25 rounded px-3 py-2 whitespace-pre-wrap break-all">
                已保存,但:{warn}
              </div>
            )}
          </div>
        )}

        <div className="px-5 py-3 border-t border-canvas-deep flex items-center justify-end gap-2 bg-canvas-warm/40 shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink rounded-md hover:bg-canvas-warm transition-colors">取消</button>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-on-accent bg-accent hover:bg-accent/90 rounded-md transition-colors disabled:opacity-50">
            {saving && <RefreshCw size={12} className="animate-spin" />}
            {isEdit ? '保存' : '添加'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
