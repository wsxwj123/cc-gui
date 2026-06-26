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
// intercepts like any other PreToolUse.
//
// Approve ("按计划执行") → onApprove: we DENY the ExitPlanMode (with an
// "approved, end the turn" reason) so the headless planning turn stops cleanly
// instead of looping — empirically, `claude -p --permission-mode plan` cannot
// transition out of plan mode in-process, so allowing ExitPlanMode just makes
// the model spin trying to re-confirm. The caller then re-spawns a fresh
// acceptEdits turn to actually execute the approved plan.
// Refine → CLI sees a `deny` with the feedback as `reason`, AI revises the
// plan and re-emits ExitPlanMode. Cancel → plain deny.
function PlanReviewCard({ req, onResolve, onApprove, processing, position, hydrate }) {
  const plan = String(req.toolInput?.plan || '').trim();
  const [feedback, setFeedback] = useState('');
  const [showRefine, setShowRefine] = useState(false);
  useEffect(() => {
    // BK-1:同一会话可同时挂多个 PermissionPrompt(母会话 ChatInput + 子代理视图
    // SubagentView)。两个实例都绑 window keydown → 按一次键 respond 两次(Enter
    // 重复 onExecutePlan 更危险)。键盘只在主实例(hydrate=true)绑;子代理那张
    // hydrate=false 只能点按钮,共享 store 单次解析。
    if (!hydrate) return;
    if (position !== 0) return;
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (e.key === 'Enter') { e.preventDefault(); onApprove(req); }
      else if (e.key === 'Escape') { e.preventDefault(); onResolve(req, 'deny', '用户取消计划'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hydrate, position, req, onResolve, onApprove]);

  const submitRefine = () => {
    onResolve(req, 'deny', feedback.trim() || '请修改计划');
  };

  return (
    <div className="flex flex-col max-h-[68vh] rounded-xl bg-white border border-canvas-deep shadow-lg overflow-hidden animate-fade-up relative">
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
      <div className="px-4 py-3 flex-1 min-h-0 overflow-y-auto bg-canvas-warm/40">
        <MarkdownRenderer content={plan || '(空计划)'} />
      </div>
      {showRefine && (
        <div className="px-4 py-2.5 border-t border-canvas-deep bg-amber-50/40 space-y-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              // 与输入框一致:Cmd/Ctrl+Enter 提交修改意见,裸 Enter 换行。stopPropagation
              // 防冒泡到卡片 window 级 Enter 监听(那个会触发"按计划执行")。
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                e.stopPropagation();
                if (feedback.trim() && !processing) submitRefine();
              }
            }}
            placeholder="告诉 Claude 该如何修改这份计划...（⌘/Ctrl+Enter 提交）"
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
            onClick={() => onApprove(req)}
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

// AskUserQuestion picker. The CLI can't run this tool in headless mode, so the
// GUI collects the choice and feeds it back via onAnswer (a deny whose reason is
// the answer). toolInput.questions = [{ question, header, options:[{label,
// description}], multiSelect? }].
function AskQuestionCard({ req, onAnswer, processing, position, hydrate }) {
  const questions = Array.isArray(req.toolInput?.questions) ? req.toolInput.questions : [];
  const [picks, setPicks] = useState({});    // qi -> string | string[]
  const [customs, setCustoms] = useState({}); // qi -> free text

  const choose = (qi, label, multi) => {
    setPicks((prev) => {
      if (!multi) return { ...prev, [qi]: prev[qi] === label ? undefined : label };
      const cur = Array.isArray(prev[qi]) ? prev[qi] : [];
      return { ...prev, [qi]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
    });
  };
  const answerOf = (qi) => {
    const c = (customs[qi] || '').trim();
    const p = picks[qi];
    const sel = Array.isArray(p) ? p.join('、') : (p || '');
    return [sel, c].filter(Boolean).join('；');
  };
  const allAnswered = questions.length > 0 && questions.every((_, qi) => answerOf(qi));

  const submit = () => {
    if (!allAnswered) return;
    const text = questions
      .map((q, qi) => `【${q.header || '问题' + (qi + 1)}】${q.question}\n→ ${answerOf(qi)}`)
      .join('\n\n');
    // 结构化 answers:key=问题原文,value=所选 label(多选用"、"拼)。SDK canUseTool 据此
    // 返回 {behavior:'allow', updatedInput:{questions, answers}},模型干净收到。
    const answers = {};
    questions.forEach((q, qi) => { answers[q.question] = answerOf(qi); });
    onAnswer(req, text, { questions, answers });
  };

  useEffect(() => {
    if (!hydrate) return; // BK-1:键盘只在主实例绑,避免子代理视图重复 respond
    if (position !== 0) return;
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        // submit() 内部已有 `if (!allAnswered) return;`,未答完时无副作用。
        // 此前外层加 `&& allAnswered` 守门,Enter 完全沉默,用户以为回车没绑。
        submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hydrate, position, allAnswered, picks, customs]);

  return (
    <div className="flex flex-col max-h-[68vh] rounded-xl bg-white border border-canvas-deep shadow-lg overflow-hidden animate-fade-up relative">
      <div className="px-4 py-2.5 flex items-center gap-2 border-b border-canvas-deep bg-violet-50/60">
        <div className="w-6 h-6 rounded-md bg-violet-100 flex items-center justify-center shrink-0">
          <AlertCircle size={13} className="text-violet-700" />
        </div>
        <div className="text-[13px] font-medium text-ink flex-1">Claude 需要你的选择</div>
      </div>
      <div className="px-4 py-3 flex-1 min-h-0 overflow-y-auto space-y-4">
        {questions.map((q, qi) => {
          const multi = !!q.multiSelect;
          const opts = Array.isArray(q.options) ? q.options : [];
          return (
            <div key={qi} className="space-y-2">
              {q.header && <div className="text-[10.5px] uppercase tracking-wide text-ink-faint">{q.header}</div>}
              <div className="text-[13px] text-ink font-medium">{q.question}{multi && <span className="text-ink-faint font-normal">（可多选）</span>}</div>
              <div className="grid gap-1.5">
                {opts.map((o, oi) => {
                  const label = typeof o === 'string' ? o : (o?.label ?? '');
                  const desc = typeof o === 'object' ? o?.description : null;
                  const p = picks[qi];
                  const sel = multi ? (Array.isArray(p) && p.includes(label)) : p === label;
                  return (
                    <button
                      key={oi}
                      disabled={processing}
                      onClick={() => choose(qi, label, multi)}
                      className={`text-left px-3 py-2 rounded-lg border text-[12.5px] transition-colors disabled:opacity-50 ${
                        sel ? 'border-violet-400 bg-violet-50 text-ink' : 'border-canvas-deep bg-canvas-warm/40 text-ink-soft hover:bg-canvas-deep'
                      }`}
                    >
                      <span className="font-medium">{label}</span>
                      {desc && <span className="block text-[11px] text-ink-faint mt-0.5">{desc}</span>}
                    </button>
                  );
                })}
                <input
                  type="text"
                  value={customs[qi] || ''}
                  onChange={(e) => setCustoms((prev) => ({ ...prev, [qi]: e.target.value }))}
                  placeholder="或自定义回答…"
                  className="mt-0.5 text-[12px] font-body px-2.5 py-1.5 rounded-md border border-canvas-deep bg-white text-ink"
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-4 py-2.5 flex items-center gap-2 bg-canvas-warm/60 border-t border-canvas-deep">
        <button
          disabled={processing}
          onClick={() => onAnswer(req, '[用户跳过了此问题，请自行用合理默认值继续]')}
          className="px-3 py-1.5 rounded-md text-[12px] font-medium text-ink-muted hover:bg-canvas-deep disabled:opacity-50"
        >跳过</button>
        <button
          disabled={processing || !allAnswered}
          onClick={submit}
          className="ml-auto px-3 py-1.5 rounded-md text-[12px] font-medium text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-1.5"
          title="Enter"
        >
          {processing && <Loader2 size={11} className="animate-spin" />}
          提交 ↵
        </button>
      </div>
    </div>
  );
}

function PermissionCard({ req, onResolve, onWhitelistAndAllow, onResolveSame, sameCount, processing, position, hydrate }) {
  const [remember, setRemember] = useState(false);
  // Enter = allow, Esc = deny — only when this is the top card.
  useEffect(() => {
    if (!hydrate) return; // BK-1:键盘只在主实例绑,避免子代理视图重复 respond
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
  }, [hydrate, position, req, remember, onResolve, onWhitelistAndAllow]);

  return (
    <div className="flex flex-col max-h-[68vh] rounded-xl bg-white border border-canvas-deep shadow-lg overflow-hidden animate-fade-up relative">
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
      <div className="px-4 py-3 flex-1 min-h-0 overflow-y-auto">{renderInput(req.toolName, req.toolInput)}</div>
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
// hydrate:挂载时是否从 /api/permissions/pending 拉取并自动放行白名单项。同一会话
// 同时挂多个 PermissionPrompt(如 ChatInput 与子代理视图)时,只让其中一个 hydrate,
// 避免对同一 id 重复 respond。两个实例共享 store,审批/驳回按 id 幂等。
export function PermissionPrompt({ sessionId = null, onExecutePlan = null, hydrate = true }) {
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
  // attached). The live WS path auto-allows whitelisted tools before they
  // ever render; the hydration path must do the same, otherwise a request
  // for a "永远允许" tool that was pending at mount re-prompts despite the
  // user having opted in. Auto-resolve those here (per-request sessionId
  // whitelist only — no cross-session reach).
  useEffect(() => {
    if (!hydrate) return;
    const ctrl = new AbortController();
    fetch('/api/permissions/pending', { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => {
        const items = Array.isArray(d?.items) ? d.items : [];
        // BK-2:不能整表 setPendingPermissions(keep) —— fetch 飞行期 WS 来的新请求
        // (addPendingPermission)会被旧快照覆盖 → "授权弹窗不出现"。改为逐条
        // addPendingPermission(内部按 id 去重),即"合并"而非"替换",不丢飞行期新增。
        const add = useStore.getState().addPendingPermission;
        for (const it of items) {
          let wl = [];
          try { wl = JSON.parse(localStorage.getItem(`cgui-perm-wl-${it.sessionId || 'none'}`) || '[]'); } catch {}
          if (wl.includes(it.toolName)) {
            // 白名单命中:放行但不入表。
            fetch(`/api/permissions/respond/${it.id}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ decision: 'allow' }),
            }).catch(() => {});
          } else {
            add(it);
          }
        }
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  // A request whose sessionId is null/undefined — the CLI hasn't surfaced the
  // session id yet on a brand-new session's first tool call — would otherwise
  // match no pane and stay invisible: the user never sees the prompt, the
  // bridge eventually times out, and the tool looks "denied / no permission".
  // In single-pane mode, surface such orphans under the current session. (Skip
  // in split mode so the same orphan isn't shown in every pane at once.)
  // T1: 单窗格此前无条件显示全部 in-flight 请求(为修 #2"plan 回合带新/空
  // sessionId 时审批卡不出现") —— 副作用是会话 A 等回复时切到 B,A 的权限/
  // 计划卡片串显在 B 里。改为按归属精准过滤:
  //   ① sessionId 命中当前会话 → 显示;
  //   ② sessionId 为空(新会话首个工具调用,CLI 还没给 id) → 显示;
  //   ③ sessionId 属于其他已知会话(在会话列表里) → 不显示(这就是串显);
  //   ④ sessionId 未知(plan 回合 spawn 的新 id,#2 场景) → 仅当请求 cwd 落在
  //      当前项目路径下才显示,跨项目一律不串。
  // 多窗格:保持按 pane 的 sessionId 严格匹配,避免同一请求在每个窗格重复弹。
  const sessionsList = useStore((s) => s.sessions);
  const projectPath = useStore((s) => s.selectedProject?.path);
  const knownSids = new Set((Array.isArray(sessionsList) ? sessionsList : []).map((x) => x.sessionId));
  const mine = paneCount === 1
    ? all.filter((p) => {
        if (!p.sessionId) return true;                       // ②
        if (p.sessionId === selectedSid) return true;        // ①
        if (knownSids.has(p.sessionId)) return false;        // ③
        return !projectPath || !p.cwd || String(p.cwd).startsWith(projectPath); // ④
      })
    : all.filter((p) => !selectedSid || p.sessionId === selectedSid);
  if (mine.length === 0) return null;

  const resolve = async (req, decision, reason, updatedInput) => {
    setBusyId(req.id);
    try {
      await fetch(`/api/permissions/respond/${req.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // updatedInput:SDK canUseTool 用 —— AskUserQuestion 的 {questions, answers}
        // 或被用户改过的工具入参。仅在提供时附带,保持旧 deny 路径不变。
        body: JSON.stringify({ decision, reason, ...(updatedInput !== undefined ? { updatedInput } : {}) }),
      });
    } catch {}
    removePendingPermission(req.id);
    setBusyId(null);
  };

  const whitelistAndAllow = async (req) => {
    whitelist(req.sessionId, req.toolName);
    // 勾选"本会话永远允许 X"时,把当前同会话同工具的其他待处理请求一并放行。它们
    // 在白名单写入之前就已并发发出(例:AI 一次抛 3 条 Bash),useWebSocket 的 auto-
    // allow 只对"之后"到达的请求生效,所以这几条会卡着要逐条点。这里补扫一次(#8)。
    const sameTool = all.filter(
      (p) => p.id !== req.id && p.sessionId === req.sessionId && p.toolName === req.toolName,
    );
    await Promise.all([req, ...sameTool].map((r) => resolve(r, 'allow')));
  };

  // Plan approved (SDK 引擎):allow ExitPlanMode → 模型退出 plan、在同一回合继续执行
  // (不再 deny+另起回合)。再把活跃 query 切到 acceptEdits,使后续写从"plan 硬拦"
  // 变为"经 canUseTool 弹窗"。onExecutePlan 仅用于同步 GUI 档位状态(已去掉 respawn)。
  const approvePlan = async (req) => {
    await resolve(req, 'allow');
    try {
      await fetch('/api/chat/permission-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: req.sessionId, mode: 'acceptEdits' }),
      });
    } catch {}
    onExecutePlan?.();
  };

  // AskUserQuestion answered (SDK 引擎):allow + 结构化 answers,模型干净收到答案
  // (tool 视为成功)。跳过(无结构化答案)回退 deny + 备注,模型读文本继续。
  const answerQuestion = async (req, answerText, structured) => {
    if (structured && structured.answers) {
      await resolve(req, 'allow', null, { questions: structured.questions, answers: structured.answers });
    } else {
      await resolve(req, 'deny', `[用户已通过界面回答]\n${answerText}\n请直接据此继续，不要再次调用 AskUserQuestion。`);
    }
  };

  // Opt-in batch: resolve the SAME request (same tool + identical input) in the
  // OTHER sessions currently open in panes. Different requests are untouched.
  const sameInputKey = (r) => `${r.toolName} ${JSON.stringify(r.toolInput || {})}`;
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
    <div className="px-6 pb-2 space-y-2 max-w-[var(--content-max)] mx-auto w-full">
      {mine.length > 1 && (
        <div className="text-[11px] text-ink-muted px-1">
          {mine.length} 个待处理请求 · 上面的先处理
        </div>
      )}
      {mine[0].toolName === 'ExitPlanMode' ? (
        <PlanReviewCard
          req={mine[0]}
          onResolve={resolve}
          onApprove={approvePlan}
          processing={busyId === mine[0].id}
          position={0}
          hydrate={hydrate}
        />
      ) : mine[0].toolName === 'AskUserQuestion' ? (
        <AskQuestionCard
          req={mine[0]}
          onAnswer={answerQuestion}
          processing={busyId === mine[0].id}
          position={0}
          hydrate={hydrate}
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
          hydrate={hydrate}
        />
      )}
      {mine.slice(1).map((req, i) => (
        <PendingPill key={req.id} req={req} position={i + 1} />
      ))}
    </div>
  );
}
