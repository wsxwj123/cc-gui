// r64-genui 浏览器验收测试的公共夹具。
// 依据只有 .devflow/BRIEF-r64-genui.md 与 .devflow/INTERFACE-r64-genui.md,没看过实现代码。
//
// ────────────────────────────────────────────────────────────────────────────
// 【测试与实现之间的约定】UI 测试没法凭空猜 DOM,所以需要实现方挂一批稳定的
// data-testid。下面这张表是**唯一**的约定面,除此之外测试不假设任何 DOM 结构、
// 类名、层级。名字随便改——改了把这张表一起改就行,测试逻辑不用动。
//
// 另外三件事需要实现方配合(否则浏览器验收根本没法自动化):
//  A. 后端能用 HOME 环境变量把 ~/.claude 指到临时目录(tests/acceptance/r26 已是这个约定)。
//  B. 会话记录用 claude CLI 的 JSONL 形态落在 $HOME/.claude/projects/<编码后的cwd>/<sid>.jsonl,
//     测试据此"喂"一条含围栏的助手消息进去(这是黑盒:不调实现的任何函数,只放文件)。
//  C. 需要真流式的用例(排队、回合结束)靠 PATH 上的**假 claude 可执行文件**驱动,
//     见 fake-claude.mjs。假 CLI 只说 stream-json,不碰任何实现细节。
// 任何一条不成立,harness 会用一句人话报出来,而不是抛一屏栈。
// ────────────────────────────────────────────────────────────────────────────
import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../../..');

/**
 * 可测锚。**逐字照抄 INTERFACE §9**,不是测试方自定的了 —— 契约里同时写了
 * "何时必须存在"和"何时必须不存在",所以反向断言一律用 toHaveCount(0),
 * 不要用 toBeHidden()(隐藏 ≠ 不存在,"默认折叠"就无法证伪)。
 */
export const TID = {
  // §9.1 渲染侧
  block: 'genui-block',
  source: 'genui-source',
  notice: 'genui-notice',
  ignored: 'genui-ignored',
  node: (t) => `genui-node-${t}`,
  series: 'genui-series',               // 仅 chart / plot;echart 是 canvas,§9.4 明确不提供
  failCard: 'genui-render-failed',
  badge: 'genui-badge',
  // §9.2 action 侧
  feedback: 'genui-action-feedback',
  actionMsg: 'genui-action-message',
  actionMsgToggle: 'genui-action-message-toggle',
  actionMsgBody: 'genui-action-message-body',
  passwordHint: 'genui-password-hint',
  // §9.3 设置与宿主既有 UI
  // 打开设置**不用点按钮**:那个按钮也在面板坞里(两步入口),契约改用全局快捷键 Cmd/Ctrl+0。
  // settings-open 这个锚已明确不新增,别再找它。
  settingsSearch: 'settings-search',          // 设置面板顶部搜索框;genui 落在哪个分组没规定,靠搜索才是确定路径
  settingsSection: 'genui-settings-section',  // 不是标签页:genui 挂进既有设置分组
  genuiToggle: 'genui-render-toggle',
  skillState: 'genui-skill-state',
  skillAction: 'genui-skill-action',
  skillScopeNote: 'genui-skill-scope-note',
  queueBar: 'queue-bar',
  queueCount: 'queue-count',
  queueItem: 'queue-item',
  queueItemDelete: 'queue-item-delete',
  pane: 'pane',                         // 每个会话窗格;**判断有没有分屏就数它的个数**(≥2 即分屏)
  paneSplit: 'pane-split',              // 承载全部窗格的容器,**常驻**(单屏也在)——不能用它判断分屏
  panelDockToggle: 'panel-dock-toggle', // 分屏第一步:展开顶栏的面板坞
  paneCount: 'pane-count',              // 分屏第二步:坞内的分屏按钮(坞展开时才在 DOM 里)
  paneCountN: (n) => `pane-count-${n}`, // 分屏弹层里的数量选项 1..6;别靠数字文字定位
  // 会话行的操作菜单(两步入口)。按**功能名**拼接,不要照中文 label——
  // 置顶↔取消置顶、归档↔取消归档 这些文字会随状态翻转,照文字写必红。
  sessionActionsBtn: 'session-actions-btn',   // 恒在 DOM(仅 opacity 隐藏);会话行选中时恒显
  sessionActionsMenu: 'session-actions-menu', // 仅菜单打开时存在
  sessionAction: (a) => `session-actions-${a}`, // a ∈ pin/rename/fork/archive/delete
};

