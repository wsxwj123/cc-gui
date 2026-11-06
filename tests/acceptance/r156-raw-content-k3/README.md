# r156-raw-content-k3 验收用例

依据:`.devflow/r156-raw-content-k3-接口.md`(A1-A6、B、C、D1-D7、E1、F1,共 23 个用例;B / C / D7 按引擎拆开)。
只通过公开面验证:HTTP 状态码/响应头/正文、浏览器页面脚本看到的结果、服务日志行、配置文件内容。不 import 产品内部模块,不 mock 内部层,不读实现代码。

## 怎么跑(一条命令,在工作树根目录)

    npx playwright test -c tests/acceptance/r156-raw-content-k3/playwright.config.mjs

只跑一部分:`-g 'A1|A5'`、`-g 'D7-webkit'`(`-g` 匹配的是"文件名 › 用例标题",不要用 `^` 锚点)。机器可读结果在 `.artifacts/results.json`。
不需要任何环境变量。每个用例自己起一个隔离后端(约 1~3 秒),浏览器用例更久,整套几分钟。

## 守卫与隔离(套件自带,不靠调用者自觉)

- 每个用例自己起一个后端 `node server/index.js`,假家目录在本目录 `.artifacts/<标签>-<随机>/home`;`HOME`、`USERPROFILE`、`CU_TEST_HOME` 都指向它。
  `NODE_OPTIONS` 带两个预加载:`r128-checkpoint-perf/helpers/no-outbound.mjs`(禁外连)与 `tests/unit/q8-helpers/cu-preload.mjs`(把电脑操控的家目录指到假目录)。
  子进程环境里删掉 `ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN`、所有 `*_proxy`、`CU_ALLOW_*`、`CGUI_TAURI`、`HOST`、`TUNNEL_HOSTNAME`、`PORT`(再显式设置)。
- 端口只用 6700-6999 里空闲的,硬拒 6677 / 6689 / 6710;起服务后用 `lsof` 核对监听者就是刚起的 pid;杀进程只按自己记录的 pid(先 SIGTERM 再 SIGKILL),杀完核对端口已释放。
  进程退出钩子与 `global-teardown`(按 pid+启动时间双重核对)兜底;收尾若发现本套件记录过的 pid 仍在监听,套件失败。
  撞车(别的会话刚好占了选定的端口)表现为 `ENVIRONMENT_BLOCKED: 实例没起来或端口被别人占了`,重跑即可。
- 真实授权文件守卫:`global-setup` 对 `~/.claude-gui/cu-runtime/grants.json` 只记 `stat`(mtime+size,不读内容),`global-teardown` 对比,变了就抛错。
- WS 帧内容不打印、不落盘。浏览器用例不用 Playwright 的 route 拦截发往被测后端的请求。
- Chromium 一律用完整版新无头 `channel: 'chromium'`(默认的 headless-shell 与 Playwright 的 WebKit 没有 PDF 查看器)。
- MP4(H.264)与 WebM(VP8)夹具是 `helpers/media-fixtures.mjs` 里的 base64 常量(ffmpeg 一次性生成),运行时不依赖 ffmpeg;WAV、PDF 由 Node 现场生成。
- 依赖都已在仓库里,套件不装任何东西:`node_modules/@playwright/test`(含 chromium、webkit)、`node_modules/ws`、`client/node_modules/vite`。

## 目录

- `a-raw-headers.spec.mjs` A1-A6 · `b-svg-script.spec.mjs` B · `c-preview.spec.mjs` C(含 PDF、Vite 形态)
- `d1-d4-k3-rules.spec.mjs` D1-D4 · `d5-d6-compat-and-log.spec.mjs` D5-D6 · `d7-browser.spec.mjs` D7 · `e1-ws-internal-error.spec.mjs` E1 · `f1-config-guard.spec.mjs` F1
- `helpers/world.mjs`(实例、端口、日志增量)· `helpers/net.mjs`(HTTP/原始 socket/WS 握手探针与断言助手)· `helpers/browser.mjs`(引擎、他端口页、Vite 夹具、页内脚本)· `helpers/fixtures.mjs`、`helpers/media-fixtures.mjs`(夹具)
- `vite-root/index.html`(Vite 夹具的静态页)· `.artifacts/` 是运行产物(日志、假家目录),不提交。

## 人话版测试清单

