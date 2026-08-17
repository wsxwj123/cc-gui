// r11-③:客户端皮肤引擎(T1 变量/背景/home/图标 + T2 代码层加载/卸载)。
// 契约 = INTERFACE-skin.md §2.6:应用只走 setProperty(零 CSS 文本拼接、零 <style>
// 注入——T2 例外且有总开关+静态校验)、激活按设备 localStorage、FOUC 缓存同步重放、
// 明暗联动重跑、失效静默回默认。
import { setIconOverrides } from './iconOverrides.js';
import { useStore } from '../stores/sessionStore.js';

// 与 server/utils/skin-validate.js 的 SKIN_TOKENS/SKIN_TOKENS_REJECTED_V1 逐字一致
// (单测跨文件钉死;客户端复制而非 import server 文件,避免打包边界纠缠)。
export const SKIN_TOKENS_CLIENT = [
  '--color-canvas', '--color-canvas-warm', '--color-canvas-deep', '--color-canvas-sunken',
  '--color-ink', '--color-ink-soft', '--color-ink-muted', '--color-ink-faint', '--color-ink-ghost',
  '--color-accent', '--color-accent-hover', '--color-accent-subtle', '--color-accent-muted',
  '--color-success', '--color-error', '--color-error-subtle', '--color-warning',
  '--glass-base-bg', '--glass-thick-bg', '--glass-thin-bg', '--glass-bar-bg',
  '--glass-specular', '--glass-shade', '--glass-edge', '--glass-edge-outer',
  '--glass-shadow',
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-2xl',
  '--radius-panel', '--radius-control',
  '--shadow-panel', '--shadow-bevel', '--shadow-bar', '--shadow-capsule',
  '--shadow-popover', '--shadow-accent', '--shadow-accent-hover',
  '--backdrop-glass', '--backdrop-soft',
];
export const SKIN_TOKENS_REJECTED_CLIENT = ['--glass-shadow'];
// T2 静态校验黑名单(与服务端 T2_SCRIPT_BLACKLIST 一致;客户端加载前再验一遍=纵深)。
export const T2_BLACKLIST_CLIENT = [
  'fetch(', 'xmlhttprequest', 'websocket', 'import(', 'eval(', 'new function', 'navigator.sendbeacon',
];

const LS_ID = 'cgui-skin-id';
const LS_CACHE = 'cgui-skin-cache';
const LS_DEV = 'cgui-dev-skins';

// ── 订阅(SkinBackground/HomeState 用 useSyncExternalStore 挂这) ──
let version = 0;
const subs = new Set();
export const subscribeSkin = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export const getSkinVersion = () => version;
const bump = () => { version++; for (const fn of subs) fn(); };

// 当前引擎态(module 级单例;分屏共享同一 <html>,天然全局)。
const state = {
  id: null,
  manifest: null,
  appliedVars: [],       // 已 setProperty 的 token 名(清除用)
  background: null,      // { url, overlayOpacity, fit, position, blur } | null
  t2: null,              // { styleNodes:[], scriptNode, blobUrl, attrSnapshot } | null
  tryOn: false,          // 试穿(不落 localStorage)
};
export const getSkinState = () => state;

export function devSkinsEnabled() {
  try { return localStorage.getItem(LS_DEV) === '1'; } catch { return false; }
}
export function setDevSkinsEnabled(on) {
  try { localStorage.setItem(LS_DEV, on ? '1' : '0'); } catch {}
}

export function skinAssetUrl(id, name) { return `/api/skins/${id}/asset/${name}`; }

/** 当前生效明暗模式(含 auto 跟随系统):读 <html> 属性,与主题体系同源。 */
export function resolveSkinMode(root = document.documentElement) {
  const t = root.getAttribute('data-theme');
  if (t === 'dark') return 'dark';
  if (t === 'light') return 'light';
  return root.getAttribute('data-theme-system') === 'dark' ? 'dark' : 'light';
}

/** manifest + mode → 展开的生效值 { vars, background, home, icons }(纯函数,可测)。 */
export function expandSkin(manifest, mode) {
  const m = manifest || {};
  const vars = {};
  const pick = (obj) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (!SKIN_TOKENS_CLIENT.includes(k) || SKIN_TOKENS_REJECTED_CLIENT.includes(k)) continue;
      if (typeof v === 'string' && v.length <= 240) vars[k] = v;
    }
  };
  pick(m.shared?.vars);
  pick(m[mode]?.vars); // 模式块后应用覆盖 shared
  const bg = m[mode]?.background || null;
  return {
    vars,
    background: bg ? {
      image: bg.image,
      overlayOpacity: typeof bg.overlayOpacity === 'number' ? bg.overlayOpacity : 0.45,
      fit: bg.fit || 'cover',
      position: bg.position || 'center',
      blur: typeof bg.blur === 'number' ? bg.blur : 0,
    } : null,
    home: m.home || null,
    icons: m.icons || null,
  };
}

