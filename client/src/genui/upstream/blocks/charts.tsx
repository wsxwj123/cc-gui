/**
 * Chart family: categorical palette, the sortable table, and the bars / line
 * / donut renderers. All local-first; no model round trips.
 * @module @changfenhuang/dsh-genui/client/blocks/charts
 */
import { memo, useState } from 'react'
import css from '../GenuiBlock.module.css'
import { GENUI_LIMITS } from '../guard.ts'
import type { GenuiChart, GenuiTable } from '../spec.ts'
import type { AnswersState } from './state.ts'

export const CHART_COLORS = [
  'var(--dsw-static-deepseek-400)',
  'var(--dsw-static-green-400)',
  'var(--dsw-static-amber-400)',
  'var(--dsw-static-red-400)',
  'var(--dsw-static-blue-450)',
  'var(--dsw-static-deepseek-450)',
  'var(--dsw-static-neutral-bluish-400)',
  'var(--dsw-static-deepseek-300)',
]

/**
 * Series color: explicit color wins, otherwise assign from the fixed palette.
 *
 * CGUI-PATCH(INTERFACE §6):去掉 `n > 1` 那道门。原来单序列的柱/折线拿不到色板色,
 * 回落 CSS 里的 `--dsl-g-accent` —— 那是**主题强调色**,换个主题家族就变。契约写死
 * 「序列色只随浅/深翻转,不随主题家族变」,回落到 accent 正好违反它。色板是明暗两套的
 * 固定值(host/genui-tokens.css,与画布对比度已由 check-genui-palette 逐主题看住)。
 * `n` 保留在签名里只为读起来对称,判定不再用它。
 */
const seriesColor = (i: number, n: number, c?: string): string =>
  c ?? CHART_COLORS[i % CHART_COLORS.length]!

/**
 * Sortable numeric value of a cell. Human-written table cells are rarely
 * plain numbers, so the sort accepts the usual decorations:
 * `1,234` / `1，234`（千分位）、`1.2k`/`3M`/`5b`、`3.5万`/`2亿`、`0.3%`、
 * `¥99`/`$12`。A cell that cannot be read as a number returns NaN and the
 * row falls back to the text comparison — mixed columns sort deterministically
 * (numbers first, then text).
 */
export function parseSortableNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  let s = v.trim()
  if (s === '') return NaN
  s = s.replace(/^[¥$€£]/, '')
  const pct = s.endsWith('%')
  if (pct) s = s.slice(0, -1)
  // 中文单位在前：3.5万 → 35000、2亿 → 200000000；再是 k/m/b 后缀。
  let mult = 1
  if (s.endsWith('万')) { mult = 10_000; s = s.slice(0, -1) }
  else if (s.endsWith('亿')) { mult = 100_000_000; s = s.slice(0, -1) }
  else if (/[kmb]$/i.test(s)) {
    const unit = s.slice(-1).toLowerCase()
    mult = unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : 1e9
    s = s.slice(0, -1)
  }
  s = s.replace(/[,，\s]/g, '')
  // CGUI-PATCH: 剥完装饰后尾数为空 = 这串里根本没有数字,按文本排。
  // 上游漏了这一步:`'b'` 被当成 10 亿的后缀、尾数剩空串,而 `Number('') === 0`
  // ⟹ 一个纯字母单元格变成数字 0,排到所有文本行前面(锁定验收 B70 的第二条红因)。
  // 同一个洞还吃掉 `'k'`/`'m'`/`'万'`/`'亿'`/`'%'`/`'¥'` 这些光杆装饰。
  // 数字+后缀(`3k`/`1.2m`/`3.5万`)一个字节没动:它们的尾数非空。
  if (s === '') return NaN
  const n = Number(s)
  if (!Number.isFinite(n)) return NaN
  return n * mult
}

/** A column is numeric when every non-empty cell parses to a finite number —
 * those columns right-align with tabular numerals (the table's data voice). */
function numericColumns(rows: GenuiTable['rows'], nCols: number): boolean[] {
  return Array.from({ length: nCols }, (_, j) => {
    let any = false
    for (const row of rows) {
      const cell = row[j]
      if (cell === undefined || cell === null || cell === '') continue
      if (!Number.isFinite(parseSortableNumber(cell))) return false
      any = true
    }
    return any
  })
}