// 消息滚动容器不新增锚,用仓内既有的(§9.0 末行)。每窗格一个。
export const MSG_LIST = '[data-cgui="message-list"]';

/** 文案断言用的固定片段(取自 INTERFACE,逐字)。 */
export const COPY = {
  parseFail: 'cgui-ui 围栏 JSON 解析失败',
  parseFailTail: '围栏保持为代码块',
  oversize: '界面规格过大',
  oversizeTail: '已按代码块显示',
  ignoredSuffix: '个不支持的组件已忽略',
  renderFailed: '该界面渲染失败（已隔离，不影响其他内容）',
  mermaidFallback: '图语法有误，已降级显示源码',
  mermaidLoading: '渲染中…',
  chartFailed: '图表加载失败',
  chartLoading: '加载图表…',
  queued: '已排队',
  sent: '已发送',
  sendFailed: '发送失败',
  truncated: '数据已截断',
  passwordHint: '不会被发送',
};

// ── 起一个隔离实例 ───────────────────────────────────────────────────────
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 尽力而为 */ } };

function encodeProjectDir(cwd) {
  // claude CLI 把工作目录编进 projects 子目录名(路径分隔符换成连字符)。
  return cwd.replace(/[/\\]/g, '-');
}

/** 等端口空出来(上一个 worker 的后端可能还在收尾)。 */
async function waitPortFree(port, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const busy = await fetch(`http://127.0.0.1:${port}/api/health`).then(() => true).catch(() => false);
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`测试端口 6703-6710 全被占着。若有残留的测试后端先清掉再跑;绝不要去动 6677(生产实例,只许 GET)。`);
}

