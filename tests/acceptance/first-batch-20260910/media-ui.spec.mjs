import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  EnvironmentBlocked,
  expectImageDecoded,
  fixtureSection,
  getRuntime,
  openFixtureFile,
  openFixtureSession,
} from './helpers/runtime.mjs';

// 夹具载体与制备前提（本套件不用会话级 URL：产品任何路径都渲染首页，夹具一律经公开 UI 点选打开，
// 导航实现见 helpers/runtime.mjs 的 openFixtureSession / openFixtureFile，细节见 README「夹具导航」）。
//
// - markdown 段（FB-T19/T20/T21/T23）夹具 = 夹具项目根目录下的 markdown 文件（manifest.markdown.fileName）。
//   导航：侧栏搜索 manifest.markdown.sessionSearchMarker → 打开该项目会话（文件面板的根取活动会话的项目）
//   → 顶栏「设置」→「文件」→ 点文件名 → 文件预览。文件预览同样是产品渲染 Markdown 的公开表面，
//   同样给出"复制/运行"入口（黑盒可见，实测与断言同形），R05/R06 的断言（图片真实解码、围栏原文复制、
//   正文不误转图片、运行确认框）在此完全保留。局限：本轮没有模型凭据，聊天回复里的同一批断言
//   （回复 Markdown 表面）未覆盖，需在具备真实模型凭据时补验——见 README 的不可制备清单。
//   操作者需准备：① 夹具项目里至少一条可被侧栏搜索到的会话（该会话任意人工消息里带
//   sessionSearchMarker，无需模型凭据即可发送）；② 项目根目录下的 markdown 文件，含围栏/行内代码/
//   可运行代码块/图片入口；③ FB-T19 另需文件里的图片指向真实 Windows 路径，并在 Windows 主机上跑。
// - FB-T22（R06 真实流）夹具 = 运行中的实时流会话（manifest.markdown.streamingSessionSearchMarker）。
//   当前隔离实例无模型登录态：该夹具不可制备——需要操作者提供一次性低额度 CLI/model 账户、
//   在隔离实例里跑起真实流，并设 FIRST_BATCH_ALLOW_MODEL=1；未设开关时按设计报 ENVIRONMENT_BLOCKED。
// - attachments 段 FB-T25（实时并入）夹具 = 运行中的会话（manifest.attachments.mergeSessionSearchMarker），
//   同样需要真实模型/CLI，无凭据时不可制备（同上，FIRST_BATCH_ALLOW_MODEL=1 才跑）。
//   另注：并入按钮的可达性依赖"活动运行中的队列状态"——并入按钮只对队列里的消息渲染，队列为空时整块不渲染。
//   本轮无模型凭据，无法实测该交互路径，步骤保持原样；需在有模型凭据的实跑中确认按钮归属
//   （点击的应是刚排队的那条消息，而不是别的队列项）。
// - attachments 段 FB-T26–T30 夹具 = 一条经公开 UI 真实发送的“2 图 + 1 文件 + 说明”附件消息，
//   用 manifest.attachments.sessionSearchMarker 定位其所在会话。无模型凭据也可制备：发送后本回合
//   以本地“需要登录”提示结束，但人工消息与附件照常入历史（FB-T26 刷新后仍只一条）。

function requireString(section, key) {
  if (typeof section?.[key] !== 'string' || !section[key]) {
    throw new EnvironmentBlocked(`fixture field ${key} is required`);
  }
  return section[key];
}

async function imageByAlt(page, alt) {
  const image = page.getByAltText(alt, { exact: true }).first();
  await expectImageDecoded(image);
  return image;
}

test('FB-T19 R05 reproduction [Windows]: encoded backslash/space path decodes once and renders a real image', async ({ page }) => {
  const { manifest } = getRuntime({ requireManifest: true });
  if (process.platform !== 'win32' || manifest.platform !== 'windows') {
    throw new EnvironmentBlocked('run FB-T19 on a Windows host/build with the prepared Windows-path markdown fixture');
  }
  const section = fixtureSection('markdown');
  await openFixtureFile(page, section);
  await imageByAlt(page, requireString(section, 'windowsImageAlt'));
  await imageByAlt(page, requireString(section, 'percentImageAlt'));
});

