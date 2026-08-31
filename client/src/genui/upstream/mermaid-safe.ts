/**
 * Pure mermaid source utilities — no mermaid import, so this module can ship
 * in the main client bundle while the heavy mermaid engine lives in a lazy
 * asset bundle (`lib/assets/mermaid.js`, loaded on demand by mermaid-lazy).
 * @module @changfenhuang/dsh-genui/client/mermaid-safe
 */

/** Reject any rendered SVG that carries script, event-handler attributes, or
 * `javascript:` URIs. Under mermaid's strict security level a legitimate
 * diagram never contains these, so a hit means the sanitizer failed (a
 * mermaid regression or a bypass): throw and let the caller show the plain
 * source fallback instead of injecting the markup. Cheap linear scan over
 * the SVG string; happens once per diagram.
 */
/*
 * CGUI-PATCH(PLAN §5.3 补丁 4):上游 `[\s"']on[a-z]+\s*=` 的**前置字符类**是个洞 ——
 * `<img/onerror=x>` 里 `onerror` 前面是 `/`,不在 `[\s"']` 里,整条溜过去。这是本函数
 * "弱于 DOMPurify"的那一条,去掉前置要求补死。
 *
 * 代价按 PLAN 接受:标签文字里出现 `xxon<字母>=`(如 `A[condition=true]`、`done=1`)
 * 会误杀。误杀 = 降级显示 mermaid 源码,无害。
 *
 * ⚠️ **本条与 PLAN 的清单有出入,是取证后的有意偏离**:PLAN 还要求补
 * `<foreignObject|<image|<use|<style`,实测这四个 mermaid 自己就会输出,补上去等于
 * 把 mermaid 关掉,不是 PLAN 预期的"少量误杀"(取证:本仓 client/node_modules/mermaid
 * 11.15.0):
 *   - `<style>`:dist/mermaid.core.mjs:1200-1202 `createElement("style")` +
 *     `svg.insertBefore(style1, firstChild)`,在 render 主路径上**无条件**插进每一张
 *     SVG ⟹ 补上 = 100% 的图全部降级,mermaid 组件等于不存在;
 *   - `<foreignObject>`:33 处输出点,且 mermaid 把它显式加进自己的 DOMPurify 白名单
 *     (`DOMPURIFY_TAGS = ["foreignobject"]`),flowchart 的 htmlLabels 默认就是它 ⟹
 *     补上 = 最常用的流程图全灭;
 *   - `<image>` 9 处、`<use>` 3 处输出点 ⟹ 补上 = 相应图种全灭。
 * 替代:补 `<iframe|<object|<embed`(实测 mermaid 输出点为 0;`putIntoIFrame` 只在
 * `securityLevel:'sandbox'` 走,本仓恒为 'strict')与 `data:text\/html`。这三个标签正是
 * 「HTML 走私进 SVG」的落点,补回了原本指望 `<foreignObject` 拦的那一类,且零误杀。
 */
const SVG_INJECTION = /<script|<iframe|<object|<embed|on[a-z]+\s*=|javascript:|data:text\/html/i

/** Throws when `svg` carries script, event-handler attributes, or
 * `javascript:` URIs. Exported for tests; `renderMermaid` is the only caller
 * in production. */
export function assertSafeSvg(svg: string): void {
  if (SVG_INJECTION.test(svg)) {
    throw new Error('mermaid output failed the sanitization check; refusing to render')
  }
}

/**
 * Best-effort repair of common model-authored label mistakes in graph /
 * flowchart sources, used only when the original fails to render:
 * - drop backticks — lexically illegal in mermaid labels (models embed
 *   ```dsh-ui style fences, which break the parser with "Lexical error");
 * - strip `<br/>` tags, which require htmlLabels (never enabled here);
 * - quote unquoted node labels containing CJK, spaces, or other characters
 *   mermaid's bare-label grammar rejects (observed live: `A[模型生成 spec]`).
 * Conservative by design: already-quoted labels, plain ASCII labels without
 * spaces, and non-flowchart kinds are left untouched (apart from the
 * backtick/`<br/>` sanitation above, which is harmless everywhere in a
 * flowchart).
 *
 * Labeled-edge spans (`-- 文本 -->`, `== 文本 ==>`, `-. 文本 .->`) are free
 * text and must never be quoted: wrapping them breaks the parser
 * ("Expecting 'LINK' … got 'STR'"), observed live with
 * `H -- 否(流式中) --> J`. Each span is swapped for a bracket-free
 * placeholder before quoting and restored verbatim afterwards, so the quote
 * pass can neither corrupt it nor be thrown off by inserted quotes
 * elsewhere on the line.
 *
 * Pipe-style edge labels (`-->|文本|`) are the opposite: an UNQUOTED pipe
 * label containing `[` or `]` breaks the parser ("Parse error", observed
 * live with `-->|6. 用户交互 → [genui-action]|`) because the brackets are
 * node grammar. Quoting the label text is display-neutral (mermaid renders
 * `-->|"文本"|` without the quotes) and parses. These spans are masked too,
 * so the node-label quote pass below cannot reach inside them and produce
 * nested quotes, and restored last.
 */
