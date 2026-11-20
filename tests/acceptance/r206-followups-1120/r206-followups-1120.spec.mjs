// r206-followups-1120 黑盒验收:「安全检查」说明行什么时候该画、什么时候不该画。
// 只依据接口文件(.devflow/r206-followups-1120-接口.md)的行为清单 1~5;只通过页面观测(文案 / 挂点 / title)。
// 编号:S1/S2 = 清单 1/2(读历史·子代理页);S3/S4 = 清单 3/4(直播·主对话);S5 = 清单 5(读历史·主对话)。
// 清单 6(live-subcost 套件的假命令行)不在本套件里:由 live-subcost-20260913 自己跑一遍并核对没有残留进程。
// 清单 1、3、5 是「现在会画、修好后不该画」的缺陷,断言「页面上没有含『安全检查』的说明行」;2、4 是回归。
// 假命令行见 helpers/fake-claude.mjs;历史用例直接把会话记录铺成文件(helpers/fixtures.mjs),再刷新页面打开。
import { test, expect } from '@playwright/test';
import { seedWorkspace, seedStatic, writeScenario } from './helpers/fixtures.mjs';
import {
  openNewSession, openStaticSession, sendText, waitTurnEnded,
  expandGroup, openSubagentView, messageList, norm, uniqueTag,
} from './helpers/runtime.mjs';
import { ARROW } from './helpers/transcripts.mjs';

const FABLE = 'claude-fable-5-1';
const OPUS = 'claude-opus-5';
const SWITCHED = `${FABLE}${ARROW}${OPUS}`;
const NEW_MODEL_RE = /claude-opus-5(?![-\d])/;
const NOTICE_WORD = '安全检查';

test.beforeEach(async ({ page }) => {
  page.__pageErrors = [];
  page.__dialogs = [];
  page.on('pageerror', (e) => page.__pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('dialog', (d) => { page.__dialogs.push(d.message()); d.dismiss().catch(() => {}); });
});
test.afterEach(async ({ page }) => {
  // 刷新页面时被取消的在途请求(WebKit 报「… due to access control checks」)是与本套件无关的环境噪声,不算页面错误
  const real = page.__pageErrors.filter((m) => !/due to access control checks/.test(m));
  expect(real, '页面不应有未捕获的错误(pageerror)').toEqual([]);
});

const textOf = async (loc) => norm(await loc.first().innerText().catch(() => ''));

/** 把消息区里还收着的折叠组都点开(说明行可能收在折叠组里)。 */
async function expandAllGroups(page) {
  const heads = page.locator('[data-work-group-head]');
  const n = await heads.count();
  for (let i = 0; i < n; i += 1) {
    const h = heads.nth(i);
    if ((await h.getAttribute('aria-expanded').catch(() => 'true')) === 'false') await h.click().catch(() => {});
  }
}

/** 范围里「同时含全部 needles(字符串或正则)的最小元素」的可见文字;没有返回 null。用来认「一行说明」。 */
async function noticeIn(locator, needles) {
  return await locator.first().evaluate((root, specs) => {
    const tests = specs.map((s) => (s.re ? new RegExp(s.re) : { test: (t) => t.includes(s.str) }));
    const all = (el) => tests.every((t) => t.test(el.innerText || ''));
    let best = null;
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (!all(el)) continue;
      if (!best || (el.innerText || '').length < (best.innerText || '').length) best = el;
    }
    return best ? (best.innerText || '').replace(/\s+/g, ' ').trim() : null;
  }, needles.map((n) => (n instanceof RegExp ? { re: n.source } : { str: n })));
}

/** 消息区里含「安全检查」的行(按换行切开)。 */
const noticeLines = async (page) => (await messageList(page).first().innerText()).split('\n').filter((l) => l.includes(NOTICE_WORD));

// ───────────────────────── 清单 1~2:读历史·子代理页 ─────────────────────────
test('S1【缺陷】读历史·子代理·被拦(fable)后紧跟的下一次调用还是 fable、之后才换 opus:子代理页显示「fable → opus」,但没有含「安全检查」的说明', async ({ page }) => {
  const ctx = seedStatic(uniqueTag('t'), { sub: { models: [FABLE, FABLE, OPUS, OPUS], format: 'new', refuse: { at: 0, category: 'bio' } } });
  await openStaticSession(page, ctx);
  await expandGroup(page);
  const view = await openSubagentView(page);
  await expect.poll(() => textOf(view), { message: 'S1:子代理页应显示换过模型', timeout: 20_000 }).toContain(SWITCHED);
  await expect.poll(() => textOf(view), { message: 'S1:子代理页要先加载出最后一段回复', timeout: 20_000 }).toContain('R206-SUB-DONE-3');
  await page.waitForTimeout(1500);
  expect(await noticeIn(view, [NOTICE_WORD]), 'S1:子代理页里不应有任何含「安全检查」的元素').toBeNull();
  expect(await textOf(view), 'S1:子代理页文字里不应有「安全检查」').not.toContain(NOTICE_WORD);
  expect(await textOf(messageList(page)), 'S1:主消息区里也不应有「安全检查」').not.toContain(NOTICE_WORD);
});