| 编号 | 验什么 | 预期 |
|---|---|---|
| A1 | 读文件接口 raw=1 读一个带脚本的 SVG(再对同一地址发 HEAD、带 Range 的 GET) | 200;类型仍是 image/svg+xml;带 `X-Content-Type-Options: nosniff`;带 CSP 且其中有一项恰为 `sandbox`、不含 `allow-`;不带 Content-Disposition;长度对、字节原样、Cache-Control 为 no-cache;HEAD / Range 的这两个头与 GET 一致(都是 200,没有 206,HEAD 没正文) |
| A2 | 其他图片类型(png/jpg/jpeg/gif/webp/bmp/ico,外加大写扩展名 B.PNG) | 200;类型按扩展名不变;都带 nosniff 与 sandbox;字节原样、长度对 |
| A3 | 音视频类型(mp4/webm/mov/m4v/ogg/mp3/wav/m4a) | 同 A2 |
| A4 | 未映射类型(含 `<script>` 的 html、xml、txt、无扩展名 Makefile、ogv、flac) | 200;类型是 application/octet-stream;带 nosniff 与 sandbox;字节原样 |
| A5 | PDF(a.pdf、大写 B.PDF;HEAD 与 Range 同) | 200;类型 application/pdf;带 nosniff;**没有** Content-Security-Policy 也没有 Report-Only 头;字节原样 |
| A6 | 不变项:文件不存在 / 是目录 / 相对路径 / 缺 path / 家目录外 /etc/hosts / 受保护的 network.json;不带 raw 读 SVG;读 0 字节文件 | 404 FILE_READ_NOT_FOUND / 400 FILE_READ_INVALID_PATH(三种)/ 403 FILE_READ_FORBIDDEN(两种);不带 raw 回 JSON(content 等于 SVG 文本,binary、truncated 都是 false);0 字节文件 200、长度 0、正文空 |
| B-chromium / B-webkit | 真浏览器里打开带脚本的 SVG 的四种方式:地址栏直开、他端口网页里跳转、跨站别名(localhost)网页里跳转、同源页面里的 iframe | 四种方式下脚本都没运行(`__state` 不是 ran,跳转的两种里 `__frames` 也没建起来);直开时仍按 SVG 图片文档显示、`location.origin` 是后端;iframe 里读不到或读到的不是 ran |
| C-chromium / C-webkit | 应用自己的同源预览:img 加载无脚本 SVG 与 PNG;fetch PNG 转 blob 再进 img;audio 播 WAV;video 播 MP4 与 WebM | 都成功(naturalWidth 大于 0;loadedmetadata 触发且 duration 大于 0);服务日志里没有任何 `[cors] blocked` 行 |
| C-pdf-chromium | 完整版 Chromium 里同源页面建不带 sandbox 的 PDF iframe | iframe load 触发,且出现 chrome-extension:// 开头的 PDF 查看器框架;日志无拒绝行 |
| C-vite-chromium / C-vite-webkit | Vite 开发代理形态(页面来自 Vite,请求经代理到后端):img(PNG、无脚本 SVG)、fetch PNG、audio WAV(Chromium 另加 PDF iframe) | 都成功;日志无拒绝行 |
| D1 | 无 Origin、自报 same-site / cross-site 访问五个不同挂载点(health、auth-status、network、skins、读文件) | 全部 403;JSON;正文恰为 `{"error":"Cross-origin request blocked by cc-gui"}`;读文件的应答里没有 SVG 内容;无任何 Access-Control-Allow-* 头(network 的正文不打印) |
| D2 | 自报取值的变体:Cross-Site、SAME-SITE、`same-origin, cross-site`、`none, same-site`、`cross-site `(尾随空格)、两行同名头(same-origin / same-site) | 全部 403 固定正文 |
| D3 | 放行:自报 none、same-origin、不带该头、未知取值 bogus,访问 health 与读文件 | 全部 200;读文件正文等于 SVG 字节;日志里没有拒绝行 |
| D4 | 自报 cross-site、无 Origin,不同的路径写法 | `/API/health`、`/Api/Health`、`/api/health/` 照样 403 固定正文;`/apix/health`、`//api/health`、`/api//health`、`/api%2Fhealth`、`/%61pi/health`、`/`、`/assets/x.js`、`/icons/a.png` 不是来源拒绝:不是 403、正文没有来源拒绝文案,且与"不带自报头"的对照请求状态码、类型都相同(没有前端构建时对照是 404;见下面"与接口文件的差异") |
| D5 | 带 Origin 的既有规则抽样:(a) 同站 Origin 无自报;(b) 同站 Origin + cross-site;(c) 另一个端口的 Origin | (a) 200 且回显 Access-Control-Allow-Origin;(b) 403 固定正文,日志 rule=sfs-veto;(c) 403 固定正文,日志 rule=site-mismatch;三次都不是 no-origin-sfs-veto |
| D6 | K3 拒绝的日志整行 | 恰一行匹配 `[cors] blocked origin=null host="127.0.0.1" path="…probe=d6…" sfs="cross-site" rule=no-origin-sfs-veto rawHost="127.0.0.1:端口"`;再发 `Same-Site` 时 sfs 原样记成 `"Same-Site"` |
| D7-chromium / D7-webkit | 真浏览器里,他端口网页(127.0.0.1:Q)与跨站别名网页(localhost:Q)各发 img、fetch(no-cors)、iframe、audio 四种请求去读后端的图片;同源页面发 img 与 fetch 作对照 | 8 个请求每个在日志里至少有一行 `origin=null … rule=no-origin-sfs-veto`(sfs 分别是 same-site 与 cross-site);img 的 onerror 触发;同源对照成功且日志里没有 no-origin-sfs-veto |
| E1 | 把 network.json 改成带隧道主机名、没有 tokenSecret 键、只读(0444),再以隧道主机名带 cookie 发 WS 握手 | 3 秒内收到 401(不挂起);之后 health 仍 200、后端还是原 pid 且在监听;日志有 `[ws] blocked … rule=internal-error`,没有 `[uncaughtException]` |
| F1 | 配置护栏:`client/vite.config.js` 的 server.host / preview.host 与所有调用 vite 的脚本 | host 未设置或仅本机地址;脚本里没有 `--host`;判定函数对 `host:true`、`0.0.0.0`、`::`、`192.168.1.5`、`preview.host:true`、`vite --host` 等合成配置必须判失败,失败信息说明原因(开发代理形态下外部请求会被后端当成本机) |

