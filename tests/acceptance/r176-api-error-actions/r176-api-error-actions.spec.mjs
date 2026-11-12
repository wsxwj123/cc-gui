// r176-api-error-actions 黑盒验收:接口报错(鉴权 / 内容审核 / 空内容块)下方的动作按钮要在回合结束后一直留在页面上。
// 只依据接口文件的行为清单 B1–B12;只通过页面观测(文案 / role / data-* 锚点);假命令行见 helpers/fake-claude.mjs。
// 「持续可见」= 回合结束(停止键消失)起连续观察 3 秒,每 100 毫秒看一次(31 次),每一次都在。
import { test, expect } from '@playwright/test';
import {
  openApp, newSessionDesktop, newSessionMobile, sendText, waitTurnEnded, uniqueTag, reopenSessionByTag, reloadApp,
  probe, sampleProbe, persistenceFailures,
} from './helpers/runtime.mjs';

const BTN_PROVIDER = { key: 'provider', kind: 'button', re: '检查 Provider 设置' };
const BTN_ROLLBACK = { key: 'rollback', kind: 'button', re: '^回退到上一条' };
const BTN_NEWSESSION = { key: 'newSession', kind: 'button', re: '^新开会话[(（]带上最后一条消息[)）]' };
const BTN_CLEANUP = { key: 'cleanup', kind: 'button', re: '^体检与清理' };
const TXT_REVIEW = { key: 'review', kind: 'text', re: '内容审核' };

const AUTH = { anchor: 'Failed to authenticate', items: [BTN_PROVIDER] };
const RISK = { anchor: 'API Error: 400 Content Exists Risk', items: [TXT_REVIEW, BTN_ROLLBACK, BTN_NEWSESSION] };
const EMPTY = { anchor: 'API Error: 400 messages.1.content.0.text', items: [BTN_CLEANUP] };
const PRE = { anchor: '❌', items: [BTN_PROVIDER] };
const NOTHING = { anchor: '❌', items: [BTN_PROVIDER, BTN_ROLLBACK, BTN_CLEANUP] };

/** 桌面:新会话里发一条消息,等回合结束。返回这条消息里的唯一标签(之后用它在侧栏找回会话)。 */
async function sendInNewSession(page, marker, tailText = '你好') {
  const tag = uniqueTag('Z');
  await openApp(page);
  await newSessionDesktop(page);
  await sendText(page, marker ? `${marker} ${tailText} ${tag}` : `${tailText} ${tag}`);
  await waitTurnEnded(page);
  return tag;
}

/** 回合结束后连续 3 秒,每一次都要:报错原文在 + 指定的每一项都在报错下方。 */
async function expectPersistent(page, spec, keys, what) {
  const samples = await sampleProbe(page, spec);
  const { total, bad } = persistenceFailures(samples, keys);
  expect(bad.length, `${what}:${total} 次探测里有 ${bad.length} 次缺东西;第一处 = 第 ${bad[0]?.i} 次(+${bad[0] ? bad[0].at - samples[0].at : 0}ms)缺 ${bad[0]?.missing.join('、')}`).toBe(0);
}

/** 重新打开会话后(不要求持续 3 秒):等到报错原文在 + 指定项都在报错下方。 */
async function expectPresent(page, spec, keys, what) {
  await expect.poll(async () => {
    const r = await probe(page, spec);
    const missing = [];
    if (r.anchorsAnywhere < 1) missing.push('报错原文');
    for (const k of keys) if (!(r.items[k] && r.items[k].below >= 1)) missing.push(k);
    return missing.join('、');
  }, { timeout: 15_000, message: what }).toBe('');
}

/** 连续 1.5 秒(16 次)每一次都没有这些东西。返回出现过的次数。 */
async function absentFor(page, spec, keys, withAnchor) {
  const samples = await sampleProbe(page, spec, { count: 16 });
  const seen = [];
  samples.forEach((s, i) => {
    const hit = keys.filter((k) => s.r.items[k] && s.r.items[k].any > 0);
    if (withAnchor && s.r.anchorsAnywhere > 0) hit.push('报错块');
    if (hit.length) seen.push({ i, hit });
  });
  return seen;
}

// ───────────────────────── 鉴权报错 ─────────────────────────
test('B1 新会话发 R176AUTH:报错原文下方有「检查 Provider 设置」按钮,回合结束后持续可见', async ({ page }) => {
  await sendInNewSession(page, 'R176AUTH');
  await expectPersistent(page, AUTH, ['provider'], '鉴权报错下方的「检查 Provider 设置」按钮没有持续可见');
});

test('B2 鉴权报错:点「检查 Provider 设置」→ 顶栏 Provider 弹层打开(出现「管理 Provider」)', async ({ page }) => {
  await sendInNewSession(page, 'R176AUTH');
  const btn = page.getByRole('button', { name: /检查 Provider 设置/ }).first();
  await expect(btn, '回合结束后页面上应有「检查 Provider 设置」按钮').toBeVisible();
  await btn.click();
  await expect(page.getByText('管理 Provider').first(), '点按钮后应出现「管理 Provider」字样').toBeVisible({ timeout: 10_000 });
});

test('B3 鉴权报错:刷新页面并在侧栏重新点开会话,报错下方仍有「检查 Provider 设置」按钮', async ({ page }) => {
  const tag = await sendInNewSession(page, 'R176AUTH');
  await reloadApp(page);
  await reopenSessionByTag(page, tag);
  await expectPresent(page, AUTH, ['provider'], '刷新并重新点开会话后,报错下方应仍有「检查 Provider 设置」按钮');
});

