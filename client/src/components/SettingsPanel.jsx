import React, { useEffect, useState } from 'react';
import { Settings, Save, RefreshCw, AlertCircle, Check, Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { useStore } from '../stores/sessionStore.js';

const HOOK_EVENTS = [
  'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse',
  'Stop', 'SubagentStop', 'Notification',
];

export function SettingsPanel() {
  const [settings, setSettings] = useState(null);
  const [rawJson, setRawJson] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('overview'); // overview | hooks | json | storage

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      setSettings(data);
      setRawJson(JSON.stringify(data, null, 2));
    } catch (err) { setError(err.message); }
    setLoading(false);
  };

  useEffect(() => { fetchSettings(); }, []);

  // Persist either an arbitrary object (Hooks tab) or the raw JSON (JSON tab).
  const save = async (next) => {
    setSaving(true); setError(null);
    try {
      const body = next !== undefined ? next : JSON.parse(rawJson);
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setSettings(data); setRawJson(JSON.stringify(data, null, 2));
      setSaved(true); setTimeout(() => setSaved(false), 1800);
    } catch (err) { setError(err.message); }
    setSaving(false);
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12"><RefreshCw size={16} className="text-ink-faint animate-spin" /></div>;
  }

  return (
    <div className="px-4 py-4 space-y-4 overflow-y-auto h-full">
      <div className="flex items-center gap-1 border-b border-canvas-deep -mx-4 px-4 pb-2">
        {[['overview', '概览'], ['hooks', 'Hooks'], ['json', 'JSON'], ['storage', '存储']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`text-[11px] px-2.5 py-1 rounded font-body transition-colors ${tab === id ? 'bg-accent/15 text-accent' : 'text-ink-muted hover:text-ink'}`}>
            {label}
          </button>
        ))}
        <button onClick={fetchSettings} className="ml-auto p-1 text-ink-faint hover:text-ink" title="重新加载">
          <RefreshCw size={12} />
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-error bg-error-subtle rounded-lg p-2.5">
          <AlertCircle size={13} /><span className="font-body">{error}</span>
        </div>
      )}

      {tab === 'overview' && <OverviewTab settings={settings} />}
      {tab === 'hooks' && (
        <HooksTab settings={settings} onSave={save} saving={saving} saved={saved} />
      )}
      {tab === 'json' && (
        <JsonTab rawJson={rawJson} setRawJson={setRawJson} onSave={() => save()}
          onReset={() => { setRawJson(JSON.stringify(settings, null, 2)); setError(null); }}
          saving={saving} saved={saved} />
      )}
      {tab === 'storage' && <StorageTab />}
    </div>
  );
}

