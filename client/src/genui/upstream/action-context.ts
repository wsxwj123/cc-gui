/**
 * GenUI action context, plugin-owned.
 *
 * Absent provider = display-only: interactive components ignore their
 * `action`. The hook never throws.
 *
 * CGUI-PATCH: 删掉上游的宿主 primitives 探测(`@deepseek-ai/dsh-client-ui-primitives`
 * 里可能另有一份 GenuiActionContext,上游要认那一份)。CC-GUI 没有那层,本地
 * context 就是唯一一份;Provider 由 `genui/host/action-context.jsx` 挂在窗格根上
 * (PLAN §1.3.2),按 §2.0.1-2 的规矩 upstream/ 不反向 import 宿主件。
 * @module @changfenhuang/dsh-genui/client/action-context
 */
import { createContext, useContext } from 'react'
import type { Context } from 'react'

/** v2 action handler: component action + its collected data. */
export type GenuiActionHandler = (action: string, payload: Record<string, unknown>) => void

/** 一次外发的三态结果(PLAN §1.2.4:让发送方回报,不让组件靠 isStreaming 猜)。 */
export type GenuiSendState = 'sent' | 'queued' | 'failed'

/**
 * CGUI-PATCH:context 值从"一个回调"扩成"本窗格的发送能力"。三件套缺一不可:
 * - `queueKey`:本窗格的会话身份。**渲染时固定**(B2),点击时闭包捕获它,不现读;
 *   同时也是交互态键的会话分量(§1.2.2 A1),让分屏两个窗格里逐字节相同的围栏分家。
 * - `send`:同步回报三态。忙则由宿主既有的门自动入队,组件不判断忙不忙。
 * - `queuedIds`:当前**还在队列里**的 action id 集合。「已排队」是派生态不是存储态
 *   (§1.2.4):发出即消失、用户删掉即消失、刷新后队列还在则它也还在,没有生命周期可写错。
 */
export interface GenuiActionCapability {
  queueKey: string
  send: (action: string, payload: Record<string, unknown>) => { state: GenuiSendState, truncated: boolean }
  queuedIds: ReadonlySet<string>
}

/** The one action context; a tree without a Provider (value === null) renders read-only. */
export const GenuiActionContext: Context<GenuiActionCapability | null> =
  createContext<GenuiActionCapability | null>(null)

/** Read the installed action capability, if any. */
export function useGenuiAction(): GenuiActionCapability | null {
  return useContext(GenuiActionContext)
}

/**
 * 一次外发的身份。既是「已排队」徽章的判据(入队时写进 `opts.meta.genuiActionId`,
 * 徽章看队列里有没有这个 id),也天然跨重挂与刷新 —— `stateKey` 含会话与内容指纹,
 * 同一条围栏重开会话后算出来还是它。
 */
export function genuiActionId(stateKey: string | undefined, action: string): string {
  return `${stateKey ?? ''}:${action}`
}
