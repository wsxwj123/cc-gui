import React, { useEffect, useState } from 'react';
import { AlertCircle, Loader2, ClipboardList } from 'lucide-react';
import { useStore } from '../stores/sessionStore.js';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';

// Color per tool family so the user's eye locks onto the risk class quickly.
function toolBadgeClass(name) {
  if (!name) return 'bg-canvas-deep text-ink-muted';
  const m = name.toLowerCase();
  if (m === 'bash') return 'bg-amber-100 text-amber-800';
  if (m === 'write') return 'bg-rose-100 text-rose-800';
  if (m === 'edit' || m === 'notebookedit') return 'bg-blue-100 text-blue-800';
  if (m === 'read') return 'bg-emerald-100 text-emerald-800';
  if (m.startsWith('webfetch') || m.startsWith('websearch')) return 'bg-violet-100 text-violet-800';
  return 'bg-canvas-deep text-ink-muted';
}

// Friendly headline label for the most common tools' primary input.
function primaryInputLabel(name) {
  const m = (name || '').toLowerCase();
  if (m === 'bash') return ['命令', 'command'];
  if (m === 'read' || m === 'write' || m === 'edit' || m === 'notebookedit') return ['文件', 'file_path'];
  if (m === 'glob') return ['Glob', 'pattern'];
  if (m === 'grep') return ['搜索', 'pattern'];
  if (m === 'webfetch') return ['URL', 'url'];
  if (m === 'websearch') return ['查询', 'query'];
  return ['输入', null];
}

function renderInput(toolName, input) {
  const [label, key] = primaryInputLabel(toolName);
  const primary = key && input?.[key];
  const rest = { ...(input || {}) };
  if (key) delete rest[key];
  return (
    <div className="space-y-1.5">
      {primary != null && (
        <>
          <div className="text-[11px] text-ink-faint">{label}</div>
          <pre className="font-mono text-[12px] bg-canvas-warm border border-canvas-deep rounded px-2.5 py-2 whitespace-pre-wrap break-all text-ink max-h-32 overflow-y-auto">{String(primary)}</pre>
        </>
      )}
      {Object.keys(rest).length > 0 && (
        <details className="text-[11px] text-ink-faint">
          <summary className="cursor-pointer hover:text-ink-muted select-none">其他参数 ({Object.keys(rest).length}) ▾</summary>
          <pre className="font-mono text-[11px] bg-canvas-warm border border-canvas-deep rounded px-2.5 py-2 whitespace-pre-wrap break-all text-ink-muted mt-1.5 max-h-40 overflow-y-auto">{JSON.stringify(rest, null, 2)}</pre>
        </details>
      )}
      {primary == null && Object.keys(rest).length === 0 && (
        <div className="text-[12px] text-ink-faint">（无参数）</div>
      )}
    </div>
  );
}