function clearVars(root = document.documentElement) {
  for (const k of state.appliedVars) root.style.removeProperty(k);
  state.appliedVars = [];
}

/** T1 应用(setProperty 循环 + data-cgui-skin + home/icons/背景态)。幂等,可重复调。 */
export function applySkinDom(id, manifest, { root = document.documentElement } = {}) {
  const mode = resolveSkinMode(root);
  const ex = expandSkin(manifest, mode);
  clearVars(root);
  for (const [k, v] of Object.entries(ex.vars)) {
    root.style.setProperty(k, v);
    state.appliedVars.push(k);
  }
  root.setAttribute('data-cgui-skin', id);
  state.id = id;
  state.manifest = manifest;
  state.background = ex.background ? { ...ex.background, url: skinAssetUrl(id, ex.background.image) } : null;
  // home 自定义(r11-② readHomeCustom 占位接管点)
  try {
    window.__cguiHomeCustom = ex.home
      ? { icon: ex.home.icon ? skinAssetUrl(id, ex.home.icon) : undefined, greeting: ex.home.greeting }
      : null;
  } catch {}
  // 图标语义替换(服务端已清洗的 SVG,mask 渲染)
  const iconMap = {};
  for (const [sem, file] of Object.entries(ex.icons || {})) iconMap[sem] = skinAssetUrl(id, file);
  setIconOverrides(iconMap);
  // 明暗双图预载(另一模式背景,切换不闪空)
  const other = manifest?.[mode === 'dark' ? 'light' : 'dark']?.background?.image;
  if (other) { try { new Image().src = skinAssetUrl(id, other); } catch {} }
  bump();
}

/** 停用:清 inline 变量 + 属性 + home/icons/背景/T2;回到主题原样。 */
export function clearSkinDom({ root = document.documentElement } = {}) {
  disposeT2();
  clearVars(root);
  root.removeAttribute('data-cgui-skin');
  state.id = null;
  state.manifest = null;
  state.background = null;
  try { window.__cguiHomeCustom = null; } catch {}
  setIconOverrides({});
  bump();
}

// ── T2 代码层(开发者皮肤;总开关 + 双端静态校验 + 三重卸载兜底) ──
export function validateT2Client(text) {
  if (typeof text !== 'string') return { ok: false, hits: ['not_text'] };
  const low = text.toLowerCase();
  const hits = T2_BLACKLIST_CLIENT.filter((k) => low.includes(k));
  return hits.length ? { ok: false, hits } : { ok: true };
}

/**
 * 装载 T2 三件套(样式节点带 data-cgui-skin-style 标记;client.js 经 Blob-URL 经典
 * 脚本注入;激活前快照 documentElement 属性)。texts 可直接传入(粘贴试穿),否则
 * 按 manifest 从资源端点取。总开关关闭 → 静默不载(T1 部分照常)。
 */
export async function loadT2(id, manifest, texts = null) {
  if (!devSkinsEnabled()) return { loaded: false, reason: 'disabled' };
  disposeT2();
  const get = async (name) => {
    if (texts && typeof texts[name] === 'string') return texts[name];
    const key = name.replace('.', '_');
    if (!manifest?.[key]) return null;
    const r = await fetch(skinAssetUrl(id, name));
    return r.ok ? await r.text() : null;
  };
  const css = await get('skin.css');
  const a11y = await get('a11y.css');
  const js = await get('client.js');
  if (js) {
    const v = validateT2Client(js);
    if (!v.ok) return { loaded: false, reason: 'script_rejected', hits: v.hits };
  }
  const attrSnapshot = {};
  for (const name of document.documentElement.getAttributeNames()) {
    attrSnapshot[name] = document.documentElement.getAttribute(name);
  }
  const t2 = { styleNodes: [], scriptNode: null, blobUrl: null, attrSnapshot };
  for (const text of [css, a11y]) {
    if (!text) continue;
    const node = document.createElement('style');
    node.setAttribute('data-cgui-skin-style', id);
    node.textContent = text;
    document.head.appendChild(node);
    t2.styleNodes.push(node);
  }
  if (js) {
    // Blob-URL 经典脚本(对齐 dsh 执行模型);皮肤脚本用 window.__cguiSkinDispose 注册卸载器。
    const blob = new Blob([js], { type: 'text/javascript' });
    t2.blobUrl = URL.createObjectURL(blob);
    const node = document.createElement('script');
    node.setAttribute('data-cgui-skin-style', id);
    node.src = t2.blobUrl;
    document.head.appendChild(node);
    t2.scriptNode = node;
  }
  state.t2 = t2;
  return { loaded: true };
}