test('FB-T20 R05 adjacent regression: path-like text in prose, quotes, and code remains text', async ({ page }) => {
  const section = fixtureSection('markdown');
  await openFixtureFile(page, section);
  const marker = requireString(section, 'pathFalsePositiveMarker');
  const region = page.getByText(marker, { exact: false }).first();
  await expect(region).toBeVisible();
  await expect(region.locator('img')).toHaveCount(0);
});

test('FB-T21 R06 reproduction: nested backtick and tilde fences render and copy byte-for-byte', async ({ page, context }) => {
  const { baseURL } = getRuntime({ requireManifest: true });
  const section = fixtureSection('markdown');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  await openFixtureFile(page, section);
  const marker = requireString(section, 'fenceMarker');
  const expected = requireString(section, 'expectedFenceCopy');
  const block = page.locator('pre').filter({ hasText: marker }).first();
  await expect(block).toBeVisible();
  const copy = block.locator('xpath=..').getByRole('button', { name: /复制|copy/i }).first();
  await copy.click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(expected);
  await expect(block.locator('img')).toHaveCount(0);
});

test('FB-T22 R06 adjacent regression: inline code and an unfinished streamed fence never become an image', async ({ page }) => {
  if (process.env.FIRST_BATCH_ALLOW_MODEL !== '1') {
    throw new EnvironmentBlocked('FB-T22 needs the isolated live-stream fixture and FIRST_BATCH_ALLOW_MODEL=1');
  }
  const section = fixtureSection('markdown');
  await openFixtureSession(page, section, { markerKey: 'streamingSessionSearchMarker' });
  const inline = page.getByText(requireString(section, 'inlineMarker'), { exact: false }).first();
  const unfinished = page.getByText(requireString(section, 'unfinishedFenceMarker'), { exact: false }).first();
  await expect(inline).toBeVisible();
  await expect(unfinished).toBeVisible();
  await expect(inline.locator('img')).toHaveCount(0);
  await expect(unfinished.locator('img')).toHaveCount(0);
});

