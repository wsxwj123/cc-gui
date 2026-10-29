// r151b 跨会话消息一期:来源行(接口文件 X.3.4「消息气泡」)。历史条目、直播 xs_message(点卡片)、
// 直播 result.origin(CLI 原生通道)三处是同一个元素;字段口径与标签规则在 utils/xsession.js。
// 正文是另一个会话的模型输出(不可信):按纯文本显示,不渲染 markdown。没有回滚 / 分叉入口(它不是用户提问)。
// 不看总开关:它描述已经发生过的事(X.3.7)。
// r151w:改成与收件箱 / 发送提示同款的居中折叠行(XsNoticeRow),正文默认两行预览,点标题行展开全文。
import React from 'react';
import { CornerLeftUp } from './Icon.jsx';
import { XsNoticeRow } from './XsNoticeRow.jsx';
import { peerVia, peerFromLabel, peerFromSession, PEER_BODY_MISSING } from '../utils/xsession.js';

const pad2 = (n) => String(n).padStart(2, '0');
function clockOf(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// r151w:点【处理】之后那条直播行 —— 用户刚看过写着「由你从 <标题> 转发」的卡片,这里再叠一层
// 「用户转发自」是同一句话的重复;按「来自 <来源标题>」显示,与 AI 会话发来的同款(r151w C1b 契约)。
// 历史条目仍用 peerFromLabel(x23 的口径:手动转发 = 用户转发自 <标题>)。
function peerRowLabel(m) {
  const label = peerFromLabel(m);
  if (m && m.via === 'card' && m.from === 'gui:user' && typeof m.fromName === 'string') {
    const tail = m.fromName.replace(/^用户转发自\s*/, '');
    if (tail && tail !== m.fromName) return `来自 ${tail}`;
  }
  return label;
}

export const PeerMessageBubble = React.memo(function PeerMessageBubble({ message }) {
  const via = peerVia(message);
  const fromSession = peerFromSession(message);
  const body = typeof message.body === 'string' && message.body ? message.body : null;
  const clock = clockOf(message.timestamp);
  const title = (
    <>
      <span data-testid="peer-message-from" className="truncate min-w-0">{peerRowLabel(message)}</span>
      {via === 'auto' && (
        <span data-testid="peer-message-auto" className="shrink-0 px-1.5 py-0.5 rounded bg-accent/12 text-accent text-[10px]">自动处理</span>
      )}
    </>
  );
  const status = (
    <>
      <span className="shrink-0">跨会话消息</span>
      {clock && <span className="shrink-0 text-ink-faint font-mono">{clock}</span>}
    </>
  );
  return (
    <XsNoticeRow
      testId="peer-message"
      rootProps={{ 'data-via': via, 'data-from-session': fromSession || undefined }}
      direction="in"
      idSeed={message.uuid || message.timestamp || ''}
      toggleTestId="peer-message-toggle"
      bodyTestId="peer-message-body"
      expandTestId="peer-message-expand"
      icon={<CornerLeftUp size={12} className="shrink-0 text-accent" />}
      title={title}
      status={status}
      body={body ?? PEER_BODY_MISSING}
      className="px-6 py-2"
      innerClassName="max-w-[var(--content-max)] mx-auto"
      animate
    />
  );
});
