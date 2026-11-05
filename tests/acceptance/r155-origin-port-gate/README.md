# r155-origin-port-gate 验收用例(后端对浏览器 Origin 的"站点=主机名+端口"校验)

依据:`.devflow/r155-origin-port-gate-接口.md`(22 条行为 O1-O22,O15 预留不写;O19、O20 各按 chromium / webkit 拆成两个用例,共 23 个用例)。
只通过公开面验证:HTTP 状态码/响应头/正文、WebSocket 握手结果、浏览器页面脚本看到的结果、服务日志行。不 import 产品内部模块,不 mock 内部层。

## 怎么跑(一条命令,在工作树根目录)

    npx playwright test -c tests/acceptance/r155-origin-port-gate/playwright.config.mjs

只跑一部分:`-g 'O5|O6'`(`-g` 匹配的是"文件名 › 用例标题",不要用 `^` 锚点)。机器可读结果在 `.artifacts/results.json`。
不需要任何环境变量。整套约 1~2 分钟(每个用例自己起一个隔离后端,单个约 1 秒)。

## 守卫与隔离(套件自带,不靠调用者自觉)

- 每个用例自己起一个后端 `node server/index.js`,假家目录在本目录 `.artifacts/<标签>-<随机>/home`;`HOME`、`USERPROFILE`、`CU_TEST_HOME` 都指向它。
  `NODE_OPTIONS` 带两个预加载:`r128-checkpoint-perf/helpers/no-outbound.mjs`(禁外连)与 `tests/unit/q8-helpers/cu-preload.mjs`(把电脑操控的家目录指到假目录,
  否则后端启动清理授权文件会改到真实 `~/.claude-gui/cu-runtime/grants.json`)。子进程环境里删掉 `ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN`、所有 `*_proxy`、`CU_ALLOW_*`、`CGUI_TAURI`、`HOST`、`TUNNEL_HOSTNAME`、`PORT`(再按用例显式设置)。
- 端口只用 6700-6999 里空闲的,硬拒 6677 / 6689 / 6710;起服务后用 `lsof` 核对监听者就是刚起的 pid;杀进程只按自己记录的 pid(先 SIGTERM 再 SIGKILL),杀完核对端口已释放。
  进程退出钩子与 `global-teardown`(按 pid+启动时间双重核对)兜底;收尾若发现本套件记录过的 pid 仍在监听,套件失败。
- 6700-6999 可能被其他会话并行的测试占用:选端口时已避开当前监听的端口,但"选定到真正监听"之间有极小的撞车窗口;
  撞车表现为 `ENVIRONMENT_BLOCKED: 实例没起来或端口被别人占了`,重跑即可。收尾只对本套件记录过的 pid 判残留,别的会话的监听只作提示、绝不会被杀。
- 真实授权文件守卫:`global-setup` 对 `~/.claude-gui/cu-runtime/grants.json` 只记 `stat`(mtime+size,不读内容),`global-teardown` 对比,变了就抛错并写出前后值。
- 登录限速:每个实例里"错误密码"登录最多 3 次(实际 O5 每实例 2 次、O20 每实例 2 次);证明"处理器执行了"优先用正确密码。
- WS 帧内容不打印、不落盘,只计数。浏览器用例不用 Playwright 的 route 拦截发往受害实例的请求。
- 局域网用例(O16、O21)会让隔离实例(O21 还有一个静态页服务)短暂绑 `0.0.0.0`(已知随机密码,用户已同意);用例结束、`finally`、进程退出钩子里都会杀掉并核对端口释放。
  本机没有 `en*` 网卡的非内部 IPv4 时,这两条标记为跳过并写明原因(不会默默通过)。
- 依赖都已在仓库里,套件不装任何东西:`node_modules/@playwright/test`(含 chromium、webkit)、`node_modules/ws`、`client/node_modules/vite`。

## 目录

- `o01-o08-origin-rules.spec.mjs` O1-O8 · `o09-o11-edge.spec.mjs` O9-O11 · `o12-o14-tunnel-and-log.spec.mjs` O12-O14
- `o16-lan-runtime.spec.mjs` O16 · `o17-o21-browser.spec.mjs` O17-O21 · `o22-vite-config-guard.spec.mjs` O22
- `helpers/world.mjs`(实例、端口、日志增量)· `helpers/net.mjs`(HTTP/WS/原始 socket 客户端与断言助手)· `helpers/browser.mjs`(攻击页静态服务、Vite 夹具、页内脚本)
- `vite-root/index.html`(Vite 夹具的测试页)· `.artifacts/` 是运行产物(日志、假家目录),不提交。

## 人话版测试清单

