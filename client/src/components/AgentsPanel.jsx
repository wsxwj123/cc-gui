import React, { useEffect, useState } from 'react';
import { Bot, RefreshCw, Save, Check, Plus, FileText, Download, Package, Trash2 } from 'lucide-react';

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
      const opts = Array.from(new Set(['sonnet', 'opus', 'haiku', cur, ...ids])).filter(Boolean);
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
    if (!window.confirm(`删除 agent「${name}」？\n将删除 ~/.claude/agents/${name}.md，不可恢复。`)) return;
    try {
      await fetch(`/api/agents/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (selected === name) { setSelected(null); setContent(''); }
      fetchAgents();
      if (showBuiltin) fetchBuiltin();
    } catch {}
  };

  const createNew = async () => {
    if (!/^[a-z0-9-]{1,64}$/.test(newName)) return alert('名字只能小写字母、数字、-');
    setSelected(newName);
    setContent(`---\nname: ${newName}\ndescription: 何时调用我——写清触发场景,主对话据此自动决定是否把任务派给我\nmodel: ${newModel || defaultModel}\n---\n\n你是 ${newName}。\n\n职责:用自然语言描述专长、做事方式和输出要求(本正文即该子代理的 system prompt)。\n`);
    setCreating(false); setNewName('');
  };

  if (loading) return <div className="flex items-center justify-center py-12"><RefreshCw size={16} className="animate-spin text-ink-faint" /></div>;

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-canvas-deep shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-widest text-ink-faint font-body flex items-center gap-1.5">
            <Bot size={11} />Subagents · {agents.length}
          </span>
          <div className="flex gap-1">
            <button onClick={() => { const n = !showBuiltin; setShowBuiltin(n); if (n) fetchBuiltin(); }}
              className={`p-1 hover:text-accent ${showBuiltin ? 'text-accent' : 'text-ink-faint'}`} title="安装内置 Agent 预设（explorer/oracle/orchestrator 等）"><Package size={12} /></button>
            <button onClick={() => setCreating(!creating)} className="p-1 text-ink-faint hover:text-accent" title="新建 subagent 定义"><Plus size={12} /></button>
            <button onClick={fetchAgents} className="p-1 text-ink-faint hover:text-ink-muted" title="刷新列表"><RefreshCw size={11} /></button>
          </div>
        </div>
        <p className="text-[10px] text-ink-faint mt-1 font-body leading-snug">
          这是 <code className="text-ink-muted">~/.claude/agents/*.md</code> 里的 subagent <b>定义</b>（不是运行实时状态）。在主对话里调用 <code className="text-ink-muted">Task</code> 工具时由 Claude 派给这些代理。
        </p>
      </div>

      {creating && (
        <div className="px-4 py-2 border-b border-canvas-deep bg-canvas-warm/40 space-y-1.5">
          <div className="flex gap-1.5 items-center">
            <input value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="agent-name"
              className="flex-1 bg-canvas border border-canvas-deep rounded px-2 py-1 text-xs font-mono" />
            <select value={newModel} onChange={(e) => setNewModel(e.target.value)}
              title="子代理默认模型(写入 .md 的 model 字段)"
              className="bg-canvas border border-canvas-deep rounded px-1.5 py-1 text-xs font-mono max-w-[140px]">
              {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button onClick={createNew} className="btn-accent text-[11px] px-2 py-1">创建</button>
          </div>
          <p className="text-[10px] text-ink-faint font-body leading-snug">
            默认填当前 provider 的默认模型（<code className="text-ink-muted">{defaultModel}</code>）。.md 里的 <code className="text-ink-muted">model</code> 会决定该子代理实际使用的模型，可与主会话不同；别名（sonnet/opus/haiku）在各 provider 下由 CLI 自动路由。
          </p>
        </div>
      )}

      {showBuiltin && (
        <div className="px-4 py-2 border-b border-canvas-deep bg-canvas-warm/40">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] uppercase tracking-wider text-ink-faint font-body">内置预设 · 移植自 oh-my-opencode-slim</span>
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
            装好后即普通可编辑的自定义 agent。<code className="text-ink-muted">orchestrator</code> 可在输入框旁的「模式」开关里选作主控，自动委派 explorer/oracle/fixer 等。
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
              <div className="px-3 py-2 border-b border-canvas-deep flex items-center justify-between">
                <span className="text-xs font-mono text-ink-soft truncate">{selected}.md</span>
                <button onClick={save} disabled={saving} className="btn-accent flex items-center gap-1 text-[11px] px-2 py-0.5">
                  {saved ? <Check size={11} /> : <Save size={11} />}
                  {saved ? '已存' : saving ? '…' : '保存'}
                </button>
              </div>
              <textarea value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false}
                className="flex-1 bg-canvas-warm border-0 p-3 text-[11px] font-mono text-ink-soft resize-none focus:outline-none leading-relaxed" />
            </>
          ) : (
            <p className="text-[11px] text-ink-faint p-6 text-center font-body">选择左侧 agent 编辑</p>
          )}
        </div>
      </div>
    </div>
  );
}
