/**
 * Runtime loader for the mermaid engine. mermaid-core already imports mermaid
 * dynamically, so this module only has to hand it through: the sole caller
 * reaches it via `import('../mermaid-lazy.ts')`, which keeps the engine in its
 * own chunk — most conversations never download mermaid at all. When the chunk
 * fails to load the MermaidNode shows its plain-source fallback.
 *
 * CGUI-PATCH: 上游经 asset-loader 注入 script + `window.__GenuiAssets__` 全局交接,
 * 那是为绕开宿主的模块加载协议才存在的;Vite 下直接转交 mermaid-core 即可。
 *
 * The pure source utilities stay statically exported from mermaid-safe so
 * tests (and any consumer) can use them without the engine.
 * @module @changfenhuang/dsh-genui/client/mermaid-lazy
 */
export { assertSafeSvg, ensureFlowchartKind, repairMermaidSource } from './mermaid-safe.ts'

/**
 * Render mermaid source to an SVG string (engine loaded on demand).
 * @throws when the engine cannot load, the kind is not whitelisted, rendering
 *   fails, or the output fails the sanitization check.
 */
export { renderMermaid } from './mermaid-core.ts'
