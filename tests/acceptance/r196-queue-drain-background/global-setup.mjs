// 跑用例之前的预检:确认页面与后端是本套件自己的隔离实例(端口 6978 / 6977)、夹具会话在它肚子里,再用一次性浏览器把首页打开一遍热身。
import fs from 'node:fs';
import { webkit } from '@playwright/test';
import { homeDir, transcriptPath, NAV } from './helpers/fixtures.mjs';

const RESERVED = [6677, 6689, 6710, 8788, 8789, 8798, 8799];

export default async function globalSetup() {
  const ui = process.env.R196_UI_BASE;
  const api = process.env.R196_API_BASE;
  if (!ui || !api || !process.env.R196_CTL) throw new Error('ENVIRONMENT_BLOCKED: 用 run-isolated.sh 运行(R196_UI_BASE / R196_API_BASE / R196_CTL 未设置)');
  const uiPort = Number(new URL(ui).port); const apiPort = Number(new URL(api).port);
  if (uiPort !== 6978 || apiPort !== 6977 || RESERVED.includes(uiPort) || RESERVED.includes(apiPort)) throw new Error(`ENVIRONMENT_BLOCKED: 端口 ${uiPort}/${apiPort} 不是本套件的 6978/6977`);
  if (!fs.existsSync(transcriptPath(NAV.sid))) throw new Error(`ENVIRONMENT_BLOCKED: 夹具会话不在 ${homeDir()} 下`);
  const health = await fetch(`${api}/api/health`).catch((e) => { throw new Error(`ENVIRONMENT_BLOCKED: 后端不通 ${e.message}`); });
  if (!health.ok) throw new Error(`ENVIRONMENT_BLOCKED: health HTTP ${health.status}`);
  const browser = await webkit.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
    await page.goto(`${ui}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-cgui="panel-dock"]').waitFor({ state: 'visible', timeout: 150_000 });
  } finally { await browser.close(); }
  process.stdout.write(`[R196] 预检通过:页面 ${ui} 后端 ${api} version=${(await health.json()).version}\n`);
}