export function repairMermaidSource(code: string): string {
  const kind = /^([A-Za-z]+)/.exec(code.trim())?.[1] ?? ''
  if (kind !== 'graph' && kind !== 'flowchart') return code
  const cleaned = code.replace(/`/g, '').replace(/<br\s*\/?>/gi, ' ')
  // A labeled edge is `--`/`==`/`-.` (not immediately `-->`/`==>`), a label
  // made of non-dash chars or single dashes (never `--`, which would start a
  // new edge), then the arrow. `[ \t]*` — never newlines — keeps the span on
  // one line.
  const EDGE = /(--|==|-\.)(?!>)[ \t]*([^-\n]|-(?!--))*?[ \t]*(-->|==>|\.->)/g
  const spans: string[] = []
  const masked = cleaned.replace(EDGE, (span) => {
    spans.push(span)
    return `\uE000${spans.length - 1}\uE001`
  })
  // Pipe label spans whose text carries at least one bracket char. The
  // bracket requirement keeps legitimate pipe characters inside node labels
  // (e.g. `A[a | b | c]`) untouched. Already-quoted labels (any `"` in the
  // text) are left alone. The placeholder must be bracket-free so the
  // node-label quote pass below cannot match inside it.
  const PIPE = /\|([^|\n]*[\[\]][^|\n]*)\|/g
  const pipeSpans: string[] = []
  const maskedPipes = masked.replace(PIPE, (whole, text: string) => {
    const trimmed = text.trim()
    if (trimmed.includes('"')) return whole
    pipeSpans.push(trimmed)
    return `\uE002${pipeSpans.length - 1}\uE003`
  })
  const quoted = maskedPipes.replace(
    /([\[\(])([^\[\]\(\)\{\}"'\n]*)([\]\)])/g,
    (whole, open: string, label: string, close: string) => {
      const trimmed = label.trim()
      if (trimmed === '') return whole
      if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(trimmed) || /\s/.test(trimmed)) {
        return `${open}"${trimmed}"${close}`
      }
      return whole
    },
  )
  return quoted
    .replace(/\uE000(\d+)\uE001/g, (whole, i: string) => spans[Number(i)] ?? whole)
    .replace(/\uE002(\d+)\uE003/g, (whole, i: string) => {
      const text = pipeSpans[Number(i)]
      return text === undefined ? whole : `|"${text}"|`
    })
}

/** Flowchart edge arrows. The negative lookahead on `-->(?!>)` keeps
 * sequence-diagram message arrows (`-->>`) from matching. */
const FLOWCHART_EDGE = /-->(?!>)|==>|-\.->/

/**
 * Lenient repair for sources that omit the mandatory diagram-type
 * declaration line — the #1 failure mode of model-generated mermaid (chat
 * assistants routinely emit `A --> B` without the leading `graph TD`).
 *
 * When the first token is not an already-declared `graph`/`flowchart` kind
 * but the body contains flowchart edge arrows, prepend `graph TD` so the
 * diagram renders instead of tripping the kind gate. Anything else — an
 * explicitly declared kind, a sequence/gantt/pie body (no flowchart edges),
 * or plain text — is returned unchanged: we never guess at the diagram type.
 */
export function ensureFlowchartKind(code: string): string {
  const trimmed = code.trim()
  const kind = /^([A-Za-z]+)/.exec(trimmed)?.[1] ?? ''
  if (kind === 'graph' || kind === 'flowchart') return code
  if (!FLOWCHART_EDGE.test(trimmed)) return code
  return `graph TD\n${trimmed}`
}