test('B4 鉴权报错:消息区里以「Failed to authenticate」开头的消息只有一条(原文不重复)', async ({ page }) => {
  await sendInNewSession(page, 'R176AUTH');
  const samples = await sampleProbe(page, AUTH, { count: 16 });
  const counts = samples.map((s) => s.r.anchors);
  expect(counts.every((c) => c === 1), `消息区里以「Failed to authenticate」开头的文字,逐次探测的个数 = ${JSON.stringify(counts)}(应全是 1)`).toBe(true);
});

test('B5 鉴权报错之后同一会话再发「你好」(正常回复):页面上没有「检查 Provider 设置」按钮', async ({ page }) => {
  await sendInNewSession(page, 'R176AUTH');
  await sendText(page, '你好');
  await waitTurnEnded(page);
  await expect(page.getByText('好的', { exact: true }).first(), '前置:第二回合的正常回复「好的」应已显示').toBeVisible({ timeout: 10_000 });
  const seen = await absentFor(page, NOTHING, ['provider'], false);
  expect(seen, `正常回复之后页面上不应再有「检查 Provider 设置」按钮;出现过 ${seen.length} 次`).toEqual([]);
});

test('B6 手机宽度(390×844)发 R176AUTH:报错原文在,页面上没有「检查 Provider 设置」按钮', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await openApp(page, { mobile: true });
    await newSessionMobile(page);
    await sendText(page, `R176AUTH 你好 ${uniqueTag('Z')}`);
    await waitTurnEnded(page);
    const samples = await sampleProbe(page, AUTH, { count: 16 });
    const noAnchor = samples.filter((s) => s.r.anchorsAnywhere < 1).length;
    const withBtn = samples.filter((s) => s.r.items.provider.any > 0).length;
    expect(noAnchor, `手机宽度下报错原文应一直在;缺席 ${noAnchor}/${samples.length} 次`).toBe(0);
    expect(withBtn, `手机宽度下不应出现「检查 Provider 设置」按钮;出现 ${withBtn}/${samples.length} 次`).toBe(0);
  } finally {
    await context.close();
  }
});

// ───────────────────────── 内容审核拒绝 ─────────────────────────
test('B7 新会话发 R176RISK:报错下方有「内容审核」说明与「回退到上一条…」「新开会话(带上最后一条消息)」两个按钮,持续可见', async ({ page }) => {
  await sendInNewSession(page, 'R176RISK');
  await expectPersistent(page, RISK, ['review', 'rollback', 'newSession'], '内容审核报错下方的说明文字与两个按钮没有持续可见');
});

test('B8 内容审核报错:刷新并在侧栏重新点开会话,说明文字与两个按钮仍在', async ({ page }) => {
  const tag = await sendInNewSession(page, 'R176RISK');
  await reloadApp(page);
  await reopenSessionByTag(page, tag);
  await expectPresent(page, RISK, ['review', 'rollback', 'newSession'], '刷新并重新点开会话后,内容审核的说明与两个按钮应仍在报错下方');
});

test('B9 内容审核报错之后同一会话再发「你好」(正常回复):页面上没有这两个按钮', async ({ page }) => {
  await sendInNewSession(page, 'R176RISK');
  await sendText(page, '你好');
  await waitTurnEnded(page);
  await expect(page.getByText('好的', { exact: true }).first(), '前置:第二回合的正常回复「好的」应已显示').toBeVisible({ timeout: 10_000 });
  const seen = await absentFor(page, RISK, ['rollback', 'newSession'], false);
  expect(seen, `正常回复之后页面上不应再有这两个按钮;出现过 ${seen.length} 次,首次 = ${JSON.stringify(seen[0])}`).toEqual([]);
});

// ───────────────────────── 官方拒收空内容块 ─────────────────────────
test('B10 新会话发 R176EMPTY:报错下方有「体检与清理…」按钮,持续可见', async ({ page }) => {
  await sendInNewSession(page, 'R176EMPTY');
  await expectPersistent(page, EMPTY, ['cleanup'], '空内容块报错下方的「体检与清理」按钮没有持续可见');
});

// ───────────────────────── 相邻回归 ─────────────────────────
test('B11 新会话发 R176PRE(预检报错):有「❌」开头的报错块,其下方有「检查 Provider 设置」按钮,持续可见', async ({ page }) => {
  await sendInNewSession(page, 'R176PRE');
  await expectPersistent(page, PRE, ['provider'], '预检报错的「❌」块下方的「检查 Provider 设置」按钮没有持续可见');
});

test('B12 新会话发「你好」(正常回复):没有「检查 Provider 设置」「回退到上一条」「体检与清理」按钮,也没有「❌」报错块', async ({ page }) => {
  await sendInNewSession(page, null);
  await expect(page.getByText('好的', { exact: true }).first(), '前置:正常回复「好的」应已显示').toBeVisible({ timeout: 10_000 });
  const seen = await absentFor(page, NOTHING, ['provider', 'rollback', 'cleanup'], true);
  expect(seen, `正常回复之后页面上不应出现这些按钮 / 报错块;出现过 ${seen.length} 次,首次 = ${JSON.stringify(seen[0])}`).toEqual([]);
});
