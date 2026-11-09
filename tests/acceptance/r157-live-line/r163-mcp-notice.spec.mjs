// r163:新进程 init 里 MCP 服务器的黄字提示——只报真问题(needs-auth / failed),「正在连接(pending)」不报,
// 同一服务器同一状态这次运行里只报一次(换会话 / 新进程不重弹),状态变了才再报。
// 背景(2026-11-09 真命令行实测,CLI 2.1.319):MCP 连接全异步,冷启动 init 时 15 个里 13 个非 connected,11 个只是 pending;
// 旧行为把它们全当问题、每个新进程弹一遍长黄字。
// 只看页面上看得见的东西(黄字的文字、助手回复文字);假命令行在 init 里带 scenario.mcpServers(见 helpers/fake-claude.mjs 的 r163 扩展)。
//   G1 一个新进程的 init:3 个真问题各出现在黄字里,11 个 pending 的名字一个都不出现;
//   G2 同一页再换一个会话发消息(新进程、同样的 init):不再弹黄字;
//   G3 之后某个服务器状态变了(failed → needs-auth):只弹变了的那一个;
//   G4 init 里只有 pending(其余 connected):整条黄字都不弹。
import { test, expect } from '@playwright/test';
import { SESSIONS } from './helpers/fixtures.mjs';
import { primeOverlays, openApp, openSessionByMarker, sendInOpenSession, resetCtl, writeScenario, waitRoundIdle } from './helpers/runtime.mjs';

const PENDING = ['pubmed', 'biorxiv', 'consensus', 'c-trials', 'chembl', 'wiley', 'ot', 'pdf', 'paper-search-mcp', 'deepseek-search', 'ot2'];
const mcp = ({ benchling = 'failed' } = {}) => [
  ...PENDING.map((n) => ({ name: `plugin:bio-research:${n}`, status: 'pending' })),
  { name: 'plugin:bio-research:biorender', status: 'needs-auth' },
  { name: 'plugin:bio-research:synapse', status: 'needs-auth' },
  { name: 'plugin:bio-research:benchling', status: benchling },
  { name: 'xiaohongshu-mcp', status: 'connected' },
  { name: 'ccgui-computer-use', status: 'connected' },
];
const noticeLoc = (page) => page.getByText(/MCP 服务器/);

/** 在当前页打开 key 对应的夹具会话、按 servers 写场景、发一条消息,等助手回复出现(= init 已处理)再返回回复文字。 */
async function sendRound(page, key, tag, servers) {
  resetCtl();
  writeScenario({ stepDelayMs: 120, mcpServers: servers, events: [{ kind: 'text', text: `回复:${tag}` }], end: 'ok' });
  await openSessionByMarker(page, SESSIONS[key].marker);
  await sendInOpenSession(page, `r163 ${tag}`);
  await expect(page.getByText(`回复:${tag}`).first(), `${tag}:助手回复应出现`).toBeVisible({ timeout: 30_000 });
  return `回复:${tag}`;
}

test('G1–G3 黄字只报真问题、同一问题只报一次、状态变了才再报', async ({ page }) => {
  test.setTimeout(180_000);
  await primeOverlays(page, {});
  await openApp(page);

  // G1:第一个新进程
  await sendRound(page, 'b1', 'G1', mcp());
  const n1 = noticeLoc(page);
  await expect(n1, 'G1 应弹出 MCP 黄字(有 3 个真问题)').toBeVisible({ timeout: 15_000 });
  const t1 = (await n1.first().textContent()) || '';
  for (const name of ['biorender', 'synapse', 'benchling']) expect(t1, `G1 黄字应包含真问题「${name}」(实际:${t1})`).toContain(name);
  for (const name of PENDING) expect(t1, `G1 黄字不应出现 pending 的服务器「${name}」(实际:${t1})`).not.toContain(name);
  expect(t1, 'G1 黄字里不应出现 pending 这个状态词').not.toContain('pending');
  await waitRoundIdle(page, 60_000);
  await expect(noticeLoc(page), '前置:G1 的黄字 5 秒后自己消掉').toHaveCount(0, { timeout: 15_000 });

  // G2:换一个会话发消息 = 新进程、同样的 init
  await sendRound(page, 'b2', 'G2', mcp());
  await page.waitForTimeout(1200);
  expect(await noticeLoc(page).count(), 'G2 同样的问题,新进程不应再弹黄字').toBe(0);
  await waitRoundIdle(page, 60_000);

  // G3:benchling 的状态从 failed 变成 needs-auth → 只弹它
  await sendRound(page, 'b3', 'G3', mcp({ benchling: 'needs-auth' }));
  const n3 = noticeLoc(page);
  await expect(n3, 'G3 状态变了的服务器应再弹一次').toBeVisible({ timeout: 15_000 });
  const t3 = (await n3.first().textContent()) || '';
  expect(t3, `G3 黄字应包含 benchling(实际:${t3})`).toContain('benchling');
  expect(t3, `G3 黄字应写新状态 needs-auth(实际:${t3})`).toContain('needs-auth');
  for (const name of ['biorender', 'synapse', ...PENDING]) expect(t3, `G3 黄字只该有变了的那个,不该出现「${name}」(实际:${t3})`).not.toContain(name);
  await waitRoundIdle(page, 60_000);
});

test('G4 init 里只有 pending(其余 connected):不弹黄字', async ({ page }) => {
  test.setTimeout(120_000);
  await primeOverlays(page, {});
  await openApp(page);
  const servers = [
    ...PENDING.map((n) => ({ name: `plugin:bio-research:${n}`, status: 'pending' })),
    { name: 'xiaohongshu-mcp', status: 'connected' }, { name: 'ccgui-computer-use', status: 'connected' },
  ];
  await sendRound(page, 'b4', 'G4', servers);
  await page.waitForTimeout(1200);
  expect(await noticeLoc(page).count(), 'G4 只有 pending 的 init 不应弹任何 MCP 黄字').toBe(0);
  await waitRoundIdle(page, 60_000);
});