test('S2【回归】读历史·子代理·被拦的那条(fable)之后紧跟的下一条就是 opus:子代理页显示「fable → opus」,并有一行同时含 fable、opus、「安全检查」、bio 的说明', async ({ page }) => {
  const ctx = seedStatic(uniqueTag('t'), { sub: { models: [FABLE, FABLE, OPUS, OPUS], format: 'new', refuse: { at: 1, category: 'bio' } } });
  await openStaticSession(page, ctx);
  await expandGroup(page);
  const view = await openSubagentView(page);
  await expect.poll(() => textOf(view), { message: 'S2:子代理页应显示换过模型', timeout: 20_000 }).toContain(SWITCHED);
  await expect.poll(() => noticeIn(view, [FABLE, NEW_MODEL_RE, NOTICE_WORD, 'bio']), {
    message: `S2:子代理页应有一个元素同时含 ${FABLE}、${OPUS}、安全检查、bio`, timeout: 15_000,
  }).not.toBeNull();
});

// ───────────────────────── 清单 3~4:直播·主对话 ─────────────────────────
async function liveMainSwitch(page, scope) {
  const ctx = seedWorkspace(uniqueTag('t'));
  writeScenario(ctx.workspaceName, { form: 'main-switch', category: 'bio', scope });
  await openNewSession(page, ctx);
  await sendText(page, `你好 ${uniqueTag('M')}`);
  await expect(messageList(page), '换模型前那段回复应先显示').toContainText('R206-BEFORE', { timeout: 30_000 });
  await waitTurnEnded(page);
  await expect(messageList(page), '换模型后的回复应照常显示完').toContainText('R206-AFTER', { timeout: 20_000 });
  await expandAllGroups(page);
}

test('S3【缺陷】直播·主对话:命令行发来的换模型通知 scope 为 local → 这一轮里没有含「安全检查」的说明行,回复照常显示', async ({ page }) => {
  await liveMainSwitch(page, 'local');
  await page.waitForTimeout(2000);
  await expandAllGroups(page);
  const lines = await noticeLines(page);
  expect(lines, `S3:scope=local 的通知不应在主对话画说明行;实际含「安全检查」的行 = ${JSON.stringify(lines)}`).toEqual([]);
  expect(await noticeIn(messageList(page), [NOTICE_WORD]), 'S3:主消息区里不应有任何含「安全检查」的元素').toBeNull();
});

test('S4【回归】直播·主对话:同样的通知 scope 为 session → 这一轮里有一行同时含 claude-opus-5-5、claude-opus-5、「安全检查」的说明', async ({ page }) => {
  await liveMainSwitch(page, 'session');
  await expect.poll(() => noticeIn(messageList(page), ['claude-opus-5-5', NEW_MODEL_RE, NOTICE_WORD]), {
    message: 'S4:这一轮应有一个元素同时含 claude-opus-5-5、claude-opus-5、安全检查', timeout: 15_000,
  }).not.toBeNull();
});

// ───────────────────────── 清单 5:读历史·主对话 ─────────────────────────
test('S5【缺陷】读历史·主对话:会话记录里落盘的换模型记录 scope 为 local → 刷新后打开会话,这一轮里没有含「安全检查」的说明行', async ({ page }) => {
  const ctx = seedStatic(uniqueTag('t'), { kind: 'main-switch', category: 'bio', scope: 'local' });
  await openStaticSession(page, ctx);
  await expandAllGroups(page);
  await expect(messageList(page), 'S5:会话应已加载(含换模型前的那段回复)').toContainText('R206-BEFORE', { timeout: 20_000 });
  await page.waitForTimeout(2000);
  await expandAllGroups(page);
  const lines = await noticeLines(page);
  expect(lines, `S5:scope=local 的落盘记录不应画说明行;实际含「安全检查」的行 = ${JSON.stringify(lines)}`).toEqual([]);
  expect(await noticeIn(messageList(page), [NOTICE_WORD]), 'S5:主消息区里不应有任何含「安全检查」的元素').toBeNull();
});
