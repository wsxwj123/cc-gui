// r151b 跨会话消息一期:目标会话输入框上方的卡片区(接口文件 X.3.4「卡片区」)。
// 数据与动作全在 utils/xsession.js;这里只渲染。总开关关着、没有会话、没有待处理或处理中的消息时整块不渲染
// (输入框在这些情况下与改动前逐字相同,见 tests/unit/check-r151b-baseline-ui.mjs)。
// 外层容器照权限卡(PermissionPrompt)的同一写法,与它同在输入框上方。
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CornerLeftUp, ChevronDown, ChevronRight } from './Icon.jsx';
import {
  useXsEnabled, useXsInbox, useXsBusy, useXsQueuedHere, watchXsInbox,
  processXsMessage, releaseXsMessage, dismissXsMessage,
  xsCardFromText, xsCardReasonText,
} from '../utils/xsession.js';

const FOLD_LINES = 8;
const CLAMP_STYLE = { display: '-webkit-box', WebkitLineClamp: FOLD_LINES, WebkitBoxOrient: 'vertical', overflow: 'hidden' };
const BTN = 'shrink-0 px-2.5 py-1 rounded-md text-[12px] font-body transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const BTN_PRIMARY = `${BTN} bg-accent text-white hover:bg-accent/90`;
const BTN_PLAIN = `${BTN} border border-canvas-deep text-ink-muted hover:border-accent/40 hover:text-ink`;

const pad2 = (n) => String(n).padStart(2, '0');
function formatArrival(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const now = new Date();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// noFold:目标会话(本窗格会话)在「放任」档 —— 点【处理】后工具不经确认直接执行,正文整段摊开、不给折叠(审计 S6)
const XsCard = React.memo(function XsCard({ message, noFold = false, onProcess, onRelease, onDismiss }) {
  const busy = useXsBusy(message.id);
  // 会话正忙时点过【处理】:"处理这条消息"已排在前端队列里(消息在服务端仍是 pending),轮到它时才认领
  const queuedHere = useXsQueuedHere(message.id);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const bodyRef = useRef(null);
  const body = typeof message.body === 'string' ? message.body : '';
  const lineCount = body ? body.split('\n').length : 0;
  const unfolded = expanded || noFold;
  // 折叠态一律按 8 行截断;是否需要「展开」看实际有没有被截(长行自动折行也算),不只数换行
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || unfolded) return;
    setOverflow(el.scrollHeight > el.clientHeight + 1);
  }, [body, unfolded]);
  const foldable = !noFold && (lineCount > FOLD_LINES || overflow);
  const status = message.status;
  const canProcess = !busy && !queuedHere && (status === 'pending' || status === 'queued');
  const canDismiss = !busy && (status === 'pending' || status === 'queued' || status === 'claimed');
  const arrival = formatArrival(message.createdAt);
  return (
    <div data-testid="xs-card" data-message-id={message.id} data-status={status}
      className="rounded-panel bg-canvas border border-canvas-deep shadow-popover px-3 py-2.5 animate-fade-up">
      <div className="flex items-center gap-1.5 min-w-0 text-[11px] font-body text-ink-muted">
        <CornerLeftUp size={12} className="shrink-0 text-accent" />
        <span data-testid="xs-card-from" className="truncate min-w-0">{xsCardFromText(message)}</span>
        {arrival && <span className="shrink-0 text-ink-faint font-mono" title={new Date(Date.parse(message.createdAt)).toLocaleString()}>{arrival}</span>}
      </div>
      <div ref={bodyRef} data-testid="xs-card-body"
        className="mt-1.5 text-[12.5px] leading-relaxed text-ink font-body whitespace-pre-wrap break-words"
        style={unfolded ? undefined : CLAMP_STYLE}>
        {body || '（正文不可用）'}
      </div>
      {foldable && (
        <button data-testid="xs-card-expand" onClick={() => setExpanded((v) => !v)}
          className="mt-1 flex items-center gap-1 text-[11px] text-accent font-body hover:underline">
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {expanded ? '收起' : '展开全文'}
        </button>
      )}
      <div className="mt-2 flex items-center gap-2 min-w-0">
        <span data-testid="xs-card-reason" className="flex-1 min-w-0 truncate text-[11px] text-ink-faint font-body">{xsCardReasonText(message, queuedHere)}</span>
        <button data-testid="xs-card-process" disabled={!canProcess} onClick={() => onProcess(message.id)} className={BTN_PRIMARY}
          title="把这条消息交给本会话的模型处理(用本会话当前的模型与权限档)">处理</button>
        {status === 'claimed' && (
          <button data-testid="xs-card-release" disabled={busy} onClick={() => onRelease(message.id)} className={BTN_PLAIN}
            title="撤回这次处理,卡片回到待处理">撤回</button>
        )}
        <button data-testid="xs-card-dismiss" disabled={!canDismiss} onClick={() => onDismiss(message.id)} className={BTN_PLAIN}
          title="不处理这条消息,卡片消失,正文随即删除">忽略</button>
      </div>
    </div>
  );
});

/** sessionId = 本窗格当前会话;onSend = 本窗格的既有发送入口(App.jsx handleSend,经 ChatInput 透传);noFold = 本会话在「放任」档。 */
export const XsInbox = React.memo(function XsInbox({ sessionId = null, onSend, noFold = false }) {
  const enabled = useXsEnabled();
  const messages = useXsInbox(sessionId);
  const [error, setError] = useState('');
  // 回调走 ref:按钮点下后的异步续体里读"此刻"的会话与发送入口,不读闭包里的旧值
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  useEffect(() => (enabled && sessionId ? watchXsInbox(sessionId) : undefined), [enabled, sessionId]);
  useEffect(() => { setError(''); }, [sessionId]);
  const handlersRef = useRef(null);
  if (!handlersRef.current) {
    const act = (fn) => async (messageId) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      setError('');
      const r = await fn(sid, messageId);
      if (r && r.error && sessionIdRef.current === sid) setError(r.error);
    };
    handlersRef.current = {
      onProcess: act((sid, messageId) => processXsMessage({
        sessionId: sid,
        messageId,
        send: (prompt, opts) => onSendRef.current?.(prompt, opts),
        isStillOn: () => sessionIdRef.current === sid,
      })),
      onRelease: act((sid, messageId) => releaseXsMessage({ sessionId: sid, messageId })),
      onDismiss: act((sid, messageId) => dismissXsMessage({ sessionId: sid, messageId })),
    };
  }
  if (!enabled || !sessionId || messages.length === 0) return null;
  const { onProcess, onRelease, onDismiss } = handlersRef.current;
  return (
    <div data-testid="xs-inbox" data-cgui="xs-inbox" className="px-6 pb-2 space-y-2 max-w-[var(--content-max)] mx-auto w-full">
      {error && <div className="text-[11px] text-amber-700 font-body px-1">{error}</div>}
      <div className="space-y-2 max-h-[min(42vh,calc(var(--app-h,100dvh)*0.42))] overflow-y-auto">
        {messages.map((m) => (
          <XsCard key={m.id} message={m} noFold={noFold} onProcess={onProcess} onRelease={onRelease} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
});
