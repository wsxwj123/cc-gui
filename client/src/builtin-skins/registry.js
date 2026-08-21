// r28:内置皮肤 gallery 注册表 —— 三套移植自 dsh theme-gallery 的真 T2 皮肤
// (miku / xp / whale-song,四件套 = skin.json + skin.css + a11y.css + client.js,
// 由移植代理按 .devflow-porting-guide.md 产出到 ./<id>/)。
// 四件套文本经 vite ?raw import 直进 bundle(内置皮肤不走服务端资源端点);
// skin.json 同走 ?raw + JSON.parse(避免 JSON import attributes 的双端口径差)。
// ⚠️ 本模块含 ?raw import,只能在 vite 下加载,node 单测禁止直接 import
// (node 侧由 tests/unit/helpers/vite-raw-hooks.mjs 的 module hooks 兜底);
// skins.js 因此不反向 import 本模块,改由本模块 import skins.js 并自注册
// (registerBuiltinSkins),保持 skins.js 为 node 可测纯模块(同 iconOverrides 惯例)。
// 注册时机:SkinPanel 被 App.jsx 静态 import → 本模块随 App 首评完成注册,
// 早于挂载后 effect 里的 reconcileSkinOnBoot,builtin- 对账分支可查表。
import { registerBuiltinSkins } from '../utils/skins.js';

import mikuManifestRaw from './miku/skin.json?raw';
import mikuCss from './miku/skin.css?raw';
import mikuA11y from './miku/a11y.css?raw';
import mikuJs from './miku/client.js?raw';

import xpManifestRaw from './xp/skin.json?raw';
import xpCss from './xp/skin.css?raw';
import xpA11y from './xp/a11y.css?raw';
import xpJs from './xp/client.js?raw';

import whaleManifestRaw from './whale-song/skin.json?raw';
import whaleCss from './whale-song/skin.css?raw';
import whaleA11y from './whale-song/a11y.css?raw';
import whaleJs from './whale-song/client.js?raw';

/** 四件套 → gallery 行。row 形状与 activateSkin 契约对齐:{ id, name, source, manifest, t2Texts }。 */
function row(id, manifestRaw, css, a11y, js) {
  const manifest = JSON.parse(manifestRaw);
  return {
    id,
    name: manifest.name || id,
    source: 'builtin',
    manifest,
    t2Texts: { 'skin.css': css, 'a11y.css': a11y, 'client.js': js },
  };
}

export const BUILTIN_GALLERY = [
  row('builtin-miku', mikuManifestRaw, mikuCss, mikuA11y, mikuJs),
  row('builtin-xp', xpManifestRaw, xpCss, xpA11y, xpJs),
  row('builtin-whale-song', whaleManifestRaw, whaleCss, whaleA11y, whaleJs),
];

// 自注册:把 gallery 推进 skins.js 的 BUILTIN_SKINS(reconcile/FOUC/明暗联动统一查它)。
registerBuiltinSkins(BUILTIN_GALLERY);
