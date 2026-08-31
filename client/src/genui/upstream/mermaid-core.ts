/**
 * Mermaid render engine — the HEAVY half. This module imports mermaid and is
 * bundled ONLY into the lazy asset bundle `lib/assets/mermaid.js`, loaded on
 * demand by the mermaid-lazy loader when a spec contains a `mermaid` node;
 * the main client bundle stays small.
 *
 * Whitelist: only a fixed set of diagram kinds render; anything else throws
 * so the caller shows its fallback — except undeclared flowchart bodies
 * (model-generated sources missing the `graph TD` header line), which get
 * the declaration prepended via ensureFlowchartKind and render normally.
 * mermaid runs client-side with its own sanitizer; we additionally refuse `securityLevel: 'loose'`-style inputs by
 * only initializing with the strict default, AND we re-check the rendered SVG
 * before it is injected (see `assertSafeSvg` in mermaid-safe): the injection
 * point is the only place in GenUI that uses `dangerouslySetInnerHTML`, so
 * the last line of defense lives here, not inside mermaid.
 * @module @changfenhuang/dsh-genui/client/mermaid-core
 */
import { assertSafeSvg, ensureFlowchartKind, repairMermaidSource } from './mermaid-safe.ts'
// CGUI-PATCH: 上游按 documentElement.style.colorScheme 判明暗,本仓从不设该属性
// (SPIKE V7:34 个主题变体实测恒为空串)⟹ 照抄的话 genui 的 mermaid 恒定浅色。
import { hostPrefersDark } from '../host/host-theme.ts'

let mermaidPromise: Promise<typeof import('mermaid')> | null = null

/** CGUI-PATCH: 上次 initialize 用的明暗。mermaidPromise 是单例、initialize 只跑一次,
 * 切主题后已加载的 mermaid 不会重新主题化,所以要记住这个值好在渲染前比对。 */
let initializedDark: boolean | null = null

/** CGUI-PATCH: initialize 的参数抽出来,首次加载与切主题后的重新主题化共用一份。 */
function initMermaid(api: typeof import('mermaid').default, dark: boolean): void {
  api.initialize({
    startOnLoad: false,
    // Strict default: mermaid escapes/sanitizes; we never enable htmlLabels.
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'neutral',
    // Fail loudly: with suppressErrorRendering false (the default) mermaid
    // renders an "error" diagram on parse/draw failure — the caller then
    // receives a normal-looking SVG whose text is the raw engine error
    // ("Syntax error in text / mermaid version …"), which lands on the page
    // with no exception ever thrown. Suppressing the error diagram makes
    // every failure throw so the caller shows its own fallback instead.
    suppressErrorRendering: true,
  })
  initializedDark = dark
}

/** Monotonic render id (replaces Math.random): no collisions, no entropy. */
let renderSeq = 0

function loadMermaid(): Promise<typeof import('mermaid')> {
  mermaidPromise ??= import('mermaid').then(async m => {
    // Follow the host theme: a dark-forced diagram on a light chat looked broken.
    initMermaid(m.default, hostPrefersDark())
    return m
  })
  return mermaidPromise
}

/** Diagram kinds allowed through to the renderer. */
const ALLOWED_KINDS = [
  'flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram',
  'gantt', 'pie', 'erDiagram', 'journey', 'gitGraph',
]

/** One render attempt into a private container. mermaid ≥ 11.16 resolves the
 * diagram element via `document.body` while drawing flowcharts
 * (`getDiagramElement`), so a DETACHED container makes every flowchart/graph
 * render throw on an empty d3 selection ("Cannot read properties of null").
 * The container is therefore mounted off-screen for the duration of the
 * render — NOT `display:none`, which zeroes label measurements and makes
 * dagre fail with "Could not find a suitable point" — and removed when done. */
async function renderInto(m: typeof import('mermaid'), id: string, code: string, container: HTMLDivElement): Promise<string> {
  container.style.position = 'fixed'
  container.style.left = '-100000px'
  container.style.top = '0'
  container.style.margin = '0'
  document.body?.appendChild(container)
  try {
    const { svg } = await m.default.render(id, code, container)
    assertSafeSvg(svg)
    return svg
  } finally {
    container.remove()
  }
}

/**
 * Render mermaid source to an SVG string.
 * @param code - the mermaid diagram source.
 * @returns the rendered SVG markup (verified free of script/event handlers).
 * @throws when the kind is not whitelisted, rendering fails, or the output
 *   fails the sanitization check.
 */
export async function renderMermaid(code: string): Promise<string> {
  let trimmed = code.trim()
  const firstLine = trimmed.split('\n', 1)[0] ?? ''
  let kind = /^([A-Za-z]+)/.exec(firstLine)?.[1] ?? ''
  if (!ALLOWED_KINDS.includes(kind)) {
    // Lenient: model-generated sources frequently omit the mandatory
    // diagram-type declaration line (`A --> B` with no leading
    // `graph TD`). Detect a flowchart body by its edge arrows and prepend
    // the declaration instead of throwing straight to the raw-source
    // fallback; genuinely unclassifiable input still fails as before.
    const lenient = ensureFlowchartKind(trimmed)
    if (lenient !== trimmed) {
      trimmed = lenient
      kind = 'graph'
    }
  }
  if (!ALLOWED_KINDS.includes(kind)) {
    throw new Error(`mermaid kind '${kind}' is not allowed`)
  }
  const m = await loadMermaid()
  // CGUI-PATCH: 切主题后重新主题化。initialize 只在首次加载时跑过一次,不比对的话
  // 已经加载过 mermaid 的会话切到深色后,新画的图仍是浅色主题(旧图由调用侧重渲带走)。
  const dark = hostPrefersDark()
  if (dark !== initializedDark) initMermaid(m.default, dark)
  const container = document.createElement('div')
  try {
    try {
      return await renderInto(m, `genui-mermaid-${renderSeq++}`, trimmed, container)
    } catch (error) {
      // Retry once with the label-repair pass; a repaired source rendering
      // successfully beats a syntax-error fallback for the same content.
      const repaired = repairMermaidSource(trimmed)
      if (repaired !== trimmed) {
        return await renderInto(m, `genui-mermaid-${renderSeq++}`, repaired, container)
      }
      throw error
    }
  } finally {
    container.remove()
  }
}
