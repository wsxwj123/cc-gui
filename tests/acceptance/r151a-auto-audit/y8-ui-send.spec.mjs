// H 组:发送时(INTERFACE Y.3.4 "发送时")—— 档位降级与提示条、开关开时照发 auto、四句 CLI 原文触发的回退。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { useProvider, useOfficial, tpAutoOn, tpAutoOff, resetOverrides, setTpAuto, writeScript, snapshot, SETTINGS } from './helpers/api.mjs';
import { boot, openFreshSession, chooseMode, chooseModeByTitle, sendPrompt, recordChatPosts, selector, readLocal } from './helpers/ui.mjs';
import { UI, AUTO_UNAVAILABLE_PHRASES } from './helpers/texts.mjs';
import { provider } from './helpers/scenes.mjs';

let saved = {};
test.beforeEach(async () => { saved = snapshot([SETTINGS()]); await tpAutoOff(); resetOverrides({}); });
test.afterEach(async () => { for (const [p, c] of Object.entries(saved)) if (c !== null) fs.writeFileSync(p, c); });

const banner = (page) => page.getByText(UI.SEND_DOWNGRADE_BANNER, { exact: false });
const firstPost = async (posts) => { await expect.poll(() => posts.length, { message: '应发出 POST /api/chat', timeout: 15_000 }).toBeGreaterThan(0); return posts[0]; };

/** 官方下选好「自动」,再在不刷新页面的情况下切到第三方(开关关)。 */
async function autoThenThirdParty(page, tag) {
  await useOfficial();
  await boot(page);
  await openFreshSession(page, tag);
  await chooseModeByTitle(page, '自动');
  await expect(selector(page), '前置:会话档位已是「自动」').toContainText('自动');
  await useProvider(await provider('main'));
  await page.waitForTimeout(2_000);   // 等界面收到 provider 变化
}

test('H1 官方下选了「自动」→ 切到第三方(开关关)→ 发送:请求体 permissionMode 为 "default"', async ({ page }) => {
  await autoThenThirdParty(page, 'h1');
  const posts = recordChatPosts(page);
  await sendPrompt(page, 'R151 H1 发一句');
  expect((await firstPost(posts)).permissionMode).toBe('default');
});

test('H1b 同上:出现提示条「「自动」权限档在第三方 provider 下默认关闭,本会话已切回「逐步确认」…」', async ({ page }) => {
  await autoThenThirdParty(page, 'h1b');
  await sendPrompt(page, 'R151 H1b 发一句');
  await expect(banner(page)).toBeVisible({ timeout: 10_000 });
});

test('H1c 同上:发送后会话档位回写成「逐步确认」', async ({ page }) => {
  await autoThenThirdParty(page, 'h1c');
  await sendPrompt(page, 'R151 H1c 发一句');
  await expect(selector(page)).toContainText('逐步确认', { timeout: 10_000 });
});

test('H1d 第三方 + 开关开时选了自动档 → 开关被关掉 → 发送:请求体为 "default" 且出现提示条', async ({ page }) => {
  await useProvider(await provider('main'));
  await tpAutoOn();
  await boot(page);
  await openFreshSession(page, 'h1d');
  await chooseMode(page, 'auto');
  expect((await setTpAuto(false)).status).toBe(200);
  await page.waitForTimeout(1_500);
  const posts = recordChatPosts(page);
  await sendPrompt(page, 'R151 H1d 发一句');
  expect((await firstPost(posts)).permissionMode).toBe('default');
  await expect(banner(page)).toBeVisible({ timeout: 10_000 });
});

test('H2 第三方 + 开关开 + 档位 auto → 请求体 permissionMode 为 "auto",不出提示条', async ({ page }) => {
  await useProvider(await provider('main'));
  await tpAutoOn();
  await boot(page);
  await openFreshSession(page, 'h2');
  await chooseMode(page, 'auto');
  const posts = recordChatPosts(page);
  await sendPrompt(page, 'R151 H2 发一句');
  expect((await firstPost(posts)).permissionMode).toBe('auto');
  await page.waitForTimeout(2_000);
  await expect(banner(page)).toHaveCount(0);
});

for (const [i, phrase] of AUTO_UNAVAILABLE_PHRASES.entries()) {
  test(`H3 第三方 + 自动档,回合报错含「${phrase}」→ 记不可用(tp:<id>|模型)、切回逐步确认、自动重发一次`, async ({ page }) => {
    const id = await provider('main');
    await useProvider(id);
    await tpAutoOn();
    const name = `h3-${i}-${Date.now().toString(36)}`;
    writeScript(name, [{ errorIfMode: { mode: 'auto', text: `API Error: 400 {"type":"error","error":{"message":"${phrase}"}}` } }, { say: 'R151-H3-RESENT-OK' }]);
    await boot(page);
    await openFreshSession(page, `h3${i}`);
    await chooseMode(page, 'auto');
    const posts = recordChatPosts(page);
    await sendPrompt(page, `R151S:${name} 发一句`);
    await expect.poll(() => posts.length, { message: '应自动重发一次(共 2 次 POST)', timeout: 20_000 }).toBe(2);
    expect(posts[0].permissionMode).toBe('auto');
    expect(posts[1].permissionMode).toBe('default');
    const marks = JSON.parse((await readLocal(page, 'cgui-auto-unavailable')) || '{}');
    expect(marks[`tp:${id}|r151-chat`]).toBe(true);
    await expect(selector(page)).toContainText('逐步确认');
  });
}

test('H4 第三方 + 自动档,回合报错不含那四句 → 不记不可用、不切档、不重发', async ({ page }) => {
  const id = await provider('main');
  await useProvider(id);
  await tpAutoOn();
  const name = `h4-${Date.now().toString(36)}`;
  // 真实 CLI 回合以 API 报错结束时,会话记录里也会留下这条报错(界面刷新历史以会话记录为准),所以让假 claude 照样写进去。
  writeScript(name, [{ errorIfMode: { mode: 'auto', status: 500, transcript: true, text: 'API Error: 500 {"type":"error","error":{"message":"upstream overloaded, auto retry later"}}' } }]);
  await boot(page);
  await openFreshSession(page, 'h4');
  await chooseMode(page, 'auto');
  const posts = recordChatPosts(page);
  await sendPrompt(page, `R151S:${name} 发一句`);
  await expect(page.getByText('upstream overloaded', { exact: false }).first(), '报错应显示出来').toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2_500);
  expect(posts.length, '不应重发').toBe(1);
  const marks = JSON.parse((await readLocal(page, 'cgui-auto-unavailable')) || '{}');
  expect(Object.keys(marks).filter((k) => k.startsWith('tp:'))).toEqual([]);
  await expect(selector(page)).toContainText('自动');
});