// Plan-mode review card. Triggered by ExitPlanMode tool_use which our hook
// intercepts like any other PreToolUse. Approve → CLI continues turn with
// acceptEdits-like execution. Refine → CLI sees a `deny` with the feedback
// as `reason`, AI revises the plan and re-emits ExitPlanMode.
function PlanReviewCard({ req, onResolve, processing, position }) {
  const plan = String(req.toolInput?.plan || '').trim();
  const [feedback, setFeedback] = useState('');
  const [showRefine, setShowRefine] = useState(false);
  useEffect(() => {
    if (position !== 0) return;
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (e.key === 'Enter') { e.preventDefault(); onResolve(req, 'allow'); }
      else if (e.key === 'Escape') { e.preventDefault(); onResolve(req, 'deny'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [position, req, onResolve]);

  const submitRefine = () => {
    onResolve(req, 'deny', feedback.trim() || '请修改计划');
  };

  return (
    <div className="rounded-xl bg-white border border-canvas-deep shadow-lg overflow-hidden animate-fade-up relative">
      <div className="px-4 py-2.5 flex items-center gap-2 border-b border-canvas-deep bg-blue-50/60">
        <div className="w-6 h-6 rounded-md bg-blue-100 flex items-center justify-center shrink-0">
          <ClipboardList size={13} className="text-blue-700" />
        </div>
        <div className="text-[13px] font-medium text-ink flex-1">
          Claude 完成了计划，请审查
        </div>
        {req.cwd && (
          <div className="text-[10px] text-ink-faint font-mono truncate max-w-[40%]" title={req.cwd}>
            {req.cwd}
          </div>
        )}
      </div>
      <div className="px-4 py-3 max-h-[42vh] overflow-y-auto bg-canvas-warm/40">
        <MarkdownRenderer content={plan || '(空计划)'} />
      </div>
      {showRefine && (
        <div className="px-4 py-2.5 border-t border-canvas-deep bg-amber-50/40 space-y-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="告诉 Claude 该如何修改这份计划..."
            rows={3}
            autoFocus
            className="w-full text-[12px] font-body px-2.5 py-2 rounded border border-canvas-deep bg-white text-ink resize-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setShowRefine(false); setFeedback(''); }}
              className="text-[11px] text-ink-muted hover:text-ink px-2 py-1"
            >取消</button>
            <button
              disabled={!feedback.trim() || processing}
              onClick={submitRefine}
              className="ml-auto px-3 py-1.5 rounded-md text-[12px] font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50"
            >提交修改意见</button>
          </div>
        </div>
      )}
      {!showRefine && (
        <div className="px-4 py-2.5 flex items-center gap-2 bg-canvas-warm/60 border-t border-canvas-deep">
          <button
            disabled={processing}
            onClick={() => setShowRefine(true)}
            className="px-3 py-1.5 rounded-md text-[12px] font-medium text-ink-muted hover:bg-canvas-deep"
            title="附上修改意见，让 AI 重写计划"
          >需要修改</button>
          <button
            disabled={processing}
            onClick={() => onResolve(req, 'deny', '用户取消计划')}
            className="px-3 py-1.5 rounded-md text-[12px] font-medium text-ink-muted hover:bg-canvas-deep"
            title="Esc"
          >取消</button>
          <button
            disabled={processing}
            onClick={() => onResolve(req, 'allow')}
            className="ml-auto px-3 py-1.5 rounded-md text-[12px] font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
            title="Enter"
          >
            {processing && <Loader2 size={11} className="animate-spin" />}
            按计划执行 ↵
          </button>
        </div>
      )}
    </div>
  );
}

function PermissionCard({ req, onResolve, onWhitelistAndAllow, onResolveSame, sameCount, processing, position }) {
  const [remember, setRemember] = useState(false);
  // Enter = allow, Esc = deny — only when this is the top card.
  useEffect(() => {
    if (position !== 0) return;
    const onKey = (e) => {
      // ignore if user is typing in textarea/input
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (remember) onWhitelistAndAllow(req); else onResolve(req, 'allow');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onResolve(req, 'deny');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [position, req, remember, onResolve, onWhitelistAndAllow]);

  return (
    <div className="rounded-xl bg-white border border-canvas-deep shadow-lg overflow-hidden animate-fade-up relative">
      <div className="px-4 py-2.5 flex items-center gap-2 border-b border-canvas-deep bg-amber-50/60">
        <div className="w-6 h-6 rounded-md bg-amber-100 flex items-center justify-center shrink-0">
          <AlertCircle size={13} className="text-amber-700" />
        </div>
        <div className="text-[13px] font-medium text-ink flex items-center gap-1 flex-1 min-w-0">
          <span className="shrink-0">Claude 想使用</span>
          <span className={`px-1.5 py-0.5 rounded font-mono text-[11px] ml-1 ${toolBadgeClass(req.toolName)}`}>
            {req.toolName}
          </span>
        </div>
        {req.cwd && (
          <div className="text-[10px] text-ink-faint font-mono truncate max-w-[40%]" title={req.cwd}>
            {req.cwd}
          </div>
        )}
      </div>
      <div className="px-4 py-3">{renderInput(req.toolName, req.toolInput)}</div>
      {sameCount > 0 && (
        <div className="px-4 pb-2 -mt-1">
          <button
            disabled={processing}
            onClick={() => onResolveSame(req, 'allow')}
            className="w-full text-[11px] text-accent hover:bg-accent/10 border border-accent/30 rounded-md px-2 py-1.5 transition-colors disabled:opacity-50"
            title="把本分屏其他会话里相同工具+相同参数的请求一并允许；不同请求仍单独询问"
          >
            同时允许其他 {sameCount} 个会话的相同请求（{req.toolName}）
          </button>
        </div>
      )}
      <div className="px-4 py-2.5 flex items-center gap-2 bg-canvas-warm/60 border-t border-canvas-deep">
        <label className="flex items-center gap-1.5 text-[11px] text-ink-muted mr-auto cursor-pointer select-none">
          <input
            type="checkbox"
            className="rounded accent-accent"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          本会话内永远允许 <span className="font-mono">{req.toolName}</span>
        </label>
        <button
          disabled={processing}
          onClick={() => onResolve(req, 'deny')}
          className="px-3 py-1.5 rounded-md text-[12px] font-medium text-ink-muted hover:bg-canvas-deep disabled:opacity-50"
          title="Esc"
        >拒绝</button>
        <button
          disabled={processing}
          onClick={() => remember ? onWhitelistAndAllow(req) : onResolve(req, 'allow')}
          className="px-3 py-1.5 rounded-md text-[12px] font-medium text-white bg-accent hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1.5"
          title="Enter"
        >
          {processing && <Loader2 size={11} className="animate-spin" />}
          允许 ↵
        </button>
      </div>
    </div>
  );
}

function PendingPill({ req, position }) {
  return (
    <div className="rounded-lg bg-white/60 border border-canvas-deep px-3 py-1.5 flex items-center gap-2 opacity-70">
      <span className="text-[10px] font-mono text-ink-faint shrink-0">{position + 1}</span>
      <span className="text-[12px] text-ink shrink-0">
        <span className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${toolBadgeClass(req.toolName)}`}>{req.toolName}</span>
      </span>
      <span className="font-mono text-[11px] text-ink-faint truncate flex-1">
        {String(req.toolInput?.command || req.toolInput?.file_path || req.toolInput?.url || req.toolInput?.pattern || req.toolInput?.query || '')}
      </span>
    </div>
  );
}

/**
 * Sits above ChatInput. Shows pending permission requests filtered to the
 * currently-selected session — other sessions' requests stay in the store
 * but don't render here.
 */
export function PermissionPrompt({ sessionId = null }) {
  const all = useStore((s) => s.pendingPermissions);
  const globalSid = useStore((s) => s.selectedSession?.sessionId);
  const paneSessions = useStore((s) => s.paneSessions);
  const paneCount = useStore((s) => s.paneCount);
  const removePendingPermission = useStore((s) => s.removePendingPermission);
  const whitelist = useStore((s) => s.whitelistPermissionTool);
  const [busyId, setBusyId] = useState(null);
  // This card belongs to a specific pane's session. Prefer the explicit prop
  // (correct in split mode where each pane has its own session); fall back to
  // the global selection for single-pane callers.
  const selectedSid = sessionId || globalSid;

  // Hydrate on first mount so a page refresh while a request is mid-flight
  // doesn't leave it invisible (the WS broadcast already fired before we
  // attached).
  useEffect(() => {
    fetch('/api/permissions/pending')
      .then((r) => r.json())
      .then((d) => {
        useStore.getState().setPendingPermissions(d.items || []);
      })
      .catch(() => {});
  }, []);

  const mine = all.filter((p) => !selectedSid || p.sessionId === selectedSid);
  if (mine.length === 0) return null;

  const resolve = async (req, decision, reason) => {
    setBusyId(req.id);
    try {
      await fetch(`/api/permissions/respond/${req.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, reason }),
      });
    } catch {}
    removePendingPermission(req.id);
    setBusyId(null);
  };

  const whitelistAndAllow = async (req) => {
    whitelist(req.sessionId, req.toolName);
    await resolve(req, 'allow');
  };

  // Opt-in batch: resolve the SAME request (same tool + identical input) in the
  // OTHER sessions currently open in panes. Different requests are untouched.
  const sameInputKey = (r) => `${r.toolName} ${JSON.stringify(r.toolInput || {})}`;
  const paneSidSet = new Set(
    (paneSessions || []).slice(0, paneCount || 1).map((p) => p?.sessionId).filter(Boolean)
  );
  const matchesAcrossPanes = (req) => all.filter(
    (p) => p.id !== req.id
      && p.sessionId !== req.sessionId
      && paneSidSet.has(p.sessionId)
      && sameInputKey(p) === sameInputKey(req)
  );
  const resolveSame = async (req, decision) => {
    const others = matchesAcrossPanes(req);
    await Promise.all([req, ...others].map((r) => resolve(r, decision)));
  };

  return (
    <div className="px-6 pb-2 space-y-2 max-w-3xl mx-auto w-full">
      {mine.length > 1 && (
        <div className="text-[11px] text-ink-muted px-1">
          {mine.length} 个待处理请求 · 上面的先处理
        </div>
      )}
      {mine[0].toolName === 'ExitPlanMode' ? (
        <PlanReviewCard
          req={mine[0]}
          onResolve={resolve}
          processing={busyId === mine[0].id}
          position={0}
        />
      ) : (
        <PermissionCard
          req={mine[0]}
          onResolve={resolve}
          onWhitelistAndAllow={whitelistAndAllow}
          onResolveSame={resolveSame}
          sameCount={matchesAcrossPanes(mine[0]).length}
          processing={busyId === mine[0].id}
          position={0}
        />
      )}
      {mine.slice(1).map((req, i) => (
        <PendingPill key={req.id} req={req} position={i + 1} />
      ))}
    </div>
  );
}
