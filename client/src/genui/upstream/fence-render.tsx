/**
 * The cgui-ui fence render pipeline. `MarkdownRenderer` hands a fence body here
 * with a session-scoped context (sessionId + whether the message has settled)
 * and gets back either the GenuiBlock tree or a degraded code block.
 *
 * Two entry points, differing only in what an unrepairable body yields:
 * {@link renderGenuiFence} returns {@link FenceFallback} (code block + settled
 * diagnostic) because the caller already replaced the original block;
 * {@link renderResolvedFenceNode} returns `null` so an untouched code block
 * stays visible.
 *
 * CGUI-PATCH: 上游有两条渲染通道(registry / DOM observer),CC-GUI 只有围栏拦截
 * 一条(dom-fence.tsx 不搬),所以上面两个入口在这里只是"修不好时给什么"的区别。
 */
// CGUI-PATCH: CodeBlock 改由 genui/host/primitives.jsx 提供(§1.7);
// panel-store 整个不搬(§6.1 首版不做常驻面板);
// fence-repair 扁平化一层(CC-GUI 无 shared/ 概念),isCompleteJson 只被 panel 分支用过,一并去掉。
import { type CSSProperties, type Key, type ReactNode } from 'react'
import { CodeBlock } from '../host/primitives.jsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { GenuiBlock } from './GenuiBlock.tsx'
import { repairGenuiSpec } from './guard.ts'
import { fenceStateKey } from './interaction-store.ts'
import { parsePartialGenuiSpec } from './parse-partial.ts'
import type { GenuiSpec } from './spec.ts'
import { completeFenceJson, describeJsonFailure, repairFenceJson } from './fence-repair.ts'

/**
 * Context a fence renderer receives beside the raw source and React key.
 *
 * CGUI-PATCH: 上游的 `source`(宿主给的结构身份 id+order)整个去掉,换成一个布尔
 * `settled`。CC-GUI 拿得到更直接的信号 —— `TurnBubble` 的 `isLiveStream`,经
 * `MarkdownRenderer` 的 `isStreaming` prop 透传下来(PLAN §1.4)。不查 DOM:
 * DOM 探测在 React 19 并发渲染下时序不可靠,而 props 是渲染输入。
 */
export interface GenuiFenceContext {
  /** Owning session route; absent outside a session-scoped render. */
  readonly sessionId?: string
  /** True once the message finished streaming (upstream: `source !== undefined`). */
  readonly settled?: boolean
}

const FENCE_ERROR_STYLE: CSSProperties = {
  margin: '0 0 6px',
  padding: '6px 10px',
  borderRadius: 6,
  background: 'rgba(239, 68, 68, 0.14)',
  border: '1px solid rgba(239, 68, 68, 0.4)',
  color: '#f87171',
  fontSize: 12,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
}

/**
 * Fallback for a ```cgui-ui fence whose body has no finished component yet.
 * Two very different situations land here and they must not be conflated:
 *
 * 1. **Streaming partial** — the reply is still being written and the JSON
 *    simply is not complete. `settled` is false for the whole of it, and a
 *    plain code block is then the correct rendering (partial JSON must never
 *    look like an error).
 *
 * 2. **Settled defect** — the message is finished but the body still does
 *    not parse as JSON (a malformed fence like a missing `}`). This used to
 *    fail silently: the fence degraded to a code block with no hint, and the
 *    author had no way to know the UI never rendered. Once the message is
 *    settled, surface a compact diagnostic with the parse position so the
 *    defect is visible instead of silent.
 *
 * CGUI-PATCH: 上游在 layout effect 里 `node.closest('[data-streaming]')` 反查
 * 祖先节点来判断"还在不在流",CC-GUI 直接收 `settled` prop(§1.4 同一条理由)。
 * ref / useState / useLayoutEffect 三件套随之消失。
 */
function FenceFallback({ raw, fenceKey, settled }: { raw: string; fenceKey: Key; settled: boolean }) {
  const diagnostic = settled && raw.trim() !== '' ? describeJsonFailure(raw) : null
  return (
    <div>
      {diagnostic !== null && (
        <div style={FENCE_ERROR_STYLE} role="alert">
          ⚠️ cgui-ui 围栏 JSON 解析失败{diagnostic} —— 围栏保持为代码块；请让模型检查并修复 JSON 后重发。
        </div>
      )}
      <CodeBlock key={fenceKey} code={`${raw}\n`} lang="cgui-ui" />
    </div>
  )
}