test('FB-T23 R06/R29 code-run cancellation: full command is shown and cancel creates no shell or input', async ({ page, request }) => {
  const { baseURL } = getRuntime({ requireManifest: true });
  const section = fixtureSection('markdown');
  await openFixtureFile(page, section);
  const before = await (await request.get(`${baseURL}/api/terminal/status`)).json();
  const command = requireString(section, 'runnableCommand');
  const block = page.locator('pre').filter({ hasText: section.runnableMarker }).first();
  await block.locator('xpath=..').getByRole('button', { name: /运行|run/i }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(command);
  await dialog.getByRole('button', { name: /取消|cancel/i }).click();
  const after = await (await request.get(`${baseURL}/api/terminal/status`)).json();
  expect(after.active).toBe(before.active);
  await expect(page.getByText(section.expectedRunOutput, { exact: false })).toHaveCount(0);
});

test('FB-T25 R07 reproduction: merge immediately shows two decoded images, one file, and explanation', async ({ page }, testInfo) => {
  if (process.env.FIRST_BATCH_ALLOW_MODEL !== '1') {
    throw new EnvironmentBlocked('set FIRST_BATCH_ALLOW_MODEL=1 only for the isolated active-run session');
  }
  const section = fixtureSection('attachments');
  await openFixtureSession(page, section, { markerKey: 'mergeSessionSearchMarker' });
  const root = testInfo.outputPath('merge files');
  fs.mkdirSync(root, { recursive: true });
  const red = path.join(root, 'fb merge red.png');
  const blue = path.join(root, 'fb merge blue.png');
  const note = path.join(root, 'fb merge note.txt');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0u8AAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(red, png);
  fs.writeFileSync(blue, png);
  fs.writeFileSync(note, 'fixture note\n');
  await page.locator('input[type=file]').setInputFiles([red, blue, note]);
  await page.locator('textarea:visible').last().fill(requireString(section, 'mergedExplanation'));
  await page.getByRole('button', { name: /并入|queue|steer/i }).click();

  const explanation = page.getByText(section.mergedExplanation, { exact: true }).last();
  await expect(explanation).toBeVisible();
  const message = explanation.locator('xpath=ancestor::*[@data-message-id][1]');
  await expect(message.locator('img')).toHaveCount(2);
  for (const image of await message.locator('img').all()) await expectImageDecoded(image);
  await expect(message).toContainText('fb merge note.txt');
});

test('FB-T26 R07 adjacent regression: refresh keeps one message UUID and does not lose attachments', async ({ page }) => {
  const section = fixtureSection('attachments');
  await openFixtureSession(page, section);
  const id = requireString(section, 'historyMessageId');
  let message = page.locator(`[data-message-id="${id}"]`);
  await expect(message).toHaveCount(1);
  await expect(message.locator('img')).toHaveCount(2);
  await page.reload();
  // 产品没有会话级 URL：刷新后回到首页，必须经公开 UI 重新打开同一夹具会话，再断言同一条消息。
  await openFixtureSession(page, section);
  message = page.locator(`[data-message-id="${id}"]`);
  await expect(message).toHaveCount(1);
  await expect(message.locator('img')).toHaveCount(2);
  await expect(message).toContainText(requireString(section, 'normalExplanation'));
});

test('FB-T27 R08 reproduction: previewless readable image still decodes and opens', async ({ page }) => {
  const section = fixtureSection('attachments');
  await openFixtureSession(page, section);
  const image = await imageByAlt(page, requireString(section, 'previewlessImageAlt'));
  await image.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expectImageDecoded(dialog.locator('img').first());
});

test('FB-T28 R08 error: missing image is explicit, keeps filename, and shows no fake thumbnail', async ({ page }) => {
  const section = fixtureSection('attachments');
  await openFixtureSession(page, section);
  const name = requireString(section, 'missingFileName');
  const unavailable = page.getByText(name, { exact: false })
    .locator('xpath=ancestor::*[contains(normalize-space(.), "图片不可用")][1]');
  await expect(unavailable).toBeVisible();
  await expect(unavailable.locator('img')).toHaveCount(0);
});

test('FB-T29 R09 reproduction: lightbox stays within one message, uses order, boundaries, count, and Escape', async ({ page }) => {
  const section = fixtureSection('attachments');
  await openFixtureSession(page, section);
  const first = await imageByAlt(page, requireString(section, 'firstImageAlt'));
  await first.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('1 / 2');
  await page.keyboard.press('ArrowRight');
  await expect(dialog).toContainText('2 / 2');
  await page.keyboard.press('ArrowRight');
  await expect(dialog).toContainText('2 / 2');
  await page.keyboard.press('ArrowLeft');
  await expect(dialog).toContainText('1 / 2');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('FB-T30 R09 adjacent regression: lightbox arrow keys do not alter composer input and input resumes after close', async ({ page }) => {
  const section = fixtureSection('attachments');
  await openFixtureSession(page, section);
  const composer = page.locator('textarea:visible').last();
  await composer.fill('FB_COMPOSER_GUARD');
  const first = await imageByAlt(page, requireString(section, 'firstImageAlt'));
  await first.click();
  await page.keyboard.press('ArrowRight');
  expect(await composer.inputValue()).toBe('FB_COMPOSER_GUARD');
  await page.keyboard.press('Escape');
  await composer.focus();
  await page.keyboard.type('_RESTORED');
  expect(await composer.inputValue()).toBe('FB_COMPOSER_GUARD_RESTORED');
});