| 编号 | 验什么 | 预期 |
|---|---|---|
| O1 | 不带 Origin(命令行/curl/MCP 那种)的读请求和 WS | 照旧放行,且响应不带跨域放行头 |
| O2 | Host 与 Origin 是同一个站点(127.0.0.1、localhost、[::1] 三种写法,带/不带浏览器的同源自报) | 读 200 且回显 Origin、带 Vary: Origin;预检 204;WS 放行 |
| O3 | 开发代理形态(Host 被 Vite 改写成 localhost:P,Origin 是 127.0.0.1:V,浏览器自报同源) | 读、写(正确密码登录)、WS 都放行 |
| O4 | 上一条的五种变体:多一个 CF 头 / 自报写成大写 / 不带自报 / 自报 none / Origin 是陌生站点 | 读 403、WS 401 |
| O5 | 本机另一个端口上的网页当来源(四种 Host/Origin/自报组合) | 读 403;预检 403 且没有任何跨域放行头;错误密码登录是 403 而不是 401(证明登录处理器没执行);WS 401 |
| O6 | 浏览器自报跨站(cross-site / same-site / 大小写混写 / 多值),即使 Host 与 Origin 文本相同 | 读 403、WS 401;对照自报 same-origin、none 则放行 |
| O7 | 跨协议同默认端口(Host=localhost,Origin=https://localhost,自报 cross-site) | 读 403、WS 401 |
| O8 | 非法 Origin 写法:null、chrome-extension://、ftp://、尾斜杠、大写主机名 | 读 403、WS 401 |
| O9 | 请求里没有 Host 头(原始 socket):HTTP/1.0 带 Origin / 不带 / HTTP/1.1 缺 Host / WS 升级带 Origin / 不带 | 403 且正文固定 / 200 / 400 / 401 / 101 |
| O10 | DNS 重绑定防护(Host=evil.com)不变 | 403 Host 文案(含 GET /)、WS 401;日志只有 Host 门的行,没有来源校验的行 |
| O11 | 陌生 Origin 访问非 /api 路径(/、/assets/x.js) | 403、JSON、固定文案,正文没有堆栈/绝对路径/node_modules;同站放行的读响应带 Vary: Origin |
| O12 | 隧道来源(t.example.com,CF 头,https Origin) | 登录 200 且 cookie 带 Secure;无 cookie 鉴权探针 401、有 cookie 200;WS 有 cookie 放行/无 cookie 401;显式 :443 放行;Origin 换成 :8443 读 403 |
| O13 | 隧道 Host 被前置代理改写成 localhost 的旧形态(带/不带 CF 头) | 读 403、WS 401 |
| O14 | 拒绝日志格式:HTTP 与 WS 两种整行格式、rule 取值与判定先后、Origin 里夹带 `rule=same-site` 的注入、300 个字符的超长 Origin | 整行匹配;rule 分别是 sfs-veto / site-mismatch / bad-origin / no-host;注入的 rule 被关在引号里;origin 字面量里连续原始字符 ≤ 200 |
| O16 | 运行时打开局域网:回环时 Host=局域网 IP 被 Host 门拒;POST /api/network + /api/restart 后可达;打开后同站放行、cookie 不带 Secure、WS 有/无 cookie 放行/401;同 IP 另一端口当来源被拒 | 见 §4 |
| O17 | 真浏览器(chromium):他端口的攻击页连后端 WS、跨源 fetch、带自定义头的 POST(预检) | WS 从不 open 也收不到帧;fetch 与预检读不到;日志有 `[ws]`/`[cors] blocked origin="<页面来源>"`;假家目录没有写入 TextEdit 授权 |
| O18 | 同 O17,引擎换成 webkit | 同上 |
| O19 | 浏览器直接打开后端的 /api/health(127.0.0.1 与 localhost),在该文档里用同源 WS 与登录(chromium、webkit 各一个用例) | WS open 且至少一帧;登录 200 `{"ok":true}` |
| O20 | Vite 开发代理夹具(与 client/vite.config.js 同形)页面里:WS、正确密码登录、错误密码登录(chromium、webkit 各一个用例) | WS open 且至少一帧;200;错误密码 401 `密码错误`(证明经代理的 POST 进了处理器) |
| O21 | 真实局域网 IP(chromium):本站登录后 WS 放行;同 IP 另一端口的页面带着登录 cookie 连 WS | 本站放行;他端口页面 WS 从不 open、无帧,日志有 `[ws] blocked origin="http://<局域网IP>:Q"` |
| O22 | 护栏:`client/vite.config.js` 的 `/api` 是字符串目标,`/ws` 是对象且 `ws:true`、`changeOrigin` 不为 true | 失败信息说明:改配置前要重新评估后端来源校验 |

## 没覆盖的

- Firefox、Windows 真机;真实 Tauri 壳(WKWebView)里的页面(用 Playwright 的 webkit 近似)。
- 真实 Cloudflare 隧道(用伪造的 CF 头模拟);IPv6 局域网地址;多网卡/VPN 下的局域网 IP 选择。
- "跨协议 + 默认端口 + 不带自报"的放行现状(已知局限,接口文件明确不给弱点上锁);无 Origin 的跨站 GET(另立项);非浏览器伪造 `Sec-Fetch-Site: same-origin` 被放行(设计如此)。
- 后端内部异常时的处理(黑盒触发不了);限速(429)本身的行为。
- O14 里 `host=`、`path=` 字段的具体取值只验"符合格式",不验内容(接口文件没规定);`rawHost`/`sfs` 只验缺省时为字面量 `null`。
- O14 中"无 Host 且带 cross-site → sfs-veto"一条,是按接口文件写的判定先后(bad-origin → sfs-veto → no-host → site-mismatch)推出来的,文件里没有直接举例。
