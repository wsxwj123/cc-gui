/**
 * Runtime loader for the three.js scene renderer. scene3d-core already imports
 * three dynamically, so this module only has to hand it through: the sole
 * caller reaches it via `import('../scene3d-lazy.ts')`, which keeps three in
 * its own chunk — it is fetched ONLY when a spec contains a `scene3d` node.
 * When the chunk fails to load the Scene3DNode shows its error hint.
 *
 * CGUI-PATCH: 上游经 asset-loader 注入 script + `window.__GenuiAssets__` 全局交接,
 * 那是为绕开宿主的模块加载协议才存在的;Vite 下直接转交 scene3d-core 即可。
 * @module @changfenhuang/dsh-genui/client/scene3d-lazy
 */
/**
 * Mount a GenUI 3D scene into `container` (engine loaded on demand).
 * @returns a disposer that removes the renderer and its context.
 */
export { mountScene } from './scene3d-core.ts'