/** 卸载 T2:①皮肤自注册 disposer → ②标记节点逐项移除 → ③documentElement 属性快照恢复。 */
export function disposeT2() {
  const t2 = state.t2;
  try { window.__cguiSkinDispose?.(); } catch {}
  try { window.__cguiSkinDispose = undefined; } catch {}
  for (const node of document.querySelectorAll('[data-cgui-skin-style]')) {
    try { node.remove(); } catch {}
  }
  if (t2) {
    if (t2.blobUrl) { try { URL.revokeObjectURL(t2.blobUrl); } catch {} }
    const root = document.documentElement;
    const snap = t2.attrSnapshot || {};
    for (const name of root.getAttributeNames()) {
      if (!(name in snap)) root.removeAttribute(name);
    }
    for (const [name, val] of Object.entries(snap)) {
      if (root.getAttribute(name) !== val) root.setAttribute(name, val);
    }
  }
  state.t2 = null;
}

// ── 激活/停用(持久化 + FOUC 缓存)──────────────────────────────
function writeCache(id, manifest) {
  try { localStorage.setItem(LS_CACHE, JSON.stringify({ id, manifest })); } catch {}
}
export async function activateSkin(row, { tryOn = false } = {}) {
  const { id, manifest } = row || {};
  if (!id || !manifest) return;
  disposeT2();
  applySkinDom(id, manifest);
  state.tryOn = tryOn;
  // base 基底主题族:应用皮肤同时切过去(保留用户当前明暗档;用户随后可再手动改主题,
  // 皮肤 inline 变量继续盖在其上)。store setTheme(family, tone) 是唯一正规入口。
  if (manifest.base) {
    try {
      const st = useStore.getState();
      if (st.themeFamily !== manifest.base) st.setTheme(manifest.base, st.themeTone || 'auto');
    } catch {}
  }
  if (manifest.tier === 2) await loadT2(id, manifest);
  if (!tryOn) {
    try { localStorage.setItem(LS_ID, id); } catch {}
    writeCache(id, manifest);
  }
}
export function deactivateSkin({ forget = true } = {}) {
  clearSkinDom();
  state.tryOn = false;
  if (forget) {
    try { localStorage.removeItem(LS_ID); localStorage.removeItem(LS_CACHE); } catch {}
  }
}

/** 启动同步重放(main.jsx 在 React 挂载前调,防 FOUC):只回放 T1 视觉;T2 等对账后载。 */
export function bootReplaySkin() {
  try {
    const id = localStorage.getItem(LS_ID);
    if (!id) return;
    const cache = JSON.parse(localStorage.getItem(LS_CACHE) || 'null');
    if (cache?.id === id && cache.manifest) applySkinDom(id, cache.manifest);
  } catch {}
}

/** 列表返回后校对(App 挂载后调):id 失效 → 静默清;manifest 有变 → 以服务端为准重应用。 */
export async function reconcileSkinOnBoot() {
  let id = null;
  try { id = localStorage.getItem(LS_ID); } catch {}
  if (!id) return;
  try {
    const r = await fetch('/api/skins');
    const d = await r.json();
    const row = (d.skins || []).find((s) => s.id === id);
    if (!row) { deactivateSkin(); return; }
    await activateSkin({ id, manifest: row.manifest });
  } catch { /* 网络失败保持缓存重放的样子,下次再对账 */ }
}

// ── 明暗联动:data-theme / data-theme-system 变化 → 重跑应用循环 ──
let observer = null;
export function watchThemeForSkin() {
  if (observer || typeof MutationObserver === 'undefined') return;
  let lastMode = resolveSkinMode();
  observer = new MutationObserver(() => {
    const mode = resolveSkinMode();
    if (mode === lastMode) return;
    lastMode = mode;
    if (state.id && state.manifest) applySkinDom(state.id, state.manifest);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-system'] });
}
