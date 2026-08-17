// r11-③:图标语义替换注册表(纯 js,零 JSX)。Icon.jsx(渲染层)与 skins.js(皮肤
// 引擎)都从这里取——引擎是 node 单测可 import 的纯模块,不能反向依赖 JSX。
let overrides = {};
let version = 0;
const subs = new Set();

export const subscribeIcons = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export const getIconsVersion = () => version;

/** 皮肤层调用:map = { 语义名: 资源 URL };传空对象清除全部替换。 */
export function setIconOverrides(map) {
  overrides = (map && typeof map === 'object') ? { ...map } : {};
  version++;
  for (const fn of subs) fn();
}
export function getIconOverrides() { return overrides; }
