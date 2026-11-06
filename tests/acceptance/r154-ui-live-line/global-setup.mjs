// 跑用例之前的一次性预检：确认 BASE_URL 指的是**本套件自己的**隔离实例、夹具会话在它肚子里；
// 再用一个一次性浏览器把首页打开一遍（源码直出模式下 Vite 第一次要预构建依赖，先热好，免得第一条用例被拖超时）。
// （实例指错了不会报成环境错，而是一堆像产品缺陷的红 —— 这里提前一句话说清。）
import { webkit } from '@playwright/test';
import { getRuntime, fixtureManifest, EnvironmentBlocked } from './helpers/runtime.mjs';

export default async function globalSetup() {
  const { baseURL, port } = getRuntime();
  const manifest = fixtureManifest();

  const health = await fetch(`${baseURL}/api/health`).catch((e) => {
    throw new EnvironmentBlocked(`health unreachable at ${baseURL}: ${e.message}`);
  });
  if (!health.ok) throw new EnvironmentBlocked(`health returned HTTP ${health.status}`);
  const info = await health.json();

  for (const key of Object.keys(manifest.markers)) {
    const search = await fetch(`${baseURL}/api/search?q=${encodeURIComponent(manifest.markers[key])}`).then((r) => r.json());
    const hit = Array.isArray(search?.hits) ? search.hits.length : 0;
    if (!hit) {
      throw new EnvironmentBlocked(
        `实例 ${baseURL} 里搜不到夹具会话 ${manifest.markers[key]} —— 这个实例的数据根不是本套件的 .artifacts/runtime-data`,
      );
    }
  }

  const browser = await webkit.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-cgui="panel-dock"]').waitFor({ state: 'visible', timeout: 150_000 }).catch((e) => {
      throw new EnvironmentBlocked(`热身：首页 150s 内没画出来（${e.message.split('\n')[0]}）`);
    });
  } finally {
    await browser.close();
  }
  process.stdout.write(`[R154] 预检通过：实例 ${baseURL}（port=${port} version=${info.version}）夹具会话可见，首页已热身\n`);
}
