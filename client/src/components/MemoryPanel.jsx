import React, { useState, useEffect, useCallback } from 'react';
import { useStore } from '../stores/sessionStore.js';
import { Save, RefreshCw, Check, Lock } from 'lucide-react';

// CLAUDE.md 记忆编辑器。层级与官方文档一致(code.claude.com/docs/en/memory):
// 全局(user)/项目(project)/本地(local) 可编辑,组织(managed,IT 下发)只读。
const LEVELS = [
  { key: 'user', label: '全局', hint: '~/.claude/CLAUDE.md · 对所有项目生效,仅你' },
  { key: 'project', label: '项目', hint: '<项目>/CLAUDE.md · 团队共享(随 git 提交)' },
  { key: 'local', label: '本地', hint: '<项目>/CLAUDE.local.md · 仅你,当前项目(应 gitignore)' },
  { key: 'managed', label: '组织', hint: '系统级,IT 下发 · 只读' },
];

export function MemoryPanel() {
  const selectedProject = useStore((s) => s.selectedProject);
  const selectedSession = useStore((s) => s.selectedSession);
  const paneSessions = useStore((s) => s.paneSessions);
  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const activeSession = paneSessions?.[activeTabIndex] || selectedSession;
  const cwd = selectedProject?.path || activeSession?.projectPath || '';

  const [level, setLevel] = useState('user');
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const needsCwd = level === 'project' || level === 'local';

  const load = useCallback(async () => {
    if (needsCwd && !cwd) { setData(null); setErr('请先在左侧选择一个项目'); return; }
    setLoading(true); setErr('');
    try {
      const qs = new URLSearchParams({ level, cwd: needsCwd ? cwd : '' });
      const r = await fetch(`/api/memory?${qs}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '加载失败');
      setData(d); setDraft(d.content);
    } catch (e) { setErr(e.message); setData(null); }
    setLoading(false);
  }, [level, cwd, needsCwd]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!data?.editable) return;
    setSaving(true); setErr('');
    try {
      const r = await fetch('/api/memory', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, cwd: needsCwd ? cwd : '', content: draft }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '保存失败');
      setSaved(true); setTimeout(() => setSaved(false), 1800);
      setData((p) => ({ ...p, exists: true, content: draft }));
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  const dirty = data && draft !== data.content;
  const curHint = LEVELS.find((l) => l.key === level)?.hint;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-canvas-deep shrink-0 flex-wrap">
        {LEVELS.map((l) => (
          <button key={l.key} onClick={() => setLevel(l.key)}
            className={`text-[11px] px-2 py-1 rounded font-body transition-colors ${level === l.key ? 'bg-accent/15 text-accent' : 'text-ink-muted hover:text-ink'}`}
            title={l.hint}>
            {l.label}
          </button>
        ))}
        <button onClick={load} disabled={loading} className="ml-auto p-1 text-ink-faint hover:text-ink" title="重新加载">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="px-3 py-1.5 border-b border-canvas-deep/50 shrink-0 space-y-0.5">
        <div className="text-[10px] text-ink-faint font-mono truncate" title={data?.path || curHint}>{data?.path || curHint}</div>
        {data && !data.exists && data.editable && <div className="text-[10px] text-amber-600 font-body">文件不存在，保存后新建</div>}
        {data && !data.editable && <div className="text-[10px] text-ink-faint font-body flex items-center gap-1"><Lock size={9} />组织下发，只读</div>}
      </div>

      {err && <div className="px-3 py-2 text-xs text-amber-700 font-body shrink-0">{err}</div>}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        readOnly={!data?.editable}
        placeholder={data?.editable ? '在此编写 CLAUDE.md 指令（构建命令、代码规范、项目约定…）' : ''}
        spellCheck={false}
        className="flex-1 min-h-0 w-full resize-none px-3 py-2 text-[12px] font-mono leading-relaxed bg-transparent text-ink outline-none"
      />

      {data?.editable && (
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-canvas-deep shrink-0">
          {saved && <span className="text-[11px] text-emerald-600 flex items-center gap-1"><Check size={11} />已保存</span>}
          <button onClick={save} disabled={saving || !dirty}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md transition-colors disabled:opacity-40 text-white bg-accent hover:bg-accent/90">
            <Save size={12} />{saving ? '保存中…' : '保存'}
          </button>
        </div>
      )}
    </div>
  );
}
