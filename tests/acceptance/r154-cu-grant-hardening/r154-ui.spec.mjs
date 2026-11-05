// U1-U3:面板(浏览器页面)里的授权 / 主屏开关 / 禁止类别提示。
// 页面来源是本套件自己起的 vite dev server(源码直出,不产 client/dist),/api 与 /ws 代理到隔离实例;
// 实例跑在假家目录里,"运行中应用"由假 helper 的剧本给 —— 不碰真实授权、不打开真实应用窗口。
// 导航口径与既有授权面板套件一致:坞 → 「工具」→ 页签「MCP 服务器」→ 桌面操控卡里的「应用授权」区块。
import { test, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dismissOverlays, openPanel } from '../bugs-20260912/helpers/runtime.mjs';
import { waitHealthy } from '../cu-grant-ui-20260913/helpers/harness.mjs';
import {
  ID, WIN, makeWorld, startServer, stopInstance, pickPort, trackPid, suiteDir, worktree,
  getStatus, grantedIds, screenScopeGranted,
} from './helpers/world.mjs';

let world;
let server;
let vite;
let uiBase;

test.beforeAll(async () => {
  world = makeWorld('ui');
  world.setScenario({
    apps: [
      { bundleId: ID.textedit, name: 'TextEdit', pid: WIN.textedit.pid },
      { bundleId: ID.notes, name: 'Notes', pid: WIN.notes.pid },
    ],
  });
  server = await startServer(world, { label: 'ui' });
  const uiPort = pickPort();
  const logFd = fs.openSync(path.join(world.base, 'vite.log'), 'a');
  const proc = spawn(process.execPath, [
    path.join(worktree, 'client', 'node_modules', 'vite', 'bin', 'vite.js'), '--config', path.join(suiteDir, 'vite.dev.config.mjs'),
  ], {
    cwd: path.join(worktree, 'client'),
    env: { ...process.env, R154_API_PORT: String(server.port), R154_UI_PORT: String(uiPort) },
    stdio: ['ignore', logFd, logFd],
  });
  trackPid(proc.pid);
  vite = { pid: proc.pid };
  const healthy = await waitHealthy(uiPort, 90_000); // /api/health 经 vite 代理到实例
  const listeners = String(spawnSync('lsof', ['-nP', `-iTCP:${uiPort}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout || '').split('\n').map(Number);
  if (!healthy || !listeners.includes(proc.pid)) {
    throw new Error(`ENVIRONMENT_BLOCKED: dev server 没起来或端口被别人占了(端口 ${uiPort});看 ${path.join(world.base, 'vite.log')}`);
  }
  uiBase = `http://127.0.0.1:${uiPort}`;
});
test.afterAll(async () => {
  await stopInstance(vite);
  await stopInstance(server);
});
test.beforeEach(() => { world.setGrants({}); });

/** 在已加载的页面里打开「应用授权」区块。 */
async function openGrantsSection(page) {
  await dismissOverlays(page);
  await openPanel(page, '工具');
  const tab = page.getByRole('tab', { name: 'MCP 服务器' });
  await expect(tab, '工具面板要挂出来').toBeVisible({ timeout: 20_000 });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  const grants = page.getByTestId('cu-grants');
  await expect(grants, '桌面操控卡里的「应用授权」区块').toBeVisible({ timeout: 20_000 });
  return grants;
}
async function gotoGrants(page) {
  const st = await getStatus(server.base);
  expect(st.json?.supported, 'computer use 只在 macOS 提供').toBe(true);
  expect(st.json?.registered, '夹具 .claude.json 必须登记 ccgui-computer-use(否则面板不渲染授权区块)').toBe(true);
  await page.goto(uiBase, { waitUntil: 'domcontentloaded' });
  return openGrantsSection(page);
}
async function expandCandidates(page) {
  const add = page.getByTestId('cu-grant-add');
  await expect(add).toBeVisible();
  if ((await add.getAttribute('aria-expanded')) !== 'true') await add.click();
  await expect(page.getByTestId('cu-apps-note')).toBeVisible({ timeout: 15_000 });
}
const grantButton = (page, id) => page.locator(`[data-testid="cu-app-grant"][data-bundle-id="${id}"]`);
const grantRow = (page, id) => page.locator(`[data-testid="cu-grant-row"][data-bundle-id="${id}"]`);

test('U1 面板里对运行中应用点"授权" → 出现在已授权列表(无额外操作);刷新页面后立即再授权另一个应用同样成功', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  await gotoGrants(page);
  await expandCandidates(page);
  await expect(grantButton(page, ID.textedit), '候选列表里应有 TextEdit(假 helper 剧本里的运行中应用)').toBeVisible({ timeout: 15_000 });
  await grantButton(page, ID.textedit).click();
  await expect(grantRow(page, ID.textedit), '点"授权"后 TextEdit 应出现在已授权列表').toBeVisible({ timeout: 15_000 });
  expect(await grantedIds(server.base), '服务端授权列表也应含 TextEdit').toContain(ID.textedit);
  await expect(page.getByTestId('cu-grant-error'), '授权成功不应出现行内错误').toHaveCount(0);
  await expect(page.locator('[role="dialog"]'), '授权过程不应弹出任何额外对话框(用户无感)').toHaveCount(0);

  await page.reload({ waitUntil: 'domcontentloaded' }); // 刷新后立即再授权,中间不做任何额外等待/操作
  await openGrantsSection(page);
  await expandCandidates(page);
  await expect(grantButton(page, ID.notes), '刷新后候选列表里应有 Notes').toBeVisible({ timeout: 15_000 });
  await grantButton(page, ID.notes).click();
  await expect(grantRow(page, ID.notes), '刷新后立即授权的 Notes 应出现在已授权列表').toBeVisible({ timeout: 15_000 });
  expect(await grantedIds(server.base), '服务端授权列表应同时含 TextEdit 与 Notes').toEqual(expect.arrayContaining([ID.textedit, ID.notes]));
  expect(dialogs, '全程不应弹出原生对话框').toEqual([]);
});

test('U2 开启"主屏全部可见内容":点开关 → 出现确认框 → 点"允许" → 成功(服务端为 true);点"取消"则服务端状态不变', async ({ page }) => {
  await gotoGrants(page);
  const toggle = page.getByTestId('cu-screen-scope-toggle');
  const dialog = page.locator('[role="dialog"][data-testid="cu-screen-scope-confirm"]');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(dialog, '开启必须过确认框').toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('cu-screen-scope-confirm-cancel'), '取消按钮文案应含"取消"').toContainText('取消');
  await page.getByTestId('cu-screen-scope-confirm-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(toggle, '取消后开关不动').toHaveAttribute('aria-checked', 'false');
  expect(await screenScopeGranted(server.base), '点"取消"后服务端 screenScope 仍应是 false').toBe(false);

  await toggle.click();
  await expect(dialog, '再次开启仍要过确认框').toBeVisible({ timeout: 10_000 });
  const allow = page.getByTestId('cu-screen-scope-confirm-confirm');
  await expect(allow, '确认按钮文案应含"允许"').toContainText('允许');
  await allow.click();
  await expect(toggle, '点"允许"后开关应为开').toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
  expect(await screenScopeGranted(server.base), '点"允许"后服务端 screenScope 应为 true').toBe(true);
  await expect(page.getByTestId('cu-grant-error'), '开启成功不应出现行内错误').toHaveCount(0);
});

test('U3 手填 com.apple.Terminal 点授权 → 行内出现含"禁止"的错误提示,授权列表里不出现它', async ({ page }) => {
  await gotoGrants(page);
  await expandCandidates(page);
  await page.getByTestId('cu-manual-input').fill(ID.terminal);
  const grant = page.getByTestId('cu-manual-grant');
  await expect(grant, '手填后授权按钮应可点').toBeEnabled();
  await grant.click();
  const err = page.getByTestId('cu-grant-error');
  await expect(err, '被拒后应在行内出现错误提示').toBeVisible({ timeout: 15_000 });
  await expect(err, '错误提示文案应含"禁止"').toContainText('禁止');
  await expect(grantRow(page, ID.terminal), '已授权列表里不应出现终端').toHaveCount(0);
  const ids = (await grantedIds(server.base)).map((x) => x.toLowerCase());
  expect(ids, '服务端授权列表里不应有终端').not.toContain('com.apple.terminal');
});
