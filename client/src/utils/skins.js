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
// T2 静态校验黑名单(r26-D5:纯子串升级为正则集,修前 `fetch (`(空格)/`window["fetch"]`/
// `Function('…')` 全可绕)。与服务端 T2_SCRIPT_BLACKLIST 逐字一致(check-skin-client.mjs t1
// 按 String 形态钉死);校验前先 toLowerCase,故正则一律小写形态。口径 = 防误导入、不防
// 恶意代码:正则误伤一律朝拒载方向(安全向),已知误伤(prefetch(、匿名 function(){})
// 钉在 check-r26-t2-blacklist.mjs / check-r26-t2-blacklist-client.mjs。
// r27:规则带标识符左边界 防 prefetch(/myeval( 误伤;function 规则改抓
// 「字符串实参」形态(Function("...") 构造器——lowercase 后与 function 关键字同形,
// 普通 function 声明/表达式(标识符或 ) 开头)不命中。QQ2008 皮肤曾被旧规则误杀。
// r31-Safari<16.4:原写法用 lookbehind(标识符左边界),但旧 WebKit 不支持 lookbehind,
// 模块顶层字面量正则会在 import 时抛解析期 SyntaxError → main.jsx 顶层 import 本模块
// 整页白屏。改为等价的无 lookbehind 写法 `(?:^|[^\w$])`(捕获式,布尔 .test() 逐点一致;
// 仅当「fetch 前紧邻字符非 \w/$ 或串首」命中),hits 的 source 串变化由 check-r26 两测换锚。
export const T2_BLACKLIST_CLIENT = [
  /(?:^|[^\w$])fetch\s*\(/,
  /xmlhttprequest/,
  /(?:^|[^\w$])websocket\s*\(/,
  /(?:^|[^\w$])import\s*\(/,
  /(?:^|[^\w$])eval\s*\(/,
  /new\s+function/,
  /(?:^|[^\w$])function\s*\(\s*['"]/,
  /navigator\s*\.\s*sendbeacon/,
  /\[\s*['"](?:fetch|eval|function|websocket)['"]\s*\]/,
];

// ── 值文法校验(客户端版;r26-D11) ─────────────────────────────
// bootReplaySkin 的 FOUC 缓存重放只读 localStorage——修前 expandSkin 的 pick 只查 token
// 白名单 + ≤240 字符,篡改 localStorage 可注入 url(javascript:…) 形态值绕过服务端
// validateSkinVar 的文法闸。以下常量与函数为 server/utils/skin-validate.js 中
// validateSkinVar 纯函数部分的逐字复制(白名单引用换 CLIENT 变体;客户端复制不 import
// server 文件,本文件顶部既有惯例),双端一致性由 check-r26-skin-var-parity.mjs
// 跨文件 token × 值矩阵钉死。
// 值文法(锚定 ^$,无 m flag;进正则前黑名单预筛)。
const ALPHA_CLIENT = '(?:0|1(?:\\.0{1,4})?|0?\\.\\d{1,4})';
const HEX_CLIENT = '#[0-9a-fA-F]{3}(?:[0-9a-fA-F])?(?:[0-9a-fA-F]{2})?(?:[0-9a-fA-F]{2})?';
const RGB_CLIENT = `rgba?\\(\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*(?:,\\s*${ALPHA_CLIENT}\\s*)?\\)`;
const HSL_CLIENT = `hsla?\\(\\s*\\d{1,3}\\s*,\\s*\\d{1,3}%\\s*,\\s*\\d{1,3}%\\s*(?:,\\s*${ALPHA_CLIENT}\\s*)?\\)`;
const COLOR_RE_CLIENT = new RegExp(`^(?:${HEX_CLIENT}|${RGB_CLIENT}|${HSL_CLIENT})$`);
const LENGTH_RE_CLIENT = /^\d{1,2}(\.\d)?px$/;
const SLEN_CLIENT = '-?\\d{1,3}(?:\\.\\d{1,2})?(?:px)?';
const SCOLOR_CLIENT = `(?:${HEX_CLIENT}|${RGB_CLIENT}|${HSL_CLIENT})`;
const ONE_SHADOW_CLIENT = `(?:inset\\s+)?${SLEN_CLIENT}\\s+${SLEN_CLIENT}(?:\\s+${SLEN_CLIENT}){0,2}\\s+${SCOLOR_CLIENT}`;
const SHADOW_RE_CLIENT = new RegExp(`^${ONE_SHADOW_CLIENT}(?:\\s*,\\s*${ONE_SHADOW_CLIENT})*$`);
const BACKDROP_RE_CLIENT = /^(?:none|blur\(\d{1,2}(\.\d)?px\))$/;

// 黑名单预筛(toLowerCase 后):任一子串命中直接拒(大小写变体同闸)。
const VALUE_BLACKLIST_CLIENT = ['url(', 'var(', ';', '}', '\\', '/*', '@'];

function grammarForClient(token) {
  if (token.startsWith('--color-') || token.startsWith('--glass-')) return COLOR_RE_CLIENT; // glass-shadow 在白名单层已拒
  if (token.startsWith('--radius-')) return LENGTH_RE_CLIENT;
  if (token.startsWith('--shadow-')) return SHADOW_RE_CLIENT;
  if (token.startsWith('--backdrop-')) return BACKDROP_RE_CLIENT;
  return null;
}

/** 单变量校验(客户端版):{ ok } | { ok:false, reason }。与服务端 validateSkinVar 同口径。 */
export function validateSkinVarClient(token, value) {
  if (!SKIN_TOKENS_CLIENT.includes(token)) return { ok: false, reason: 'not_in_whitelist' };
  if (SKIN_TOKENS_REJECTED_CLIENT.includes(token)) return { ok: false, reason: 'rejected_v1' };
  if (typeof value !== 'string') return { ok: false, reason: 'grammar' };
  const v = value.trim();
  const maxLen = grammarForClient(token) === SHADOW_RE_CLIENT ? 240 : 64;
  if (!v || v.length > maxLen) return { ok: false, reason: 'too_long' };
  const low = v.toLowerCase();
  for (const bad of VALUE_BLACKLIST_CLIENT) {
    if (low.includes(bad)) return { ok: false, reason: 'blacklist' };
  }
  const re = grammarForClient(token);
  if (!re || !re.test(v)) return { ok: false, reason: 'grammar' };
  // LENGTH 数值 ≤64 附加约束
  if (re === LENGTH_RE_CLIENT && parseFloat(v) > 64) return { ok: false, reason: 'grammar' };
  return { ok: true };
}

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
  t2: null,              // { styleNodes:[], scriptNode, blobUrl, attrSnapshot(preSnap), loadedSnap } | null
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
      // r26-D11:值走全套闸(白名单+黑名单+文法)——FOUC 缓存重放不再旁路文法校验
      if (validateSkinVarClient(k, v).ok) vars[k] = String(v).trim();
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
  // 图标语义替换(mask 渲染):包内文件走资源端点(服务端已清洗);内置示例/本地预置
  // 用 data:image/svg+xml URI 直通(mask 上下文不执行脚本,且仅自带内容走此形态——
  // zip 导入的 manifest 里 data: 值过不了服务端文件名白名单,不会流到这里)。
  const iconMap = {};
  for (const [sem, file] of Object.entries(ex.icons || {})) {
    iconMap[sem] = file.startsWith('data:image/svg+xml') ? file : skinAssetUrl(id, file);
  }
  setIconOverrides(iconMap);
  // 明暗双图预载(另一模式背景,切换不闪空)
  const other = manifest?.[mode === 'dark' ? 'light' : 'dark']?.background?.image;
  if (other) { try { new Image().src = skinAssetUrl(id, other); } catch {} }
  bump();
}

/** 停用:清 inline 变量 + 属性 + home/icons/背景/T2;回到主题原样。 */
export function clearSkinDom({ root = document.documentElement } = {}) {
  ++t2Gen; // r26-D1:停用使一切在途装载失效
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

// ── r40 取证插桩(皮肤加载链;纯附加,不改任何既有行为语义) ──────────
// 背景:用户机器(Tauri WKWebView)上 T2 皮肤「模板层生效、skin.css/client.js 两层不
// 上身且界面卡死不动」,三路复现全部失败 → 缺现场数据。这里给加载链每一步「先发再做」
// 地上报一行到既有 POST /api/client-log(落 ~/.claude-gui/client.log):日志停在哪一步,
// 下一步就是凶手。三条红线:①只插上报,既有步序/早退/快照/代际一字不动;②全同步
// (不引入 await,不破坏「快照→插节点→state 赋值同一 tick」不变量);③任何异常一律
// 吞掉 —— 取证绝不许反过来影响功能。
// 通道:navigator.sendBeacon 优先(卡死/关页时仍能送出),Blob 必须标 application/json,
// 否则 express.json 不解析 → 服务端 400,证据白丢;sendBeacon 不可用/被拒时 fetch
// keepalive 兜底。服务端对「同 message」有 5s 限流,故重复步点(心跳)在载荷里带 n,
// 便于区分「被限流丢行」与「真的没发生」。
let skinTraceEnvSent = false;
function skinTrace(step, extra) {
  try {
    // 首次上报前补一行环境(UA/视口/zoom/主题)——定位「只有这台机器复现」的环境差异。
    // 递归一层即止(标志先置位),保证环境行必定排在第一条步点之前。
    if (!skinTraceEnvSent) {
      skinTraceEnvSent = true;
      let env = {};
      try {
        env = {
          ua: navigator?.userAgent || '',
          w: window?.innerWidth,
          h: window?.innerHeight,
          zoom: document?.documentElement?.style?.zoom || '',
          theme: document?.documentElement?.getAttribute('data-theme') || '',
        };
      } catch {}
      skinTrace('skin:env', env);
    }
    // 载荷落在 stack 字段:client-log 路由只持久化 ts/iso/kind/message/stack/url,
    // 顶层多写的字段会被服务端整个丢掉(实测),故步点细节序列化进 stack。
    const body = JSON.stringify({
      kind: 'skin-trace', message: String(step), stack: JSON.stringify(extra || {}),
    });
    let sent = false;
    try { sent = !!navigator.sendBeacon('/api/client-log', new Blob([body], { type: 'application/json' })); } catch {}
    if (!sent) {
      try {
        fetch('/api/client-log', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true,
        }).catch(() => {});
      } catch {}
    }
  } catch {}
}

// r40 探针:装载完成后的「冻结现场分型」(用户新线索 = 点试穿后整个 GUI 任何按钮都点
// 不动、必须 Cmd+Q,且冻结帧里皮肤零视觉)。三根探针各答一问:
//   post-load:first-frame —— 渲染管线还出不出帧(永不触发 = 渲染管线死);
//   post-load:heartbeat   —— 主线程还活不活着(停在第 N 次 = 卡死时刻);
//   post-load:pointerdown —— 点击有没有到达 JS(有 = 事件到了但 UI 不响应,
//                            无 = 被原生层/遮罩截走)。
// 30s 窗口后自动清理,皮肤卸载(disposeT2)同步清理,不留残余。
const PROBE_WINDOW_MS = 30000;
const PROBE_BEAT_MS = 6000; // 判官建议2:避开 client-log 服务端 5s 同消息限流边界
const PROBE_BEATS = 6;
let skinProbes = null;
/** 清干净三根探针(interval / pointerdown 监听 / 未触发的 rAF / 30s 兜底定时器)。幂等。 */
function disposeSkinProbes() {
  const p = skinProbes;
  skinProbes = null;
  if (!p) return;
  try { clearInterval(p.beat); } catch {}
  try { clearTimeout(p.stop); } catch {}
  try { cancelAnimationFrame(p.raf); } catch {}
  try { window.removeEventListener('pointerdown', p.onPointerDown, { capture: true }); } catch {}
}
function armSkinProbes(base) {
  disposeSkinProbes(); // 一次只留一组
  const p = {};
  skinProbes = p;
  try { p.raf = requestAnimationFrame(() => skinTrace('post-load:first-frame', base)); } catch {}
  try {
    let n = 0;
    p.beat = setInterval(() => {
      n += 1;
      skinTrace('post-load:heartbeat', { ...base, n, t: Math.round(performance?.now?.() || 0) });
      if (n >= PROBE_BEATS) { try { clearInterval(p.beat); } catch {} p.beat = null; }
    }, PROBE_BEAT_MS);
  } catch {}
  try {
    p.onPointerDown = (e) => skinTrace('post-load:pointerdown', {
      ...base, x: e?.clientX, y: e?.clientY, target: e?.target?.tagName,
    });
    window.addEventListener('pointerdown', p.onPointerDown, { capture: true });
  } catch {}
  try { p.stop = setTimeout(disposeSkinProbes, PROBE_WINDOW_MS); } catch {}
}

// ── T2 代码层(开发者皮肤;总开关 + 双端静态校验 + 三重卸载兜底) ──
// r26-D1:装载代际 token——每次激活/停用递增。快速连切(或 StrictMode 双跑)时慢一拍
// 的装载在任一 await 回来后比对代际,过期即弃(不插节点、不盖 state.t2),杜绝
// 「显示 B 的皮、跑着 A 的脚本」串皮。
let t2Gen = 0;

export function validateT2Client(text) {
  if (typeof text !== 'string') return { ok: false, hits: ['not_text'] };
  const low = text.toLowerCase();
  // r26-D5:正则集判定,hits = 命中正则的 source 串(与服务端 validateT2Script 同形状)
  const hits = T2_BLACKLIST_CLIENT.filter((re) => re.test(low)).map((re) => re.source);
  return hits.length ? { ok: false, hits } : { ok: true };
}

/**
 * 装载 T2 三件套(样式节点带 data-cgui-skin-style 标记;client.js 经 Blob-URL 经典
 * 脚本注入;激活前快照 documentElement 属性)。texts 可直接传入(粘贴试穿),否则
 * 按 manifest 从资源端点取。总开关关闭 → 静默不载(T1 部分照常)。
 * gen = r26-D1 代际 token(activateSkin 领代传入;直调则自领),过期返回 superseded。
 */
export async function loadT2(id, manifest, texts = null, gen = null) {
  // r40 取证:每步「先发再做」——下一步同步卡死时,日志停在哪一步就是凶手。
  const devEnabled = devSkinsEnabled();
  skinTrace('loadT2:enter', { id, gen, devEnabled, tier: manifest?.tier, hasTexts: !!texts });
  if (!devEnabled) {
    skinTrace('loadT2:abort', { id, gen, reason: 'disabled' });
    return { loaded: false, reason: 'disabled' };
  }
  // r26-D1:调用方未领代则自领一代(直接调 loadT2 的路径);之后每个 await 回来
  // 先比代,过期 = 已有更新的激活/停用,一律不插节点不盖 state(superseded)。
  if (gen == null) gen = ++t2Gen;
  const stale = () => gen !== t2Gen;
  disposeT2();
  skinTrace('loadT2:disposed', { id, gen });
  const get = async (name) => {
    if (texts && typeof texts[name] === 'string') return texts[name];
    const key = name.replace('.', '_');
    if (!manifest?.[key]) return null;
    const r = await fetch(skinAssetUrl(id, name));
    return r.ok ? await r.text() : null;
  };
  const css = await get('skin.css');
  if (stale()) { skinTrace('loadT2:abort', { id, gen, reason: 'superseded', at: 'skin.css' }); return { loaded: false, reason: 'superseded' }; }
  const a11y = await get('a11y.css');
  if (stale()) { skinTrace('loadT2:abort', { id, gen, reason: 'superseded', at: 'a11y.css' }); return { loaded: false, reason: 'superseded' }; }
  const js = await get('client.js');
  if (stale()) { skinTrace('loadT2:abort', { id, gen, reason: 'superseded', at: 'client.js' }); return { loaded: false, reason: 'superseded' }; }
  skinTrace('loadT2:texts-ready', {
    id, gen, cssLen: css ? css.length : 0, a11yLen: a11y ? a11y.length : 0, jsLen: js ? js.length : 0,
  });
  if (js) {
    // 校验器是 ReDoS 嫌疑位:enter 先发,done 带耗时——只有 enter 没有 done = 卡在正则。
    skinTrace('loadT2:validator-enter', { id, gen, jsLen: js.length });
    const t0 = Date.now();
    const v = validateT2Client(js);
    skinTrace('loadT2:validator-done', { id, gen, ms: Date.now() - t0, ok: v.ok, hits: v.hits });
    if (!v.ok) {
      skinTrace('loadT2:abort', { id, gen, reason: 'script_rejected', hits: v.hits });
      return { loaded: false, reason: 'script_rejected', hits: v.hits };
    }
  }
  // ── 以下为同一同步 tick(快照→插节点→state 赋值,无 await 即无竞态缝)──
  // r26-D2 二次快照法:attrSnapshot = preSnap(装载前),loadedSnap = 装载完成后同一
  // tick 再拍一次;dispose 按两快照 diff 只还原皮肤改过的属性(见 disposeT2)。
  const attrSnapshot = {};
  for (const name of document.documentElement.getAttributeNames()) {
    attrSnapshot[name] = document.documentElement.getAttribute(name);
  }
  const t2 = { styleNodes: [], scriptNode: null, blobUrl: null, attrSnapshot, loadedSnap: null };
  for (const text of [css, a11y]) {
    if (!text) continue;
    const node = document.createElement('style');
    node.setAttribute('data-cgui-skin-style', id);
    node.textContent = text;
    document.head.appendChild(node);
    t2.styleNodes.push(node);
  }
  skinTrace('loadT2:styles-appended', { id, gen, n: t2.styleNodes.length });
  if (js) {
    // Blob-URL 经典脚本(对齐 dsh 执行模型);皮肤脚本用 window.__cguiSkinDispose 注册卸载器。
    const blob = new Blob([js], { type: 'text/javascript' });
    t2.blobUrl = URL.createObjectURL(blob);
    const node = document.createElement('script');
    node.setAttribute('data-cgui-skin-style', id);
    node.src = t2.blobUrl;
    // 判官建议4:load 事件在脚本【执行完】才触发——皮肤脚本同步死循环则此步永不出现,
    // 把"脚本执行死"与"样式重算死"的日志签名彻底分开(否则渲染帧偶尔抢先会重合)。
    node.onload = () => skinTrace('loadT2:script-executed', { id, gen });
    document.head.appendChild(node);
    t2.scriptNode = node;
    skinTrace('loadT2:script-appended', { id, gen });
  }
  // r26-D2:装载完成后同一同步 tick 二次快照(皮肤脚本同步执行的痕迹落在两快照差集里)
  const loadedSnap = {};
  for (const name of document.documentElement.getAttributeNames()) {
    loadedSnap[name] = document.documentElement.getAttribute(name);
  }
  t2.loadedSnap = loadedSnap;
  state.t2 = t2;
  skinTrace('loadT2:done', { id, gen });
  armSkinProbes({ id, gen }); // 装载后 30s 冻结现场分型(异常全吞,disposeT2/超时自清)
  return { loaded: true };
}

// r31:app 自持的属性(主题/缩放/system 等 sessionStore 写入点)属 app 所有,皮肤不负责
// 清理。disposeT2 的「新增属性摘除」分支(①/②的 removeAttribute)绝不许删这些 —— 否则
// 皮肤存活期间用户换主题写的 data-theme / data-cgui-theme(或 --ui-zoom 等 style 内的
// app 变量)会被当成「皮肤/第三方新增」误删,停用皮肤=把用户主题设置摘掉。style 由
// clearVars(appliedVars)精确清皮肤变量,这里只豁免「整段不摘除」。
const APP_ATTRS = new Set(['data-theme', 'data-cgui-theme', 'data-theme-system', 'style']);

/** 卸载 T2:①皮肤自注册 disposer → ②标记节点逐项移除 → ③documentElement 属性按双快照 diff 还原。 */
export function disposeT2() {
  const t2 = state.t2;
  // r40:先把取证探针(心跳/pointerdown 监听/rAF/30s 兜底)同步清干净 —— 皮肤卸载后
  // 不留残余。皮肤自持的 window.__cguiSkinDispose 归皮肤所有,这里不包装、不替换。
  disposeSkinProbes();
  try { window.__cguiSkinDispose?.(); } catch {}
  try { window.__cguiSkinDispose = undefined; } catch {}
  for (const node of document.querySelectorAll('[data-cgui-skin-style]')) {
    try { node.remove(); } catch {}
  }
  if (t2) {
    if (t2.blobUrl) { try { URL.revokeObjectURL(t2.blobUrl); } catch {} }
    const root = document.documentElement;
    // r26-D2 二次快照 diff:只还原「皮肤改过且之后没人再动」的属性——皮肤存活期间
    // 用户换主题(data-theme)/改字体透明度等不再被回滚。迭代域必须含 keys(preSnap):
    // 皮肤装载期删除的属性 preSnap 有、loadedSnap 无,不进迭代就永不还原。
    // cur === null(属性当前不存在)先摘出来单独判,绝不与 undefined 比(getAttribute
    // 缺席返回 null,null === undefined 为 false 会把「被删掉」错判成「被改过」)。
    const preSnap = t2.attrSnapshot || {};
    const loadedSnap = t2.loadedSnap || preSnap; // 旧态兜底:无二次快照时退化为全量还原
    const names = new Set([...root.getAttributeNames(), ...Object.keys(loadedSnap), ...Object.keys(preSnap)]);
    for (const name of names) {
      const inLoaded = Object.prototype.hasOwnProperty.call(loadedSnap, name);
      const inPre = Object.prototype.hasOwnProperty.call(preSnap, name);
      const cur = root.getAttribute(name); // null = 当前不存在
      // r31:app 自持属性(data-theme/data-cgui-theme/data-theme-system/style)豁免「摘除」——
      // 这些是 app 加的不该由皮肤清理(皮肤存活期用户换主题写 data-theme 等,不能被当新增删)。
      // 注意此处只豁免 removeAttribute;`if (inPre) setAttribute(preSnap)` 的还原路径仍照常
      // (把 app 属性还原到装载前值是正确语义,不丢用户改动)。
      if (!inLoaded && !inPre) {
        if (!APP_ATTRS.has(name)) root.removeAttribute(name); // 存活期新增(皮肤脚本异步或第三方) → 摘除
      } else if (inLoaded && cur !== null && cur === loadedSnap[name]) {
        // 装载后没人动 → 还原到装载前(preSnap 无此键 = 装载期新增,摘除)
        if (inPre) root.setAttribute(name, preSnap[name]);
        else if (!APP_ATTRS.has(name)) root.removeAttribute(name);
      } else if (!inLoaded && inPre && cur === null) {
        root.setAttribute(name, preSnap[name]); // 皮肤装载期删掉且仍缺席 → 还原
      }
      // else:第三方改过(cur≠loadedSnap)/皮肤删掉但第三方重设(cur≠null) → 一律保留现状。
      // 已知残留面:皮肤脚本在 loadedSnap 之后异步(setInterval 等)自改的属性会被当用户
      // 改动保留——T2 是受信开发者代码(总开关+确认弹窗),残留可接受。
      // watchThemeForSkin 交互:明暗切换重跑 applySkinDom 会重写 root.style 内联变量 →
      // style ≠ loadedSnap 被当「用户改动」保留,这不泄漏:clearSkinDom 顺序是
      // disposeT2() → clearVars(),clearVars 按 appliedVars 精确 removeProperty 清干净。
    }
  }
  state.t2 = null;
}

// ── 激活/停用(持久化 + FOUC 缓存)──────────────────────────────
function writeCache(id, manifest) {
  try { localStorage.setItem(LS_CACHE, JSON.stringify({ id, manifest })); } catch {}
}
export async function activateSkin(row, { tryOn = false } = {}) {
  const { id, manifest, t2Texts } = row || {};
  if (!id || !manifest) return;
  const gen = ++t2Gen; // r26-D1:每次激活领一代,此前在途装载全部失效
  skinTrace('activate:start', { id, gen, tier: manifest.tier, source: row.source || null, tryOn });
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
  // t2Texts = 内置示例/粘贴试穿的本地三件套(不经资源端点);否则按 manifest 从服务端取。
  // 返回 T2 装载结果给 UI(拒载/门控不再被静默吞掉——p2-1 顺带修)。
  let t2 = null;
  if (manifest.tier === 2) t2 = await loadT2(id, manifest, t2Texts || null, gen);
  // r31:只在实际仍是「当前代」时才落 LS_ID/缓存 —— 若在 await loadT2 期间又有新的激活
  // (gen 已被 ++t2Gen 越代),本皮肤已被 superseded(loadT2 返回 reason:'superseded'),
  // 绝不能把已被替代的皮写进 LS_ID,否则重启 bootReplaySkin 会回放到旧皮。
  // tier-1 无 await,gen===t2Gen 恒真,行为不变;tier-2 被后来者越代才跳过。
  if (!tryOn && gen === t2Gen) {
    try { localStorage.setItem(LS_ID, id); } catch {}
    writeCache(id, manifest);
  }
  return { t2 };
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

/** 列表返回后校对(App 挂载后调):id 失效 → 静默清;manifest 有变 → 以服务端为准重应用。
 *  r26-D8:先查服务端列表再判 builtin- 分支——修前 builtin- 前缀直接进本地分支,
 *  而 BUILTIN_SKINS 已退役为空 → 用户皮肤起名 "builtin xxx" 得的 builtin- 前缀 id
 *  重启即被静默卸。现在服务端列表命中(含用户自起的 builtin- 前缀皮肤)优先激活;
 *  查无且 builtin- 前缀才进本地 gallery 分支(命中 BUILTIN_SKINS → 本地激活,
 *  r28 起由 registry.js 自注册填充、带 t2Texts;未命中 → deactivate)。 */
export async function reconcileSkinOnBoot() {
  let id = null;
  try { id = localStorage.getItem(LS_ID); } catch {}
  if (!id) return;
  try {
    const r = await fetch('/api/skins');
    const d = await r.json();
    const row = (d.skins || []).find((s) => s.id === id);
    if (row) { await activateSkin({ id, manifest: row.manifest }); return; }
    // 服务端查无:builtin- 前缀进本地 gallery 分支(注册表命中 → activateSkin,
    // 内置皮肤永不在服务端列表里,绝不能误判成「失效皮肤」清掉),否则失效静默清
    if (id.startsWith('builtin-')) {
      const b = BUILTIN_SKINS.find((s) => s.id === id);
      if (b) { await activateSkin(b); return; }
    }
    deactivateSkin(); return;
  } catch { /* 网络失败保持缓存重放的样子,下次再对账 */ }
}

// ── 内置皮肤 gallery(客户端预置,非服务端库) ──────────────────
// r13-p2-10:旧内置示例(晨光/夜航/霓虹终端)因「和主题没有区别」退役。
// r28:以三套移植自 dsh theme-gallery 的真 T2 皮肤(miku / xp / whale-song)复活
// 内置 gallery —— 数据唯一真相源 = client/src/builtin-skins/registry.js(vite ?raw
// 收四件套文本进 bundle)。skins.js 须保持 node 单测可 import 的纯模块(?raw 在 node
// 下不可执行),故不正向 import registry,改由 registry 反向调 registerBuiltinSkins
// 注入;面板/对账/FOUC/明暗联动一律只读本数组,导出形状不变(数组,元素 = activateSkin
// 的 row 契约 { id, name, source:'builtin', manifest, t2Texts })。
export const BUILTIN_SKINS = [];
/** registry.js 自注册入口:原地填充 BUILTIN_SKINS(保持引用不变,消费点零改动)。 */
export function registerBuiltinSkins(rows) {
  BUILTIN_SKINS.splice(0, BUILTIN_SKINS.length, ...(Array.isArray(rows) ? rows : []));
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
