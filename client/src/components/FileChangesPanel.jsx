import React, { useEffect, useState } from 'react';
import { FileText, Edit3, Terminal, RefreshCw, ChevronDown, ChevronRight, ExternalLink, RotateCcw, Check, Eye, EyeOff } from 'lucide-react';
import { useStore } from '../stores/sessionStore.js';
import { DiffViewer } from './DiffViewer.jsx';
import { confirmDialog } from '../utils/confirmDialog.jsx';

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function reviewKey(change) {
  return change.id || `${change.type}:${change.file || change.command}:${change.timestamp}:${change.uuid || ''}`;
}

function ChangeItem({ change, sessionId, cwd, reviewed, onToggleReviewed }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(null);
  const [reverted, setReverted] = useState(false);

  const revert = async (e) => {
    e.stopPropagation();
    if (!change.file) return;
    const msg = change.type === 'write'
      ? `恢复到 HEAD：\n${change.file}\n\n如果这是本轮新建且未被 git 跟踪的文件，会直接删除；否则会丢失该文件的未提交修改。确定？`
      : `恢复到 HEAD：\n${change.file}\n\n会丢失所有未提交修改，确定？`;
    if (!(await confirmDialog(msg, { danger: true }))) return;
    setBusy('revert');
    try {
      const res = await fetch('/api/file/revert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: change.file, allowDeleteUntracked: change.type === 'write' }),
      });
      const d = await res.json();
      if (res.ok) setReverted(true);
      else if (sessionId && cwd) {
        const params = new URLSearchParams();
        if (change.timestamp) params.set('timestamp', change.timestamp);
        params.set('before', 'true');
        const rr = await fetch(`/api/checkpoints/${sessionId}/resolve?${params.toString()}`);
        const rd = await rr.json().catch(() => ({}));
        if (!rr.ok || !rd.sha) {
          alert('恢复失败：' + (d.error || res.status));
          return;
        }
        const cr = await fetch(`/api/checkpoints/${sessionId}/restore-file`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sha: rd.sha, cwd, file: change.file }),
        });
        const cd = await cr.json().catch(() => ({}));
        if (cr.ok) setReverted(true);
        else alert('恢复失败：' + (cd.error || cr.status));
      } else {
        alert('恢复失败：' + (d.error || res.status));
      }
    } catch (err) { alert('恢复失败：' + err.message); }
    setBusy(null);
  };

  const open = async (e) => {
    e.stopPropagation();
    if (!change.file) return;
    setBusy('open');
    try {
      await fetch('/api/file/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: change.file }),
      });
    } catch {}
    setBusy(null);
  };

  const icon = change.type === 'edit' ? Edit3 : change.type === 'write' ? FileText : Terminal;
  const Icon = icon;
  const label = change.type === 'bash'
    ? change.command?.slice(0, 80)
    : `${change.file?.split('/').pop()}${change.editIndex != null ? ` #${change.editIndex + 1}` : ''}`;
  const detail = change.type === 'bash'
    ? change.command
    : change.file;

  return (
    <div className={`group border rounded-lg overflow-hidden animate-fade-up ${reviewed ? 'border-success/25 bg-success/5' : 'border-canvas-deep'}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-canvas-warm/60 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-ink-faint shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-ink-faint shrink-0" />
        )}
        <Icon size={12} className={change.type === 'bash' ? 'text-warning/70' : 'text-accent/60'} shrink-0 />
        <span className="text-xs text-ink-soft font-mono truncate flex-1">{label}</span>
        {change.diff && (
          <span className="flex items-center gap-1 text-[10px] font-mono shrink-0">
            {change.deletions > 0 && <span className="text-red-500">-{change.deletions}</span>}
            {change.additions > 0 && <span className="text-green-600">+{change.additions}</span>}
          </span>
        )}
        <span className="flex items-center gap-1 shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onToggleReviewed(change); }}
            className={`p-1 rounded transition-colors ${reviewed ? 'bg-success/10 hover:bg-success/15' : 'hover:bg-black/10'}`}
            title={reviewed ? '标记为未审查' : '标记为已审查'}
          >
            {reviewed ? <EyeOff size={11} className="text-success" /> : <Eye size={11} className="text-ink-muted" />}
          </button>
          {change.file && (
            <span className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={open} disabled={busy === 'open'}
              className="p-1 hover:bg-black/10 rounded" title="在编辑器中打开">
              <ExternalLink size={11} className="text-ink-muted" />
            </button>
            <button onClick={revert} disabled={busy === 'revert' || reverted}
              className="p-1 hover:bg-error/15 rounded" title={reverted ? '已恢复' : '恢复到 git HEAD'}>
              {reverted
                ? <Check size={11} className="text-success" />
                : <RotateCcw size={11} className={busy === 'revert' ? 'text-ink-faint animate-spin' : 'text-error'} />}
            </button>
            </span>
          )}
        </span>
        <span className="text-[10px] text-ink-faint font-mono shrink-0">
          {formatTime(change.timestamp)}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-canvas-deep p-3 space-y-2 animate-fade-in bg-canvas">
          <div className="text-[10px] text-ink-faint font-body">
            类型: {change.type === 'edit' ? '编辑' : change.type === 'write' ? '写入' : '命令'}
          </div>
          <div className="text-[10px] text-ink-muted font-mono break-all">
            {detail}
          </div>
          {change.diff ? (
            <div className="border border-canvas-sunken rounded-md overflow-hidden">
              <DiffViewer diff={change.diff} maxHeight="max-h-96" />
            </div>
          ) : change.type === 'bash' ? (
            <div className="text-[11px] text-ink-faint font-body bg-canvas-warm border border-canvas-sunken rounded p-2">
              该命令可能修改文件，但无法从命令文本可靠生成逐文件 diff。请结合 Git 面板或文件树确认实际变更。
            </div>
          ) : null}
          {!change.diff && change.type === 'edit' && change.oldPreview && (
            <div>
              <div className="text-[10px] text-ink-faint font-body mb-1">旧内容:</div>
              <pre className="text-[11px] bg-canvas-warm border border-canvas-sunken rounded p-2 font-mono text-ink-muted overflow-x-auto max-h-24">
                {change.oldPreview}
              </pre>
            </div>
          )}
          {!change.diff && change.preview && (
            <div>
              <div className="text-[10px] text-ink-faint font-body mb-1">
                {change.type === 'edit' ? '新内容:' : '内容预览:'}
              </div>
              <pre className="text-[11px] bg-canvas-warm border border-canvas-sunken rounded p-2 font-mono text-ink-muted overflow-x-auto max-h-24">
                {change.preview}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FileChangesPanel({ sessionId, projectHash, cwd }) {
  const [changes, setChanges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reviewedMap, setReviewedMap] = useState({});
  const storageKey = sessionId ? `cgui-file-review-${sessionId}` : null;

  useEffect(() => {
    if (!storageKey) { setReviewedMap({}); return; }
    try {
      setReviewedMap(JSON.parse(localStorage.getItem(storageKey) || '{}'));
    } catch {
      setReviewedMap({});
    }
  }, [storageKey]);

  const saveReviewedMap = (next) => {
    setReviewedMap(next);
    if (storageKey) {
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
    }
  };

  const toggleReviewed = (change) => {
    const key = reviewKey(change);
    const next = { ...reviewedMap };
    if (next[key]) delete next[key];
    else next[key] = { reviewedAt: new Date().toISOString() };
    saveReviewedMap(next);
  };

  const fetchChanges = async () => {
    if (!sessionId || !projectHash) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/file-changes?projectHash=${encodeURIComponent(projectHash)}`
      );
      // Server may return a 5xx HTML error page; .json() would throw and a
      // non-array body would crash the .map() below. Coerce to [] defensively.
      const data = res.ok ? await res.json().catch(() => []) : [];
      setChanges(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to fetch file changes:', err);
    }
    setLoading(false);
  };

  useEffect(() => { fetchChanges(); }, [sessionId, projectHash]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <RefreshCw size={14} className="text-ink-faint animate-spin" />
      </div>
    );
  }

  if (changes.length === 0) {
    return (
      <div className="text-xs text-ink-faint font-body py-6 text-center">
        该会话没有文件变更记录
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-ink-faint font-mono">
          {changes.filter((change) => reviewedMap[reviewKey(change)]).length}/{changes.length} 已审查
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              const next = {};
              for (const change of changes) next[reviewKey(change)] = { reviewedAt: new Date().toISOString() };
              saveReviewedMap(next);
            }}
            className="text-[10px] text-ink-faint hover:text-ink-muted font-body px-1 py-0.5 rounded hover:bg-canvas-warm"
          >
            完成审查
          </button>
          <button
            onClick={fetchChanges}
            className="text-[10px] text-ink-faint hover:text-ink-muted font-body p-1 rounded hover:bg-canvas-warm"
            title="刷新"
          >
            <RefreshCw size={10} />
          </button>
        </div>
      </div>
      {changes.map((change, i) => (
        <ChangeItem
          key={reviewKey(change) || i}
          change={change}
          sessionId={sessionId}
          cwd={cwd}
          reviewed={!!reviewedMap[reviewKey(change)]}
          onToggleReviewed={toggleReviewed}
        />
      ))}
    </div>
  );
}

export function FileReviewPanel() {
  const selectedSession = useStore((s) => s.selectedSession);
  const paneSessions = useStore((s) => s.paneSessions);
  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const selectedProject = useStore((s) => s.selectedProject);
  const activeSession = paneSessions?.[activeTabIndex] || selectedSession;

  if (!activeSession?.sessionId || !activeSession?.projectHash) {
    return (
      <div className="h-full flex items-center justify-center px-6 text-center">
        <div className="text-xs text-ink-faint font-body">
          当前没有可审查的会话
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-3">
      <FileChangesPanel
        sessionId={activeSession.sessionId}
        projectHash={activeSession.projectHash}
        cwd={selectedProject?.path || activeSession.projectPath}
      />
    </div>
  );
}
