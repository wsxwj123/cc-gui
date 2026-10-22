// I. 电脑操控状态(行为 23、24)。只读状态接口 GET /api/computer-use/status(不调安装 / 卸载 / 体检 / 授权这类会写盘的接口)。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { uniq, homeDir, dataRoot, WORKTREE } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { shared, readText } from '../r151b-xsession-p1/helpers/api.mjs';
import { boot } from '../r151b-xsession-p1/helpers/ui.mjs';
import { dismissOverlays, openPanel } from '../bugs-20260912/helpers/runtime.mjs';
import { startInstanceQ } from './helpers/inst.mjs';

test.describe.configure({ timeout: 150_000 });
test.skip(process.platform !== 'darwin', '电脑操控只在 macOS 提供');

test('Q23 后端由 PATH 上的 node 启动、它链接到带版本号(/Cellar/…)的目录 → 状态接口 nodePath 不含 /Cellar/,且就是那个稳定路径', async () => {
  // 造一个 Homebrew 式布局:真 node 二进制复制进 <base>/opt/homebrew/Cellar/node/99.9.9/bin/,稳定路径 <base>/opt/homebrew/bin/node 是指向它的符号链接
  const base = path.join(dataRoot(), `q23-${uniq('')}`);
  const realNode = fs.realpathSync(process.execPath);
  const cellar = path.join(base, 'opt', 'homebrew', 'Cellar', 'node', '99.9.9');
  const stableBin = path.join(base, 'opt', 'homebrew', 'bin');
  fs.mkdirSync(path.join(cellar, 'bin'), { recursive: true }); fs.mkdirSync(stableBin, { recursive: true });
  fs.copyFileSync(realNode, path.join(cellar, 'bin', 'node'), fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(path.join(cellar, 'bin', 'node'), 0o755);
  const libDir = path.join(path.dirname(path.dirname(realNode)), 'lib'); // Homebrew 的 node 依赖 ../lib/libnode*.dylib
  if (fs.existsSync(libDir)) fs.symlinkSync(libDir, path.join(cellar, 'lib'));
  const stableNode = path.join(stableBin, 'node');
  fs.symlinkSync(path.join('..', 'Cellar', 'node', '99.9.9', 'bin', 'node'), stableNode);
  const execPath = execFileSync(stableNode, ['-p', 'process.execPath'], { encoding: 'utf8' }).trim();
  expect(execPath, `前置(夹具):经稳定路径启动的 node,自己看到的 process.execPath 应在 /Cellar/ 下`).toContain('/Cellar/');

  const inst = await startInstanceQ('q23', { nodeBin: stableNode, pathPrefix: stableBin });
  try {
    const r = await inst.c.get('/api/computer-use/status');
    expect(r.status, `状态接口应 200(${String(r.text).slice(0, 300)})`).toBe(200);
    expect.soft(r.body && r.body.nodePath, `nodePath 不应含 /Cellar/(应答:${String(r.text).slice(0, 400)})`).not.toContain('/Cellar/');
    expect.soft(r.body && r.body.nodePath, 'nodePath 应就是 PATH 上的稳定路径').toBe(stableNode);
  } finally { await inst.stop(); }
});

const CLAUDE_JSON = () => path.join(homeDir(), '.claude.json');
const registration = (command) => ({ mcpServers: { 'ccgui-computer-use': { type: 'stdio', command, args: [path.join(WORKTREE, 'server', 'computer-use', 'mcp-server.js')] } } });
async function cuCardText(page) {
  await boot(page);
  await dismissOverlays(page);
  await openPanel(page, '工具');
  const tab = page.getByRole('tab', { name: 'MCP 服务器' });
  await expect(tab, '工具面板要挂出来').toBeVisible({ timeout: 25_000 });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(page.getByTestId('cu-card-subtitle'), '桌面操控卡片').toBeVisible({ timeout: 25_000 });
  await page.waitForTimeout(1_000);
  return page.evaluate(() => document.body.innerText);
}
const reinstallMentions = (text) => (String(text).match(/重新安装/g) || []).length;

test('Q24 ~/.claude.json 里 ccgui-computer-use 的命令指向不存在的 node → registeredNodeMissing:true、面板提示重新安装;路径存在时为 false', async ({ page }) => {
  const prev = readText(CLAUDE_JSON());
  try {
    fs.writeFileSync(CLAUDE_JSON(), JSON.stringify(registration('/nonexistent-r151q/bin/node'), null, 2));
    const missing = await shared.get('/api/computer-use/status');
    const missingText = await cuCardText(page);
    fs.writeFileSync(CLAUDE_JSON(), JSON.stringify(registration(process.execPath), null, 2));
    const present = await shared.get('/api/computer-use/status');
    const presentText = await cuCardText(page);
    expect.soft(missing.body && { registered: missing.body.registered, registeredNodeMissing: missing.body.registeredNodeMissing }, `node 路径不存在时的状态(原文:${String(missing.text).slice(0, 400)})`).toEqual({ registered: true, registeredNodeMissing: true });
    expect.soft(present.body && { registered: present.body.registered, registeredNodeMissing: present.body.registeredNodeMissing }, `node 路径存在时的状态(原文:${String(present.text).slice(0, 400)})`).toEqual({ registered: true, registeredNodeMissing: false });
    expect.soft(reinstallMentions(missingText), `node 路径不存在时面板应提示重新安装(页面文字:${missingText.slice(0, 800)})`).toBeGreaterThan(reinstallMentions(presentText));
    expect.soft(reinstallMentions(missingText), '面板里应出现"重新安装"').toBeGreaterThan(0);
  } finally {
    if (prev === null) fs.rmSync(CLAUDE_JSON(), { force: true }); else fs.writeFileSync(CLAUDE_JSON(), prev);
  }
});
