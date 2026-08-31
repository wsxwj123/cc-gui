/**
 * 宿主明暗探测 + 主题变更订阅(PLAN r64 §1.6-4)。
 *
 * 为什么需要它:
 * ① 上游按 `documentElement.style.colorScheme === 'dark'` 判明暗,而 CC-GUI 用
 *    `<html data-theme>`,**从不设** colorScheme —— SPIKE V7 在 34 个主题变体上逐个实测,
 *    该属性恒为空串。照抄上游 = genui 的 mermaid / diagram 永远浅色。
 * ② 主题是在 `<html>` 上换属性,不经 React。三个"把颜色算进 JS 而不是留给 CSS"的节点
 *    (mermaid 的 initialize、diagram 的调色板、echart 的 option)在切主题时**不会重渲**,
 *    图会停在旧主题直到刷新。所以要一个外部订阅把属性变更喂回 React。
 *
 * 明暗判据与 index.css 的深色 mixin 选择器逐字对齐:
 * `[data-theme="dark"]` 或 `[data-theme="auto"]` 且 `[data-theme-system="dark"]`。
 * 属性缺席按浅色算(CSS 也是这么算的),不要在这里自作主张查 matchMedia —— 那会与 CSS 分叉。
 *
 * @module genui/host/host-theme
 */
import { useSyncExternalStore } from 'react'

/** 宿主当前是深色吗。 */
export function hostPrefersDark(): boolean {
  if (typeof document === 'undefined') return false
  const root = document.documentElement
  const theme = root.getAttribute('data-theme')
  if (theme === 'dark') return true
  if (theme === 'auto') return root.getAttribute('data-theme-system') === 'dark'
  return false
}

// ── 主题变更订阅:`<html>` 属性一变就 bump 一个计数 ───────────────────────────
// 只盯这四个属性:明暗、系统明暗、主题家族、皮肤 id。**刻意不盯 `style`** ——
// 界面不透明度滑杆是往 documentElement 的 inline style 写的,盯上就会在拖动时逐帧
// 重建 echart option。皮肤装载/卸载都会动 data-cgui-skin,所以皮肤照样能被这里接住。
const WATCHED = ['data-theme', 'data-theme-system', 'data-cgui-theme', 'data-cgui-skin']

let epoch = 0
const listeners = new Set<() => void>()
let observer: MutationObserver | null = null

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  if (observer === null && typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    observer = new MutationObserver(() => {
      epoch += 1
      for (const l of listeners) l()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: WATCHED })
  }
  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0 && observer !== null) {
      observer.disconnect()
      observer = null
    }
  }
}

/**
 * 主题代际号。放进 effect / useMemo 的 deps,主题或皮肤一变就重算。
 * 值本身没有意义,只保证"变了就不同"。
 */
export function useHostThemeEpoch(): number {
  return useSyncExternalStore(subscribe, () => epoch, () => 0)
}
