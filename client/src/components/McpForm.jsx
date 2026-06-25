import React, { useEffect, useState } from 'react';
import { X, Plus, Trash2, RefreshCw, ExternalLink } from 'lucide-react';
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

export function McpForm({ editing, onClose, onSaved }) {
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

  const [name, setName] = useState(editing?.name || '');
  const [label, setLabel] = useState('');
  const [transport, setTransport] = useState(seedTransport);
  const [commandLine, setCommandLine] = useState(seedTransport === 'stdio' ? seedCmd : '');
  const [url, setUrl] = useState(seedTransport !== 'stdio' ? seedCmd : '');
  const [scope, setScope] = useState('user');
  const [autoApprove, setAutoApprove] = useState(false);
  const [envRows, setEnvRows] = useState([]); // [{k,v}]
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

  // 选内置模板自动回填字段;需密钥的把 env 占位 key 填好(value 留空,用户补)。
  const applyTemplate = (id) => {
    const t = findBuiltinMcp(id);
    if (!t) return;
    setName(t.id);
    setLabel(t.name);
    setTransport(t.transport);
    if (t.transport === 'stdio') { setCommandLine(t.commandLine || ''); setUrl(''); }
    else { setUrl(t.url || ''); setCommandLine(''); }
    setEnvRows((t.env || []).map((e) => ({ k: e.k, v: '' })));
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

  const isStdio = transport === 'stdio';

  const save = async () => {
    setErr('');
    if (!name.trim()) { setErr('ID 不能为空'); return; }
    if (isStdio && !commandLine.trim()) { setErr('命令不能为空'); return; }
    if (!isStdio && !url.trim()) { setErr('URL 不能为空'); return; }
    const env = {};
    for (const { k, v } of envRows) { if (k.trim()) env[k.trim()] = v; }
    const body = { name: name.trim(), transport, commandLine, url, scope, autoApprove, label, env };
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
      onSaved?.();
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

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="glass-popover w-[560px] max-w-[calc(var(--app-w,100vw)-1.5rem)] max-h-[90vh] overflow-y-auto rounded-2xl shadow-2xl animate-glass-rise"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-canvas-deep flex items-center gap-3 sticky top-0 bg-canvas z-10">
          <div className="flex-1 text-[14px] font-medium text-ink font-body">{isEdit ? '编辑 MCP 服务器' : '添加 MCP 服务器'}</div>
          <button onClick={onClose} className="p-1.5 hover:bg-canvas-warm rounded transition-colors"><X size={14} className="text-ink-faint" /></button>
        </div>

        {(
          <div className="px-5 py-4 space-y-4">
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
                          className="shrink-0 px-2.5 py-1 rounded text-white bg-accent hover:bg-accent-hover text-[11px] font-medium">安装 uv</button>
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
            </div>

            {err && <div className="text-[12px] text-error bg-error/10 border border-error/20 rounded px-3 py-2 whitespace-pre-wrap break-all">{err}</div>}
          </div>
        )}

        <div className="px-5 py-3 border-t border-canvas-deep flex items-center justify-end gap-2 bg-canvas-warm/40 sticky bottom-0">
          <button onClick={onClose} className="px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink rounded-md hover:bg-canvas-warm transition-colors">取消</button>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-white bg-accent hover:bg-accent/90 rounded-md transition-colors disabled:opacity-50">
            {saving && <RefreshCw size={12} className="animate-spin" />}
            {isEdit ? '保存' : '添加'}
          </button>
        </div>
      </div>
    </div>
  );
}
