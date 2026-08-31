/**
 * GenuiBlock: renders a declarative GenUI spec (from a ```dsh-ui fence in an
 * assistant reply) as real interactive components inline in the conversation.
 * The component tree is white-listed and mapped to DOM directly — no raw HTML.
 * The block shell holds the shared interaction state (answers registry,
 * durable localStorage persistence, action debounce); the per-family
 * components live in src/client/blocks/*.
 */
// CGUI-PATCH: 去掉 useRef —— 在飞定时器不再挂在组件里(见 action-debounce.ts)。
import { memo, useCallback, useEffect, useId, useMemo, useState } from 'react'
import { scheduleAction } from './action-debounce.ts'
import { genuiActionId, useGenuiAction } from './action-context.ts'
import { GenuiFeedbackProvider } from './action-feedback.tsx'
import css from './GenuiBlock.module.css'
import { loadBlockState, saveBlockState } from './interaction-store.ts'
import { renderNode } from './blocks/render-node.tsx'
import type { AnswersState, GenuiBlockProps, QuestionMeta } from './blocks/state.ts'
import type { GenuiSpec } from './spec.ts'

export { GENUI_ACTION_DEBOUNCE_MS } from './action-debounce.ts'

/**
 * Wrap the harness action callback with the per-action trailing debounce.
 * Absent provider = v1 behavior (components are display-only, callback
 * stays undefined). 闭包捕获点击那一刻的 `onAction` —— 归属固定在发起时,
 * 之后重挂换上来的新 handler 不参与这一次发送(PLAN §1.2.6 / §1.3.2 B2)。
 */
function useDebouncedAction(
  onAction: GenuiBlockProps['onAction'] | undefined,
  debounceScope: string,
): GenuiBlockProps['onAction'] {
  return useMemo(() => {
    if (onAction === undefined) return undefined
    return (action: string, payload: Record<string, unknown>): void => {
      scheduleAction(`${debounceScope}:${action}`, () => onAction(action, payload))
    }
  }, [onAction, debounceScope])
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
  // CGUI-PATCH:context 值现在是"本窗格的发送能力"(§1.3.2),不是裸回调。null = 只读面
  // (显式 `value={null}`)或窗格外 —— dispatch 保持 undefined,带 action 的控件渲染成禁用态。
  const capability = useGenuiAction()
  // 直发/失败两态是本地瞬态(发出去就是发出去了);「已排队」不在这里 —— 它派生自
  // 消息队列(§1.2.4),存了就有三个生命周期洞。value 是 'sent' | 'failed'。
  const [sendState, setSendState] = useState<Record<string, 'sent' | 'failed'>>({})
  const [truncated, setTruncated] = useState<ReadonlySet<string>>(new Set())
  const dispatch = useMemo(() => {
    if (capability === null) return undefined
    return (action: string, payload: Record<string, unknown>): void => {
      const result = capability.send(genuiActionId(stateKey, action), action, payload)
      setTruncated(prev => {
        if (prev.has(action) === result.truncated) return prev
        const next = new Set(prev)
        if (result.truncated) next.add(action); else next.delete(action)
        return next
      })
      setSendState(prev => {
        // 排队态不写本地:队列是它唯一的真相,写了就会在发出后留下清不掉的旧徽章。
        if (result.state === 'queued') {
          if (!(action in prev)) return prev
          const next = { ...prev }
          delete next[action]
          return next
        }
        return prev[action] === result.state ? prev : { ...prev, [action]: result.state }
      })
    }
  }, [capability, stateKey])
  // 去抖作用域用 **queueKey**,不用 stateKey —— 这是审查军令②的落点。
  // stateKey 含围栏原文指纹,流式期每来一个 chunk 就换一次;键跟着换 = 300ms 内连点
  // 同一个按钮会落进两个不同的 Map 条目,两个定时器都触发 = **双发**(而流式期正是
  // 用户最常点按钮的时候)。两条备选里选"改键分量"而不是"送达层去重":送达层只能
  // 丢掉两次里的一次,而先触发的那个恰是**先排期**的那次 = 旧 payload —— input /
  // select / slider 的后一次带的才是用户最新的值,丢后者就是静默发旧值,与
  // INTERFACE §3.1「只发最后一次」直接矛盾。只有键级取消能保住"后来者居上"。
  // ponytail: 代价 —— 同一会话里两个**不同的块**用了**同名 action**,且两次点击相隔
  // 不到 300ms 时,前一次会被后一次取消。要清掉它得给块一个"内容无关又跨重挂稳定"
  // 的身份,而那正是 §1.2.2 论证过不存在的东西;真撞上再补。
  const onAction = useDebouncedAction(dispatch, capability?.queueKey ?? '')
  const feedback = useMemo(() => ({
    stateOf: (action: string) => (capability?.queuedIds.has(genuiActionId(stateKey, action)) === true
      ? 'queued' as const
      : sendState[action] ?? null),
    truncated: (action: string) => truncated.has(action),
  }), [capability, stateKey, sendState, truncated])
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
  // CGUI-PATCH: 本块在待落盘槽里的身份。流式期每 chunk 换一次 stateKey,按它去重才不会
  // 在页面退出时把同一个块的 200 把旧键全写进 LRU(见 interaction-store 的 pendingSlot)。
  const owner = useId()
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
    // 一次调用两件事:内存同步写 + (定稿后)排进镜像队列。落盘的防抖与
    // "页面要走了立刻落盘"的兜底都在 store 里 —— 定时器**不能**挂在组件上:
    // 回合末组件会在 300ms 内被重挂,清理钩子一 clearTimeout,那次编辑就永远没落过盘
    // (锁定验收 B73 的形态,实测编辑后 50ms 时 localStorage 还是空的)。
    saveBlockState(stateKey, next, settled, owner)
  }, [stateKey, answers, locked, fields, ui, secretFields, settled, owner])
  return (
    <GenuiFeedbackProvider value={feedback}>
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
      {/* CGUI-PATCH(INTERFACE §5.2 / §9.1):被 guard 丢掉的节点不再静默消失。
          N 取 guard 回传的 dropped(未知类型、必填字段非法、非法 action 名、被拒的
          媒体地址、超预算裁剪,同一个口径),零丢弃时**整个元素不存在** —— 契约里
          "必须不存在"那半是靠这里成立的,不能改成渲染一个空的灰字。
          "全部节点都被丢弃"那种情形轮不到这里:围栏在 GenuiFence 就退回代码块了。 */}
      {spec.dropped !== undefined && spec.dropped > 0 && (
        <div className={css.ignored} data-testid="genui-ignored">
          {spec.dropped} 个不支持的组件已忽略
        </div>
      )}
    </div>
    </GenuiFeedbackProvider>
  )
// CGUI-PATCH: `settled` 进比较器 —— 定稿是"该镜像落盘了"的信号,漏比就永远不落盘。
}, (prev, next) => prev.stateKey === next.stateKey && prev.settled === next.settled
  && specEquivalent(prev.spec, next.spec))
