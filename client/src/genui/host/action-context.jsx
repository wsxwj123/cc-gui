// genui action 回路的宿主胶水(PLAN §1.3.2)。上游 `action-context.ts` 只定义 context,
// "本窗格的发送能力"由这里造出来并挂到**窗格根**上。
//
// 挂载点为什么必须是窗格根,不是 MessageList:MessageList 只渲染已定稿消息,流式气泡是
// 它的兄弟节点 —— 挂在 MessageList 上,流式期的围栏就拿不到 Provider,按钮全成只读,
// 而且失败形态是"点了没反应、无报错"(§1.3.2 已在源码逐行核实,两份审查判断一致)。
import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../stores/sessionStore.js';
import { GenuiActionContext } from '../upstream/action-context.ts';
import { buildActionMessage, flushSend } from './action-send.js';

/**
 * Provider 本身。可交互面传能力对象,**只读面显式传 `value={null}`**。
 * B4 不变量:可交互面是显式白名单,不靠 DOM 嵌套推断 —— 只读退出必须能 grep 到。
 */
export const GenuiActionProvider = GenuiActionContext.Provider;

/**
 * 造本窗格的发送能力。
 *
 * @param queueKey       本窗格当前会话的队列键(`sessionQueueKey`)
 * @param handleSendRef  本窗格最新 handleSend 的 ref
 * @param messageQueue   本窗格当前会话的队列(派生「已排队」徽章用)
 */
export function useGenuiActionCapability({ queueKey, handleSendRef, messageQueue }) {
  // 送达这一刻本窗格的会话键。用 ref 而不是现读 store —— B1 禁止 action 链路上出现
  // 任何"当前选中会话/当前聚焦窗格"的读取,那正是上游 dom-fence 那个串扰 bug 的形态。
  const paneKeyRef = useRef(queueKey);
  useEffect(() => { paneKeyRef.current = queueKey; }, [queueKey]);

  const queuedIds = useMemo(() => {
    const ids = new Set();
    for (const item of messageQueue || []) {
      const id = item?.opts?.meta?.genuiActionId;
      if (typeof id === 'string') ids.add(id);
    }
    return ids;
  }, [messageQueue]);

  return useMemo(() => ({
    // B2:身份在**渲染时**固定。下面 send 闭包里的 `queueKey` 就是点击那一刻的会话 ——
    // 300ms 去抖窗口内用户切窗格/切会话都影响不到它。
    queueKey,
    queuedIds,
    send: (actionId, action, payload) => {
      const { text, truncated } = buildActionMessage(action, payload);
      const opts = { meta: { genuiActionId: actionId } };
      const state = flushSend({
        capturedKey: queueKey,
        paneKey: paneKeyRef.current,
        text,
        opts,
        send: handleSendRef.current,
        // 归属不符时的入队编排入口(照 `enqueueHomeDraft` 的先例:App.jsx 内的直接入队点
        // 保持唯一,新通道自带编排层)。这条既不经回滚/重发通道,也不碰 forceSend,
        // 目标恒是**捕获到的那个**会话键 —— 与"回滚重发不双入队"那条不变量不相交。
        enqueue: (key, t, o) => !!useStore.getState()
          .enqueueMessage(key, { text: t, queuedAt: Date.now(), opts: o }),
      });
      return { state, truncated };
    },
  }), [queueKey, queuedIds, handleSendRef]);
}
