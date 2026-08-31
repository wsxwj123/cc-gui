/**
 * Form family: radio aggregation + submit grading, switch, slider, IME-safe
 * input/select/textarea. All state flows through the shared AnswersState.
 * @module @changfenhuang/dsh-genui/client/blocks/forms
 */
import { useEffect, useId, useRef, useState } from 'react'
import css from '../GenuiBlock.module.css'
import { GENUI_LIMITS } from '../guard.ts'
import type { AnswersState, GenuiBlockProps, QuestionMeta } from './state.ts'
// CGUI-PATCH: 无 id 输入值也要活过重挂(§3.6),存取统一走这两个
import { keepValue, keptValue } from './state.ts'
import type { GenuiInput, GenuiRadio, GenuiSelect, GenuiSlider, GenuiSubmit, GenuiSwitch, GenuiTextarea } from '../spec.ts'

export function RadioNode({ node, onAction, answers }: {
  node: GenuiRadio
  onAction?: GenuiBlockProps['onAction']
  answers?: AnswersState | undefined
}) {
  const action = node.action
  const group = node.group
  const grouped = group !== undefined
  const options = node.options.slice(0, GENUI_LIMITS.maxOptions)
  // No default selection unless the model explicitly sets `selected` — a
  // pre-checked first option silently swallows the user's "keep the default"
  // answer (the registry only records real change events). A DURABLE answer
  // (restored from localStorage) wins over both. The parent key includes the
  // reset round, so 重新作答 remounts this radio with a clean selection —
  // no sync effect needed.
  const restoredIndex = group !== undefined && answers?.answers[group] !== undefined
    ? options.indexOf(answers!.answers[group]!)
    : -1
  const [selected, setSelected] = useState<number | null>(restoredIndex >= 0 ? restoredIndex : (node.selected ?? null))
  const uid = useId()
  const locked = grouped && answers?.locked === true
  // Register question metadata for local grading (mount + when the question
  // changes). `answers` is deliberately NOT a dep: the callback identity is
  // stable and re-registering on every answers update is needless churn.
  useEffect(() => {
    if (group === undefined) return
    answers?.registerMeta(group, {
      label: node.label ?? group,
      options,
      answer: node.answer,
      explanation: node.explanation,
    })
    // A model-provided default selection IS the answer — but only when the
    // group has no durable answer yet (a restored user choice must win).
    if (node.selected !== undefined && options[node.selected] !== undefined && answers?.answers[group] === undefined) {
      answers?.setAnswer(group, options[node.selected]!)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, node.label, node.answer, node.explanation, node.options, node.selected])
  return (
    <div className={css.fieldGroup} role="radiogroup" aria-label={node.label}>
      {node.label !== undefined && <span className={css.fieldLabel}>{node.label}</span>}
      {options.map((opt, i) => (
        <label key={i} className={css.radio}>
          <input
            type="radio"
            name={`genui-radio-${uid}`}
            checked={selected === i}
            disabled={locked}
            onChange={() => {
              setSelected(i)
              if (grouped) {
                // Aggregation mode: record, do NOT round-trip per click.
                answers?.setAnswer(group, opt)
              } else if (action !== undefined && onAction !== undefined) {
                onAction(action, { type: 'radio', value: opt })
              }
            }}
          />
          <span>{opt}</span>
        </label>
      ))}
    </div>
  )
}

/** Resolve a question's correct label from its metadata. */
export function correctLabelOf(m: QuestionMeta): string | undefined {
  if (m.answer === undefined) return undefined
  if (typeof m.answer === 'number') return m.options[m.answer]
  return m.answer
}

/** Submit: the "交卷" control of a grouped-radio block. LOCAL-FIRST (v2.6):
 * when at least one question carries `answer` data the click grades IN PLACE
 * — score, per-question right/wrong, explanations — with zero model round
 * trip, and locks the questions until 重新作答 resets them. Only when NO
 * question has answers does it fall back to firing ONE action
 * (`{type:'submit', answers, total, answered}`). Disabled until the
 * selection criteria are met (all listed groups answered, or ≥1 answer
 * without a group list); the hint shows the progress. */
export function SubmitNode({ node, onAction, answers }: {
  node: GenuiSubmit
  onAction?: GenuiBlockProps['onAction']
  answers?: AnswersState | undefined
}) {
  const recorded = answers?.answers ?? {}
  const fields = answers?.fields ?? {}
  const meta = answers?.meta ?? {}
  const expected = node.groups
  // One shared notion of "filled fields" for answered/ready/payload: non-blank
  // values only, secrets (password inputs) never collected into submit.
  const filledFields = Object.fromEntries(
    Object.entries(fields).filter(([id, v]) => v.trim() !== '' && !answers?.secretFields.has(id)),
  )
  // Without an explicit group list, the submit counts radio answers AND
  // filled fields — a fields-only form (inputs with id + submit) enables
  // once any field has a value.
  const answered = expected === undefined
    ? Math.max(Object.keys(recorded).length, Object.keys(filledFields).length)
    : expected.filter(g => recorded[g] !== undefined).length
  const total = expected?.length ?? answered
  const scope = expected ?? Object.keys(recorded)
  // Local grading is possible when ANY in-scope question carries answers.
  const canGradeLocally = scope.some(g => meta[g]?.answer !== undefined)
  const submitted = answers?.locked === true
  // Ready = enough answers AND the click can do something: either local
  // grading, or a real action name + provider. A submit with neither is a
  // display-only control — honest disabled affordance (action is optional:
  // local grading needs no round trip).
  const ready = answered > 0 && answered >= total
    && (canGradeLocally || (node.action !== undefined && onAction !== undefined))

  if (submitted) {
    // ── local grading result ──
    const graded = scope.filter(g => recorded[g] !== undefined && meta[g]?.answer !== undefined)
    const score = graded.filter(g => recorded[g] === correctLabelOf(meta[g]!)).length
    return (
      <div className={css.gradeWrap} data-genui-grade>
        <div className={css.gradeScore}>
          <span className={css.gradeScoreValue}>{score} / {graded.length}</span>
          <span className={css.gradeScoreLabel}>得分{graded.length < scope.length ? `（${scope.length - graded.length} 题无答案未计分）` : ''}</span>
        </div>
        <div className={css.gradeList}>
          {scope.map(g => {
            const entry = recorded[g]
            const m = meta[g]
            if (entry === undefined || m === undefined) return null
            const correct = correctLabelOf(m)
            if (correct === undefined) {
              return (
                <div key={g} className={css.gradeItem}>
                  <span className={css.gradeQ}>{m.label}</span>
                  <span className={css.gradeAns}>你的答案：{entry}</span>
                </div>
              )
            }
            const isCorrect = entry === correct
            return (
              <div key={g} className={`${css.gradeItem} ${isCorrect ? css.gradeItemOk : css.gradeItemNo}`}>
                <span className={css.gradeQ}>{m.label}</span>
                <span className={css.gradeTag}>{isCorrect ? '✓' : '✗'}</span>
                <span className={css.gradeAns}>
                  你的答案：{entry}
                  {!isCorrect && <span className={css.gradeRight}> 正确答案：{correct}</span>}
                </span>
                {m.explanation !== undefined && <span className={css.gradeExp}>{m.explanation}</span>}
              </div>
            )
          })}
        </div>
        <button
          type="button"
          className={`${css.button} ${css.ghost} ${css.submit}`}
          onClick={() => {
            answers?.clear()
            if (node.resetAction !== undefined && onAction !== undefined) {
              onAction(node.resetAction, { type: 'submit-reset', groups: expected ?? Object.keys(recorded) })
            }
          }}
        >
          重新作答
        </button>
      </div>
    )
  }

  return (
    <div className={css.submitRow}>
      <button
        type="button"
        className={`${css.button} ${css.primary} ${css.submit}`}
        disabled={!ready}
        onClick={ready ? () => {
          if (canGradeLocally) {
            // Local grading: immediate in-place result, no model round trip.
            answers?.setLocked(true)
          } else if (node.action !== undefined && onAction !== undefined) {
            // `ready` already guarantees this branch, but the narrow keeps
            // the optional-action type honest.
            onAction(node.action, {
              type: 'submit',
              answers: recorded,
              ...(Object.keys(filledFields).length > 0 ? { fields: filledFields } : {}),
              total,
              answered,
            })
          }
        } : undefined}
      >
        {node.label}
      </button>
      {total > 0 && <span className={css.submitHint} aria-live="polite">已选 {answered}/{total}</span>}
    </div>
  )
}

/** Switch: toggle with local state. */
export function SwitchNode({ node, onAction, answers, uiKey }: {
  node: GenuiSwitch
  onAction?: GenuiBlockProps['onAction']
  answers?: AnswersState | undefined
  uiKey?: string | undefined
}) {
  // CGUI-PATCH: 开关没有 id 这一说,状态一律按节点路径存(§3.6「选择」)。
  // '1'/'0' 而不是 true/'' —— setUi 把空串当"回到默认"删条目,关掉的开关会存不住。
  const kept = uiKey !== undefined ? answers?.ui[uiKey] : undefined
  const [on, setOn] = useState(kept !== undefined ? kept === '1' : node.checked === true)
  const action = node.action
  return (
    <label className={css.switchRow}>
      <span className={css.switchLabel}>{node.label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`${css.switch} ${on ? css.switchOn : ''}`}
        onClick={() => {
          const next = !on
          setOn(next)
          if (uiKey !== undefined) answers?.setUi(uiKey, next ? '1' : '0')
          if (action !== undefined && onAction !== undefined) onAction(action, { type: 'switch', checked: next })
        }}
      >
        <span className={css.switchKnob} />
      </button>
    </label>
  )
}

/** Slider: range input for numeric form values (v2.9). Field-aligned: with an
 * `id` the value persists across refresh and joins the sibling submit's
 * `fields` collection (stored as the numeric string); a model-provided
 * default registers at mount; a restored durable value wins. Dragging fires
 * the action (block-level debounce collapses the drag into one delivery). */
export function SliderNode({ node, onAction, answers, uiKey }: {
  node: GenuiSlider
  onAction?: GenuiBlockProps['onAction']
  answers?: AnswersState | undefined
  uiKey?: string | undefined
}) {
  const action = node.action
  const id = node.id
  // CGUI-PATCH: 无 id 的滑杆也要活过重挂(§3.6「输入」)。
  const restored = Number(keptValue(answers, id, uiKey) ?? NaN)
  const initial = Number.isFinite(restored) ? restored : node.value ?? node.min ?? 0
  const [value, setValue] = useState<number>(initial)
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    // CGUI-PATCH: 同上。initial 在有存值时本就等于存值,加这道门只是把口径统一,
    // 免得日后有人改了 initial 的推导又把存值冲掉。
    if (keptValue(answers, id, uiKey) === undefined) keepValue(answers, id, uiKey, String(initial))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const send = (v: number): void => {
    if (action !== undefined && onAction !== undefined) {
      onAction(action, { type: 'slider', value: v, ...(id !== undefined ? { id } : {}) })
    }
  }
  return (
    <label className={css.sliderRow}>
      {node.label !== undefined && <span className={css.fieldLabel}>{node.label}</span>}
      <input
        type="range"
        className={css.sliderInput}
        min={node.min}
        max={node.max}
        step={node.step ?? 1}
        value={value}
        aria-label={node.label}
        onChange={e => {
          const v = Number(e.currentTarget.value)
          setValue(v)
          keepValue(answers, id, uiKey, String(v))
          send(v)
        }}
      />
      <span className={css.sliderValue}>{Math.round(value * 100) / 100}</span>
    </label>
  )
}

/** Reuse the DSH main input's three-layer IME protection (verified in the
 *  host InputBar): composition start arms a ref, composition end clears it
 *  10ms later (Safari sends the closing keydown BEFORE compositionend), and
 *  every submit keydown re-checks the ref, the native `isComposing` flag,
 *  and `keyCode === 229`. A Chinese selection Enter must never submit. */
export function useImeComposing(): {
  isComposing: () => boolean
  onCompositionStart: () => void
  onCompositionEnd: () => void
} {
  const composing = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])
  return {
    isComposing: () => composing.current,
    onCompositionStart: () => {
      composing.current = true
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    },
    onCompositionEnd: () => {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        composing.current = false
      }, 10)
    },
  }
}

