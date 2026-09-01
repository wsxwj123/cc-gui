// r14-1:其他电脑(Mac/Win)检测不到 GUI 更新的根因与修复。
// 根因二连:①版本检测用裸 fetch,而 Node 的 fetch(undici)不读系统代理 —— 墙内机器
// 直连 api.github.com 失败即恒"检测不到";本机因 Clash TUN 劫持全部流量恰好能通,
// 长期掩盖。②失败时若有旧缓存就静默复用,且前端渲染读的字段(state.error)与写入的
// 字段(message)不一致 → 失败原因从来没显示过。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// t1 GitHub 请求必须走带代理回落的 gfetch(直连失败/403 限流自动经本机代理重试)
{
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ gfetch \} from '\.\.\/utils\/github-fetch\.js'/, 't1: 引入共用代理回落层');
  // r22:原哨兵只认 `await fetch('https://api.github.com` 这一种写法 —— 换双引号、
  // 去掉 await、或先把 URL 赋给变量再 fetch,全都绕得过。改成对【URL 字面量本身】判:
  // 每一处 api.github.com 字面量都必须紧跟在 gfetch( 之后。
  for (const m of src.matchAll(/['"`]https:\/\/api\.github\.com/g)) {
    const before = src.slice(Math.max(0, m.index - 10), m.index);
    assert.ok(/gfetch\($/.test(before),
      `t1: GitHub URL 必须经 gfetch 发起(裸 fetch 不读系统代理,墙内必失败)。命中处上文:${JSON.stringify(before)}`);
  }
  assert.match(src, /await gfetch\('https:\/\/api\.github\.com\/repos\/[^']+\/releases\/latest'/, 't1: releases/latest 走 gfetch');
  assert.match(src, /await gfetch\('https:\/\/api\.github\.com\/repos\/[^']+\/tags/, 't1: tags 兜底同样走 gfetch');
}

// t2 共用层保留原有语义:直连优先、网络失败回落代理、403 换代理重试
{
  const gh = readFileSync(new URL('../../server/utils/github-fetch.js', import.meta.url), 'utf8');
  assert.match(gh, /export async function gfetch/, 't2: 导出 gfetch');
  // 限流修复:注入 GitHub 令牌后直连写法变为 fetch(url, { ...opts, headers })——锁"先直连 fetch"这一语义,
  // 不锁参数字面(headers 里带不带令牌都必须直连优先)。
  assert.match(gh, /try \{ r = await fetch\(url, [^)]*\); \}/, 't2: 直连优先');
  assert.match(gh, /r\.status === 403/, 't2: 限流换代理链路');
  // 限流修复:带令牌收到 401 = 令牌失效,必须作废缓存退回匿名重试(最坏=改动前的匿名行为),
  // 否则一个失效 PAT 会让技能市场/版本检测全部变成 401,比不配令牌还糟。
  assert.match(gh, /invalidateGithubToken\(\)/, 't2: 令牌 401 作废缓存');
  assert.match(gh, /r\.status === 401 && usedToken/, 't2: 401 兜底只对注入令牌的请求生效');
  assert.match(gh, /CONNECT/, 't2: CONNECT 隧道(不设全局代理,不碰子进程环境)');
  // skills.js 不再各自持有一份实现
  const sk = readFileSync(new URL('../../server/routes/skills.js', import.meta.url), 'utf8');
  assert.ok(!/function proxyGet\(/.test(sk), 't2: skills 不再自带副本(单一实现)');
  assert.match(sk, /import \{ gfetch \} from '\.\.\/utils\/github-fetch\.js'/, 't2: skills 改用共用层');
}

// t3 失败原因必须可见(前端渲染字段与写入字段一致 + 旧缓存明示)
{
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  assert.match(src, /无法连接 GitHub/, 't3: 网络失败给人话原因');
  assert.match(src, /GitHub 接口限流/, 't3: 403 给人话原因');
  assert.match(src, /staleError/, 't3: 用旧缓存时带标记');
  // r22:原来这三条是对【整个 SettingsPanel.jsx】做正则 —— 字符串在文件里就算过,
  // 不管它落在哪个组件。必修④正是这么溜过去的:staleError 那段被接在 CcUpdater
  // (数据源 /api/claude-version-check 永远不含该字段)= 恒为假的死渲染,而测试全绿。
  // 改成先切到组件片段再断言。
  const ui = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
  const cut = (from, to) => {
    const a = ui.indexOf(from); const b = ui.indexOf(to);
    assert.ok(a > 0 && b > a, `t3: 组件定位锚失效(${from} → ${to})`);
    return ui.slice(a, b);
  };
  // GUI 版本检查(数据源 /api/version-check):失败原因 + staleError 都归它
  const uc = cut('function UpdateChecker()', 'function CcUpdater()');
  assert.match(uc, /检查失败:\{state\.message\}/, 't3: UpdateChecker 渲染读 message(check() 写的就是 message)');
  assert.match(uc, /state\.status === 'ok' && state\.staleError/, 't3: staleError 必须接在 UpdateChecker(它的唯一数据源)');
  assert.match(uc, /结果可能过期/, 't3: 旧缓存明示');
  // CLI 更新器(数据源 /api/claude-version-check)
  const cc = cut('function CcUpdater()', 'function CloseBehaviorPicker()');
  assert.match(cc, /检查更新失败:\{state\.error/, 't3: CcUpdater 的失败原因读它自己真正写入的字段(error)');
  // r23-④:r22 把这段从 CcUpdater 删掉时,连"明示旧缓存"这个功能一起删了 —— 而 CLI
  // 那条链路的 catch 同样会静默改用 5 分钟旧缓存,于是双源全断时照显「✓ 已是最新版本」。
  // 正确做法是让它自己的数据源也产出 staleError(见下面服务端断言),渲染补回来。
  assert.match(cc, /state\.status === 'ok' && state\.staleError/,
    't3: CcUpdater 也要渲染 staleError —— 它的数据源现在会产出(静默用旧缓存必须明示)');
  assert.match(cc, /结果可能过期/, 't3: CLI 侧旧缓存明示');
  // 服务端:两条链路的旧缓存分支都必须带 staleError(只在 GUI 那条带 = 只修了一半)
  const cli = src.slice(
    src.indexOf("router.get('/claude-version-check'"),
    src.indexOf("router.post('/claude-update'"),
  );
  assert.ok(cli.length > 200, 't3: /claude-version-check 路由定位锚失效');
  assert.match(cli, /if \(ccCache && ccCacheSrc === srcKey\) \{[\s\S]{0,400}?staleError =/,
    't3: **走旧缓存的那一支**必须写 staleError(原来是静默复用 → 前端显示"已是最新版本")');
  assert.match(cli, /\.\.\.\(staleError \? \{ staleError \} : \{\}\)/,
    't3: 且必须真的进响应体(写了变量不发出去等于没写)');
  assert.match(cli, /分钟前的结果/, 't3: 文案说清"这次没查成、看到的是几分钟前的结果"');
}

console.log('check-update-detect: all passed (r14-1)');

// t5(r22-③):打开更新面板不得启动安装;并发两个请求不得 spawn 两个 npm i -g。
{
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  const stream = src.slice(
    src.indexOf("router.post('/claude-update/stream'"),
    src.indexOf("router.post('/claude-update/attach'"),
  );
  assert.ok(stream.length > 200, 't5: /claude-update/stream 与 /attach 两个路由都要在(后者是只续看的入口)');
  // 占位必须在两个耗时 await 之前:detectInstall 走登录 shell、detectLocalProxy 探 6 个端口,
  // 判定放在它们之后 = 同时到达的两个请求都能通过 running 检查 → 两个 npm i -g 写同一目录。
  const claim = stream.indexOf("updateTask.status = 'running';");
  const detect = stream.indexOf('await detectInstall()');
  const proxy = stream.indexOf('await detectLocalProxy()');
  assert.ok(claim > 0 && detect > 0 && proxy > 0, 't5: 定位锚失效');
  assert.ok(claim < detect && claim < proxy,
    't5: updateTask.status=\'running\' 必须写在 detectInstall/detectLocalProxy 两个 await 之前(先占位再解析)');
  // 占位后解析失败必须还原状态,否则任务卡成"永远 running",用户再也更新不了
  assert.match(stream, /catch \(e\) \{[\s\S]{0,200}updateTask\.status = 'error'/,
    't5: 解析失败要把占位状态还原成 error,不许卡在 running');
  // 只续看的入口:绝不 spawn
  const attach = src.slice(
    src.indexOf("router.post('/claude-update/attach'"),
    src.indexOf("router.get('/claude-update/status'"),
  );
  assert.ok(!/spawn\(/.test(attach), 't5: /attach 绝不 spawn(它就是为"打开面板别装东西"存在的)');
  // (r26-C9) 换锚:没在跑时不再一律空流 —— done/error 态补一帧终态再收尾(前端
  // doUpdateStream 既有 done 分支消化),idle 仍空流。锚钉「终态帧 + res.end() 收尾」两要素。
  assert.match(attach, /if \(updateTask\.status !== 'running'\) \{[\s\S]{0,400}type: 'done', code: updateTask\.code[\s\S]{0,400}res\.end\(\);\s*return;/,
    't5: /attach 没在跑时对 done/error 补终态帧再收尾(r26-C9),idle 空流');
  // 前端:挂载对账那条路径必须走 /attach,且参数真的被读了(原来 {attach:true} 被完全忽略)
  const ui = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
  // (r26-C9) 换锚:签名新增 allowCrossChannel 回执参数(r26-C1 跨渠道确认),attach 参数语义不变。
  assert.match(ui, /const doUpdateStream = async \(\{ attach = false, allowCrossChannel = false \} = \{\}\) =>/,
    't5: doUpdateStream 必须真的接收 attach 参数(此前签名是 async () => {},传了等于没传)');
  assert.match(ui, /fetch\(attach \? '\/api\/claude-update\/attach' : '\/api\/claude-update\/stream'/,
    't5: attach=true 走只续看的端点,false 才走会启动安装的那个');
  assert.match(ui, /if \(d\.running\) \{ setUpdating\(true\); doUpdateStream\(\{ attach: true \}\); return; \}/,
    't5: 挂载对账续看必须带 attach:true');
}

// t5b(r22-③):真起路由打一次 /attach —— 正则只能证明"写了",证明不了"路由真注册了、
// 且空闲时立刻收流不起进程"。⚠️ 这里【只打 /attach】,绝不碰 /stream(那个会真的跑
// npm install -g)。端口只用 6704。
{
  const express = (await import('express')).default;
  const router = (await import('../../server/routes/version-check.js')).default;
  const app = express();
  app.use('/api', router);
  let server = null;
  for (let i = 0; i < 3 && !server; i++) {
    const s = app.listen(6704, '127.0.0.1');
    const r = await new Promise((done) => {
      s.once('listening', () => done({ ok: true }));
      s.once('error', (e) => done({ err: e }));
    });
    if (r.ok) server = s;
    else if (r.err?.code === 'EADDRINUSE') await new Promise((done) => setTimeout(done, 400));
    else throw r.err;
  }
  assert.ok(server, 't5b: 6704 一直被占(隔壁 worktree 的 E2E?)');
  try {
    const t0 = Date.now();
    const r = await fetch('http://127.0.0.1:6704/api/claude-update/attach', { method: 'POST' });
    const body = await r.text();
    assert.equal(r.status, 200, 't5b: /attach 空闲时也要正常收流');
    assert.equal(body, '', 't5b: 没有任务在跑 → 空流,不许回 start 事件(回了就说明它起了进程)');
    assert.ok(Date.now() - t0 < 5000, 't5b: 空闲时必须立即收流,不许挂着');
    const status = await (await fetch('http://127.0.0.1:6704/api/claude-update/status')).json();
    assert.notEqual(status.status, 'running', 't5b: 打完 /attach 后任务状态仍是空闲 —— 它一个进程都没起');
  } finally {
    server.closeAllConnections?.();
    server.close();
    await new Promise((done) => server.once('close', done));
  }
}

// t4(r14-2):没开代理 / 只开系统代理(非 TUN)的机器也要能检测。
{
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  // 系统代理读取:mac scutil、Windows 注册表(端口探测覆盖不到的场景)
  assert.match(src, /async function readSystemProxy\(\)/, 't4: 读系统代理设置');
  assert.match(src, /scutil/, 't4: macOS 走 scutil --proxy');
  assert.match(src, /HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Internet Settings/, 't4: Windows 读注册表');
  // (r26-C2) 换锚:系统代理读取点改经可注入参数 readSystem(缺省 = readSystemProxy,
  // 语义不变:仍先读系统设置),读取结果须先探活再采用。锚钉「缺省即 readSystemProxy」
  // 与「读取点」两要素。
  assert.match(src, /readSystem = readSystemProxy/, 't4: detectLocalProxy 缺省仍读系统代理设置(r26-C2 换锚)');
  assert.match(src, /const sys = await readSystem\(\)\.catch\(\(\) => null\)/, 't4: detectLocalProxy 先读系统设置(哨兵锚)(r26-C2 换锚)');
  // 免代理兜底源:GitHub 全挂时仍能问出"有没有新版"
  assert.match(src, /async function fetchJsdelivrLatest\(\)/, 't4: 备用版本源');
  assert.match(src, /data\.jsdelivr\.com\/v1\/packages\/gh\//, 't4: jsDelivr 元数据接口(墙内免代理可达)');
  // (r63) 换锚:jsDelivr 单点兜底改为 npmmirror ∥ jsDelivr 并行取大(PLAN §2.2 ③),
  // 语义不变:GitHub 全败后仍由免代理镜像接管,jsDelivr 仍在兜底链里。
  assert.match(src, /Promise\.allSettled\(\[\s*fetchNpmChannelGuiLatest\('https:\/\/registry\.npmmirror\.com'\),\s*fetchJsdelivrLatest\(\),/, 't4: GitHub 全败后接管(r63 两源并行取大)');
  assert.match(src, /无法连接 GitHub 与备用源/, 't4: 两条路都断才报错,文案说清');
}
