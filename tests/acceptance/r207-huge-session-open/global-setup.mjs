// 跑页面用例之前的预检:确认页面与后端是本套件自己的隔离实例(6958 / 6957),再用一次性浏览器把首页打开一遍热身。
import { webkit } from '@playwright/test';

const RESERVED = [6677, 6689, 6710, 8788, 8789, 8798, 8799];
export default async function globalSetup() {
  const ui = process.env.R207_UI_BASE; const api = process.env.R207_API_BASE;
  if (!ui || !api || !process.env.R207_CTL) throw new Error('ENVIRONMENT_BLOCKED: 用 run.sh 运行(R207_UI_BASE / R207_API_BASE / R207_CTL 未设置)');
  const uiPort = Number(new URL(ui).port); const apiPort = Number(new URL(api).port);
  if (uiPort !== 6958 || apiPort !== 6957 || RESERVED.includes(uiPort) || RESERVED.includes(apiPort)) throw new Error(`ENVIRONMENT_BLOCKED: 端口 ${uiPort}/${apiPort} 不是本套件的 6958/6957`);
  const health = await fetch(`${api}/api/health`).catch((e) => { throw new Error(`ENVIRONMENT_BLOCKED: 后端不通 ${e.message}`); });
  if (!health.ok) throw new Error(`ENVIRONMENT_BLOCKED: health HTTP ${health.status}`);
  const browser = await webkit.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
    await page.goto(`${ui}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-cgui="panel-dock"]').waitFor({ state: 'visible', timeout: 150_000 });
  } finally { await browser.close(); }
  process.stdout.write(`[R207] 预检通过:页面 ${ui} 后端 ${api}\n`);
}
