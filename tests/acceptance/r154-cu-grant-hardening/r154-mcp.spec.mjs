// M1-M6:禁止名单在 MCP 工具与授权读取面上的效果。
// 一律用假 helper(假窗口列表 / 假光标命中)驱动:不点击、不输入、不打开任何真实应用窗口;
// "零投递"的判据 = 假 helper 的调用记录里没有任何非只读子命令。
// 关键顺序:先起 MCP 进程,再把"旧数据"写进授权文件 —— MCP 每次动作前重读授权,
// 这样绕开任何启动期清理,专测运行期过滤。
import { test, expect } from '@playwright/test';
import {
  ID, WIN, makeWorld, startServer, stopInstance, startMcp, parseWindows, clickArgs,
  getGrants, postDoctor, getStatus, collectIds, lower,
} from './helpers/world.mjs';

let world;
let server;
test.beforeAll(async () => {
  world = makeWorld('mcp');
  server = await startServer(world, { label: 'mcp' });
});
test.afterAll(async () => { await stopInstance(server); });

const SCENARIO = {
  frontmost: { pid: WIN.textedit.pid, name: 'TextEdit', bundleId: ID.textedit },
  windows: [WIN.textedit, WIN.terminal, WIN.gui, WIN.guiDs, WIN.notes],
};

async function begin(extra = {}) {
  world.setGrants({});
  world.setScenario({ ...SCENARIO, ...extra });
  world.clearStubLog();
  return startMcp(world);
}

/** M1 / M2 共用:授权文件里放"禁止应用 + TextEdit"(MCP 已在跑),四个读写面都不该把禁止应用当已授权。 */
async function expectForbiddenEverywhere(mcp, target) {
  const who = target.bundleId;
  world.setGrants({ apps: [target.bundleId, ID.textedit] });
  const list = await mcp.call('window_list', {});
  expect(list.isError, `window_list 应成功:${list.text.slice(0, 200)}`).toBe(false);
  const wins = parseWindows(list.text);
  expect.soft(wins.map((w) => w.pid), '对照:TextEdit 的窗口应被列出(证明假窗口列表有效)').toContain(WIN.textedit.pid);
  expect.soft(wins.map((w) => w.pid), `window_list 不得列出 ${who} 的窗口`).not.toContain(target.pid);
  expect.soft(list.text, `window_list 文本不得泄露 ${who} 的窗口标题`).not.toContain(target.title);

  world.clearStubLog();
  const click = await mcp.call('left_click', clickArgs(target));
  expect.soft(click.isError, `${who}:left_click 应返回错误`).toBe(true);
  expect.soft(click.sc.code, `${who}:left_click 应被拒为 CU_APP_NOT_ALLOWED,实际 ${click.sc.code}`).toBe('CU_APP_NOT_ALLOWED');
  expect.soft(String(click.sc.detail ?? ''), `${who}:structuredContent.detail 应是含"禁止"的说明`).toContain('禁止');
  expect.soft(world.dispatchCalls(), `${who}:不得有任何事件被投递`).toEqual([]);

  const grants = await getGrants(server.base);
  const gids = lower((grants.json?.apps || []).map((a) => (typeof a === 'string' ? a : a?.bundleId)));
  expect.soft(gids, `GET /grants 的应用列表不应含 ${who}`).not.toContain(who.toLowerCase());
  expect.soft(gids, 'GET /grants 的应用列表仍应含 TextEdit').toContain('com.apple.textedit');
  const doctor = await postDoctor(server.base);
  const dids = lower(collectIds(doctor.json));
  expect.soft(dids, `POST /doctor 的应用列表不应含 ${who}`).not.toContain(who.toLowerCase());
  expect.soft(dids, 'POST /doctor 的应用列表仍应含 TextEdit').toContain('com.apple.textedit');
}

test('M1 授权文件(启动后写入)里有 Terminal 与 TextEdit:window_list 无终端窗口、点终端 → CU_APP_NOT_ALLOWED(detail 含"禁止")、GET/doctor 列表不含终端', async () => {
  const mcp = await begin();
  try {
    await expectForbiddenEverywhere(mcp, WIN.terminal);
  } finally { mcp.kill(); }
});