async function waitHealthy(port, proc, timeoutMs = 30_000) {
  const t0 = Date.now();
  let lastErr = '';
  while (Date.now() - t0 < timeoutMs) {
    if (proc.exitCode !== null) throw new Error(`后端进程提前退出(code=${proc.exitCode})，日志:\n${proc.__log.slice(-4000)}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return await r.json().catch(() => ({}));
      lastErr = 'HTTP ' + r.status;
    } catch (e) { lastErr = String(e.message || e); }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`后端 30 秒没起来(${lastErr})。日志:\n${proc.__log.slice(-4000)}`);
}

/**
 * 起一份完全隔离的 CC-GUI:临时 HOME、临时工作目录、PATH 上放假 claude。
 * 绝不碰 6677 生产实例,绝不写真实 ~/.claude。
 */
/** 允许的测试端口。6677 是生产实例,只许 GET,永远不在这个范围里。 */
// 6710 上有一个不属于本轮的常驻服务,排除掉。
export const TEST_PORTS = [6703, 6704, 6705, 6706, 6707, 6708, 6709];

export async function startApp(workerIndex) {
  // playwright 在用例失败后会换 worker,workerIndex 一路涨;所以不按序号取模死绑端口,
  // 而是从 workerIndex 对应的位置开始,挑第一个当前空着的端口。端口比 worker 多,
  // 正常不会撞;真撞上了 waitPortFree 会等,等不到就报一句人话。
  const start = workerIndex % TEST_PORTS.length;
  const order = [...TEST_PORTS.slice(start), ...TEST_PORTS.slice(0, start)];
  let port = null;
  for (const p of order) {
    const busy = await fetch(`http://127.0.0.1:${p}/api/health`).then(() => true).catch(() => false);
    if (!busy) { port = p; break; }
  }
  if (port === null) {
    port = order[0];
    await waitPortFree(port);   // 全占满了才等,正常跑不到这一步
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `cgui-r64-home-${port}-`));
  // realpath 是必须的:macOS 上 /var 是指向 /private/var 的软链,mkdtemp 返回 /var/... ,
  // 而子进程里的 process.cwd() 拿到的是解析后的 /private/var/... —— 两者编码出**不同**的
  // projects 目录名,于是假 CLI 落盘的会话记录应用侧读不到,刷新后侧栏「暂无会话」,
  // 所有带 page.reload() 的用例(B40/B41/B73)全红。在源头解析一次,下游全都对齐。
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cgui-r64-proj-${port}-`)));
  const bin = path.join(home, 'fakebin');
  fs.mkdirSync(path.join(home, '.claude', 'projects', encodeProjectDir(cwd)), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  // ── 把临时 HOME 预置成"不是第一次跑" ──────────────────────────────────
  // 首启会连弹三层整屏遮罩,每一层都是 pointer-events 生效的,会**吃掉用例的第一次点击**
  // (表现为交互像是没生效、断言压根跑不到)。三层各自的状态落点不同,逐个预置:
  //   ① 使用指引  z-400 → localStorage 的 cgui-tour-seen(在 page fixture 里预置)
  //   ② 更新说明  z-220 → 服务端 ~/.claude-gui/prefs.json 的 releaseNotesSeen
  //   ③ 磁盘权限  z-210 → 服务端 ~/.claude-gui/permission-guide-shown.flag(文件存在即已看过)
  // 这三项都与被测行为无关,清掉的是"够不到",不放宽任何断言。
  fs.mkdirSync(path.join(home, '.claude-gui'), { recursive: true });
  const appVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'),
    JSON.stringify({ releaseNotesSeen: appVersion }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), new Date().toISOString());

  // PATH 上的假 claude:一个 shell 薄壳,转交给 fake-claude.mjs
  const shim = path.join(bin, 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);

  const proc = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOME: home,
      USERPROFILE: home,
      PATH: `${bin}:${process.env.PATH}`,
      CGUI_FAKE_CLAUDE_DIR: path.join(home, 'fake-claude'),
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.__log = '';
  proc.stdout.on('data', (b) => { proc.__log += b; });
  proc.stderr.on('data', (b) => { proc.__log += b; });
  fs.mkdirSync(path.join(home, 'fake-claude'), { recursive: true });

  const health = await waitHealthy(port, proc);
  return {
    port, home, cwd, proc, health,
    baseURL: `http://127.0.0.1:${port}`,
    ctlDir: path.join(home, 'fake-claude'),
    projectDir: path.join(home, '.claude', 'projects', encodeProjectDir(cwd)),
    async stop() {
      proc.kill('SIGTERM');
      await new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000); });
      if (proc.exitCode === null) proc.kill('SIGKILL');
      rmrf(home); rmrf(cwd);
    },
  };
}

// ── 往会话记录里"喂"一条含围栏的助手消息(黑盒:只放文件,不调实现)────────
export function fence(body, lang = 'cgui-ui') {
  return '```' + lang + '\n' + (typeof body === 'string' ? body : JSON.stringify(body, null, 2)) + '\n```';
}

/**
 * 造一条会话记录。返回 { sid, marker }。marker 是用户消息里的唯一串,用来在侧栏找到它。
 * 形态按 claude CLI 的 transcript JSONL。若 CC-GUI 读不出来,只需要改这一个函数。
 */