/**
 * Resolve a raw fence body to a guarded spec.
 *
 * - Tier-1 repair (quote escape + trailing commas): safe at any time —
 *   adopted only when the whole body parses, so a still-growing streaming
 *   half keeps falling back to the code block, never flashing a banner.
 * - Tier-2 completion (missing quotes/brackets): settled renders only —
 *   `context.settled` is true exclusively once the message finished, so
 *   streaming halves are never completed early.
 */
export function resolveGenuiSpec(raw: string, context?: GenuiFenceContext): GenuiSpec | null {
  const parsed = parsePartialGenuiSpec(raw)
  let spec = parsed === null ? null : repairGenuiSpec(parsed)
  if (spec === null) {
    const repaired = repairFenceJson(raw)
    if (repaired !== null) {
      const reparsed = parsePartialGenuiSpec(repaired.text)
      spec = reparsed === null ? null : repairGenuiSpec(reparsed)
    }
    // CGUI-PATCH: 二级补全的门 `context.source !== undefined` → `context.settled === true`(§1.4)
    if (spec === null && context?.settled === true) {
      const completed = completeFenceJson(raw)
      if (completed !== null) {
        const reparsed = parsePartialGenuiSpec(completed.text)
        spec = reparsed === null ? null : repairGenuiSpec(reparsed)
      }
    }
  }
  return spec
}

/** The inline GenuiBlock tree for a resolved spec. */
function renderInlineFence(key: Key, context: GenuiFenceContext | undefined, spec: GenuiSpec): ReactNode {
  const sessionId = context?.sessionId
  return (
    // CGUI-PATCH: 上游用 `source.id` 当身份(定稿瞬间从文档 key 换成 source.id,
    // 那次换身份正是[上游 §4.3]落差二的成因)。CC-GUI 没有 source,身份就是文档 key。
    // Repaired specs render SILENTLY: once the UI renders, no amber note
    // tells the user something was wrong — only an unrecoverable body keeps
    // the red diagnostic.
    <ErrorBoundary key={key} label="该界面">
      <GenuiBlock
        spec={spec}
        // 交互态的持久键。⚠️ 这里仍是**上游算法**(session + 文档 key + spec 指纹);
        // PLAN §1.2.2-A1 的 `g:{queueKey}:{djb2(raw)}` 与内存 Map 写透属 M5,本轮不做。
        stateKey={sessionId === undefined
          ? undefined
          : fenceStateKey(sessionId, String(key), JSON.stringify(spec))}
      />
    </ErrorBoundary>
  )
}

/**
 * Resolved fence render, `null` when the body is unrepairable (the original
 * code block stays visible — §5 总原则②).
 *
 * CGUI-PATCH: 摘掉 `panel:true` 分支(panel-store 不搬,§6.1)。带 `panel:true`
 * 的围栏按普通围栏就地渲染、不报错、不进任何常驻面板 —— INTERFACE §1.2 的
 * 「首版不支持」就是这个语义,日后接面板时在这里改成分派即可。
 */
export function renderResolvedFenceNode(raw: string, key: Key, context?: GenuiFenceContext): ReactNode | null {
  const spec = resolveGenuiSpec(raw, context)
  if (spec === null) return null
  return renderInlineFence(key, context, spec)
}

/**
 * Fence renderer: like the resolved node, but an unrepairable body renders the
 * fallback code block + settled diagnostic instead of `null` — the caller
 * replaced the host's own code block with our output, so we owe it one.
 *
 * CGUI-PATCH: 同上,摘掉 `panel:true` 分支。
 */
export function renderGenuiFence(raw: string, key: Key, context?: GenuiFenceContext): ReactNode {
  const spec = resolveGenuiSpec(raw, context)
  if (spec === null) return <FenceFallback key={key} fenceKey={key} raw={raw} settled={context?.settled === true} />
  return renderInlineFence(key, context, spec)
}