test('M2 同 M1,对象换成 com.claudegui.desktop 与变体 com.claudegui.desktop.ds(各验证一次)', async () => {
  const mcp = await begin();
  try {
    await expectForbiddenEverywhere(mcp, WIN.gui);
    await expectForbiddenEverywhere(mcp, WIN.guiDs);
  } finally { mcp.kill(); }
});

test('M3 只授权 TextEdit,但 target 的 pid/windowId 取终端窗口 → 被拒绝(CU_APP_NOT_ALLOWED 或 CU_TARGET_NOT_FOUND)且零投递', async () => {
  const mcp = await begin();
  try {
    world.setGrants({ apps: [ID.textedit] });
    world.clearStubLog();
    const spoof = { bundleId: ID.textedit, pid: WIN.terminal.pid, id: WIN.terminal.id };
    const r = await mcp.call('left_click', clickArgs(spoof));
    expect(r.isError, `应返回错误,实际 ${JSON.stringify(r.sc).slice(0, 200)}`).toBe(true);
    expect(['CU_APP_NOT_ALLOWED', 'CU_TARGET_NOT_FOUND'], `错误码应是二者之一,实际 ${r.sc.code}`).toContain(r.sc.code);
    expect(r.sc.ok, '回执 ok 应为 false').toBe(false);
    expect([r.sc.method, r.sc.verification].filter((v) => v !== undefined), '失败回执不得声称任何投递').toEqual([]);
    expect(world.dispatchCalls(), '没有任何事件被投递(假 helper 里没有非只读子命令)').toEqual([]);
    console.log(`   [M3] 被拒回执 code=${r.sc.code}`);
  } finally { mcp.kill(); }
});

test('M4 授权文件里只有普通应用 TextEdit:window_list 列出其窗口,对它的点击走原来的路径(不被禁止逻辑拦下)', async () => {
  const mcp = await begin();
  try {
    world.setGrants({ apps: [ID.textedit] });
    const list = await mcp.call('window_list', {});
    expect(list.isError, `window_list 应成功:${list.text.slice(0, 200)}`).toBe(false);
    const wins = parseWindows(list.text);
    expect(wins.map((w) => w.pid), '只应列出 TextEdit 的窗口(终端等未授权应用不列)').toEqual([WIN.textedit.pid]);
    expect(wins[0], 'TextEdit 窗口的 id / 方括号里的应用标识(修前 window_list 就显示 bundleId)/ 标题').toMatchObject({ windowId: WIN.textedit.id, app: ID.textedit, title: WIN.textedit.title });
    // 带 target 的窗口截图在产品里本就明确拒绝(docs:screenshotTarget=unverified),拿不到合法 snapshotId,
    // 所以"点击"只能验到"不被禁止逻辑拦下、错误码仍是文档里的";"动作能一路走到 helper"改用不需要 snapshotId 的 type 验。
    const r = await mcp.call('left_click', clickArgs(WIN.textedit));
    expect(r.rpcError, '工具错误走 MCP 结果,不是 JSON-RPC 错误').toBeFalsy();
    expect(r.sc.code, `已授权的普通应用不应被拦成 CU_APP_NOT_ALLOWED(实际 ${r.sc.code})`).not.toBe('CU_APP_NOT_ALLOWED');
    const clickCalls = world.dispatchCalls(); // 点击阶段的投递记录(在 type 之前取)
    expect(r.sc.code, `snapshotId 从未签发时,修前的结果是 CU_STALE_SNAPSHOT;对普通已授权应用行为应与修改前完全一致(实际 ${r.sc.code})`).toBe('CU_STALE_SNAPSHOT');
    world.clearStubLog();
    const typed = await mcp.call('type', { actionId: `r154_${Date.now()}`, target: { bundleId: ID.textedit, pid: WIN.textedit.pid, windowId: WIN.textedit.id }, text: 'r154' });
    expect(typed.sc.code, `对已授权的 TextEdit 发 type 不应被拦成 CU_APP_NOT_ALLOWED(实际 ${typed.sc.code})`).not.toBe('CU_APP_NOT_ALLOWED');
    console.log(`   [M4] type 回执 isError=${typed.isError} code=${typed.sc.code} method=${typed.sc.method} 假 helper 非只读子命令=${JSON.stringify(world.dispatchCalls())}`);
    expect(world.dispatchCalls().length, `type 应一路走到 helper(假 helper 记录里有非只读子命令),回执 ${JSON.stringify(typed.sc).slice(0, 200)}`).toBeGreaterThan(0);
    console.log(`   [M4] 点击回执 isError=${r.isError} code=${r.sc.code} method=${r.sc.method} 点击阶段假 helper 非只读子命令=${JSON.stringify(clickCalls)}`);
  } finally { mcp.kill(); }
});

