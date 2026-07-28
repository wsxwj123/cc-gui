import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useStore } from '../stores/sessionStore.js';
import { Save, RefreshCw, Check, Lock, Trash2, ChevronLeft, Brain, BookText, Sparkles, Copy, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { confirmDialog } from '../utils/confirmDialog.jsx';
import { useMultiSelect, SelModeToggle, BatchBar, SelCheckbox } from './MultiSelect.jsx';
import { copyText } from '../utils/clipboard.js';

// CLAUDE.md 指令编辑器。注意:CLAUDE.md 是用户写的"指令",不是"记忆"——官方语境里
// "记忆/memory"特指 Claude 自写的 auto memory(~/.claude/projects/<p>/memory/),二者
// 不同。层级与官方文档一致(code.claude.com/docs/en/memory):
// 全局(user)/项目(project)/本地(local) 可编辑,组织(managed,IT 下发)只读。
const LEVELS = [
  { key: 'user', label: '全局', hint: '~/.claude/CLAUDE.md — 对你这台电脑上所有项目都生效(你的个人通用规则)' },
  { key: 'project', label: '项目', hint: '<项目>/CLAUDE.md — 只对当前项目生效,会随 git 提交、和团队共享' },
  { key: 'local', label: '项目·私人', hint: '<项目>/CLAUDE.local.md — 也只对当前项目,但不提交 git、只留在你这台机器(放个人测试路径等不想共享的内容)' },
  { key: 'managed', label: '组织', hint: '公司 IT 统一下发到所有员工电脑的强制规则,只读;个人用户通常没有这个文件' },
];

export function MemoryPanel() {
  const selectedProject = useStore((s) => s.selectedProject);
  const selectedSession = useStore((s) => s.selectedSession);
  const paneSessions = useStore((s) => s.paneSessions);
  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const activeSession = paneSessions?.[activeTabIndex] || selectedSession;
  const cwd = selectedProject?.path || activeSession?.projectPath || '';

  // 二级 tab:指令(CLAUDE.md 四层级) / 自动记忆(CLI 自写 auto-memory)
  const [mode, setMode] = useState('claude-md');

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-3 pt-2 shrink-0">
        {[['claude-md', '指令 (CLAUDE.md)', BookText], ['auto', '自动记忆', Brain], ['prompts', '提示词库', Sparkles]].map(([id, label, Icon]) => (
          <button key={id} onClick={() => setMode(id)}
            className={`flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-t font-body transition-colors border-b-2 ${mode === id ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:text-ink'}`}>
            <Icon size={11} />{label}
          </button>
        ))}
      </div>
      {mode === 'claude-md' ? <ClaudeMdEditor cwd={cwd} /> : mode === 'auto' ? <AutoMemoryTab cwd={cwd} /> : <PromptLibraryTab />}
    </div>
  );
}

function ClaudeMdEditor({ cwd }) {
  const [level, setLevel] = useState('user');
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  const savedTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(savedTimerRef.current), []);

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
      setSaved(true); clearTimeout(savedTimerRef.current); savedTimerRef.current = setTimeout(() => setSaved(false), 1800);
      setData((p) => ({ ...p, exists: true, content: draft }));
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  const dirty = data && draft !== data.content;
  const curHint = LEVELS.find((l) => l.key === level)?.hint;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
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
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md transition-colors disabled:opacity-40 text-on-accent bg-accent hover:bg-accent/90">
            <Save size={12} />{saving ? '保存中…' : '保存'}
          </button>
        </div>
      )}
    </div>
  );
}