## 修复前基线(2026-11-06,当前代码;整套约 1.7 分钟,连跑两遍结果一致)

- 红(14 个,全是断言失败,与接口文件的标注一致):A1 A2 A3 A4 A5、B-chromium B-webkit、D1 D2 D4 D6、D7-chromium D7-webkit、E1。
- 绿(9 个):A6、C-chromium C-webkit C-pdf-chromium C-vite-chromium C-vite-webkit、D3 D5、F1。
- 红的原因:raw=1 应答缺 nosniff 与 CSP sandbox(A 组,B 组里脚本因此会运行);无 Origin 的自报跨站请求仍被放行成 200、没有 no-origin-sfs-veto 日志(D1 D2 D4 D6 D7);
  WS 握手挂满 3 秒、日志出现 `[uncaughtException] Error: EACCES … network.json`(E1)。A5 只红在缺 nosniff,"没有 CSP"那半条本来就成立。
- 修复后整套应全绿(这一点尚未验证,修复前只验证了上面的 14 红 9 绿)。

## 与接口文件的差异(写明,不悄悄改)

- D4:接口文件第 0 条第 6 项说"隔离实例没有前端构建产物,非 /api 路径都是 404",所以 D4 原文要求那 8 个路径返回 404。
  本工作树里 `client/dist` 是一个软链,后端会托管前端,这 8 个路径实际回前端页(200,text/html),修复前后都一样。
  所以 D4 的断言改成:不是 403、正文没有来源拒绝文案、与"不带 Sec-Fetch-Site 的对照请求"状态码和类型相同。
  在没有 `client/dist` 的环境里对照就是 404,这条同样强制 404;实际观测值写在 Playwright 报告的用例注解里。
  这 8 个路径不是来源拒绝这一要点(K3 的作用范围与路由对 /api 的认定一致)没有放松。

## 没覆盖的

- Firefox、Windows 真机;真实 Tauri 壳(WKWebView)里的页面(用 Playwright 的 WebKit 近似);Chrome 正式版(只测 Playwright 的完整版 Chromium)。
- 真实 Cloudflare 隧道;E1 的内部异常只用"只读 network.json + 缺 tokenSecret"这一种黑盒触发方式,别的内部异常来源测不到。
- 读文件接口的 Range 支持(接口文件说明现状不支持,只验证 HEAD / Range 请求的头与 GET 一致,不验证 206)。
- F1 只检查 `client/vite.config.js`、`client/package.json`、根 `package.json` 的 scripts;不检查其他启动脚本、环境变量(例如 `VITE_*` 或 CLI 之外的 host 设置)。
- 其余 4xx/5xx 的响应头(错误应答是否也带 nosniff 接口文件没要求,不测)。
