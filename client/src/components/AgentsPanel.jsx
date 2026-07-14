import React, { useEffect, useState } from 'react';
import { Bot, RefreshCw, Save, Check, Plus, FileText, Download, Package, Trash2 } from 'lucide-react';
import { confirmDialog } from '../utils/confirmDialog.jsx';

// ── 维护型常量:CLI 内置工具真实注册表 ──────────────────────────────────
// agent .md 的 tools 字段 = 声明 ∩ CLI 真实注册表,写错名不报错、被 CLI 静默丢弃
// (memory [[subagent-toolset-not-from-md-todowrite-primary-only]])。此清单据本机
// claude 2.1.208 headless `claude -p --output-format stream-json --verbose` 抓 init
// 事件 tools 数组实测(2026-07-14),【随 CLI 版本升级需重抓维护】。
// 注:AskUserQuestion/ExitPlanMode 不出现在裸 -p 的 init 里,但在 GUI 的 SDK 会话
// 上下文注册(chat.js canUseTool 依赖),属有效名。chat.js:181/useWebSocket.js:120
// 的清单是权限分级用途且含已废名(Glob/Grep/LS/TodoWrite),不能当源。
const KNOWN_CLI_TOOLS = new Set([
  'Task', 'Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch',
  'Skill', 'ToolSearch', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
  'TaskUpdate', 'AskUserQuestion', 'ExitPlanMode', 'Artifact', 'CronCreate', 'CronDelete',
  'CronList', 'DesignSync', 'EnterWorktree', 'ExitWorktree', 'ListMcpResourcesTool',
  'Monitor', 'PushNotification', 'ReadMcpResourceDirTool', 'ReadMcpResourceTool',
  'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'Workflow',
]);
// 已废/更名工具 → 替代建议(2.1.183 起注册表移除 Glob/Grep/LS/NotebookRead/TodoWrite/
// BashOutput/KillShell/SlashCommand,headless 实测确认)。
const STALE_TOOL_HINTS = {
  TodoWrite: '已更名,改用 TaskCreate/TaskUpdate/TaskList',
  Glob: '已移除,建议删除(文件检索由 Read/Bash 覆盖)',
  Grep: '已移除,建议删除(内容检索经 Bash 的 grep)',
  LS: '已移除,建议删除',
  NotebookRead: '已移除,改用 Read',
  BashOutput: '已更名,改用 TaskOutput',
  KillShell: '已更名,改用 TaskStop',
  SlashCommand: '已移除,改用 Skill',
};