// Lists .jsonl.bak backups created by /trim and /strip-thinking. Each row
// pairs a backup file with the session's first user prompt so the user can
// recognize what they're about to delete. Total size is shown up top.
function StorageTab() {
  const [data, setData] = useState({ items: [], totalBytes: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  };
  const fmtTime = (ms) => {
    try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); }
    catch { return ''; }
  };

  const fetchList = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/bak-files');
      const d = await r.json();
      setData(d);
    } catch {}
    setLoading(false);
  };
  useEffect(() => { fetchList(); }, []);

  const deleteOne = async (item) => {
    setBusy(true);
    try {
      await fetch('/api/bak-files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ projectHash: item.projectHash, sessionId: item.sessionId }] }),
      });
      await fetchList();
    } catch {}
    setBusy(false);
  };

  const deleteAll = async () => {
    if (!confirm(`确定清理全部 ${data.items.length} 个 .bak 备份？将释放 ${fmtBytes(data.totalBytes)}。`)) return;
    setBusy(true);
    try {
      await fetch('/api/bak-files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      await fetchList();
    } catch {}
    setBusy(false);
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12"><RefreshCw size={16} className="text-ink-faint animate-spin" /></div>;
  }

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-ink-faint font-body leading-relaxed bg-canvas-warm border border-canvas-deep rounded-lg p-2.5">
        每次"回滚 / 切换模型剥离思考块"前会写一份 <code className="font-mono">&lt;sid&gt;.jsonl.bak</code> 备份。删除会话不会自动删 .bak，长期积累在此手动清理。<strong className="text-amber-700">删除后不可恢复。</strong>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-xs text-ink-muted font-body">
          共 <span className="font-mono text-ink">{data.items.length}</span> 个备份 · 占用 <span className="font-mono text-ink">{fmtBytes(data.totalBytes)}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchList} disabled={busy}
            className="text-[11px] px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-canvas-warm font-body inline-flex items-center gap-1">
            <RefreshCw size={11} /> 刷新
          </button>
          <button onClick={deleteAll} disabled={busy || data.items.length === 0}
            className="text-[11px] px-2.5 py-1 rounded bg-error/10 text-error hover:bg-error/15 font-body inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed">
            <Trash2 size={11} /> 全部清理
          </button>
        </div>
      </div>

      {data.items.length === 0 ? (
        <p className="text-xs text-ink-faint font-body py-6 text-center">没有 .bak 备份文件</p>
      ) : (
        <div className="bg-canvas-warm border border-canvas-deep rounded-lg divide-y divide-canvas-deep">
          {data.items.map((it) => (
            <div key={`${it.projectHash}/${it.sessionId}`} className="flex items-center gap-3 px-3 py-2.5">
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-ink font-body truncate flex items-center gap-1.5">
                  {it.orphan && <span className="text-[9px] px-1 rounded bg-amber-100 text-amber-700 border border-amber-200 font-mono shrink-0">孤儿</span>}
                  <span className="truncate">{it.title}</span>
                </div>
                <div className="text-[10px] text-ink-faint font-mono mt-0.5">
                  {it.sessionId.slice(0, 8)} · {fmtTime(it.mtimeMs)}
                </div>
              </div>
              <div className="text-[11px] text-ink-muted font-mono shrink-0">{fmtBytes(it.size)}</div>
              <button onClick={() => deleteOne(it)} disabled={busy}
                className="p-1 rounded hover:bg-error/10 text-ink-faint hover:text-error shrink-0"
                title="删除此备份">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OverviewTab({ settings }) {
  const rows = [];
  if (settings?.defaultModel || settings?.model) rows.push(['默认模型', settings.defaultModel || settings.model]);
  if (settings?.env) rows.push(['环境变量', `${Object.keys(settings.env).length} 个`]);
  if (settings?.hooks) {
    const total = Object.values(settings.hooks).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
    rows.push(['Hooks', `${Object.keys(settings.hooks).length} 事件 · ${total} 条`]);
  }
  if (settings?.permissions) rows.push(['权限规则', `${Object.keys(settings.permissions).length} 条`]);
  if (settings?.plugins) rows.push(['插件', `${Object.keys(settings.plugins).length} 个`]);
  if (!rows.length) return <p className="text-xs text-ink-faint font-body py-6 text-center">settings.json 为空</p>;
  return (
    <div className="bg-canvas-warm border border-canvas-deep rounded-lg divide-y divide-canvas-deep">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between px-3 py-2.5">
          <span className="text-xs text-ink-muted font-body">{k}</span>
          <span className="text-xs text-ink-soft font-mono">{v}</span>
        </div>
      ))}
    </div>
  );
}

function HooksTab({ settings, onSave, saving, saved }) {
  const [hooks, setHooks] = useState(settings?.hooks || {});
  const [open, setOpen] = useState({});
  const [adding, setAdding] = useState(null); // event name being added to
  const [newCmd, setNewCmd] = useState('');
  const [newMatcher, setNewMatcher] = useState('');

  // Re-sync if settings reloaded externally
  useEffect(() => { setHooks(settings?.hooks || {}); }, [settings]);

  const persist = (next) => {
    setHooks(next);
    onSave({ ...settings, hooks: next });
  };

  const removeHook = (event, groupIdx, cmdIdx) => {
    if (!confirm('删除这条 hook？')) return;
    const next = { ...hooks };
    const groups = [...(next[event] || [])];
    const group = { ...groups[groupIdx] };
    group.hooks = (group.hooks || []).filter((_, i) => i !== cmdIdx);
    if (!group.hooks.length) groups.splice(groupIdx, 1);
    else groups[groupIdx] = group;
    if (groups.length) next[event] = groups; else delete next[event];
    persist(next);
  };

  const addHook = (event) => {
    if (!newCmd.trim()) return;
    const next = { ...hooks };
    next[event] = [
      ...(next[event] || []),
      { matcher: newMatcher, hooks: [{ type: 'command', command: newCmd }] },
    ];
    persist(next);
    setAdding(null); setNewCmd(''); setNewMatcher('');
  };

  const events = [...new Set([...Object.keys(hooks), ...HOOK_EVENTS])];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[10px] text-ink-faint">
        <span className="font-body">{Object.keys(hooks).length} 个事件已配置 hook</span>
        {saving && <span className="font-mono">保存中…</span>}
        {saved && <span className="font-mono text-success">已保存</span>}
      </div>
      {events.map((event) => {
        const groups = hooks[event] || [];
        const count = groups.reduce((n, g) => n + (g.hooks?.length || 0), 0);
        const isOpen = open[event];
        return (
          <div key={event} className="border border-canvas-deep rounded-lg overflow-hidden">
            <button onClick={() => setOpen({ ...open, [event]: !isOpen })}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-canvas-warm/60 text-left">
              {isOpen ? <ChevronDown size={11} className="text-ink-faint" /> : <ChevronRight size={11} className="text-ink-faint" />}
              <span className="text-xs font-mono text-ink-soft flex-1">{event}</span>
              <span className="text-[10px] text-ink-faint font-mono">{count}</span>
            </button>
            {isOpen && (
              <div className="border-t border-canvas-deep px-3 py-2 space-y-1.5">
                {groups.map((g, gi) => (
                  (g.hooks || []).map((h, ci) => (
                    <div key={`${gi}-${ci}`} className="flex items-start gap-2 group">
                      {g.matcher && (
                        <span className="chip font-mono shrink-0 mt-0.5" title="matcher">{g.matcher}</span>
                      )}
                      <code className="flex-1 text-[10.5px] text-ink-muted font-mono break-all leading-snug">{h.command}</code>
                      <button onClick={() => removeHook(event, gi, ci)}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-error/15 rounded shrink-0"
                        title="删除">
                        <Trash2 size={11} className="text-error" />
                      </button>
                    </div>
                  ))
                ))}
                {adding === event ? (
                  <div className="space-y-1.5 pt-1.5 border-t border-canvas-deep">
                    <input value={newMatcher} onChange={(e) => setNewMatcher(e.target.value)}
                      placeholder="matcher (可选，如 Bash, '' 匹配全部)"
                      className="w-full bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-[11px] font-mono" />
                    <textarea value={newCmd} onChange={(e) => setNewCmd(e.target.value)}
                      placeholder="shell 命令"
                      className="w-full h-16 bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-[11px] font-mono resize-none" />
                    <div className="flex gap-1.5">
                      <button onClick={() => addHook(event)} disabled={!newCmd.trim()}
                        className="btn-accent text-[11px] px-2.5 py-1">添加</button>
                      <button onClick={() => { setAdding(null); setNewCmd(''); setNewMatcher(''); }}
                        className="text-[11px] px-2.5 py-1 text-ink-muted hover:text-ink">取消</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setAdding(event)}
                    className="text-[10px] text-accent hover:underline flex items-center gap-1 font-body">
                    <Plus size={11} /> 新增 hook
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function JsonTab({ rawJson, setRawJson, onSave, onReset, saving, saved }) {
  return (
    <div className="space-y-3">
      <textarea value={rawJson} onChange={(e) => setRawJson(e.target.value)}
        spellCheck={false}
        className="w-full h-[60vh] bg-canvas-warm border border-canvas-deep rounded-lg p-3 text-xs font-mono text-ink-soft resize-none focus:outline-none focus:border-accent/40 leading-relaxed" />
      <div className="flex gap-2">
        <button onClick={onSave} disabled={saving}
          className="btn-accent flex items-center gap-1.5 px-3 py-1.5 text-xs">
          {saved ? <Check size={12} /> : <Save size={12} />}
          {saved ? '已保存' : saving ? '保存中…' : '保存'}
        </button>
        <button onClick={onReset}
          className="px-3 py-1.5 bg-canvas-warm text-ink-faint text-xs font-body rounded-lg hover:text-ink-muted">重置</button>
      </div>
    </div>
  );
}
