/**
 * Runtime loader for the ECharts engine. echarts is fetched ONLY when a spec
 * contains an `echart` node — the main client bundle stays small and most
 * conversations never download echarts at all. When the chunk fails to load
 * the EChartNode shows its fallback.
 *
 * CGUI-PATCH: 上游经 asset-loader 注入 script + `window.__GenuiAssets__` 全局交接,
 * 那是为绕开宿主的模块加载协议才存在的;Vite 下 `import('echarts')` 就是同一件事,
 * 且 Rollup 自动切 chunk。函数体照搬上游 asset-echarts.ts。
 * @module @changfenhuang/dsh-genui/client/echarts-lazy
 */

/** The ECharts instance surface (the subset the component uses). */
export interface EChartsInstance {
  setOption: (opt: unknown, notMerge?: boolean) => void
  resize: () => void
  dispose: () => void
}

/**
 * Create an ECharts instance on `el` with the given option (engine loaded on
 * demand). The caller owns the returned instance and must dispose it.
 * @param el - the DOM node to host the chart canvas.
 * @param option - the ECharts option object.
 * @param opts - optional height override.
 * @returns the ECharts instance (setOption/resize/dispose).
 */
export async function createChart(el: HTMLElement, option: unknown, opts?: { height?: number }): Promise<EChartsInstance> {
  const { init } = await import('echarts')
  const initOpts = opts !== undefined && opts.height !== undefined ? { height: opts.height } : undefined
  const instance = init(el, undefined, initOpts)
  instance.setOption(option)
  return instance
}
