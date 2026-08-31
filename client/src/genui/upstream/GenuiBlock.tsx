/**
 * GenuiBlock: renders a declarative GenUI spec (from a ```dsh-ui fence in an
 * assistant reply) as real interactive components inline in the conversation.
 * The component tree is white-listed and mapped to DOM directly — no raw HTML.
 * The block shell holds the shared interaction state (answers registry,
 * durable localStorage persistence, action debounce); the per-family
 * components live in src/client/blocks/*.
 */
// CGUI-PATCH: 去掉 useRef —— 在飞定时器不再挂在组件里(见 pendingActions)。
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useGenuiAction } from './action-context.ts'
import css from './GenuiBlock.module.css'
import { loadBlockState, saveBlockState } from './interaction-store.ts'
import { renderNode } from './blocks/render-node.tsx'
import type { AnswersState, GenuiBlockProps, QuestionMeta } from './blocks/state.ts'
import type { GenuiSpec } from './spec.ts'

export const GENUI_ACTION_DEBOUNCE_MS = 300

/**
 * CGUI-PATCH(PLAN §1.2.6):在飞的去抖定时器移出组件,放模块级 Map,**卸载不清理**。
 *
 * 上游把定时器挂在组件里、unmount 时 `clearTimeout` 全部在飞定时器(是 clear 不是
 * flush)。而回合末围栏子树连挂两次,正撞 300ms 去抖窗口:用户在回合结束前 300ms 内
 * 点的按钮 —— 消息既没发也没入队,且完全静默。这恰是最常触发的时间窗(用户看模型
 * 快写完了才去点)。定时器留在模块级则天然只有一份,重挂不吞;比"unmount 时 flush"
 * 更简单 —— flush 要处理"两次重挂 = 两次 flush"的重复发送。
 *
 * 键是 `${stateKey}:${action}`(不是裸 action):Map 现在是全局的,两个块用同一个
 * 动作名会互相取消。ponytail: 条目触发后自删,峰值 = 同时在飞的点击数(个位数),不淘汰。
 */
const pendingActions = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Wrap the harness action callback with the per-action trailing debounce.
 * Absent provider = v1 behavior (components are display-only, callback
 * stays undefined). 闭包捕获点击那一刻的 `onAction` —— 归属固定在发起时,
 * 之后重挂换上来的新 handler 不参与这一次发送(PLAN §1.2.6 / §1.3.2 B2)。
 */
function useDebouncedAction(
  onAction: GenuiBlockProps['onAction'] | undefined,
  stateKey: string | undefined,
): GenuiBlockProps['onAction'] {
  return useMemo(() => {
    if (onAction === undefined) return undefined
    return (action: string, payload: Record<string, unknown>): void => {
      const key = `${stateKey ?? ''}:${action}`
      const existing = pendingActions.get(key)
      if (existing !== undefined) clearTimeout(existing)
      pendingActions.set(key, setTimeout(() => {
        pendingActions.delete(key)
        onAction(action, payload)
      }, GENUI_ACTION_DEBOUNCE_MS))
    }
  }, [onAction, stateKey])
}

/**
 * Structural spec equality for the memo comparator: the fence path re-parses
 * the body on every streaming chunk and produces a FRESH object even when the
 * repaired content is unchanged (a chunk that closed no new component). The
 * default shallow memo would then re-render the whole tree per chunk — up to
 * ~200 full-tree renders for a max-size fence. Stringify equality makes the
 * memo skip renders whose content did not actually change; the cost is one
 * JSON.stringify per chunk (≤200 nodes, negligible next to a React tree
 * reconciliation). `stateKey` already embeds the content fingerprint, so when
 * both keys are equal and non-undefined the specs necessarily stringify
 * equal — the stringify branch matters for the streaming path (stateKey
 * undefined).
 */
function specEquivalent(a: GenuiSpec, b: GenuiSpec): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Render a GenUI spec as an inline block. Falls back to nothing when the spec
 * carries no items (the fence renderer already refused non-specs before us).
 */