export function isImeSubmitKeydown(e: React.KeyboardEvent): boolean {
  const native = e.nativeEvent
  return native.isComposing === true || native.keyCode === 229
}

/** Select: single choice from a dropdown, field-aligned (v2.8). With an `id`
 * the chosen option persists across refresh and joins the sibling submit's
 * `fields` collection; a model-provided `selected` default registers at
 * mount; a restored durable value wins over both. Without any default a
 * placeholder option shows — nothing is silently pre-registered (same
 * philosophy as radio). */
export function SelectNode({ node, onAction, answers, uiKey }: {
  node: GenuiSelect
  onAction?: GenuiBlockProps['onAction']
  answers?: AnswersState | undefined
  uiKey?: string | undefined
}) {
  const action = node.action
  const id = node.id
  const options = node.options.slice(0, GENUI_LIMITS.maxOptions)
  // CGUI-PATCH: 无 id 的下拉也要活过重挂(§3.6「选择」)。
  const kept = keptValue(answers, id, uiKey)
  const restored = kept !== undefined ? options.indexOf(kept) : -1
  const defaultValue = restored >= 0
    ? options[restored]!
    : node.selected !== undefined && options[node.selected] !== undefined
      ? options[node.selected]!
      : null
  const [value, setValue] = useState<string | null>(defaultValue)
  // Field invariant: a spec-provided default registers at mount.
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    // CGUI-PATCH: 同上;顺带把无 id 的下拉也纳入(原来只 setField 带 id 的那一半)。
    if (defaultValue !== null && keptValue(answers, id, uiKey) === undefined) {
      keepValue(answers, id, uiKey, defaultValue)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const send = (v: string): void => {
    if (action !== undefined && onAction !== undefined) {
      onAction(action, { type: 'select', value: v, ...(id !== undefined ? { id } : {}) })
    }
  }
  return (
    <label className={css.field}>
      {node.label !== undefined && <span>{node.label}</span>}
      <select
        className={css.select}
        value={value ?? ''}
        onChange={e => {
          const v = e.currentTarget.value
          setValue(v)
          keepValue(answers, id, uiKey, v)
          send(v)
        }}
      >
        {value === null && <option value="" hidden disabled>请选择…</option>}
        {options.map((o, i) => <option key={i} value={o}>{o}</option>)}
      </select>
    </label>
  )
}

/** Input: single-line field. Controlled (value tracked for persistence and
 *  submit collection when `id` is set). With `action`: Enter submits
 *  immediately (`{type:'input', value, submit:true}`), blur sends too —
 *  the user never has to click elsewhere for the value to reach the model.
 *  Enter during IME composition never submits. `inputType: 'password'`
 *  stays masked; its value is never persisted and never joins submit
 *  collection (secrets stay out of localStorage), while its own `action`
 *  still delivers on explicit user submit. */
export function InputNode({ node, onAction, answers, uiKey }: {
  node: GenuiInput
  onAction?: GenuiBlockProps['onAction']
  answers?: AnswersState | undefined
  /** CGUI-PATCH: 节点路径,无 `id` 时的存取键。 */
  uiKey?: string | undefined
}) {
  const action = node.action
  const id = node.id
  const secret = node.inputType === 'password'
  // Initial value: spec default, else durable state (restored after refresh).
  // Secrets restore as blank: a password that survives a refresh would be a
  // stored secret, which is exactly what the boundary forbids.
  // CGUI-PATCH: 存过的值**压过** spec 默认值 —— 顺序反了的话,带 default 的输入框
  // 每次重挂都会把用户改的字冲掉(上游对带 id 的那一半也是这个毛病)。
  const [value, setValue] = useState<string>(() =>
    secret ? '' : (keptValue(answers, id, uiKey) ?? node.value ?? ''))
  // Last value actually DELIVERED to the model: blur only sends when the
  // value changed since the last delivery (a focus-in/focus-out with no edit
  // used to fire a pointless action round trip). Seeded with the mount value
  // so the very first unedited blur also stays silent.
  const lastSent = useRef<string | null>(value)
  const send = (submit: boolean): void => {
    if (action !== undefined && onAction !== undefined) {
      lastSent.current = value
      onAction(action, { type: 'input', value, ...(id !== undefined ? { id } : {}), ...(submit ? { submit: true } : {}) })
    }
  }
  const ime = useImeComposing()
  // Field invariant: a spec-provided non-blank default registers at mount.
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    // CGUI-PATCH: 只在**没有存过值**时才注册 spec 默认值。无条件回写的话,
    // 回合末重挂会拿默认值把用户编辑过的值冲掉(屏幕上靠组件 state 侥幸还对,
    // 存储里已经是默认值了 ⟹ 下一次重挂/重开就丢,违 INTERFACE §3.6)。
    // 与上游 RadioNode「restored answer wins」同一条口径。
    if (!secret && node.value !== undefined && node.value.trim() !== ''
      && keptValue(answers, id, uiKey) === undefined) {
      keepValue(answers, id, uiKey, node.value)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Secret fields are filtered from persistence and submit collection.
  useEffect(() => {
    if (secret && id !== undefined) answers?.registerSecretField(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret, id])
  return (
    <label className={css.field}>
      {node.label !== undefined && <span>{node.label}</span>}
      <input
        className={css.input}
        type={node.inputType ?? 'text'}
        placeholder={node.placeholder}
        value={value}
        onChange={e => {
          const v = e.currentTarget.value
          setValue(v)
          // 密码框一个字节都不留(§3.6 永不保留),连内存层也不写。
          if (!secret) keepValue(answers, id, uiKey, v)
        }}
        onBlur={() => {
          if (value !== lastSent.current) send(false)
        }}
        onCompositionStart={ime.onCompositionStart}
        onCompositionEnd={ime.onCompositionEnd}
        onKeyDown={e => {
          if (e.key !== 'Enter') return
          if (ime.isComposing() || isImeSubmitKeydown(e)) return
          e.preventDefault()
          send(true)
        }}
      />
    </label>
  )
}

/** Textarea: multi-line input; with `action`, blurring sends the value and
 *  Ctrl/Cmd+Enter submits immediately. Controlled when `id` is set (durable
 *  value + submit collection). Ctrl/Cmd+Enter during IME composition never
 *  submits. */
export function TextareaNode({ node, onAction, answers, uiKey }: {
  node: GenuiTextarea
  onAction?: GenuiBlockProps['onAction']
  answers?: AnswersState | undefined
  uiKey?: string | undefined
}) {
  const action = node.action
  const id = node.id
  // CGUI-PATCH: 同 InputNode —— 存过的值压过 spec 默认值,无 id 也存(§3.6)。
  const [value, setValue] = useState<string>(() => keptValue(answers, id, uiKey) ?? node.value ?? '')
  // Last value delivered to the model: blur sends only on change. Seeded
  // with the mount value so an unedited blur stays silent.
  const lastSent = useRef<string | null>(value)
  const send = (submit: boolean): void => {
    if (action !== undefined && onAction !== undefined) {
      lastSent.current = value
      onAction(action, { type: 'textarea', value, ...(id !== undefined ? { id } : {}), ...(submit ? { submit: true } : {}) })
    }
  }
  const ime = useImeComposing()
  // Field invariant: a spec-provided non-blank default registers at mount.
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    // CGUI-PATCH: 同 InputNode —— 存过值就不许拿默认值覆盖(§3.6)。
    if (node.value !== undefined && node.value.trim() !== ''
      && keptValue(answers, id, uiKey) === undefined) {
      keepValue(answers, id, uiKey, node.value)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <label className={css.field}>
      {node.label !== undefined && <span>{node.label}</span>}
      <textarea
        className={css.textarea}
        placeholder={node.placeholder}
        rows={node.rows ?? 4}
        value={value}
        onChange={e => {
          const v = e.currentTarget.value
          setValue(v)
          keepValue(answers, id, uiKey, v)
        }}
        onBlur={() => {
          if (value !== lastSent.current) send(false)
        }}
        onCompositionStart={ime.onCompositionStart}
        onCompositionEnd={ime.onCompositionEnd}
        onKeyDown={e => {
          if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return
          if (ime.isComposing() || isImeSubmitKeydown(e)) return
          e.preventDefault()
          send(true)
        }}
      />
    </label>
  )
}

/** Accordion: collapsible sections with local open state. Headings and
 * bodies are wired via useId (`aria-controls`/`aria-labelledby`). */
