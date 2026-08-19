// r11-③:AI 提示词生成器(纯函数,node 可测)。三清单全部取既有唯一权威源:
// token = skins.js 白名单(减 v1 拒收)、图标语义名 = iconOverrides.js 注册表、
// 锚点 = skinAnchors.js;皮肤 schema/骨架/明暗规范/{name} 说明内联。
import { SKIN_TOKENS_CLIENT, SKIN_TOKENS_REJECTED_CLIENT } from './skins.js';
import { ICON_SEMANTICS } from './iconOverrides.js';
import { SKIN_ANCHORS } from './skinAnchors.js';

export function buildSkinPrompt() {
  const tokens = SKIN_TOKENS_CLIENT.filter((t) => !SKIN_TOKENS_REJECTED_CLIENT.includes(t));
  const icons = Object.values(ICON_SEMANTICS);
  const anchors = SKIN_ANCHORS.map((a) => `${a.id} — ${a.desc}`);
  return [
    '为 cc-gui 生成一套皮肤。两种层级任选:',
    '',
    '## T1 声明层(推荐,安全):一个 zip(.cguiskin),内含 skin.json + 图片资源',
    'skin.json 骨架:',
    '```json',
    JSON.stringify({
      format: 'cgui-skin/1', name: '皮肤名(≤40字)', author: '你', base: 'default',
      shared: { vars: { '--radius-panel': '10px' } },
      light: { vars: { '--color-accent': '#5E81AC' }, background: { image: 'bg-light.jpg', overlayOpacity: 0.45, fit: 'cover' } },
      dark: { vars: { '--color-accent': '#88C0D0' }, background: { image: 'bg-dark.jpg' } },
      home: { icon: 'home.svg', greeting: '下午好，{name}' },
      icons: { send: 'icon-send.svg' },
    }, null, 2),
    '```',
    `- 变量白名单(仅以下 ${tokens.length} 个可写,COLOR/LENGTH/SHADOW/BACKDROP 文法,禁 url()/var()):`,
    tokens.join(', '),
    `- home.greeting ≤60 字符,支持 {name} 占位符(用户未设称呼时该段自动降级)。`,
    `- icons 语义名白名单(值=包内 svg 文件,≤32KB,禁 script/foreignObject/外链):`,
    icons.join(', '),
    '- 背景图 png/jpg/webp/gif,单图 ≤20MB 且任一边 ≤8192px;明暗各配一张,overlay 遮罩自动用主题画布色。',
    '- 明暗规范:light/dark 两块都给(可缺一,缺的回落 shared);同一变量在两块分别给适配值。',
    '',
    '## T2 代码层(开发者,本机启用总开关后生效):skin.css + client.js + a11y.css 三件套',
    '- 样式选择器一律用稳定语义锚点 [data-cgui="…"],禁止挂 Tailwind 类名(重构即碎)。',
    `- 锚点清单(${anchors.length} 个):`,
    ...anchors.map((a) => `  · ${a}`),
    '- client.js 为经典脚本(Blob-URL 注入);禁 fetch/XMLHttpRequest/WebSocket/import()/eval/new Function/sendBeacon(静态校验,命中拒载);',
    '  必须注册卸载器:window.__cguiSkinDispose = () => { /* 还原你的全部改动 */ };',
    '- a11y.css 放高对比/焦点可见性补丁。',
    '',
    '### 应用尺寸变量 --app-h / --app-w(必读)',
    '- --app-h / --app-w 是根容器的官方尺寸变量:App 以 innerHeight/zoom(及 innerWidth/zoom)实时计算的 zoom 不变量 px,大字体档(html style zoom)下仍然正确。',
    '- 皮肤若要改应用占位(悬浮窗口类效果),必须在 client.js 按同一口径计算并写到 body 作用域的自定义变量,且跟踪 window resize 与 html style(zoom)变化,卸载器中清理监听与变量。',
    '- 禁止在 CSS 用静态 calc(100dvh - Npx) 自算应用高度:大字体 zoom 档下 dvh 与布局像素不同倍率,必漂。',
    '- 禁止 --app-h: calc(var(--app-h) - N) 这类自引用覆盖:CSS 自定义属性循环引用会整体失效。',
    '',
    '输出:T1 给出 skin.json 全文与资源清单;T2 给出三件套全文。',
  ].join('\n');
}
