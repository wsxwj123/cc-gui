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

// 按回合(turnIndex)把变更分组。同一文件在不同回合的修改会落到不同组,用户一眼就能看出
// "这次改动是哪轮对话、对应我哪条消息"产生的。组间按 turnIndex **倒序**(最新回合在最
// 上),方便从最新变更开始往回滚;组内保持原始顺序。
function groupByTurn(changes) {
  const byIndex = new Map();
  for (const c of changes) {
    const ti = c.turnIndex ?? 0;
    if (!byIndex.has(ti)) {
      byIndex.set(ti, { turnIndex: ti, turnPrompt: c.turnPrompt || '', turnTs: c.turnTs || c.timestamp, items: [] });
    }
    byIndex.get(ti).items.push(c);
  }
  return [...byIndex.values()].sort((a, b) => b.turnIndex - a.turnIndex);
}

function ChangeItem({ change, sessionId, cwd, reviewed, onToggleReviewed }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(null);
  const [reverted, setReverted] = useState(false);
  // AZ13:回滚成功原本只把 hover-only 图标变勾,鼠标移开就看不见 → 用户感知不到成功。
  // 加一条短暂常显的成功文案。
  const [flash, setFlash] = useState(false); // false | 'head' | 'checkpoint'
  // 两条链路语义不同:HEAD=丢弃全部未提交修改;checkpoint=回到该轮对话前的快照
  // (可能仍含更早回合的未提交改动)。文案如实区分,别都说"已恢复"。
  const markReverted = (via = 'head') => {
    setReverted(true);
    setFlash(via);
    setTimeout(() => setFlash(false), 2600);
  };

  const revert = async (e) => {
    e.stopPropagation();
    if (!change.file) return;
    const msg = change.type === 'write'
      ? `恢复到 HEAD：\n${change.file}\n\n仅当确认为本轮真实新建的文件时才会删除；若是覆写已存在文件则恢复其快照内容或丢失未提交修改。确定？`
      : `恢复到 HEAD：\n${change.file}\n\n会丢失所有未提交修改，确定？`;
    if (!(await confirmDialog(msg, { danger: true }))) return;
    setBusy('revert');
    try {
      // 链路1:git checkout HEAD。不再传 allowDeleteUntracked——untracked 文件直接
      // unlink 会绕过 checkpoint 里保存的"覆写前内容"(用户手工文件被 Write 覆盖的
      // 场景),一律 409 落到链路2,由快照决定"恢复原内容"还是"确属本轮新建才删"。
      const res = await fetch('/api/file/revert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: change.file }),
      });
      // 非 JSON 响应(网关 5xx HTML)不能让 .json() 抛进外层 catch → 会跳过链路2 的
      // checkpoint 回退。容错为 {} 后按 !res.ok 正常落到 fallback。
      const d = await res.json().catch(() => ({}));
      if (res.ok) markReverted();
      else if (sessionId && cwd) {
        const params = new URLSearchParams();
        if (change.timestamp) params.set('timestamp', change.timestamp);
        params.set('before', 'true');
        const rr = await fetch(`/api/checkpoints/${sessionId}/resolve?${params.toString()}`);
        const rd = await rr.json().catch(() => ({}));
        if (!rr.ok || !rd.sha) {
          confirmDialog('恢复失败：' + (d.error || res.status));
          return;
        }
        // allowDelete 只对【确认真新建】的文件授权(isNewFile===true,来自 jsonl 的
        // toolUseResult.type==='create')。Write 覆写已存在文件(update)或结果缺失
        // (null)一律不授权删除——否则覆写 gitignored 文件后回滚会把用户原文件销毁。
        const cr = await fetch(`/api/checkpoints/${sessionId}/restore-file`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sha: rd.sha, cwd, file: change.file, allowDelete: change.isNewFile === true }),
        });
        const cd = await cr.json().catch(() => ({}));
        if (cr.ok) markReverted('checkpoint');
        else confirmDialog('恢复失败：' + (cd.error || cr.status));
      } else {
        confirmDialog('恢复失败：' + (d.error || res.status));
      }
    } catch (err) { confirmDialog('恢复失败：' + err.message); }
    finally { setBusy(null); }
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
    : `${change.file?.split(/[/\\]/).pop()}${change.editIndex != null ? ` #${change.editIndex + 1}` : ''}`;
  const detail = change.type === 'bash'
    ? change.command
    : change.file;

  return (
    <div className={`group border rounded-lg overflow-hidden animate-fade-up ${reviewed ? 'border-success/25 bg-success/5' : 'border-canvas-deep'}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-canvas-warm/60 transition-colors text-left cursor-pointer"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-ink-faint shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-ink-faint shrink-0" />
        )}
        <Icon size={12} className={`shrink-0 ${change.type === 'bash' ? 'text-warning/70' : 'text-accent/60'}`} />
        <span className="text-xs text-ink-soft font-mono truncate flex-1">{label}</span>
        {change.subagent && (
          <span className="text-[9px] px-1 py-px rounded bg-canvas-deep text-ink-faint shrink-0" title={`来自子代理 ${change.subagent}`}>子代理</span>
        )}
        {change.diff && (
          <span className="flex items-center gap-1 text-[10px] font-mono shrink-0">
            {change.deletions > 0 && <span className="text-red-500">-{change.deletions}</span>}
            {change.additions > 0 && <span className="text-green-600">+{change.additions}</span>}
          </span>
        )}
        {flash && (
          <span className="flex items-center gap-0.5 text-[10px] text-success shrink-0 animate-fade-up">
            <Check size={10} /> {flash === 'checkpoint' ? '已恢复到该轮对话前的快照' : '已恢复到 git HEAD'}
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
      </div>

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
  const [loadError, setLoadError] = useState(null);
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
    setLoadError(null);
    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/file-changes?projectHash=${encodeURIComponent(projectHash)}`
      );
      // Server may return a 5xx HTML error page; .json() would throw and a
      // non-array body would crash the .map() below. Coerce to [] defensively.
      // 5xx 时置 error 态而非空列表——"该会话没有文件变更记录"会让用户误以为
      // AI 没改任何文件。
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setLoadError(d.error || `${res.status}`);
        setChanges([]);
      } else {
        const data = await res.json().catch(() => []);
        setChanges(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Failed to fetch file changes:', err);
      setLoadError(err.message);
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

  if (loadError) {
    return (
      <div className="text-xs text-red-600 font-body py-6 text-center px-4">
        变更记录加载失败：{loadError}
        <button onClick={() => fetchChanges()} className="block mx-auto mt-2 text-accent hover:underline">重试</button>
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
      {groupByTurn(changes).map((group) => (
        <div key={group.turnIndex} className="space-y-1.5">
          <div className="flex items-center gap-2 px-1 pt-2 pb-1 border-b border-canvas-deep/40">
            <span className="text-[10px] font-mono text-accent shrink-0">回合 {group.turnIndex || '—'}</span>
            <span className="text-[11px] text-ink-muted font-body truncate" title={group.turnPrompt}>
              {group.turnPrompt || '(无对应用户消息)'}
            </span>
            <span className="text-[9px] text-ink-faint font-mono shrink-0 ml-auto">{formatTime(group.turnTs)}</span>
          </div>
          {group.items.map((change, i) => (
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
        // 活跃 pane 的项目路径优先:分屏打开另一项目的会话时,selectedProject 还停
        // 在全局选中项目,优先它会把错误的 workTree 传给 checkpoint 恢复链路。
        cwd={activeSession.projectPath || selectedProject?.path}
      />
    </div>
  );
}
