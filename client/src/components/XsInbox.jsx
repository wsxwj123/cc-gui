// r151b 跨会话消息一期:目标会话输入框上方的卡片区(接口文件 X.3.4「卡片区」)。
// 数据与动作全在 utils/xsession.js;这里只渲染。总开关关着、没有会话、没有待处理或处理中的消息时整块不渲染
// (输入框在这些情况下与改动前逐字相同,见 tests/unit/check-r151b-baseline-ui.mjs)。
// 外层容器照权限卡(PermissionPrompt)的同一写法,与它同在输入框上方。
// r151w/r151x:卡片不再是浮起的大块,改用与 TaskNoticeRow 同款的居中折叠行(XsNoticeRow):
// 折叠态只有标题行 + 状态 + 展开全文(不显示正文),展开后才显示完整正文(窄块居中 + 块内两端对齐);
// 动作行(处理 / 撤回 / 忽略)留在折叠行里、紧贴标题行,收起状态也能直接点。
// r152d:收件箱改用 XsNoticeRow 的 compact 一行版式(标题 / 展开 / 原因 / 按钮同一行,窄屏回落两行),区域上限 20% 视口高。
// r151y:「放任」档不再例外 —— 所有权限档都折叠,正文不摊开(旧的 noFold / 审计 S6 约定作废)。
import React, { useEffect, useRef, useState } from 'react';
import { CornerLeftUp } from './Icon.jsx';
import { XsNoticeRow } from './XsNoticeRow.jsx';
import {
  useXsEnabled, useXsInbox, useXsBusy, useXsQueuedHere, watchXsInbox,
  processXsMessage, releaseXsMessage, dismissXsMessage,
  xsCardFromText, xsCardReasonText, xsCardHopText,
} from '../utils/xsession.js';

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

const XsCard = React.memo(function XsCard({ message, onProcess, onRelease, onDismiss }) {
  const busy = useXsBusy(message.id);
  // 会话正忙时点过【处理】:"处理这条消息"已排在前端队列里(消息在服务端仍是 pending),轮到它时才认领
  const queuedHere = useXsQueuedHere(message.id);
  const body = typeof message.body === 'string' ? message.body : '';
  const status = message.status;
  const canProcess = !busy && !queuedHere && (status === 'pending' || status === 'queued');
  const canDismiss = !busy && (status === 'pending' || status === 'queued' || status === 'claimed');
  const arrival = formatArrival(message.createdAt);
  const hopText = xsCardHopText(message); // r151c:hop 大于 1 时"连锁第 N 次"
  // r152d:来源与原因单行省略,同一个值既渲染又当 title(悬停看全文)
  const fromText = xsCardFromText(message);
  const reasonText = xsCardReasonText(message, queuedHere);
  const title = (
    <>
      <span data-testid="xs-card-from" title={fromText} className="truncate min-w-0">{fromText}</span>
      {hopText && <span data-testid="xs-card-hop" className="shrink-0 px-1.5 py-0.5 rounded bg-accent/12 text-accent text-[10px]">{hopText}</span>}
      {arrival && <span className="shrink-0 text-ink-faint font-mono" title={new Date(Date.parse(message.createdAt)).toLocaleString()}>{arrival}</span>}
    </>
  );
  // 原因 + 动作:独立一行(不在标题行按钮里 —— 不嵌套交互元素),收起态照样渲染、照样可点
  const actions = (
    <>
      <span data-testid="xs-card-reason" title={reasonText} className="flex-1 min-w-0 truncate text-[11px] text-ink-faint font-body">{reasonText}</span>
      <button data-testid="xs-card-process" disabled={!canProcess} onClick={() => onProcess(message.id)} className={BTN_PRIMARY}
        title="把这条消息交给本会话的模型处理(用本会话当前的模型与权限档)">处理</button>
      {status === 'claimed' && (
        <button data-testid="xs-card-release" disabled={busy} onClick={() => onRelease(message.id)} className={BTN_PLAIN}
          title="撤回这次处理,卡片回到待处理">撤回</button>
      )}
      <button data-testid="xs-card-dismiss" disabled={!canDismiss} onClick={() => onDismiss(message.id)} className={BTN_PLAIN}
        title="不处理这条消息,卡片消失,正文随即删除">忽略</button>
    </>
  );
  return (
    <XsNoticeRow
      testId="xs-card"
      rootProps={{ 'data-message-id': message.id, 'data-status': status }}
      direction="in"
      idSeed={message.id}
      toggleTestId="xs-card-toggle"
      bodyTestId="xs-card-body"
      expandTestId="xs-card-expand"
      icon={<CornerLeftUp size={12} className="shrink-0 text-accent" />}
      title={title}
      body={body}
      bodyPlaceholder="（正文不可用）"
      actions={actions}
      animate
      compact
    />
  );
});

/** sessionId = 本窗格当前会话;onSend = 本窗格的既有发送入口(App.jsx handleSend,经 ChatInput 透传)。
 *  卡片折叠行为与权限档无关(r151y):「放任」档同样折叠、有展开。 */
export const XsInbox = React.memo(function XsInbox({ sessionId = null, onSend }) {
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
    <div data-testid="xs-inbox" data-cgui="xs-inbox" className="px-6 pb-2 space-y-1 max-w-[var(--content-max)] mx-auto w-full">
      {error && <div className="text-[11px] text-amber-700 font-body px-1">{error}</div>}
      {/* r152d:上限 20% 视口高(原 42% 实测把消息区挤到 28%),超出内部滚动 */}
      <div className="space-y-1 max-h-[min(20vh,calc(var(--app-h,100dvh)*0.20))] overflow-y-auto">
        {messages.map((m) => (
          <XsCard key={m.id} message={m} onProcess={onProcess} onRelease={onRelease} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
});
