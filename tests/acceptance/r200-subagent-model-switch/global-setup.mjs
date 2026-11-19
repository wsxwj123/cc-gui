// 跑用例之前的一次性预检:确认 BASE_URL 指的是本套件自己的隔离实例、夹具会话在它肚子里;再用一次性浏览器把首页打开一遍热身。
import { webkit } from '@playwright/test';
import { getRuntime, fixtureManifest, EnvironmentBlocked } from './helpers/runtime.mjs';

export default async function globalSetup() {
  const { baseURL, port, backend } = getRuntime();
  const manifest = fixtureManifest();
  const health = await fetch(`${backend}/api/health`).catch((e) => { throw new EnvironmentBlocked(`health unreachable at ${backend}: ${e.message}`); });
  if (!health.ok) throw new EnvironmentBlocked(`health returned HTTP ${health.status}`);
  const info = await health.json();
  const search = await fetch(`${backend}/api/search?q=${encodeURIComponent(manifest.seed.marker)}`).then((r) => r.json());
  if (!(Array.isArray(search?.hits) && search.hits.length)) {
    throw new EnvironmentBlocked(`实例 ${backend} 里搜不到夹具会话 ${manifest.seed.marker} —— 数据根不是本套件的 .artifacts/runtime-data`);
  }
  const browser = await webkit.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-cgui="panel-dock"]').waitFor({ state: 'visible', timeout: 150_000 }).catch((e) => {
      throw new EnvironmentBlocked(`热身:首页 150s 内没画出来(${e.message.split('\n')[0]})`);
    });
  } finally {
    await browser.close();
  }
  process.stdout.write(`[R200] 预检通过:页面 ${baseURL}(port=${port})后端 ${backend} version=${info.version},夹具会话可见,首页已热身\n`);
}
