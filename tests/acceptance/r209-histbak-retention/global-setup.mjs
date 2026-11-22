// 第一段用例之前的预检:BASE_URL 必须是本套件自己的隔离实例(夹具里的 u1 会话搜得到),再把首页打开一遍热身(Vite 第一次要预构建依赖)。
import { webkit } from '@playwright/test';
import { getRuntime, fixtureManifest, EnvironmentBlocked } from './helpers/common.mjs';

export default async function globalSetup() {
  const { baseURL } = getRuntime();
  const manifest = fixtureManifest();
  const health = await fetch(`${baseURL}/api/health`).catch((e) => { throw new EnvironmentBlocked(`health unreachable at ${baseURL}: ${e.message}`); });
  if (!health.ok) throw new EnvironmentBlocked(`health returned HTTP ${health.status}`);
  const search = await fetch(`${baseURL}/api/search?q=${encodeURIComponent(manifest.sessions.u1.marker)}`).then((r) => r.json());
  if (!(Array.isArray(search?.hits) && search.hits.length)) throw new EnvironmentBlocked(`实例 ${baseURL} 里搜不到夹具会话 ${manifest.sessions.u1.marker}:数据根不是本套件的 .artifacts`);
  const browser = await webkit.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-cgui="panel-dock"]').waitFor({ state: 'visible', timeout: 150_000 }).catch((e) => {
      throw new EnvironmentBlocked(`热身:首页 150s 内没画出来(${e.message.split('\n')[0]})`);
    });
  } finally { await browser.close(); }
  process.stdout.write(`[R209] 预检通过:${baseURL}\n`);
}
