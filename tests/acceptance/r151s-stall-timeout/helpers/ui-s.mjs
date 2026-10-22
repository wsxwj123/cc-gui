// r151s 界面操作层(只用界面上的既有入口与接口文件约定的 data-testid,不 import 产品代码)。
// boot / openSessionSettings 照 r151n、r151b 的同名函数;设置搜索框与 Cmd+0 打开设置照 r122;下拉兼容原生 <select> 与自绘下拉。
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';

export const API_BASE = process.env.R151S_API_BASE || 'http://127.0.0.1:0';
export const SHARED_HOME = process.env.R151S_HOME || '';
export const STALL_URL = () => `${API_BASE}/api/prefs/stall-timeout`;

/** 进应用并压掉引导浮层 / 更新检查。 */
export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 隐私模式 */ } });
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
}

/** 刷新页面并等应用重新挂好。 */
export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
}

/** 打开设置页「会话」tab(入口:面板坞 → 通用 → 「会话」,照 r151b 的 openSessionSettings)。 */
export async function openSessionSettings(page) {
  const toggle = page.locator('[data-testid="panel-dock-toggle"]');
  const gen = page.locator('[data-cgui="panel-dock"] button[title="通用"]').first();
  if (!(await gen.isVisible().catch(() => false))) await toggle.click();
  await gen.click();
  await page.getByRole('button', { name: '会话', exact: true }).first().click();
  // 前置自检:「会话」tab 里既有的跨会话消息区块出现了,才说明入口走对了(之后找不到静默超时下拉才是本轮功能缺失)
  await expect(page.getByTestId('xsession-settings-section'), '前置:已打开设置页「会话」tab(应能看到既有的跨会话消息区块)').toBeVisible({ timeout: 15_000 });
}

export const stallSelect = (page) => page.getByTestId('stall-timeout-select');
export const settingsSearchBox = (page) => page.locator('input[data-testid="settings-search"], [data-testid="settings-search"] input, input[placeholder*="搜索设置"]').first();

/** 打开设置面板并让搜索框可见:先用 Cmd/Ctrl+0(照 r122),不行再走面板坞入口。 */
export async function openSettingsWithSearch(page) {
  const box = settingsSearchBox(page);
  const combo = process.platform === 'darwin' ? 'Meta+0' : 'Control+0';
  try {
    await expect(async () => {
      if (await box.isVisible().catch(() => false)) return;
      await page.keyboard.press(combo);
      await expect(box).toBeVisible({ timeout: 4_000 });
    }).toPass({ timeout: 25_000 });
  } catch {
    await openSessionSettings(page);
  }
  await expect(box, '设置页应有搜索框').toBeVisible({ timeout: 10_000 });
  return box;
}

/** 下拉当前显示:{ kind, text, value, options|null }。原生 <select> 读 options;自绘下拉读 data-value / 文字。 */
export async function readSelect(el) {
  return el.evaluate((e) => {
    if (e.tagName === 'SELECT') {
      const opt = e.options[e.selectedIndex];
      return {
        kind: 'select', value: e.value, text: opt ? opt.textContent.trim() : '',
        options: [...e.options].map((o) => ({ text: o.textContent.trim(), value: o.value })),
      };
    }
    const picked = e.querySelector('[aria-checked="true"],[aria-selected="true"],[data-selected="true"]');
    return {
      kind: e.tagName.toLowerCase(), options: null,
      value: e.getAttribute('data-value') || (picked && picked.getAttribute('data-value')) || e.getAttribute('value') || '',
      text: ((picked && picked.textContent) || e.textContent || '').trim(),
    };
  });
}

/** 在下拉里按文字选一项:原生 <select> 用 selectOption;自绘下拉点开后点选项。 */
export async function chooseOption(page, el, label) {
  const tag = await el.evaluate((e) => e.tagName);
  if (tag === 'SELECT') { await el.selectOption({ label }); return; }
  await el.click();
  await page.getByRole('option', { name: label, exact: true }).first().click();
}

// ---------------- 共享实例的偏好文件(只动临时 HOME 里的文件) ----------------
export const sharedPrefsFile = () => path.join(SHARED_HOME, '.claude-gui', 'prefs.json');
/** 摆场景:把偏好文件里的 stallTimeout 键去掉(= 没设过),其它键原样。 */
export function clearStallKey() {
  const f = sharedPrefsFile();
  let obj = {};
  try { obj = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { obj = {}; }
  delete obj.stallTimeout;
  fs.writeFileSync(f, JSON.stringify(obj, null, 2));
}

/**
 * 让偏好文件写不进去:临时 HOME 下的 .claude-gui 目录改成只读(0555),偏好文件也改成只读(0444)——
 * 无论服务端是"先写临时文件再改名"还是"原地写",都会失败。先断言本进程确实写不进(以 root 运行时权限拦不住,前提不成立)。
 * 返回 restore():把两处权限改回原值(可重复调用)。用例必须在 finally 里调用它。
 */
export function makePrefsUnwritable() {
  const dir = path.join(SHARED_HOME, '.claude-gui');
  const file = sharedPrefsFile();
  const dirMode = fs.statSync(dir).mode & 0o777;
  const fileMode = fs.statSync(file).mode & 0o777;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { fs.chmodSync(dir, dirMode); } catch { /* 目录不在就算了 */ }
    try { fs.chmodSync(file, fileMode); } catch { /* 文件不在就算了 */ }
  };
  fs.chmodSync(file, 0o444);
  fs.chmodSync(dir, 0o555);
  let code = null;
  try { fs.writeFileSync(path.join(dir, `.r151s-probe-${process.pid}`), 'x'); } catch (e) { code = e && e.code; }
  if (code === null) { try { fs.unlinkSync(path.join(dir, `.r151s-probe-${process.pid}`)); } catch { /* */ } }
  if (code !== 'EACCES' && code !== 'EPERM') restore();
  expect(code, `前置:.claude-gui 设为只读后在里面建文件应报 EACCES/EPERM(实际 ${code};以 root 运行时权限拦不住)`).toMatch(/^(EACCES|EPERM)$/);
  return restore;
}
