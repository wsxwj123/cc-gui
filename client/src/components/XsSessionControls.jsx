// r151c 跨会话消息二期:接收设置(会话头"更多"菜单里)、改接收设置失败的提示(会话头下方)、自动处理暂停提示条(界面顶部)。
// 数据与动作全在 utils/xsession.js;这里只渲染。总开关关着时三者都不渲染(接口 X.3.7:除消息气泡外不出现任何新元素)。
// 异步续体只用触发那一刻的会话 id(按钮所在窗格显示的会话),不读"当前选中会话"。
import React, { useEffect, useState } from 'react';
import { X } from './Icon.jsx';
import { confirmDialog } from '../utils/confirmDialog.jsx';
import {
  isXsId, useXsEnabled, useXsInboundMode, useXsInboundError, useXsAutoPaused, useXsAutoLimit,
  watchXsInbound, setXsInbound, clearXsInboundError, resumeXsAuto,
} from '../utils/xsession.js';

export const XS_INBOUND_CONFIRM_TEXT = '开启后，这个会话收到其它会话的消息会自行开始回合并消耗额度。发送方与这个会话的权限类别相同（都是「放任」档，或都不是）时才自动处理，不同时仍显示为卡片。两个会话都处于「放任」档时，对方的消息会在这里直接执行，不经任何确认。';

/** 会话头"更多"菜单里的接收设置。sessionId = 本窗格的会话(只对已落盘会话显示)。选"自动处理"先确认,取消保持原值。 */
export const XsInboundSelect = React.memo(function XsInboundSelect({ sessionId = null }) {
  const enabled = useXsEnabled();
  const on = enabled && isXsId(sessionId);
  const mode = useXsInboundMode(on ? sessionId : null);
  useEffect(() => (on ? watchXsInbound(sessionId) : undefined), [on, sessionId]);
  if (!on) return null;
  const onChange = async (e) => {
    const next = e.target.value;
    if (next === mode || (next !== 'card' && next !== 'auto')) return; // 受控下拉框:没确认前显示仍是原值
    if (next === 'auto') {
      const yes = await confirmDialog(XS_INBOUND_CONFIRM_TEXT, {
        danger: true, confirmText: '开启自动处理', cancelText: '取消', testId: 'xs-inbound-confirm', okTestId: 'xs-inbound-confirm-ok',
      });
      if (!yes) return;
    }
    await setXsInbound(sessionId, next);
  };
  return (
    <label className="inline-flex items-center gap-1 px-1.5 text-[11px] text-ink-muted font-body whitespace-nowrap"
      title="这个会话收到其它会话发来的消息时怎么处理">
      <span>收到跨会话消息时：</span>
      {/* r151k:服务端默认自动处理(未显式设置 → auto)。取到值前下拉是禁用态,这里只是占位。 */}
      <select data-testid="xs-inbound-select" value={mode || 'auto'} disabled={!mode} onChange={onChange}
        className="px-1.5 py-0.5 rounded-md bg-canvas border border-canvas-deep text-[11px] text-ink font-body disabled:opacity-50 disabled:cursor-not-allowed">
        <option value="card">等你确认</option>
        <option value="auto">自动处理</option>
      </select>
    </label>
  );
});

/** 会话头下方:改接收设置失败的提示"接收设置没有保存：<原因>"(没有提示时不渲染)。 */
export const XsInboundNotice = React.memo(function XsInboundNotice({ sessionId = null }) {
  const error = useXsInboundError(isXsId(sessionId) ? sessionId : null);
  if (!error) return null;
  return (
    <div className="shrink-0 px-6 pt-1.5">
      <div className="max-w-[var(--content-max)] mx-auto flex items-center gap-2 text-[11px] text-error font-body">
        <span className="flex-1 min-w-0">{error}</span>
        <button onClick={() => clearXsInboundError(sessionId)} title="关闭这条提示"
          className="shrink-0 p-0.5 rounded text-ink-faint hover:text-ink hover:bg-canvas-warm transition-colors">
          <X size={11} />
        </button>
      </div>
    </div>
  );
});

/** 界面顶部:自动处理已暂停(10 分钟内次数触顶)时的提示条,带【恢复自动处理】;恢复后消失。 */
export function XsPausedBanner() {
  const paused = useXsAutoPaused();
  const limit = useXsAutoLimit();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (!paused) setErr(''); }, [paused]);
  if (!paused) return null;
  const resume = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    const r = await resumeXsAuto();
    if (!r.ok) setErr(r.error);
    setBusy(false);
  };
  // 文字靠左、按钮靠右:触顶暂停时正好有一批自动处理的会话收尾,"会话完成"提示会在顶部正中排成一列(fixed、层级更高),
  // 按钮放正中会被它们盖住点不到;也不能把本条层级抬到它们之上(会盖住顶栏弹出的下拉菜单)。
  return (
    <div data-testid="xs-paused-banner" role="status"
      className="shrink-0 px-4 py-1.5 bg-amber-500/10 border-b border-amber-500/25 text-[12px] text-amber-700 font-body flex items-center gap-3 flex-wrap relative z-30">
      <span className="flex-1 min-w-0">{`跨会话自动处理已暂停（10 分钟内已自动处理 ${limit} 次）。`}</span>
      {err && <span className="text-error">{err}</span>}
      <button onClick={resume} disabled={busy}
        className="shrink-0 px-2 py-0.5 rounded-md bg-accent text-white text-[11px] hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
        恢复自动处理
      </button>
    </div>
  );
}
