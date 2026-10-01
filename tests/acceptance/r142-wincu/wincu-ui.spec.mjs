// r142-wincu / U-01..U-07 —— 界面层:卡片不许整张消失,文案必须跟着 inputMode 走(§4.2)。
//
// DOM 锚点口径(与既有验收同规矩):
//   · 能用公开文案就用公开文案(卡片标题「桌面操控(computer use)」、按钮「准备环境」、占位「当前平台…不支持」);
//   · 副标题与降级提示条是**新增**元素,方案没给锚点 ⇒ TEST-PLAN 里点名要两个 data-testid:
//     `cu-card-subtitle`(副标题)与 `cu-mode-note`(降级提示条)。缺锚点 = 用例失败(不是环境问题)。
//
// 跑法:tests/acceptance/r142-wincu/run-isolated.sh --platform win32 --ui / --platform darwin --ui
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dismissOverlays, openPanel } from '../bugs-20260912/helpers/runtime.mjs';
import { api, platform, uiBase, EnvironmentBlocked, sleep } from './helpers/harness.mjs';

const MAC_SUBTITLE = '让会话能截图、点鼠标、敲键盘、读窗口。模型可见的工具注册为「computer-use」;截图/窗口查询完全被动,点击优先后台投递不抢你的前台。';

async function openCard(page) {
  const status = await api('/api/computer-use/status');
  if (status.status !== 200) throw new EnvironmentBlocked(`/api/computer-use/status 不可用(HTTP ${status.status})`);
  await page.goto(uiBase(), { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await openPanel(page, '工具');
  const tab = page.getByRole('tab', { name: 'MCP 服务器' });
  await expect(tab, '工具面板要挂出来').toBeVisible({ timeout: 20_000 });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  return status.body;
}

/** 直接改夹具里的 uia 缓存再刷新页面 —— 等价于"探测结果变了",不用真跑 Windows。 */
function writeUiaCache(home, uia) {
  const file = path.join(home, '.claude-gui', 'cu-runtime', 'uia-capability.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const src = fs.readFileSync(path.join(process.env.WORKTREE, 'server', 'computer-use', 'mcp-server.js'), 'utf8');
  const m = /const PY_DEPS_WIN = \[([^\]]*)\]/.exec(src);
  const deps = (m ? m[1] : "'mss','Pillow','comtypes>=1.4.0'").split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  fs.writeFileSync(file, JSON.stringify({ version: 1, uia, checkedAt: new Date().toISOString(),
    comtypes: '1.4.11', depsStamp: createHash('sha256').update(deps.join('|')).digest('hex') }));
}

test('U-01 卡片必须存在(非 macOS 也不许整张消失)', async ({ page }) => {
  await openCard(page);
  await expect(page.getByText('桌面操控(computer use)').first(),
    '§4.2:MCPPanel.jsx:35 的 `if (!st.supported) return null` 要改成"渲染不支持占位卡"').toBeVisible({ timeout: 20_000 });
});

test('U-02 win32 副标题按 inputMode 写实话(不许照抄 mac 的"不抢前台")', async ({ page }) => {
  if (platform() !== 'win32') throw new EnvironmentBlocked('本用例要求 CGUI_TEST_PLATFORM=win32');
  const st = await openCard(page);
  const subtitle = page.getByTestId('cu-card-subtitle');
  await expect(subtitle).toBeVisible();
  const text = await subtitle.innerText();
  expect(text, '§4.2:mac 的原文在 Windows 上是假话,不许出现').not.toBe(MAC_SUBTITLE);
  if (st.inputMode === 'none') {
    expect(text, '§4.2 的 none 档要点').toMatch(/仅支持截图|点击与输入尚未提供/);
  } else {
    expect(text, '§4.2 的 background-partial 档要点').toMatch(/优先后台|UI ?Automation|元素/);
    expect(text, '§4.2:覆盖不到时要明说会明确报错,不会偷偷抢前台').toMatch(/明确报错|覆盖不到|不会.*抢前台|不会偷偷/);
  }
});

test('U-03 win32 降级提示条:走消息投递时说明"浏览器类大概率无效"', async ({ page }) => {
  if (platform() !== 'win32') throw new EnvironmentBlocked('本用例要求 CGUI_TEST_PLATFORM=win32');
  writeUiaCache(process.env.HOME, false);
  const st = await openCard(page);
  const note = page.getByTestId('cu-mode-note');
  await expect(note, '§4.2:降级提示条(background-message-only 是黄条)').toBeVisible({ timeout: 20_000 });
  const text = await note.innerText();
  expect(text, `缓存说 UIA 不可用(${st.uiaReady ? '但 status 报 uiaReady=true,缓存没生效?' : 'uiaReady=false'})`)
    .toMatch(/消息投递|传统|浏览器/);
  expect(text).toMatch(/不会.*抢前台|不抢前台/);
});

test('U-04 win32 且运行时未就绪时出现「准备环境」按钮,点了真的打 POST /prepare', async ({ page }) => {
  if (platform() !== 'win32') throw new EnvironmentBlocked('本用例要求 CGUI_TEST_PLATFORM=win32');
  const st = await openCard(page);
  if (st.runtimeReady) throw new EnvironmentBlocked('实例运行时已就绪;本用例要用 --no-venv 起实例');
  const requests = [];
  page.on('request', (r) => { if (r.url().includes('/api/computer-use/prepare')) requests.push(r); });
  const btn = page.getByRole('button', { name: '准备环境' });
  await expect(btn, '§4.2:win32 且 runtimeReady=false 时才显示').toBeVisible({ timeout: 20_000 });
  await btn.click();
  await expect.poll(() => requests.length, { timeout: 10_000, message: '点「准备环境」要打 POST /prepare(§2.5②)' }).toBeGreaterThan(0);
  expect(requests[0].method()).toBe('POST');
  await expect(btn, '准备完成后按钮要退场(或变成"已就绪")').toBeHidden({ timeout: 120_000 });
});

test('U-05 macOS:副标题与按钮保持修前原样', async ({ page }) => {
  if (platform() !== 'darwin') throw new EnvironmentBlocked('本用例要求 CGUI_TEST_PLATFORM=darwin');
  await openCard(page);
  await expect(page.getByTestId('cu-card-subtitle'), 'mac 副标题逐字不变').toHaveText(MAC_SUBTITLE);
  await expect(page.getByRole('button', { name: '准备环境' }), '§4.2:准备按钮只给 Windows').toHaveCount(0);
  await expect(page.getByTestId('cu-mode-note'), 'mac 没有降级提示条(输入全走后台)').toHaveCount(0);
});

test('U-06 不支持的平台:显示"当前平台…不支持"占位,而不是空白', async ({ page }) => {
  if (platform() !== 'linux') throw new EnvironmentBlocked('本用例要求 CGUI_TEST_PLATFORM=linux(第三遍,见 README)');
  await openCard(page);
  await expect(page.getByText(/当前平台.*不支持/).first(), '§4.2:占位卡要写清平台与原因').toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: '安装' }), '不支持的平台不该有安装按钮').toHaveCount(0);
  await sleep(50);
});