// CGUI-PATCH: 排序态按节点路径存进内存层 —— §3.6 的「排序」也在"回合结束全部保留"里,
// 而它本来只活在组件本地 state,重挂即丢。编码 `col:dir`,解不出就当没排过。
function parseSort(raw: string | undefined): { col: number; dir: 1 | -1 } | null {
  const m = /^(\d+):(-?1)$/.exec(raw ?? '')
  return m === null ? null : { col: Number(m[1]), dir: Number(m[2]) === -1 ? -1 : 1 }
}

export const TableNode = memo(function TableNode({ node, answers, uiKey }: {
  node: GenuiTable
  answers?: AnswersState | undefined
  uiKey?: string | undefined
}) {
  const columns = node.columns.slice(0, GENUI_LIMITS.maxTableCols)
  const rows = node.rows.slice(0, GENUI_LIMITS.maxTableRows)
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(
    () => parseSort(uiKey !== undefined ? answers?.ui[uiKey] : undefined))
  const sorted = sort === null
    ? rows
    : [...rows].sort((a, b) => {
      const an = parseSortableNumber(a[sort.col])
      const bn = parseSortableNumber(b[sort.col])
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return (an - bn) * sort.dir
      if (Number.isFinite(an) !== Number.isFinite(bn)) return Number.isFinite(an) ? -sort.dir : sort.dir
      const as = String(a[sort.col] ?? '')
      const bs = String(b[sort.col] ?? '')
      return (as < bs ? -1 : as > bs ? 1 : 0) * sort.dir
    })
  const clickHeader = (i: number): void => {
    // CGUI-PATCH: next 在更新函数**外面**算 —— setUi 是另一个组件的 setState,
    // 塞进 updater 里就是"在更新函数里调度更新"(React 明令 updater 必须纯)。
    const next: { col: number; dir: 1 | -1 } | null = sort !== null && sort.col === i
      ? sort.dir === 1 ? { col: i, dir: -1 } : null
      : { col: i, dir: 1 }
    setSort(next)
    // "没排序"用 'none' 显式记:setUi 把空串当"回到默认"删条目,
    // 否则点第三下(回到未排序)会被下次重挂恢复成第二下的降序。
    if (uiKey !== undefined) answers?.setUi(uiKey, next === null ? 'none' : `${next.col}:${next.dir}`)
  }
  const numeric = numericColumns(rows, columns.length)
  return (
    <div data-testid="genui-node-table" className={css.tableWrap}>
      <table className={css.table}>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th
                key={i}
                className={numeric[i] ? css.thNum : undefined}
                aria-sort={sort !== null && sort.col === i ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
              >
                <button type="button" className={css.thSort} onClick={() => clickHeader(i)}>
                  {c}
                  {sort !== null && sort.col === i && <span className={css.thSortMark} aria-hidden>{sort.dir === 1 ? ' ▲' : ' ▼'}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={i}>{row.slice(0, columns.length).map((cell, j) => (
              <td key={j} className={numeric[j] ? css.tdNum : undefined}>{String(cell)}</td>
            ))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
})

/** Chart: bars (default), line (trend), or donut (share); multi-series bars via `series`.
 *  memoized: the spec node is a stable reference, so a keystroke in a sibling
 *  field no longer re-renders the whole chart. */
export const ChartNode = memo(function ChartNode({ chart }: { chart: GenuiChart }) {
  const kind = chart.kind ?? 'bars'
  if (kind === 'donut') return <DonutNode chart={chart} />
  if (kind === 'line') return <LineChartNode chart={chart} />
  return <BarsNode chart={chart} />
})

/** Bars: one column per datum (grouped bars when `series` is present). */
export const BarsNode = memo(function BarsNode({ chart }: { chart: GenuiChart }) {
  const grouped = chart.series !== undefined ? chart.series.slice(0, GENUI_LIMITS.maxPlotSeries) : undefined
  if (grouped !== undefined && grouped.length > 0) {
    const labels = grouped[0]!.data.map(d => d.label)
    const max = Math.max(...grouped.flatMap(s => s.data.map(d => Number(d.value) || 0)), 1)
    return (
      <div data-testid="genui-node-chart" className={css.chart}>
        <div className={css.chartPlot}>
          {[0, 25, 50, 75].map(p => (
            <span key={p} className={p === 0 ? css.baseline : css.gridline} style={{ bottom: `${p}%` }} />
          ))}
          {labels.map((_, i) => (
            <div key={i} className={css.barCol}>
              <div className={css.groupedBars}>
                {grouped.map((s, si) => {
                  const d = s.data[i]
                  // Cap at 82% so the per-bar value annotation stays inside
                  // the plot; negatives clamp to a zero-height bar.
                  const v = d === undefined ? 0 : Number(d.value) || 0
                  const h = d === undefined ? 0 : Math.min(Math.round((Math.max(0, v) / max) * 100), 82)
                  return (
                    <div key={si} className={css.groupedBar} title={d === undefined ? s.label : `${s.label}: ${String(d.value)}`}>
                      <span className={css.groupValue}>{d === undefined ? '' : String(d.value)}</span>
                      <div
                        // CGUI-PATCH(§9.1):genui-series =「可着色元素,每序列一个」。分组柱的颜色
                        // 按序列分配,而 DOM 是标签为主序(每标签下并排 N 根柱) ⟹ 逐根打锚会让
                        // 一条序列出现 N 个锚。只在第 0 组打,个数正好等于序列数。
                        {...(i === 0 ? { 'data-testid': 'genui-series' } : {})}
                        className={css.groupedFill}
                        style={{
                          height: `${h}%`,
                          background: seriesColor(si, grouped.length, s.color),
                        }}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
        <div className={css.chartLabels}>
          {labels.map(label => <span key={label} className={css.barLabel}>{label}</span>)}
        </div>
      </div>
    )
  }
  const data = chart.data.slice(0, GENUI_LIMITS.maxChartPoints)
  // Negative values clamp to a zero-height bar (the value annotation still
  // shows the real number) — a negative `height` percentage is invalid CSS
  // and used to collapse the bar entirely.
  const max = Math.max(...data.map(d => Number(d.value) || 0), 1)
  return (
    <div data-testid="genui-node-chart" className={css.chart}>
      <div className={css.chartPlot}>
        {[0, 25, 50, 75].map(p => (
          <span key={p} className={p === 0 ? css.baseline : css.gridline} style={{ bottom: `${p}%` }} />
        ))}
        {data.map((d, i) => {
          // Cap at 85% so the value annotation always stays inside the plot.
          const v = Number(d.value) || 0
          const h = Math.min(Math.round((Math.max(0, v) / max) * 100), 85)
          return (
            <div key={i} className={css.barCol} title={`${d.label}: ${String(d.value)}`}>
              <span className={css.barValue}>{String(d.value)}</span>
              {/* CGUI-PATCH(§6):单序列柱也从固定色板取色。原来只在 d.color 存在时才写 inline,
                  否则回落 CSS 的 --dsl-g-accent(主题强调色)—— 换主题家族就变,违反契约。 */}
              <div data-testid="genui-series" className={css.barFill} style={{ height: `${h}%`, background: seriesColor(i, data.length, d.color) }} />
            </div>
          )
        })}
      </div>
      <div className={css.chartLabels}>
        {data.map(d => <span key={d.label} className={css.barLabel}>{d.label}</span>)}
      </div>
    </div>
  )
})

/** Line: polyline over a fixed-height plot area with a readable Y axis —
 * four evenly spaced gridlines + tick labels (design system v2 skeleton). */
export const LineChartNode = memo(function LineChartNode({ chart }: { chart: GenuiChart }) {
  const data = chart.data.slice(0, GENUI_LIMITS.maxChartPoints)
  const W = 460
  const H = 150
  const padL = 36
  const padR = 8
  const padT = 10
  const padB = 6
  const max = Math.max(...data.map(d => Number(d.value) || 0), 1)
  const min = Math.min(...data.map(d => Number(d.value) || 0), 0)
  const span = max - min || 1
  const n = Math.max(data.length - 1, 1)
  const pt = (i: number, v: number): [number, number] => [
    padL + (i / n) * (W - padL - padR),
    padT + (1 - (v - min) / span) * (H - padT - padB),
  ]
  const d = data.map((datum, i) => pt(i, Number(datum.value) || 0))
  const path = d.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  const ticks = [0, 1, 2, 3].map(i => min + (span * i) / 3)
  const formatTick = (t: number): string => {
    const abs = Math.abs(t)
    if (abs >= 1000) return `${(t / 1000).toFixed(abs % 1000 === 0 ? 0 : 1)}k`
    if (Number.isInteger(t)) return String(t)
    return t.toFixed(1)
  }
  return (
    <div data-testid="genui-node-chart" className={css.lineChart}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
        {ticks.map((t, i) => {
          const y = padT + (1 - (t - min) / span) * (H - padT - padB)
          return (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} className={i === 0 ? css.lineGridAxis : css.lineGrid} />
              <text x={padL - 6} y={y + 3} textAnchor="end" className={css.lineTick}>{formatTick(t)}</text>
            </g>
          )
        })}
        {data.map((datum, i) => {
          const [x, y] = pt(i, Number(datum.value) || 0)
          return (
            // CGUI-PATCH(§6):点色走 inline style 而不是 fill 属性 —— 表现属性优先级低于
            // CSS 规则,`.lineDot { fill: … }` 会把 fill 属性整个盖掉(逐点 color 一直是哑的)。
            <circle key={i} cx={x} cy={y} r={3} className={css.lineDot} style={{ fill: seriesColor(0, 1, datum.color) }}>
              <title>{`${datum.label}: ${String(datum.value)}`}</title>
            </circle>
          )
        })}
        <path d={path} data-testid="genui-series" className={css.linePath} />
      </svg>
      <div className={css.lineLabels}>
        {data.map((d, i) => <span key={i} className={css.barLabel}>{d.label}</span>)}
      </div>
    </div>
  )
})

/** Donut: share of total with a center total. Negative values contribute
 * zero arc (a negative dasharray segment used to produce an invalid
 * stroke-dasharray and the browser drew the FULL circle instead). */
export const DonutNode = memo(function DonutNode({ chart }: { chart: GenuiChart }) {
  const data = chart.data.slice(0, GENUI_LIMITS.maxChartPoints)
  const clamped = data.map(d => ({ ...d, v: Math.max(0, Number(d.value) || 0) }))
  const total = clamped.reduce((s, d) => s + d.v, 0) || 1
  // Center total: 1 decimal for fractional sums — a share-of-total figure
  // like 3.3/9.9 used to print the raw float as 6.6000000000000005.
  const totalText = total >= 1000
    ? `${Math.round(total / 100) / 10}k`
    : Number.isInteger(total) ? String(total) : total.toFixed(1)
  const R = 42
  const C = 2 * Math.PI * R
  let offset = 0
  return (
    <div data-testid="genui-node-chart" className={css.donut}>
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={R} fill="none" strokeWidth="14" className={css.donutTrack} />
        {clamped.map((d, i) => {
          const frac = d.v / total
          const len = frac * C
          const el = (
            <circle
              key={i}
              data-testid="genui-series"
              cx="60" cy="60" r={R} fill="none" strokeWidth="14"
              className={css.donutSeg}
              style={{ stroke: seriesColor(i, data.length, d.color) }}
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 60 60)"
            >
              <title>{`${d.label}: ${String(d.value)}`}</title>
            </circle>
          )
          offset += len
          return el
        })}
        <text x="60" y="58" textAnchor="middle" className={css.donutTotal}>{totalText}</text>
        <text x="60" y="74" textAnchor="middle" className={css.donutTotalLabel}>合计</text>
      </svg>
      <div className={css.donutLegend}>
        {data.map((d, i) => (
          <span key={i} className={css.legendItem}>
            <span className={css.legendSwatch} style={{ background: seriesColor(i, data.length, d.color) }} />
            {d.label} · {String(d.value)}
          </span>
        ))}
      </div>
    </div>
  )
})

/** Tab strip with local active-tab state. Keyboard: ArrowLeft/Right to move,
 * Home/End to jump; ids wired via useId so `aria-controls` stays unique
 * across fences and sessions. */
