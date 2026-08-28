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

/** The one action context; a tree without a Provider renders read-only. */
export const GenuiActionContext: Context<GenuiActionHandler | undefined> =
  createContext<GenuiActionHandler | undefined>(undefined)

/** Read the installed action handler, if any. */
export function useGenuiAction(): GenuiActionHandler | undefined {
  return useContext(GenuiActionContext)
}
