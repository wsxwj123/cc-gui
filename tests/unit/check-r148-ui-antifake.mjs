#!/usr/bin/env node
// 单测(真实界面):r148 的两条"防假绿"用例 —— 判官复核 r148 时指出下面两条断言单独看不出真假:
//
//   ① r148-perf 的 P6 断言"流式期间输入框渲染次数 ≤ 20"。要是渲染探针根本数不到输入框
//      (组件改了名、探针失效),这个"≤"永远成立。→ 这里补阳性对照:在输入框里真打几个字,
//      探针数到的输入框渲染次数必须 ≥ 1;什么都不做时必须不动。
//   ② r148 P1 把"渲染时现读标题"改成了订阅,但只有源码锚钉着"不再现读",没有任何用例看
//      "标题变了,导出的文件名有没有跟着变"。→ 这里让标题在别处被改一次、真点一次导出,看文件名。
//      (为什么改回"现读"这条会红:会话组件不因标题变化而重渲染,导出按钮拿到的就还是旧标题。
//       两条都实测过"把产品代码改坏会变红":① 把输入框组件改个名(探针数不到 → 打字 0 次);
//       ② 去掉会话组件对标题的订阅、导出按钮改回渲染时现读(文件名停在旧标题)。
//       注意 ② 的变异必须连订阅一起去掉:只把按钮改回现读而订阅还留着,组件照样会因标题变化重渲染,
//       现读也就拿到了新值,这条红不了。)
//
// 为什么放在 tests/unit:tests/acceptance/ 只读。本文件用 node 直接跑,自己起隔离实例(临时 HOME、
// 假 claude)+ dev server + 浏览器,**只读**借用 tests/acceptance/r148-perf 的夹具与界面助手。
// 端口只在 6700–6999 挑空闲的,硬拒 6677 / 6689 / 6710;收尾只结束自己起的两个进程。
// Run: node tests/unit/check-r148-ui-antifake.mjs      (约 40 秒)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKTREE = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const SUITE = path.join(WORKTREE, 'tests', 'acceptance', 'r148-perf');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'r148-antifake-'));
process.env.R118_DATA_ROOT = ROOT;                    // 夹具写到临时目录(必须在加载夹具模块之前)
const HOME = path.join(ROOT, 'home');
const CTL = path.join(HOME, 'fake-claude');
process.env.R118_CTL = CTL;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listening = (port) => {
  try { return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0; } catch { return false; }
};
function pickPort(exclude = []) {
  for (let p = 6700; p <= 6999; p += 1) {
    if ([6677, 6689, 6710].includes(p) || exclude.includes(p)) continue;
    if (!listening(p)) return p;
  }
  throw new Error('6700-6999 没有空闲端口');
}
async function waitHttp(url, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch { /* 还没起来 */ }
    await sleep(500);
  }
  return false;
}

const procs = [];   // 自己起的进程,收尾只结束它们
const cleanup = () => { for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* 已退出 */ } } };
process.on('exit', cleanup);

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').slice(0, 12).join('\n      ')}`); }
};

