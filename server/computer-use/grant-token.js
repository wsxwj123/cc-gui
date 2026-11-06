// 电脑操控授权的「面板凭证」(r154)。
//
// 进程启动时生成一次,**只放内存**:不进日志、环境变量、文件、任何 HTTP 响应。只经 WebSocket
// 在连接建立后对该连接单发给面板;面板发授权类请求时放进请求头 X-CGUI-Grant-Token 回传。
//
// 威胁模型(与 routes/permissions.js 的 r26-H1 nonce 同口径):防**盲打**——不知道凭证的本机脚本、
// 模型照旧文档敲出的 curl、来自其他网站域名或**本机别的端口**的网页(r155 起 WS 握手的来源校验要求
// 来源站点 = 访问地址的站点,主机名与端口都比,这类网页握手即被拒,拿不到凭证)。**不防**:①主动连 WS 的
// 本机进程(不带 Origin 的客户端放行);②直接改 grants.json 的进程(由 forbidden-apps.js 的底线缓解);
// ③本机上把请求原样转给后台的代理(其他项目的开发服务器代理、Jupyter 代理等):经过它的网页与后台同站,
// 仍能连 WS 拿到凭证,而同一条 WS 本就能开内置终端;跨协议 + 默认端口 + 浏览器不带跨站标记的组合同理,
// 只有后台或其前置代理监听 80/443 时才可能出现;④后台读文件接口(/api/files/read?raw=1)同源下发的
// 内容,r156 起的现状:`X-Content-Type-Options: nosniff` 全部类型都带,`Content-Security-Policy: sandbox`
// 除 PDF 外都带,浏览器直接打开其中带脚本的 SVG 也不运行脚本(Chromium、WebKit、macOS WKWebView 实测);
// PDF 为保证预览不带 sandbox(只带 nosniff),扩展名 .pdf 而内容是 HTML/SVG 的文件在 Chromium 新版与 WKWebView 里实测
// 其中脚本不运行;带内置脚本的 PDF(试了自动打开链接、提交表单两种动作)实测没有借此向本机发出请求。
// 另有 K3(services/auth.js 的 checkNoOriginFetchSite):不带 Origin、浏览器自报 Sec-Fetch-Site 为
// same-site/cross-site 的 /api/* 请求(他站/他端口网页的导航、嵌入、图片加载)一律 403;
// 浏览器只对回环地址与 https(隧道域名)发该头,手输地址/书签/别的应用点开的链接报 none 按设计不拦,经局域网
// IP 的明文 HTTP、老浏览器不发该头,K3 不生效,只剩 sandbox 这道内容防线。残余:WebKit 的 PDF 插件加载请求、
// 以及点击带 download 属性的链接时浏览器补发的第二次请求,在 macOS 的 WKWebView 里实测不带 Sec-Fetch-Site
// (只能触发读不到结果的 GET,或把响应存成下载文件,不会作为页面运行);浏览器版里用户亲手对聊天附件 SVG 图选"在新标签页打开"时,脚本以
// 页面来源运行(blob: 地址,响应头管不到);Windows 真机与 Firefox 未测。
// 与 H1 nonce 不同:nonce 绑定单个待决请求、随请求生灭;凭证要在面板整个生命周期可用,按进程常驻。
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

const GRANT_TOKEN = randomBytes(32).toString('hex');
const GRANT_TOKEN_DIGEST = createHash('sha256').update(GRANT_TOKEN).digest();

export function getGrantToken() {
  return GRANT_TOKEN;
}

/** 定长比较:两边各取 SHA-256 再 timingSafeEqual,长度不同也不会提前返回。 */
export function grantTokenMatches(presented) {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const digest = createHash('sha256').update(presented).digest();
  return timingSafeEqual(digest, GRANT_TOKEN_DIGEST);
}
