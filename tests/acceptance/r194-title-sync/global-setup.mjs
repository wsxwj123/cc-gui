// 跑用例之前的一次性预检:确认 BASE_URL 指的是本套件自己的隔离实例、夹具会话在它肚子里;并把首页打开一遍热身(Vite 首次预构建)。
import { webkit } from '@playwright/test';
import { getRuntime, fixtureManifest, EnvironmentBlocked } from './helpers/runtime.mjs';

export default async function globalSetup() {
  const { baseURL, port } = getRuntime();
  const manifest = fixtureManifest();
  const health = await fetch(`${baseURL}/api/health`).catch((e) => { throw new EnvironmentBlocked(`health unreachable at ${baseURL}: ${e.message}`); });
  if (!health.ok) throw new EnvironmentBlocked(`health returned HTTP ${health.status}`);
  const info = await health.json();
  const search = await fetch(`${baseURL}/api/search?q=${encodeURIComponent(manifest.seedMarker)}`).then((r) => r.json());
  if (!(Array.isArray(search?.hits) && search.hits.length)) {
    throw new EnvironmentBlocked(`实例 ${baseURL} 里搜不到夹具会话 ${manifest.seedMarker} —— 这个实例的数据根不是本套件的 .artifacts/runtime-data`);
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
  process.stdout.write(`[R194] 预检通过:实例 ${baseURL}(port=${port} version=${info.version})夹具会话可见,首页已热身\n`);
}