console.log('r148 防假绿(真实界面)');
let browser = null;
try {
  // ── 夹具 + 隔离实例 + dev server(与 r148-perf/run.sh 同一套做法)──
  const fixtures = await import(path.join(SUITE, 'helpers', 'fixtures.mjs'));
  fixtures.buildFixtures();
  const apiPort = pickPort();
  const uiPort = pickPort([apiPort]);
  const cleanEnv = { ...process.env };
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) delete cleanEnv[k];
  const logs = path.join(ROOT, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const api = spawn(process.execPath, [path.join(WORKTREE, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...cleanEnv, HOME, USERPROFILE: HOME, PORT: String(apiPort), PATH: `${path.join(SUITE, '.artifacts', 'fakebin')}:${process.env.PATH}`, CGUI_FAKE_CLAUDE_DIR: CTL, CGUI_DISABLE_FILE_WATCHER: '1' },
    stdio: ['ignore', fs.openSync(path.join(logs, 'server.log'), 'w'), fs.openSync(path.join(logs, 'server.err.log'), 'w')],
  });
  procs.push(api);
  if (!(await waitHttp(`http://127.0.0.1:${apiPort}/api/health`))) throw new Error(`隔离实例没起来,看 ${logs}/server.log`);
  const vite = spawn(process.execPath, [path.join(WORKTREE, 'client', 'node_modules', 'vite', 'bin', 'vite.js'), '--config', path.join(SUITE, 'vite.dev.config.mjs')], {
    cwd: path.join(WORKTREE, 'client'),
    env: { ...cleanEnv, R118_API_PORT: String(apiPort), R118_UI_PORT: String(uiPort) },
    stdio: ['ignore', fs.openSync(path.join(logs, 'vite.log'), 'w'), fs.openSync(path.join(logs, 'vite.err.log'), 'w')],
  });
  procs.push(vite);
  if (!(await waitHttp(`http://127.0.0.1:${uiPort}/`))) throw new Error(`dev server 没起来,看 ${logs}/vite.log`);

  const { webkit, expect } = await import('@playwright/test');
  const ui = await import(path.join(SUITE, 'helpers', 'ui.mjs'));
  const { NAV, R148 } = fixtures;
  browser = await webkit.launch({ headless: true });
  const newPage = async () => {
    const context = await browser.newContext({ baseURL: `http://127.0.0.1:${uiPort}`, viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(20_000);
    return context.newPage();
  };
  const rendered = (a, b, prefix) => {
    const re = new RegExp(`^${prefix}\\d*$`);
    let n = 0;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (re.test(k)) n += (b[k] || 0) - (a[k] || 0);
    return n;
  };
  const openFixture = async (page, mark) => {
    await ui.boot(page);
    await ui.openSessionBySearch(page, NAV.mark);
    await expect(ui.sessionRow(page, NAV.mark)).toBeVisible({ timeout: 20_000 });
    await ui.openSessionBySearch(page, mark);
    await expect(page.getByText(`${mark} 收到`, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  };

  // ── ① P6 阳性对照 ─────────────────────────────────────────
  await check('① 渲染探针数得到输入框:什么都不做 1.5 秒输入框不渲染;真打 3 个字,输入框渲染次数 ≥ 1', async () => {
    const page = await newPage();
    try {
      await ui.installRenderProbe(page);
      await openFixture(page, R148[25].mark);
      await page.waitForTimeout(3_000);              // 打开会话带起来的加载先落定
      const a = await ui.renderCounts(page);
      await page.waitForTimeout(1_500);
      const b = await ui.renderCounts(page);
      const box = ui.composer(page);
      await box.click();
      const c0 = await ui.renderCounts(page);        // 点一下聚焦可能带来的那次不算在"打字"里
      await box.pressSequentially('abc', { delay: 80 });
      await expect(box).toHaveValue('abc');
      const c = await ui.renderCounts(page);
      const idle = rendered(a, b, 'ChatInput');
      const typed = rendered(c0, c, 'ChatInput');
      console.log(`      [①] 输入框渲染:空闲 1.5 秒 ${idle} 次;打 3 个字 ${typed} 次`);
      assert(idle <= 1, `空闲时输入框不该渲染(实际 ${idle} 次)`);
      assert(typed >= 1, `打了 3 个字,探针数到的输入框渲染次数应 ≥ 1(实际 ${typed}):数不到 = 探针对输入框失效,r148-perf P6 的"≤ 20"就是假绿`);
    } finally { await page.context().close(); }
  });

  // ── ② P1 标题 → 导出文件名 ─────────────────────────────────
  await check('② 会话标题在别处被改之后(本端没有任何操作),导出 Markdown 的文件名跟着变', async () => {
    const page = await newPage();
    try {
      // 导出走 <a download=文件名>.click();记下每次点击的文件名(与浏览器怎么处理下载无关)
      await page.addInitScript(() => {
        window.__r148downloads = [];
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function patched(...args) {
          if (this.download) { window.__r148downloads.push(this.download); return undefined; }   // 记名字,不真下载
          return click.apply(this, args);
        };
      });
      const S = R148[26];
      await openFixture(page, S.mark);
      const exportOnce = async () => {
        const before = await page.evaluate(() => window.__r148downloads.length);
        const exportBtn = page.locator('[data-cgui="session-menu"] button[title="导出当前会话为 Markdown"]').first();
        if (!(await exportBtn.isVisible().catch(() => false))) {
          await page.locator('[data-cgui="session-menu"] > button[title^="更多会话操作"]').first().click();   // 展开「更多」
        }
        await expect(exportBtn, '「更多」里应有导出按钮').toBeVisible({ timeout: 5_000 });
        await exportBtn.click();
        await page.getByRole('button', { name: '下载 Markdown' }).first().click();
        await expect.poll(() => page.evaluate(() => window.__r148downloads.length), { timeout: 5_000 }).toBe(before + 1);
        return page.evaluate(() => window.__r148downloads[window.__r148downloads.length - 1]);
      };
      const first = await exportOnce();
      assert(first.includes(S.mark), `改名前的导出文件名应带原标题(实际「${first}」)`);

      // 标题在**别处**被改:另一端重命名经同步写进来、回合结束后自动生成标题,都是直接写进界面状态库,
      // 本端这时没有任何操作。选这条路径是因为它不夹带任何本端点击 —— 标题变化是会话组件重渲染的唯一理由,
      // 订没订阅一眼分得出。
      const renamed = `R148改名后${Date.now() % 100000}`;
      await page.evaluate(async ([sid, title]) => {
        const mod = await import('/src/stores/sessionStore.js');
        mod.useStore.getState().setCustomTitle(sid, title);
      }, [S.sid, renamed]);
      await expect(page.locator('span[title]').filter({ hasText: renamed }).first(), '会话头应显示新标题').toBeVisible({ timeout: 5_000 });
      await page.waitForTimeout(300);

      const second = await exportOnce();
      console.log(`      [②] 导出文件名:改名前「${first}」→ 改名后「${second}」`);
      assert(second.startsWith(`${renamed}-`), `重命名后导出的文件名应以新标题开头(实际「${second}」)—— 还是旧名说明会话组件没订阅标题`);
    } finally { await page.context().close(); }
  });
} catch (e) {
  failed += 1;
  console.log(`  ✗ 环境没起来:${String(e && e.stack || e).split('\n').slice(0, 6).join('\n      ')}`);
} finally {
  try { if (browser) await browser.close(); } catch { /* 忽略 */ }
  cleanup();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

function assert(cond, message) { if (!cond) throw new Error(message); }

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