export function seedSession(app, assistantText, opts = {}) {
  const sid = crypto.randomUUID();
  const marker = opts.marker || `R64-${crypto.randomBytes(4).toString('hex')}`;
  const now = () => new Date().toISOString();
  const u = crypto.randomUUID();
  const a = crypto.randomUUID();
  const common = { isSidechain: false, userType: 'external', cwd: app.cwd, sessionId: sid,
    version: '2.1.227', gitBranch: '' };
  const lines = [
    // 同一颗雷:产品把"少于 3 行"的 transcript 当空会话滤掉(session-reader),
    // 真 CLI 的记录首个 user 之前本就有元数据行。只写 user+assistant 两行的话,
    // 这条占位会话进不了侧栏。
    { type: 'summary', summary: marker, leafUuid: u },
    { ...common, parentUuid: null, type: 'user', uuid: u, timestamp: now(),
      message: { role: 'user', content: `${marker} 画个界面` } },
    { ...common, parentUuid: u, type: 'assistant', uuid: a, timestamp: now(),
      requestId: 'req_' + crypto.randomBytes(6).toString('hex'),
      message: { id: 'msg_' + crypto.randomBytes(8).toString('hex'), type: 'message', role: 'assistant',
        model: 'claude-sonnet-4-6', content: [{ type: 'text', text: assistantText }],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ];
  fs.writeFileSync(path.join(app.projectDir, `${sid}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { sid, marker };
}

/**
 * 把界面带到"某个项目里的新会话、光标在输入框"的状态。
 * 这条路径是实测出来的(不是猜的):临时 HOME 里先放一条占位会话记录让项目出现在列表里,
 * 关掉首启的几个浮层,点项目 → 点行尾「+」新建 → 拿到输入框。
 */
export async function bootUI(page, app) {
  seedSession(app, '占位');            // 只为让项目出现在左侧列表
  await page.goto(app.baseURL + '/');
  await dismissOverlays(page);
  // 窄屏下首页本来就带一个输入框(侧栏收进了"会话"按钮),这时不用再走"点项目 → 点 +"。
  let box = composerBox(page);
  if (await box.count()) { await box.last().waitFor({ timeout: 5000 }); await page.waitForTimeout(400); return box.last(); }

  const proj = page.getByText(/cgui-r64-proj/).first();
  await proj.waitFor({ timeout: 15_000 }).catch(() => {
    throw new Error(`左侧没出现临时项目(HOME=${app.home})。多半是后端没认 HOME,或占位会话记录的形态变了。`);
  });
  await clickSafe(page, proj);
  const plus = page.getByRole('button', { name: /^\+$|新建|新会话/ });
  if (await plus.count()) await clickSafe(page, plus.first());
  box = composerBox(page);
  await box.last().waitFor({ timeout: 10_000 }).catch(() => {
    throw new Error('点了「+」也没出现消息输入框,新建会话这一步断了。');
  });
  await page.waitForTimeout(400);       // 首页卡片有入场动画,不等它稳下来 fill 会判 unstable
  return box.last();
}

/** 消息输入框(不是左上角那个搜索框)。 */
export function composerBox(page) {
  return page.getByPlaceholder(/输入消息|开始一个新会话|发消息|问点什么/).or(page.locator('textarea'));
}

/**
 * 点击时先把挡路的浮层清掉再点;被拦住就再清一遍重试。
 * 新手引导是"跟着你走"的,点完一处会在下一处又冒出来,所以不能只在开头清一次。
 */
export async function clickSafe(page, locator, tries = 3) {
  // 先分清两种红:元素压根不存在(实现还没挂锚)vs 存在但被浮层挡住(夹具问题)。
  // 混成一句"点不动"会让人误判成夹具坏了。
  await dismissOverlays(page);
  if ((await locator.count()) === 0) {
    throw new Error(`找不到这个元素:${locator}\n`
      + '功能/锚尚未实现时本条必然红,属预期;已实现却红,说明 data-testid 没挂上或挂错了元素。');
  }
  let last;
  for (let i = 0; i < tries; i++) {
    await dismissOverlays(page);
    try { await locator.click({ timeout: 4000 }); return; } catch (e) { last = e; await page.waitForTimeout(300); }
  }
  throw new Error('元素在、但点不动(多半是浮层挡着):' + String(last && last.message).split('\n')[0]);
}

/**
 * 首启的几个浮层(权限说明、更新提示、新手引导)会挡住一切,先关干净。
 * 轮数刻意压到 4:新手引导是跟着走的,清不干净就该让用例超时报错,
 * 而不是在这里耗光整条用例的时间预算。
 */
export async function dismissOverlays(page) {
  const LABELS = ['已知晓', '以后再说', '我已授权,不再提醒', '跳过', '稍后', '知道了'];
  for (let round = 0; round < 4; round++) {
    let hit = false;
    for (const label of LABELS) {
      const btn = page.getByRole('button', { name: label, exact: true });
      if (await btn.count()) { await btn.first().click({ timeout: 1500 }).catch(() => {}); hit = true; await page.waitForTimeout(150); }
    }
    if (!hit) break;
  }
}

/**
 * 让模型"输出"一段正文,等它出现在消息流里。text 里可以带围栏。
 * opts.hold=true 时回合不结束(会话保持忙),用 ctl.release(app) 收尾。
 */
export async function modelSays(page, app, text, opts = {}) {
  ctl.script(app, text);
  if (opts.hold) ctl.hold(app);
  const box = opts.box || composerBox(page).last();
  const probe = opts.prompt || `Q-${crypto.randomBytes(3).toString('hex')}`;
  await box.fill(probe);                // fill 自带 actionability 等待,不再单独 click(点了反而更容易撞动画)
  await box.press('Enter');
  if (!opts.noWait) {
    await expect(page.getByText(probe, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  }
  return probe;
}

/**
 * 一条龙:开界面 → 让模型输出一个围栏 → 返回渲染出来的 genui 块。
 * 功能没实现时 block 不会出现,用例会红在"块没出现",这是预期。
 */
export async function openFence(page, app, body, opts = {}) {
  const box = await bootUI(page, app);
  const text = [opts.before || '', fence(body, opts.lang), opts.after || ''].filter(Boolean).join('\n\n');
  const prompt = await modelSays(page, app, text, { ...opts, box });
  const block = page.getByTestId(TID.block).first();
  if (!opts.expectNoBlock) {
    await block.waitFor({ timeout: 15_000 }).catch(() => {
      throw new Error(`围栏没有渲染成 genui 块(找不到 [data-testid="${TID.block}"])。\n`
        + '功能尚未实现时本条必然红,属预期;已实现却红,说明围栏没被拦截或 testid 没挂上。');
    });
  }
  return { block, prompt, box };
}

/** 等当前回合真正结束(流式态 → 定稿态)。判据:界面上的"停止"不再出现。 */
export async function waitTurnEnd(page, timeout = 25_000) {
  const stop = page.getByRole('button', { name: /停止|中断/ });
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await stop.count()) === 0) { await page.waitForTimeout(600); if ((await stop.count()) === 0) return; }
    await page.waitForTimeout(200);
  }
  throw new Error('回合没有在 ' + timeout + 'ms 内结束(界面上的"停止"一直在)');
}

/**
 * 该窗格消息流里的条目数。契约没给"每条消息"的锚(§9.0 只复用既有的 message-list),
 * 所以这里数容器的直接子节点 —— 只用来做"有没有变多"的相对比较,不做绝对断言。
 */
export async function messageCount(page, scope) {
  const list = (scope || page).locator(MSG_LIST).first();
  if (!(await list.count())) return 0;
  return list.evaluate((el) => el.children.length);
}

/** 队列条上的计数;§9.3 规定无可见排队条目时整条 queue-bar 不存在,所以缺席就算 0。 */
export async function queueCount(page) {
  const bar = page.getByTestId(TID.queueCount);
  return (await bar.count()) ? Number((await bar.first().innerText()).replace(/\D+/g, '') || 0) : 0;
}


/**
 * 打开设置并定位到 genui 那一段(§9.7):
 *   Cmd/Ctrl+0 直达设置(既有全局快捷键,**不受面板坞折叠影响**)→ settings-search 输入 genui
 *   → genui-settings-section 出现。
 * 不点设置按钮:那个按钮也在面板坞里,是两步入口;settings-open 这个锚契约已明确不新增。
 */
export async function openGenuiSettings(page) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+0' : 'Control+0');
  const search = page.getByTestId(TID.settingsSearch);
  await search.waitFor({ timeout: 10_000 }).catch(() => {
    throw new Error(`按了 Cmd/Ctrl+0 但设置面板没出现(找不到 [data-testid="${TID.settingsSearch}"])。`
      + '契约 §9.7 定的就是这条路径:快捷键 → 搜索框 → genui 区块。');
  });
  await search.fill('genui');
  const section = page.getByTestId(TID.settingsSection);
  await section.waitFor({ timeout: 10_000 }).catch(() => {
    throw new Error(`搜了 genui 也没出现 [data-testid="${TID.settingsSection}"]。`
      + '设置分组归属没规定,只能靠搜索定位,不要去赌它在哪个分组下。');
  });
  return section;
}

/**
 * 会话行的操作菜单(§9.7 两步入口):
 *   选中该会话行(选中即恒显,不需要 hover)→ session-actions-btn → 菜单打开 → session-actions-<action>
 * action ∈ pin / rename / fork / archive / delete,**按功能名**拼,不照中文文字。
 */
export async function sessionAction(page, action, row) {
  const btn = (row || page).getByTestId(TID.sessionActionsBtn).first();
  await btn.waitFor({ timeout: 10_000 }).catch(() => {
    throw new Error(`找不到 [data-testid="${TID.sessionActionsBtn}"]。契约声明它恒在 DOM(仅 opacity 隐藏),`
      + '当前会话行处于选中态时还应当恒显——所以够不到多半是锚还没补。');
  });
  await btn.click({ timeout: 6000 });
  await page.getByTestId(TID.sessionActionsMenu).waitFor({ timeout: 8000 }).catch(() => {
    throw new Error(`点了会话操作按钮但菜单没打开(找不到 [data-testid="${TID.sessionActionsMenu}"])。`);
  });
  const item = page.getByTestId(TID.sessionAction(action));
  await item.waitFor({ timeout: 6000 }).catch(() => {
    throw new Error(`菜单里没有 [data-testid="${TID.sessionAction(action)}"]。`
      + '这些项按功能名拼接,不要照中文文字定位(置顶↔取消置顶之类会翻转)。');
  });
  await item.click({ timeout: 6000 });
}

/** 当前渲染出来的窗格数。判断"有没有分屏"只看这个数,**不要**看 pane-split 在不在(它单屏也在)。 */
export async function paneCount(page) {
  return page.getByTestId(TID.pane).count();
}

/**
 * 开分屏。契约 §9.3 写明这是**两步入口**:
 *   panel-dock-toggle(展开面板坞) → pane-count(坞内的分屏按钮) → pane-count-<n>(弹层里的数量选项)
 * 之前只找第二步,坞没展开时那个按钮根本不在 DOM 里,所以怎么都找不到。
 *
 * 收尾判据也换了:数 [data-testid="pane"] 的个数 ≥ n。这条同时挡住一个"假绿"陷阱——
 * 代码/预览停靠面板打开时分屏只渲染聚焦的那一个窗格,pane 只有 1 个;
 * 那种状态下测"A 窗格点按钮别发到 B"根本不是分屏场景,这里会直接红,而不是悄悄过。
 */
export async function splitPanes(page, n = 2) {
  const step = async (tid, what) => {
    const loc = page.getByTestId(tid);
    await loc.first().waitFor({ timeout: 8000 }).catch(() => {
      throw new Error(`分屏第「${what}」步够不到:找不到 [data-testid="${tid}"]。\n`
        + '契约 §9.3 的两步入口:panel-dock-toggle → pane-count → pane-count-<n>。'
        + '这三个锚都是本轮要补的既有控件,还没补时红属预期。');
    });
    await loc.first().click({ timeout: 6000 });
  };
  await step(TID.panelDockToggle, '展开面板坞');
  await step(TID.paneCount, '点分屏按钮');
  await step(TID.paneCountN(n), `选 ${n} 栏`);
  await expect.poll(() => paneCount(page), { timeout: 8000 }).toBeGreaterThanOrEqual(n);
}


// ── 假 claude 的遥控:测试用文件信号驱动"回合开始 / 边写边发 / 回合结束"────
export const ctl = {
  /** 下一回合的脚本:模型要输出的正文(可含围栏)。 */
  script(app, text) { fs.writeFileSync(path.join(app.ctlDir, 'script.txt'), text); },
  /** 让回合停在写完正文之后、不结束(用来测"会话忙")。 */
  hold(app) { fs.writeFileSync(path.join(app.ctlDir, 'hold'), '1'); },
  /** 放行,让回合结束。 */
  release(app) { try { fs.unlinkSync(path.join(app.ctlDir, 'hold')); } catch { /* 已经放过了 */ } },
  /** 让本回合额外发一次工具调用+结果(用来测工具结果卡片/子代理结果里的围栏)。 */
  tools(app, list) { fs.writeFileSync(path.join(app.ctlDir, 'tools.json'), JSON.stringify(list)); },
  /** 假 CLI 是否真的被调起过(用来把"实现没接上"和"断言失败"分开)。 */
  started(app) { return fs.existsSync(path.join(app.ctlDir, 'started')); },
  reset(app) {
    for (const f of ['hold', 'started', 'script.txt', 'tools.json']) { try { fs.unlinkSync(path.join(app.ctlDir, f)); } catch { /* 无所谓 */ } }
  },
};

/** 在输入框里发一条消息,触发一个真回合(由假 claude 应答)。 */
export async function sendMessage(page, text) {
  const box = page.getByRole('textbox').first();
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

// ── fixtures ─────────────────────────────────────────────────────────────
export const test = base.extend({
  // 每个 worker 一份隔离实例(端口从 6703-6710 里挑空的),整个 worker 复用,收尾必关
  app: [async ({}, use, workerInfo) => {
    const app = await startApp(workerInfo.workerIndex);
    await use(app);
    await app.stop();
  }, { scope: 'worker' }],

  // 每条用例:干净的 localStorage + 控制台/网络采集器 + 假 CLI 复位
  page: async ({ page, app }, use) => {
    // 首启的「使用指引」浮层是一层 z-400 的整屏遮罩(pointer-events-auto),
    // 会把用例的**第一次点击**吃掉 —— 表现为交互像是没生效,断言压根跑不到。
    // 应用侧的判断是 localStorage.getItem('cgui-tour-seen') 为真就不弹(App.jsx:10525),
    // 所以在任何导航之前预置成"已看过"。addInitScript 对后续 reload 同样生效(本组多条会刷新)。
    // 这只是清掉一个与被测行为无关的拦路浮层,不放宽任何断言。
    await page.addInitScript(() => {
      try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 隐私模式下忽略 */ }
    });
    // 第四层遮罩:「发现新版本」大弹窗(z-200)。它由版本检查的结果驱动、
    // 关闭态只存在组件 state 里(没有可预置的存储位),所以从数据源头掐掉:
    // 把两个版本检查接口固定回"没有更新"。这两个接口与 genui 契约无关,
    // 不属任何一条用例的被测对象;固定它同时也消掉了"今天上游发了新版就多一层弹窗"的抖动。
    for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
      await page.route(api, (route) => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ hasUpdate: false, localBuild: true }),
      }));
    }
    const logs = [];
    const requests = [];
    page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
    page.on('request', (r) => {
      const body = r.postData();
      requests.push({ url: r.url(), method: r.method(), body: body || '' });
    });
    page.__logs = logs;
    page.__requests = requests;
    ctl.reset(app);
    await use(page);
  },
});

export { expect };

/** 控制台文本全集(含 pageerror)。 */
export const consoleText = (page) => page.__logs.join('\n');
/** 所有外发请求体拼起来(用来做"这串字没出网"的反向断言)。 */
export const requestBodies = (page) => page.__requests.map((r) => r.body).join('\n');
/** 本地存储 + 会话存储的全部内容(反向断言用)。 */
export const storageDump = (page) => page.evaluate(() => {
  const dump = (s) => { let out = ''; for (let i = 0; i < s.length; i++) { const k = s.key(i); out += k + '=' + s.getItem(k) + '\n'; } return out; };
  return dump(localStorage) + '\n' + dump(sessionStorage);
});
