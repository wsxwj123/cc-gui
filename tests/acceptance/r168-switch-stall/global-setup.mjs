// 预检：BASE_URL / BACKEND_URL 指向本套件自己的隔离实例（127.0.0.1:6890–6899）；夹具会话在它肚子里；两种内核各把首页热身一遍。
import { chromium, webkit } from '@playwright/test';
import { SESSIONS } from './helpers/fixtures.mjs';

const DENY = [6677, 6689, 6710, 8798, 8799];
function checkUrl(name, v) {
  if (!v) throw new Error(`ENVIRONMENT_BLOCKED: 缺 ${name}（请用 run-isolated.sh 跑）`);
  const u = new URL(v);
  const port = Number(u.port);
  if (u.hostname !== '127.0.0.1' || DENY.includes(port) || port < 6890 || port > 6899) {
    throw new Error(`ENVIRONMENT_BLOCKED: ${name}=${v} 不在允许范围（127.0.0.1:6890–6899）`);
  }
}

export default async function globalSetup() {
  checkUrl('BASE_URL', process.env.BASE_URL);
  checkUrl('BACKEND_URL', process.env.BACKEND_URL);
  const L = SESSIONS.L;
  const res = await fetch(`${process.env.BACKEND_URL}/api/sessions/${L.sid}/messages?projectHash=${L.projectHash}&limit=5`)
    .catch((e) => { throw new Error(`ENVIRONMENT_BLOCKED: 后端不可达 ${e.message}`); });
  if (res.status !== 200) throw new Error(`ENVIRONMENT_BLOCKED: 夹具会话 L 在隔离实例里取不到（HTTP ${res.status}）——数据根不是本套件的`);
  for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await type.launch();
    try {
      const page = await (await browser.newContext()).newPage();
      await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
      await page.goto(`${process.env.BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-cgui="panel-dock"]').waitFor({ state: 'visible', timeout: 150_000 });
    } finally {
      await browser.close();
    }
    process.stdout.write(`[R168] ${name} 热身完成\n`);
  }
  process.stdout.write(`[R168] 预检通过：前端 ${process.env.BASE_URL}  后端 ${process.env.BACKEND_URL}\n`);
}
