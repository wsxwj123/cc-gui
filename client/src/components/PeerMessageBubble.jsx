// r151b 跨会话消息一期:来源气泡(接口文件 X.3.4「消息气泡」)。历史条目、直播 xs_message(点卡片)、
// 直播 result.origin(CLI 原生通道)三处是同一个元素;字段口径与标签规则在 utils/xsession.js。
// 正文是另一个会话的模型输出(不可信):按纯文本显示,不渲染 markdown。没有回滚 / 分叉入口(它不是用户提问)。
// 不看总开关:它描述已经发生过的事(X.3.7)。
import React from 'react';
import { CornerLeftUp } from './Icon.jsx';
import { peerVia, peerFromLabel, peerFromSession, PEER_BODY_MISSING } from '../utils/xsession.js';

const pad2 = (n) => String(n).padStart(2, '0');
function clockOf(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export const PeerMessageBubble = React.memo(function PeerMessageBubble({ message }) {
  const via = peerVia(message);
  const fromSession = peerFromSession(message);
  const body = typeof message.body === 'string' && message.body ? message.body : null;
  const clock = clockOf(message.timestamp);
  return (
    <div data-testid="peer-message" data-cgui="peer-message" data-via={via} data-from-session={fromSession || undefined}
      className="px-6 py-3 animate-fade-up" style={{ animationDuration: '0.25s' }}>
      <div className="max-w-[var(--content-max)] mx-auto">
        <div className="flex items-center gap-1.5 mb-1.5 min-w-0 text-[11px] font-body">
          <CornerLeftUp size={12} className="shrink-0 text-accent" />
          <span data-testid="peer-message-from" className="truncate min-w-0 text-[12px] font-medium text-ink-soft">{peerFromLabel(message)}</span>
          {via === 'auto' && (
            <span data-testid="peer-message-auto" className="shrink-0 px-1.5 py-0.5 rounded bg-accent/12 text-accent text-[10px]">自动处理</span>
          )}
          <span className="shrink-0 text-ink-faint">跨会话消息</span>
          {clock && <span className="shrink-0 text-ink-faint font-mono">{clock}</span>}
        </div>
        <div className="border border-canvas-deep border-l-2 border-l-accent/50 bg-canvas-warm/60 rounded-lg px-4 py-2.5 text-[13px] leading-relaxed text-ink font-body whitespace-pre-wrap break-words">
          {body ?? PEER_BODY_MISSING}
        </div>
      </div>
    </div>
  );
});
