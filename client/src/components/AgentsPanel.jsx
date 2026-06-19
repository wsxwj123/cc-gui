import React, { useEffect, useState } from 'react';
import { Bot, RefreshCw, Save, Check, Plus, FileText } from 'lucide-react';

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
      const opts = Array.from(new Set(['sonnet', 'opus', 'haiku', cur, ...(Array.isArray(d.available) ? d.available : [])])).filter(Boolean);
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

  const createNew = async () => {
    if (!/^[a-z0-9-]{1,64}$/.test(newName)) return alert('名字只能小写字母、数字、-');
    setSelected(newName);
    setContent(`---\nname: ${newName}\ndescription: \nmodel: ${newModel || defaultModel}\n---\n\n你是 ${newName}。\n`);
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

      <div className="flex-1 min-h-0 overflow-hidden flex">
        <div className="w-[140px] border-r border-canvas-deep overflow-y-auto shrink-0">
          {agents.length === 0 && <p className="text-[11px] text-ink-faint p-3 text-center font-body">无 agent</p>}
          {agents.map((a) => (
            <button key={a.name} onClick={() => open(a.name)}
              className={`sidebar-item w-full text-left px-3 py-2 text-xs font-body truncate ${selected === a.name ? 'active text-accent' : 'text-ink-soft'}`}
              title={a.description}>
              <FileText size={10} className="inline mr-1 text-ink-faint" />{a.name}
            </button>
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