export const GenuiBlock = memo(function GenuiBlock({ spec, stateKey, settled = false }: GenuiBlockProps) {
  const gap = spec.gap ?? 16
  const onAction = useDebouncedAction(useGenuiAction(), stateKey)
  // v2.5/v2.6 answers registry: grouped radios record selections + question
  // metadata here; `submit` nodes grade locally (locked until 重新作答) or
  // collect into one action. Block-local state survives re-renders (streaming
  // settle, panel updates) — selections persist while the block is mounted.
  // v2.7 durability: with a stateKey the state ALSO survives refresh/reopen —
  // loaded once at mount (seed for re-renders of the same content) and saved
  // on every change.
  const [persisted] = useState(() => (stateKey === undefined ? null : loadBlockState(stateKey)))
  const [answers, setAnswers] = useState<Record<string, string>>(persisted?.answers ?? {})
  const [fields, setFields] = useState<Record<string, string>>(persisted?.fields ?? {})
  // CGUI-PATCH: 无天然键的界面态,按节点路径存。与 fields 同一条写透路径,
  // 所以回合末重挂后照样从内存层读回来(INTERFACE §3.6「全部保留」)。
  const [ui, setUiState] = useState<Record<string, string>>(persisted?.ui ?? {})
  const [meta, setMeta] = useState<Record<string, QuestionMeta>>({})
  const [locked, setLocked] = useState(persisted?.locked === true)
  const [round, setRound] = useState(0)
  // Secret (password) field ids: their values never persist and never join
  // submit collection — the input itself stays masked and its own action
  // still delivers the value on explicit user submit.
  const [secretFields, setSecretFields] = useState<ReadonlySet<string>>(new Set())
  const setAnswer = useCallback((group: string, choice: string) => {
    setAnswers(prev => (prev[group] === choice ? prev : { ...prev, [group]: choice }))
  }, [])
  const setField = useCallback((id: string, value: string) => {
    // Field invariant: a blank (trim-empty) value leaves the shared registry.
    setFields(prev => {
      if (value.trim() === '') {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      }
      return prev[id] === value ? prev : { ...prev, [id]: value }
    })
  }, [])
  // CGUI-PATCH: 空串按"回到默认"处理并删除条目,与 setField 的空值不变量一致。
  const setUi = useCallback((uiKey: string, value: string) => {
    setUiState(prev => {
      if (value === '') {
        if (!(uiKey in prev)) return prev
        const next = { ...prev }
        delete next[uiKey]
        return next
      }
      return prev[uiKey] === value ? prev : { ...prev, [uiKey]: value }
    })
  }, [])
  const registerSecretField = useCallback((id: string) => {
    setSecretFields(prev => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [])
  const registerMeta = useCallback((group: string, m: QuestionMeta) => {
    setMeta(prev => {
      const existing = prev[group]
      if (existing !== undefined && existing.label === m.label && existing.answer === m.answer
        && existing.explanation === m.explanation) return prev
      return { ...prev, [group]: m }
    })
  }, [])
  const clear = useCallback(() => {
    setAnswers({})
    setLocked(false)
    setRound(r => r + 1) // radios remount (key carries the round) with clean selections
  }, [])
  const answersState = useMemo<AnswersState>(
    () => ({
      answers, fields, ui, secretFields, meta, locked, round,
      setAnswer, setField, setUi, registerSecretField, registerMeta, clear, setLocked,
    }),
    [answers, fields, ui, secretFields, meta, locked, round, setAnswer, setField, setUi, registerSecretField, registerMeta, clear],
  )
  // Durable save. Secret field values are stripped before writing: passwords never persist.
  //
  // CGUI-PATCH(PLAN §1.2.2 A2/A3):写透两句,顺序即语义。
  //   ① 内存层**同步**写(上游是 300ms 防抖写 localStorage):回合末围栏子树连挂两次,
  //      用户点完 1ms 后就被重挂时防抖还没落盘 —— 内存里必须已经有了。
  //   ② deps 含 stateKey ⟹ 键一变就把**当前**状态写到新键上(A2-②)。流式期每 chunk
  //      换一次键,用户在第 50 个 chunk 点的选择、第 100 个 chunk 才定稿,中间再无
  //      状态变更;没有这条,定稿按最后那个键去读就是空 = 静默清零。这条**不能**放进
  //      防抖里:定时器会被下一个 chunk 的清理钩子清掉,永远轮不到落。
  //   ③ localStorage 只在定稿后镜像(A3),流式期一个字节都不写。
  useEffect(() => {
    if (stateKey === undefined) return
    const safeFields = Object.fromEntries(
      Object.entries(fields).filter(([id]) => !secretFields.has(id)),
    )
    const next = {
      answers,
      locked,
      ...(Object.keys(safeFields).length > 0 ? { fields: safeFields } : {}),
      // CGUI-PATCH: ui 走同一条写透路径。密码框永远不写这里(无 id 的密码框在
      // InputNode 里就不调 setUi),所以不需要第二道 secret 过滤。
      ...(Object.keys(ui).length > 0 ? { ui } : {}),
    }
    saveBlockState(stateKey, next)
    if (!settled) return
    // 落盘仍防抖:输入框逐字符触发,不该逐字符 JSON.stringify 整张表。
    const timer = setTimeout(() => saveBlockState(stateKey, next, true), 300)
    return () => clearTimeout(timer)
  }, [stateKey, answers, locked, fields, ui, secretFields, settled])
  return (
    <div className={css.block} data-genui>
      {spec.title !== undefined && <div className={css.banner}>{spec.title}</div>}
      <div className={css.col} style={{ gap: `${gap}px` }}>
        {spec.items.map((c, i) => (
          // Staggered reveal: each root item fades/slides in after its
          // predecessors, so the block assembles piece by piece instead of
          // popping in as one slab. Delay capped so long specs still settle
          // quickly; prefers-reduced-motion disables it (see CSS).
          <div
            key={i}
            className={css.reveal}
            style={{ animationDelay: `${Math.min(i * 90, 720)}ms` }}
          >
            {renderNode(c, i, onAction, 0, answersState)}
          </div>
        ))}
      </div>
    </div>
  )
// CGUI-PATCH: `settled` 进比较器 —— 定稿是"该镜像落盘了"的信号,漏比就永远不落盘。
}, (prev, next) => prev.stateKey === next.stateKey && prev.settled === next.settled
  && specEquivalent(prev.spec, next.spec))