// 解析 .md frontmatter 的 `tools:` 行 → token 数组;无 frontmatter/无 tools 行返回 null
// (null = 继承全部工具)。与 server/routes/agents.js rewriteAgentMcpTools 同口径:
// 仅按行解析,不做完整 YAML。
function parseToolsTokens(content) {
  const lines = String(content || '').split('\n');
  if (lines[0]?.trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return null;
    if (/^tools:/.test(lines[i])) {
      return lines[i].replace(/^tools:\s*/, '').split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return null;
}

// 解析/改写 frontmatter 的 `model:` 行。parse:无 frontmatter 返回 null(解析失败,
// 编辑面板不显示下拉),有 frontmatter 无 model 行返回 ''(= 继承)。write:model 为空
// 删除该行(删行与 model: inherit 等效——继承主对话模型);frontmatter 不合法原样返回。
function parseModelValue(content) {
  const lines = String(content || '').split('\n');
  if (lines[0]?.trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return '';
    const m = lines[i].match(/^model:\s*(.*)$/);
    if (m) return m[1].trim();
  }
  return null;
}
function withModelValue(content, model) {
  const lines = String(content || '').split('\n');
  if (lines[0]?.trim() !== '---') return content;
  let end = -1;
  for (let i = 1; i < lines.length; i++) { if (lines[i].trim() === '---') { end = i; break; } }
  if (end === -1) return content;
  for (let i = 1; i < end; i++) {
    if (/^model:/.test(lines[i])) {
      if (!model) lines.splice(i, 1); else lines[i] = `model: ${model}`;
      return lines.join('\n');
    }
  }
  if (model) lines.splice(end, 0, `model: ${model}`);
  return lines.join('\n');
}

export function AgentsPanel() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  // 当前 provider 的默认模型 + 可选模型,供新建 agent 时预填 model 字段。
  const [defaultModel, setDefaultModel] = useState('sonnet');
  const [modelOptions, setModelOptions] = useState([]);
  const [newModel, setNewModel] = useState('sonnet');
  // BG5:内置预设(随 GUI 分发,移植自 oh-my-opencode-slim)。按需安装到 ~/.claude/agents。
  const [showBuiltin, setShowBuiltin] = useState(false);
  const [builtin, setBuiltin] = useState([]);
  const [installing, setInstalling] = useState('');

  const fetchBuiltin = async () => {
    try {
      const d = await (await fetch('/api/agents/builtin')).json();
      setBuiltin(Array.isArray(d?.agents) ? d.agents : []);
    } catch {}
  };
  const installBuiltin = async (names, overwrite) => {
    setInstalling(names ? names[0] : '__all__');
    try {
      await fetch('/api/agents/builtin/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names, overwrite }),
      });
      await fetchBuiltin();
      await fetchAgents();
    } catch {}
    setInstalling('');
  };

  const fetchAgents = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/agents');
      const d = await res.json();
      setAgents(d.agents || []);
    } catch {}
    setLoading(false);
  };
  useEffect(() => { fetchAgents(); }, []);

  // 取当前 provider 的默认模型与可用模型(同 /api/model,ModelSelector 用的同一源)。
  useEffect(() => {
    fetch('/api/model').then((r) => r.json()).then((d) => {
      const cur = d.model || 'sonnet';
      // 别名 + 当前 provider 的具体模型 id 一起作为下拉选项(去重)。别名在
      // 任意 provider 下都被 CLI 路由到对应模型,具体 id 适合钉死某个模型。
      // ⚠️/api/model 的 available 是【对象数组】{id,name,tier,...}(model-resolver),
      // 必须取 .id 转成字符串——否则 <option>{对象}</option> 渲染对象 → React
      // "Objects are not valid as a React child" → 生产白屏(dev 因 available 为空掩盖)。
      const ids = (Array.isArray(d.available) ? d.available : [])
        .map((x) => (typeof x === 'string' ? x : x && x.id)).filter(Boolean);
      // inherit = 继承主对话当前模型(CLI 原生支持的 model 取值)。
      const opts = Array.from(new Set(['inherit', 'sonnet', 'opus', 'haiku', cur, ...ids])).filter(Boolean);
      setDefaultModel(cur);
      setModelOptions(opts);
      setNewModel(cur);
    }).catch(() => {});
  }, []);

  const open = async (name) => {
    setSelected(name);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(name)}`);
      const d = await res.json();
      setContent(res.ok ? (d.content || '') : '');
    } catch { setContent(''); }
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(selected)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); fetchAgents(); }
    } catch {}
    setSaving(false);
  };

  const del = async (name) => {
    // window.confirm 在 Tauri WKWebView 里被屏蔽(返回 falsy)→ 删除按钮"点了没反应"。
    // 用项目自带的 confirmDialog(应用内弹层,异步返回 boolean)。
    if (!(await confirmDialog(`删除 agent「${name}」？\n将删除 ~/.claude/agents/${name}.md，不可恢复。`, { danger: true }))) return;
    try {
      await fetch(`/api/agents/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (selected === name) { setSelected(null); setContent(''); }
      fetchAgents();
      if (showBuiltin) fetchBuiltin();
    } catch {}
  };

  const createNew = async () => {
    if (!/^[a-z0-9-]{1,64}$/.test(newName)) return confirmDialog('名字只能小写字母、数字、-');
    setSelected(newName);
    setContent(`---\nname: ${newName}\ndescription: 此处填写该 agent 的功能概览,主对话据此判断何时调用它\nmodel: ${newModel || defaultModel}\ntools: Read, Edit, Write, Bash, TaskCreate, TaskUpdate, TaskList, AskUserQuestion, ExitPlanMode\n---\n\n此处填写该 agent 的系统提示词:说明其职责、处理方式与输出要求。\n`);
    setCreating(false); setNewName('');
  };

  // tools 校验(非阻塞):未知的非 mcp__ 工具名 → 黄色警告,仍可保存(CLI 只是静默忽略)。
  const toolTokens = selected ? parseToolsTokens(content) : null;
  const unknownTools = (toolTokens || []).filter((t) => !t.startsWith('mcp__') && t !== '*' && !KNOWN_CLI_TOOLS.has(t));
  // 编辑面板的 model 下拉:从 frontmatter 解析;null=frontmatter 不合法不显示。
  // ''(无 model 行)与 inherit 等效,显示为 inherit;手输自定义 id 直接改正文 model: 行。
  // tools 只读 chips 摘要:普通工具计数一组,mcp__<server>__* 按 server 分组。
  // 纯前端解析;toolTokens 为 null(无 frontmatter/无 tools 行)则不显示。
  let builtinToolCount = 0;
  const mcpGroups = new Map(); // server → { all: 含 __* 通配, count: 单独放行的工具数 }
  for (const t of toolTokens || []) {
    if (t.startsWith('mcp__')) {
      const rest = t.slice(5);
      const idx = rest.indexOf('__');
      const server = idx === -1 ? rest : rest.slice(0, idx);
      const g = mcpGroups.get(server) || { all: false, count: 0 };
      if (idx !== -1 && rest.slice(idx + 2) === '*') g.all = true; else g.count++;
      mcpGroups.set(server, g);
    } else builtinToolCount++;
  }
  const editModel = selected ? parseModelValue(content) : null;
  const baseModelOpts = modelOptions.length ? modelOptions : ['inherit', 'sonnet', 'opus', 'haiku'];
  const editModelOpts = editModel && editModel !== '' && !baseModelOpts.includes(editModel)
    ? [editModel, ...baseModelOpts] : baseModelOpts;

  if (loading) return <div className="flex items-center justify-center py-12"><RefreshCw size={16} className="animate-spin text-ink-faint" /></div>;

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-canvas-deep shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-widest text-ink-faint font-body flex items-center gap-1.5">
            <Bot size={11} />Agents · {agents.length}
          </span>
          <div className="flex gap-1">
            <button onClick={() => { const n = !showBuiltin; setShowBuiltin(n); if (n) fetchBuiltin(); }}
              className={`p-1 hover:text-accent ${showBuiltin ? 'text-accent' : 'text-ink-faint'}`} title="安装内置 Agent 预设（explorer/oracle/orchestrator 等）"><Package size={12} /></button>
            <button onClick={() => setCreating(!creating)} className="p-1 text-ink-faint hover:text-accent" title="新建 agent"><Plus size={12} /></button>
            <button onClick={fetchAgents} className="p-1 text-ink-faint hover:text-ink-muted" title="刷新列表"><RefreshCw size={11} /></button>
          </div>
        </div>
        <p className="text-[10px] text-ink-faint mt-1 font-body leading-snug">
          此处为本机 <code className="text-ink-muted">~/.claude/agents</code> 中保存的 agent 定义。对话过程中 Claude 会按需调用这些 agent 执行子任务。
        </p>
      </div>

      {creating && (
        <div className="px-4 py-2 border-b border-canvas-deep bg-canvas-warm/40 space-y-1.5">
          <div className="flex gap-1.5 items-center">
            <input value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="agent-name"
              className="flex-1 bg-canvas border border-canvas-deep rounded px-2 py-1 text-xs font-mono" />
            <select value={newModel} onChange={(e) => setNewModel(e.target.value)}
              title="这个助手默认用哪个模型"
              className="bg-canvas border border-canvas-deep rounded px-1.5 py-1 text-xs font-mono max-w-[140px]">
              {baseModelOpts.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button onClick={createNew} className="btn-accent text-[11px] px-2 py-1">创建</button>
          </div>
          <p className="text-[10px] text-ink-faint font-body leading-snug">
            默认使用当前服务商的默认模型（<code className="text-ink-muted">{defaultModel}</code>）。可单独为该 agent 指定模型，与主对话不同。
          </p>
        </div>
      )}

      {showBuiltin && (
        <div className="px-4 py-2 border-b border-canvas-deep bg-canvas-warm/40">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] uppercase tracking-wider text-ink-faint font-body">内置 agent 预设 · 来自 oh-my-opencode-slim</span>
            <button onClick={() => installBuiltin(null, false)} disabled={!!installing}
              className="btn-accent text-[10px] px-2 py-0.5 flex items-center gap-1"><Download size={10} />全部安装</button>
          </div>
          <div className="space-y-1">
            {builtin.map((a) => (
              <div key={a.name} className="flex items-center gap-2 text-[11px] font-body">
                <span className="font-mono text-ink-soft w-[88px] shrink-0 truncate">{a.name}</span>
                <span className="text-ink-faint font-mono shrink-0">{a.model || '继承'}</span>
                <span className="flex-1 text-ink-faint truncate">{a.description}</span>
                {a.installed ? (
                  <button onClick={() => installBuiltin([a.name], true)} disabled={!!installing}
                    className="text-[10px] px-1.5 py-0.5 rounded text-ink-faint hover:text-accent shrink-0" title="覆盖重装">已装·覆盖</button>
                ) : (
                  <button onClick={() => installBuiltin([a.name], false)} disabled={!!installing}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent hover:bg-accent/25 shrink-0">安装</button>
                )}
              </div>
            ))}
            {builtin.length === 0 && <p className="text-[10px] text-ink-faint">加载中…</p>}
          </div>
          <p className="text-[10px] text-ink-faint mt-1.5 font-body leading-snug">
            安装后即为可编辑的普通 agent。<code className="text-ink-muted">orchestrator</code> 可在输入框旁的 agent 开关中选为主导,自动分配 explorer/oracle/fixer 等执行子任务。
          </p>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden flex">
        <div className="w-[140px] border-r border-canvas-deep overflow-y-auto shrink-0">
          {agents.length === 0 && <p className="text-[11px] text-ink-faint p-3 text-center font-body">无 agent</p>}
          {agents.map((a) => (
            <div key={a.name} className="group relative flex items-center">
              <button onClick={() => open(a.name)}
                className={`flex-1 min-w-0 sidebar-item text-left px-3 py-2 text-xs font-body truncate ${selected === a.name ? 'active text-accent' : 'text-ink-soft'}`}
                title={a.description}>
                <FileText size={10} className="inline mr-1 text-ink-faint" />{a.name}
              </button>
              {a.format !== 'cli' && (
                <button onClick={() => del(a.name)} title="删除该 agent"
                  className="absolute right-1 opacity-0 group-hover:opacity-100 p-1 rounded text-ink-faint hover:text-red-500 hover:bg-black/5 transition-opacity">
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="flex-1 min-w-0 flex flex-col">
          {selected ? (
            <>
              <div className="px-3 py-2 border-b border-canvas-deep flex items-center justify-between gap-2">
                <span className="text-xs font-mono text-ink-soft truncate">{selected}.md</span>
                {editModel !== null && (
                  <select value={editModel === '' ? 'inherit' : editModel}
                    onChange={(e) => setContent(withModelValue(content, e.target.value))}
                    title="该 agent 使用的模型;inherit 表示继承主对话当前模型。自定义模型 id 可在正文 model: 行手输"
                    className="bg-canvas border border-canvas-deep rounded px-1.5 py-0.5 text-[10px] font-mono max-w-[130px] ml-auto shrink-0">
                    {editModelOpts.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                )}
                <button onClick={save} disabled={saving} className="btn-accent flex items-center gap-1 text-[11px] px-2 py-0.5">
                  {saved ? <Check size={11} /> : <Save size={11} />}
                  {saved ? '已存' : saving ? '…' : '保存'}
                </button>
              </div>
              {toolTokens && (
                <div className="px-3 py-1.5 border-b border-canvas-deep bg-canvas-warm/40 flex flex-wrap items-center gap-1 shrink-0"
                  title="tools 字段解析摘要(只读)。MCP 面板增删 MCP 时会自动改写此字段">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-canvas border border-canvas-deep text-ink-muted font-mono">内置工具 ×{builtinToolCount}</span>
                  {[...mcpGroups].map(([server, g]) => (
                    <span key={server} className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 border border-canvas-deep text-accent font-mono">
                      {server}({g.all ? '全部工具' : `${g.count} 个工具`})
                    </span>
                  ))}
                </div>
              )}
              {unknownTools.length > 0 && (
                <div className="px-3 py-1.5 border-b border-canvas-deep bg-amber-500/10 text-[10px] text-amber-700 font-body leading-snug shrink-0">
                  以下工具名不在当前 CLI 内置工具集,保存后会被 CLI 静默忽略:<code className="font-mono">{unknownTools.join('、')}</code>。
                  {unknownTools.filter((t) => STALE_TOOL_HINTS[t]).map((t) => `${t} ${STALE_TOOL_HINTS[t]};`).join('')}
                  若为 MCP 工具需写完整前缀 <code className="font-mono">mcp__服务器名__工具名</code>。
                </div>
              )}
              <textarea value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false}
                className="flex-1 bg-canvas-warm border-0 p-3 text-[11px] font-mono text-ink-soft resize-none focus:outline-none leading-relaxed" />
              <div className="px-3 py-2 border-t border-canvas-deep bg-canvas-warm/40 text-[10px] text-ink-faint font-body leading-snug shrink-0">
在 MCP 面板添加/删除 MCP 时,会自动把 <code className="text-ink-muted">mcp__服务器名__*</code> 同步进所有 agent 的 <code className="text-ink-muted">tools</code>,无需手动维护。如需精确控制(只放行单个工具或从某 agent 移除),可在上方手改:<code className="text-ink-muted">mcp__服务器名__*</code> 放行该服务器全部工具,<code className="text-ink-muted">mcp__服务器名__工具名</code> 仅放行单个;删掉对应条目即禁用。<code className="text-ink-muted">tools</code> 字段整行删除则继承全部工具(含所有 MCP)。
              </div>
            </>
          ) : (
            <p className="text-[11px] text-ink-faint p-6 text-center font-body">选择左侧 agent 编辑</p>
          )}
        </div>
      </div>
    </div>
  );
}
