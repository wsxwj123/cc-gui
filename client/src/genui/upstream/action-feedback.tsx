/**
 * CGUI-PATCH(PLAN §1.2.4,INTERFACE §3.5 / §9.2):交互组件上的发送态反馈。
 *
 * 三态由**发送方回报**,组件不靠 `isStreaming` 猜忙不忙 —— `isStreaming` 说的是
 * "本条 turn 还在产出",而入队判据是"会话忙不忙"。反例很常见:用户翻回上一条已定稿
 * 的消息点按钮,而此刻新回合正在流式 → 该围栏 isStreaming=false 但实际会入队。
 *
 * 「已排队」是**派生态、不存**:判据是该 action id 还在不在消息队列里。存了就有
 * "发出去之后徽章不清""用户从队列删掉后徽章还在""刷新后显示已排队但队列早空"
 * 三个生命周期洞;派生态一个都没有,而且天然跨重挂(队列在 store + localStorage)。
 * @module genui/action-feedback
 */
import { createContext, useContext } from 'react'
import type { Context, ReactNode } from 'react'
import type { GenuiSendState } from './action-context.ts'
import css from './GenuiBlock.module.css'

/** 一个块内所有 action 的当前反馈态。null = 该 action 还没被触发过。 */
export interface GenuiFeedback {
  stateOf: (action: string) => GenuiSendState | null
  /** 该 action 的外发数据是否被 8KB 上限截断(INTERFACE §3.2 末行)。 */
  truncated: (action: string) => boolean
}

const FeedbackContext: Context<GenuiFeedback | null> = createContext<GenuiFeedback | null>(null)
export const GenuiFeedbackProvider = FeedbackContext.Provider

const LABEL: Record<GenuiSendState, string> = {
  sent: '已发送',
  queued: '已排队',
  failed: '发送失败',
}

/**
 * 挂在每个带 `action` 的组件旁。没有反馈态就**不进 DOM** —— §9.2 的"必须不存在"
 * 那一半靠这条兑现(只读面从来触发不了,所以那里恒无徽章)。
 */
export function ActionFeedback({ action }: { action: string | undefined }): ReactNode {
  const fb = useContext(FeedbackContext)
  const state = action === undefined ? null : (fb?.stateOf(action) ?? null)
  if (state === null || action === undefined) return null
  return (
    <span data-testid="genui-action-feedback" role="status" className={css.actionFeedback}>
      {LABEL[state]}
      {fb?.truncated(action) === true && <span className={css.actionTruncated}>数据已截断</span>}
    </span>
  )
}