// 自动记忆:CLI 在 ~/.claude/projects/<hash>/memory/ 自写的跨会话记忆。
// 列表(name+description)→ 点开编辑/删除;删除联动清 MEMORY.md 索引行(后端做)。
function AutoMemoryTab({ cwd }) {
  const [entries, setEntries] = useState([]);
  const ms = useMultiSelect();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(null); // { file, content, mtime }
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(savedTimerRef.current), []);

  const load = useCallback(async () => {
    if (!cwd) { setEntries([]); setErr('请先在左侧选择一个项目'); return; }
    setLoading(true); setErr('');
    try {
      const r = await fetch(`/api/memory/entries?cwd=${encodeURIComponent(cwd)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '加载失败');
      setEntries(d.entries || []);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }, [cwd]);

  useEffect(() => { setEditing(null); ms.exit(); load(); }, [load]);

  const open = async (file) => {
    setErr('');
    try {
      const r = await fetch(`/api/memory/entries/${encodeURIComponent(file)}?cwd=${encodeURIComponent(cwd)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '读取失败');
      setEditing(d); setDraft(d.content);
    } catch (e) { setErr(e.message); }
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true); setErr('');
    try {
      const r = await fetch(`/api/memory/entries/${encodeURIComponent(editing.file)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        // baseMtime 乐观检查:编辑期间 CLI 若更新过该记忆,后端 409,提示刷新再改。
        body: JSON.stringify({ cwd, content: draft, baseMtime: editing.mtime }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '保存失败');
      setEditing((p) => ({ ...p, content: draft, mtime: d.mtime }));
      setSaved(true); clearTimeout(savedTimerRef.current); savedTimerRef.current = setTimeout(() => setSaved(false), 1800);
      load();
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  const remove = async (file) => {
    if (!(await confirmDialog(`删除这条自动记忆?\n${file}\n\n同时会从 MEMORY.md 索引移除,删除后不可恢复。`, { danger: true }))) return;
    setErr('');
    try {
      const r = await fetch(`/api/memory/entries/${encodeURIComponent(file)}?cwd=${encodeURIComponent(cwd)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '删除失败');
      setEditing(null);
      load();
    } catch (e) { setErr(e.message); }
  };

  // 批量删除:并发调各自单删端点(纯后端,失败 throw),删完统一刷新一次。
  const delOne = (file) => fetch(`/api/memory/entries/${encodeURIComponent(file)}?cwd=${encodeURIComponent(cwd)}`, { method: 'DELETE' })
    .then(async (r) => { if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || '删除失败'); } });
  const onBatchDelete = async () => {
    const res = await ms.runDelete(delOne, { noun: '条记忆', sequential: true, nameOf: (f) => entries.find((e) => e.file === f)?.name || f });
    if (res) { load(); if (res.failed.length) setErr(`${res.failed.length}/${res.total} 条删除失败`); }
  };

  if (editing) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-canvas-deep shrink-0">
          <button onClick={() => setEditing(null)} className="p-1 text-ink-faint hover:text-ink" title="返回列表">
            <ChevronLeft size={13} />
          </button>
          <span className="text-[11px] font-mono text-ink truncate flex-1">{editing.file}</span>
          <button onClick={() => remove(editing.file)} className="p-1 text-ink-faint hover:text-error" title="删除">
            <Trash2 size={12} />
          </button>
        </div>
        {err && <div className="px-3 py-2 text-xs text-amber-700 font-body shrink-0">{err}</div>}
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
          className="flex-1 min-h-0 w-full resize-none px-3 py-2 text-[12px] font-mono leading-relaxed bg-transparent text-ink outline-none" />
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-canvas-deep shrink-0">
          {saved && <span className="text-[11px] text-emerald-600 flex items-center gap-1"><Check size={11} />已保存</span>}
          <button onClick={save} disabled={saving || draft === editing.content}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md transition-colors disabled:opacity-40 text-on-accent bg-accent hover:bg-accent/90">
            <Save size={12} />{saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-canvas-deep shrink-0">
        <span className="text-[10px] text-ink-faint font-body flex-1">
          Claude 自动记下的项目经验(每会话开头自动载入)。共 {entries.length} 条
        </span>
        {entries.length > 0 && <SelModeToggle selMode={ms.selMode} onToggle={() => (ms.selMode ? ms.exit() : ms.enter())} size={12} />}
        <button onClick={load} disabled={loading} className="p-1 text-ink-faint hover:text-ink" title="重新加载">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      {ms.selMode && <BatchBar count={ms.count} busy={ms.busy} onDelete={onBatchDelete} onExit={ms.exit} noun="条记忆"
        allIds={entries.map((e) => e.file)} onSetAll={ms.setAll} />}
      {err && <div className="px-3 py-2 text-xs text-amber-700 font-body shrink-0">{err}</div>}
      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-canvas-deep/50">
        {entries.length === 0 && !loading && (
          <div className="px-3 py-6 text-center text-[11px] text-ink-faint font-body">
            该项目还没有自动记忆。Claude 会在对话中发现值得跨会话记住的经验时自动写入。
          </div>
        )}
        {entries.map((e) => (
          <div key={e.file} className="px-3 py-2 flex items-start gap-2 hover:bg-canvas-warm/50 cursor-pointer group"
            onClick={() => (ms.selMode ? ms.toggle(e.file) : open(e.file))}>
            {ms.selMode
              ? <SelCheckbox checked={ms.selected.has(e.file)} onClick={() => ms.toggle(e.file)} size={13} className="mt-0.5" />
              : <Brain size={12} className="text-accent/70 mt-0.5 shrink-0" />}
            <div className="min-w-0 flex-1">
              <div className="text-[12px] text-ink font-body font-medium truncate">{e.name || e.file}</div>
              {e.description && <div className="text-[10.5px] text-ink-muted font-body line-clamp-2">{e.description.replace(/^"|"$/g, '')}</div>}
            </div>
            {!ms.selMode && (
              <button onClick={(ev) => { ev.stopPropagation(); remove(e.file); }}
                className="p-1 text-ink-faint hover:text-error opacity-0 group-hover:opacity-100 shrink-0" title="删除">
                <Trash2 size={11} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// 提示词库:内置 780 条(Cherry Studio 开源助手预设),按分类折叠浏览,复制 prompt
// 到剪贴板(可粘贴到输入框或项目级/会话级 CLAUDE.md)。分类全部保留、各有名字。
function PromptLibraryTab() {
  const [templates, setTemplates] = useState(null);
  const [openGroups, setOpenGroups] = useState({});
  const [copiedId, setCopiedId] = useState('');
  const [query, setQuery] = useState('');
  const copyTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  useEffect(() => {
    fetch('/api/prompt-templates')
      .then((r) => r.json())
      .then((d) => setTemplates(Array.isArray(d.templates) ? d.templates : []))
      .catch(() => setTemplates([]));
  }, []);

  // 按第一个 group 归类(一个模板只出现在一处,避免重复);检索匹配标题+描述+提示词
  // 正文(此前只搜标题描述,按用途关键词如"周报"搜不到正文里才出现的词)。
  const searching = query.trim().length > 0;
  const byGroup = useMemo(() => {
    const q = query.trim().toLowerCase();
    const m = new Map();
    for (const t of templates || []) {
      if (q && !`${t.name || ''}\n${t.description || ''}\n${t.prompt || ''}`.toLowerCase().includes(q)) continue;
      const g = (Array.isArray(t.group) && t.group[0]) || '未分类';
      if (!m.has(g)) m.set(g, []);
      m.get(g).push(t);
    }
    // 按数量降序,分类名各自保留
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [templates, query]);
  const matchCount = useMemo(() => byGroup.reduce((n, [, items]) => n + items.length, 0), [byGroup]);

  const copy = async (t) => {
    const ok = await copyText(t.prompt || '');
    if (ok) { setCopiedId(t.id); clearTimeout(copyTimerRef.current); copyTimerRef.current = setTimeout(() => setCopiedId(''), 1500); }
    else await confirmDialog('复制失败:剪贴板不可用', { danger: false });
  };

  if (templates === null) {
    return <div className="flex-1 flex items-center justify-center text-ink-faint text-sm font-body">加载中…</div>;
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col px-3 pb-3">
      <div className="text-[10.5px] text-ink-faint font-body py-2 leading-relaxed shrink-0">
        内置 {templates.length} 条提示词预设。点「复制」后可粘贴到输入框直接用,或粘到项目级 /
        会话级 CLAUDE.md 里作为长期指令。
      </div>
      <div className="relative shrink-0 mb-2">
        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索提示词（标题 / 描述 / 正文）…"
          className="w-full text-[11px] font-body bg-canvas-warm border border-canvas-deep rounded pl-7 pr-2 py-1.5 text-ink focus:border-accent outline-none" />
      </div>
      {searching && (
        <div className="text-[10px] text-ink-faint font-body mb-1 shrink-0">找到 {matchCount} 条匹配</div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
        {byGroup.map(([group, items]) => {
          // 检索时默认展开各分类(否则只见分类头看不到命中条目,等于没搜);
          // 用户手动折叠仍尊重(??);清空检索恢复原折叠状态。
          const open = searching ? (openGroups[group] ?? true) : openGroups[group];
          return (
            <div key={group} className="border border-canvas-deep rounded-lg overflow-hidden">
              <button onClick={() => setOpenGroups((s) => ({ ...s, [group]: !s[group] }))}
                className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-body text-ink hover:bg-canvas-warm transition-colors">
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="font-medium">{group}</span>
                <span className="text-ink-faint">({items.length})</span>
              </button>
              {open && (
                <div className="divide-y divide-canvas-deep/60">
                  {items.map((t) => (
                    <div key={t.id} className="px-2.5 py-2 flex items-start gap-2 hover:bg-canvas-warm/50">
                      <span className="text-[15px] leading-none shrink-0 mt-0.5">{t.emoji || '📝'}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[11.5px] text-ink font-body font-medium truncate">{t.name}</div>
                        {t.description && <div className="text-[10px] text-ink-faint font-body line-clamp-2">{t.description}</div>}
                      </div>
                      <button onClick={() => copy(t)} title="复制提示词到剪贴板"
                        className="shrink-0 flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-canvas-deep text-ink-soft hover:text-accent hover:border-accent transition-colors">
                        {copiedId === t.id ? <><Check size={10} className="text-success" />已复制</> : <><Copy size={10} />复制</>}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {byGroup.length === 0 && <div className="text-center text-ink-faint text-[11px] font-body py-8">没有匹配的提示词</div>}
      </div>
    </div>
  );
}