test('M5 终端窗口在光标位置、screenScope=false、文件里有 Terminal:cursor_position → CU_SCREEN_SCOPE_REQUIRED(不返回局部坐标)', async () => {
  const over = (w, x, y) => ({ bundleId: w.bundleId, pid: w.pid, windowId: w.id, x, y });
  const mcp = await begin({ cursor: { point: [760, 100], over: over(WIN.terminal, 60, 40) } });
  try {
    world.setGrants({ apps: [ID.terminal, ID.textedit], screenScope: false });
    const r = await mcp.call('cursor_position', {});
    expect.soft(r.isError, `应拒绝,实际 ${JSON.stringify(r.sc).slice(0, 200)}`).toBe(true);
    expect.soft(r.sc.code, `错误码应是 CU_SCREEN_SCOPE_REQUIRED,实际 ${r.sc.code}`).toBe('CU_SCREEN_SCOPE_REQUIRED');
    expect.soft(r.sc.local ?? null, '不得把终端当已授权目标返回局部坐标').toBeNull();
    expect.soft(r.text, '文本里不得给出局部坐标数值(形如「局部坐标 (60, 40)」)').not.toMatch(/局部坐标\s*[(（]\s*-?\d/);
    // 对照:同样的授权文件,光标落在已授权的 TextEdit 窗口里 → 仍返回局部坐标(证明假光标命中被产品识别)
    world.setScenario({ ...SCENARIO, cursor: { point: [100, 100], over: over(WIN.textedit, 10, 20) } });
    const ctl = await mcp.call('cursor_position', {});
    expect.soft(ctl.isError, `对照失败:光标在已授权 TextEdit 窗口内应成功,实际 ${JSON.stringify(ctl.sc).slice(0, 200)}(假光标命中没被识别,上面的结论不可信)`).toBe(false);
    expect.soft(ctl.text, '对照:文本应给出局部坐标 (10,20)').toMatch(/局部坐标 \(10,\s*20\)/);
  } finally { mcp.kill(); }
});

test('M6 CU_APP_NOT_ALLOWED 的默认报错文本与 /status 里 capabilities.screenScope.reason:不含 /api/ 与 POST,且含"面板"', async () => {
  const mcp = await begin();
  try {
    world.setGrants({});
    const r = await mcp.call('left_click', clickArgs(WIN.notes)); // 对未授权的普通应用发动作
    expect(r.sc.code, `应触发 CU_APP_NOT_ALLOWED,实际 ${r.sc.code}`).toBe('CU_APP_NOT_ALLOWED');
    const sources = [['MCP 回执文本', r.text], ['structuredContent(整体)', JSON.stringify(r.sc)]];
    for (const [name, t] of sources) {
      expect.soft(t, `${name}不应含 /api/`).not.toContain('/api/');
      expect.soft(t, `${name}不应含 POST`).not.toContain('POST');
    }
    expect.soft(`${r.text}\n${JSON.stringify(r.sc)}`, '报错文本应含"面板"').toContain('面板');
    const st = await getStatus(server.base);
    const reason = st.json?.capabilities?.screenScope?.reason;
    expect.soft(typeof reason, `capabilities.screenScope.reason 应是字符串,实际 ${JSON.stringify(reason)}`).toBe('string');
    if (typeof reason === 'string') {
      expect.soft(reason, 'screenScope.reason 不应含 /api/').not.toContain('/api/');
      expect.soft(reason, 'screenScope.reason 不应含 POST').not.toContain('POST');
      expect.soft(reason, 'screenScope.reason 应含"面板"').toContain('面板');
    }
  } finally { mcp.kill(); }
});
