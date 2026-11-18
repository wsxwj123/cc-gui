// r193-image-attach-inline 黑盒验收(一):发送类 G1–G12。
// 带图片附件的消息,命令行从标准输入收到的是「文字块 + 每张图一个图片块」的数组;没有能带上的图时与改动前逐字相同(字符串)。
// 只依据接口文件的行为清单;「命令行收到的」读假命令行的收信日志(helpers/fake-claude.mjs 写的 received-<工作区>.jsonl),
// 应答读页面发出的 POST /api/chat(/api/chat/steer)的 JSON,页面现象读对话区。标【复现】的用例在改动之前应当因断言不成立而失败;标【相邻回归】的应当通过。
import { test, expect, prepare } from './helpers/base.mjs';
import { writeScenario, readStatus, requestAbort } from './helpers/fixtures.mjs';
import { openJia, openNewSession, sendMessage, stopBtn, composerBox, uniqueTag, pickRollbackItem } from './helpers/runtime.mjs';
import {
  smallImage, bigImage, hugeImage, textFile, queueLoc, cardsLoc, addImage, addFile, sendAndGetResponse,
  waitReceived, expectedText, finishTurn, hintEverShown, HINT_KEY, readUserCard, imageBlocks, textBlocks,
} from './helpers/ui.mjs';

const SHORT = { chunkCount: 3, chunkIntervalMs: 50 };

/** 数组形态的断言:恰好 1 个文字块在最前,后面 nImages 个图片块,全是 base64 的 image/png。 */
function expectArrayShape(e, nImages, what) {
  expect(e.kind, `${what}:命令行收到的内容应是数组(实际 ${e.kind})`).toBe('array');
  expect(e.blocks.map((b) => b.type), `${what}:块的类型顺序应是 1 个文字块 + ${nImages} 个图片块`).toEqual(['text', ...Array(nImages).fill('image')]);
  for (const b of imageBlocks(e)) {
    expect(b.sourceType, `${what}:图片块的数据来源应是 base64`).toBe('base64');
    expect(b.mediaType, `${what}:图片块的媒体类型应是 image/png`).toBe('image/png');
  }
}

// ───────────────────────── 回合进行中的准备(待发列表) ─────────────────────────
/** 回合进行中:写长回合场景,发一条开场消息,等停止键出现。 */
async function startRunningTurn(page) {
  const ctx = prepare();
  await openJia(page, ctx);
  writeScenario({ chunkCount: 1200, chunkIntervalMs: 50 });
  await sendMessage(page, `R193-open-${uniqueTag()}`);
  await expect(stopBtn(page), '开场消息发出后停止键应出现(回合进行中)').toBeVisible({ timeout: 30_000 });
  await expect(queueLoc(page), '开始时待发列表应为空').toHaveCount(0);
  await expect(composerBox(page), '开始时输入框应为空').toHaveValue('');
  await expect(cardsLoc(page), '开始时不应有附件卡片').toHaveCount(0);
  return ctx;
}

/** 回合进行中往待发列表排一条「文字 + 一张图」,等列表多出一条且输入框 / 卡片清空。 */
async function queueTextWithImage(page, text, img) {
  const box = composerBox(page);
  await box.fill(text);
  await addImage(page, img, 1);
  await box.focus();
  await box.press('Enter');
  await expect(queueLoc(page), '按回车后待发列表应多出一条').toHaveCount(1, { timeout: 15_000 });
  await expect(box, '排进待发列表后输入框应清空').toHaveValue('');
  await expect(cardsLoc(page), '排进待发列表后输入框上方的卡片应清空').toHaveCount(0, { timeout: 15_000 });
}

/** 没有回合在进行:发「T + 一张图」,等这一轮结束,再多等 1 秒让消息列表稳定。返回 { path, resp }。 */
async function sendOneImageAndFinish(page, ctx, T, img) {
  await openJia(page, ctx);
  writeScenario(SHORT);
  const p = await addImage(page, img, 1);
  const resp = await sendAndGetResponse(page, T);
  await finishTurn(page, ctx, T);
  await expect(page.locator('[data-cgui="message-user"]').filter({ hasText: T }).first(), '对话里应有文字为 T 的用户消息').toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1000);
  return { path: p, resp };
}

// ───────────────────────── 普通发送 ─────────────────────────
test('G1 【复现】发「T + 1 张大图」:命令行收到 [文字块, 图片块],文字与改动前逐字相同、图片 image/png 且 base64 长度吻合;应答 inlined=1、skipped 为空、不含完整路径', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  writeScenario(SHORT);
  const img = bigImage('r193-g1.png');
  const p = await addImage(page, img, 1);
  const T = `G1-${uniqueTag()}`;
  const r = await sendAndGetResponse(page, T);
  expect(r.status, `G1:POST /api/chat 应答状态(应答原文 ${r.raw.slice(0, 200)})`).toBe(200);
  const [e] = await waitReceived(page, ctx, T);
  expectArrayShape(e, 1, 'G1');
  expect(e.blocks[0].text, 'G1:文字块应与改动前发出的文字逐字相同(T、空行、附件:、一行 @路径)').toBe(expectedText(T, [p]));
  expect(e.blocks[1].b64Len, 'G1:图片块 base64 长度应等于这张图文件内容的 base64 长度').toBe(img.b64Len);
  expect(e.blocks[1].sha256, 'G1:图片块数据解码后应与上传的文件逐字节相同').toBe(img.sha);
  expect(r.json && r.json.imageAttach, 'G1:应答里的 imageAttach').toEqual({ inlined: 1, skipped: [] });
  expect(r.raw.includes(p), 'G1:应答里任何地方都不应出现图片的完整路径').toBe(false);
});

test('G2 【复现】发「T + 2 张图(小图、大图)」:命令行收到 2 个图片块,顺序与附件段路径顺序一致;inlined=2', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  writeScenario(SHORT);
  const small = smallImage('r193-g2-small.png');
  const big = bigImage('r193-g2-big.png');
  const p1 = await addImage(page, small, 1);
  const p2 = await addImage(page, big, 2);
  const T = `G2-${uniqueTag()}`;
  const r = await sendAndGetResponse(page, T);
  const [e] = await waitReceived(page, ctx, T);
  expectArrayShape(e, 2, 'G2');
  expect(e.blocks[0].text, 'G2:文字块里附件段的路径顺序应是 小图、大图').toBe(expectedText(T, [p1, p2]));
  expect(imageBlocks(e).map((b) => b.sha256), 'G2:两个图片块的顺序应与附件段路径顺序一致(小图在前、大图在后)').toEqual([small.sha, big.sha]);
  expect(r.json && r.json.imageAttach, 'G2:应答里的 imageAttach').toEqual({ inlined: 2, skipped: [] });
});

test('G3 【复现】发「T + 1 张约 15MB 的 PNG」:命令行收到 1 个图片块(15MB 的数据完整);这一轮正常结束', async ({ page }) => {
  test.setTimeout(120_000);
  const ctx = prepare();
  await openJia(page, ctx);
  writeScenario(SHORT);
  const img = hugeImage('r193-g3-15mb.png', 15);
  expect(img.buf.length, 'G3:夹具图应约 15MB 且不超过 20MB').toBeGreaterThan(14 * 1024 * 1024);
  await addImage(page, img, 1);
  const T = `G3-${uniqueTag()}`;
  const r = await sendAndGetResponse(page, T);
  const [e] = await waitReceived(page, ctx, T, { timeout: 60_000 });
  expectArrayShape(e, 1, 'G3');
  expect(imageBlocks(e)[0].b64Len, 'G3:图片块 base64 长度应等于 15MB 文件的 base64 长度').toBe(img.b64Len);
  expect(r.json && r.json.imageAttach && r.json.imageAttach.inlined, 'G3:应答 inlined 应为 1').toBe(1);
  await finishTurn(page, ctx, T);
  const st = readStatus(ctx.workspaceName);
  expect(st && st.ended, 'G3:这一轮应正常结束(假命令行状态 ended)').toBe(true);
  expect(st.interruptedAtChunks, 'G3:这一轮不应被打断').toBe(null);
});

test('G4 【相邻回归】发一条不带附件的消息 T:命令行收到的是字符串 T;应答里没有 imageAttach', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  writeScenario(SHORT);
  const T = `G4-${uniqueTag()}`;
  const r = await sendAndGetResponse(page, T);
  const [e] = await waitReceived(page, ctx, T);
  expect(e.kind, 'G4:命令行收到的内容应是字符串').toBe('string');
  expect(e.text, 'G4:字符串应恰好是 T').toBe(T);
  expect(r.json, `G4:应答应是 JSON(原文 ${r.raw.slice(0, 200)})`).not.toBe(null);
  expect('imageAttach' in r.json, 'G4:应答里不应有 imageAttach 字段').toBe(false);
});

test('G5 【相邻回归】发「T + 1 个 .txt 文本附件」:命令行收到字符串(T、空行、附件:、一行 @路径);应答无 imageAttach;页面没有提示', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  writeScenario(SHORT);
  const p = await addFile(page, textFile('r193-g5.txt'), 1);
  const T = `G5-${uniqueTag()}`;
  const r = await sendAndGetResponse(page, T);
  const [e] = await waitReceived(page, ctx, T);
  expect(e.kind, 'G5:命令行收到的内容应是字符串').toBe('string');
  expect(e.text, 'G5:字符串应是 T + 空行 + 附件: + 一行 @路径').toBe(expectedText(T, [p]));
  expect(r.json, `G5:应答应是 JSON(原文 ${r.raw.slice(0, 200)})`).not.toBe(null);
  expect('imageAttach' in r.json, 'G5:应答里不应有 imageAttach 字段').toBe(false);
  expect(await hintEverShown(page, 2_000), `G5:页面不应出现含「${HINT_KEY}」的提示`).toBe(false);
});

test('G6 【复现】发「T + 1 张小图 + 1 个 .txt」:命令行收到数组,文字块里两行 @路径 都在、图片块 1 个;页面没有提示', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  writeScenario(SHORT);
  const small = smallImage('r193-g6.png');
  const pImg = await addImage(page, small, 1);
  const pTxt = await addFile(page, textFile('r193-g6.txt'), 2);
  const T = `G6-${uniqueTag()}`;
  await sendAndGetResponse(page, T);
  const [e] = await waitReceived(page, ctx, T);
  expectArrayShape(e, 1, 'G6');
  const lines = textBlocks(e)[0].text.split('\n');
  expect(lines.includes(`@${pImg}`), 'G6:文字块里应有图片的 @路径 行').toBe(true);
  expect(lines.includes(`@${pTxt}`), 'G6:文字块里应有文本附件的 @路径 行').toBe(true);
  expect(imageBlocks(e)[0].sha256, 'G6:图片块应是那张小图').toBe(small.sha);
  expect(await hintEverShown(page, 2_000), `G6:页面不应出现含「${HINT_KEY}」的提示`).toBe(false);
});

test('G7 【相邻回归】G1 发出并结束后:对话里用户消息显示文字 T 和 1 个加载成功的图片卡片,刷新再打开同样;气泡文字里没有 base64(长度 ≤ T 长度 + 200)', async ({ page }) => {
  const ctx = prepare();
  const T = `G7-${uniqueTag()}`;
  await sendOneImageAndFinish(page, ctx, T, bigImage('r193-g7.png'));
  const check = async (when) => {
    await expect.poll(() => readUserCard(page, T).then((s) => ({ cards: s.cards, imgs: s.imgs })), { message: `G7(${when}):对话里文字为 T 的用户消息应恰好 1 条、带 1 个加载成功的图片卡片`, timeout: 20_000 })
      .toEqual({ cards: 1, imgs: [{ alt: 'r193-g7.png', loaded: true }] });
    const s = await readUserCard(page, T);
    expect(s.textLen, `G7(${when}):气泡文字长度应不超过 T 的长度加 200`).toBeLessThanOrEqual(T.length + 200);
    expect(s.b64Like, `G7(${when}):气泡文字里不应出现 base64 数据`).toBe(false);
  };
  await check('发出后');
  await openJia(page, ctx); // 刷新页面并重新打开这个会话
  await check('刷新后');
});

// ───────────────────────── 编辑后重发 / 回退 ─────────────────────────
/** 对 T 那条消息点「编辑后重发」,等输入框的值变成 T。 */
async function editAndResend(page, T, what) {
  await pickRollbackItem(page, T, /编辑后重发/, what);
  await expect(composerBox(page), `${what}:点「编辑后重发」后输入框应变成原来的文字`).toHaveValue(T, { timeout: 20_000 });
}

test('G8 【复现】对「T + 大图」点「编辑后重发」,再加一张小图、文字改成 T2 发出:命令行收到的这条消息有 2 个图片块', async ({ page }) => {
  const ctx = prepare();
  const T = `G8orig-${uniqueTag()}`;
  const T2 = `G8new-${uniqueTag()}`;
  const big = bigImage('r193-g8-big.png');
  const small = smallImage('r193-g8-small.png');
  await sendOneImageAndFinish(page, ctx, T, big);
  await editAndResend(page, T, 'G8');
  await expect(cardsLoc(page), 'G8:取回后输入框上方应有 1 张卡片').toHaveCount(1, { timeout: 20_000 });
  await addImage(page, small, 2);
  const r = await sendAndGetResponse(page, T2);
  const [e] = await waitReceived(page, ctx, T2);
  expectArrayShape(e, 2, 'G8');
  expect(imageBlocks(e).map((b) => b.sha256).sort(), 'G8:两个图片块应分别是原来的大图与新加的小图').toEqual([big.sha, small.sha].sort());
  expect(r.json && r.json.imageAttach && r.json.imageAttach.inlined, 'G8:应答 inlined 应为 2').toBe(2);
});

test('G9 【复现】对「T + 大图」点「回滚 / 重新编辑」里的「仅回退消息」(自动重发):重发的那条,命令行收到 1 个图片块', async ({ page }) => {
  const ctx = prepare();
  const T = `G9-${uniqueTag()}`;
  const big = bigImage('r193-g9.png');
  await sendOneImageAndFinish(page, ctx, T, big);
  await pickRollbackItem(page, T, /仅回退消息/, 'G9');
  const hits = await waitReceived(page, ctx, T, { atLeast: 2, timeout: 45_000 });
  const resent = hits[hits.length - 1];
  expectArrayShape(resent, 1, 'G9(重发的那条)');
  expect(imageBlocks(resent)[0].sha256, 'G9:重发带的应是原来那张大图').toBe(big.sha);
});

// ───────────────────────── 待发列表 / 并入 ─────────────────────────
test('G10 【复现】回合进行中发「T + 大图」进入待发列表,等回合结束它自动发出:命令行收到的这条消息有 1 个图片块', async ({ page }) => {
  const T = `G10-${uniqueTag()}`;
  const big = bigImage('r193-g10.png');
  const ctx = await startRunningTurn(page);
  await queueTextWithImage(page, T, big);
  requestAbort(ctx.workspaceName); // 让开场那一轮立刻正常收尾,待发消息随之自动发出
  const [e] = await waitReceived(page, ctx, T, { timeout: 60_000 });
  expect(e.steer, 'G10:自动发出的是普通发送,不是并入').toBe(false);
  expectArrayShape(e, 1, 'G10');
  expect(imageBlocks(e)[0].sha256, 'G10:图片块应是那张大图').toBe(big.sha);
});

test('G11 【复现】回合进行中「T + 大图」进待发列表后点「并入」:命令行收到的并入消息是数组带 1 个图片块,steer 应答 inlined=1;回合结束刷新后对话里有文字为 T 的用户消息和它的图片卡片', async ({ page }) => {
  const T = `G11-${uniqueTag()}`;
  const big = bigImage('r193-g11.png');
  const ctx = await startRunningTurn(page);
  await queueTextWithImage(page, T, big);
  const steerResp = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/chat/steer', { timeout: 30_000 });
  // 页面上「并入」是待发列表顶部那一行的按钮(「1 条消息已排队 · 当前回复完成后自动发出」旁边),不在每条右侧;列表里只有这一条。
  await page.getByRole('button', { name: /并入/ }).click();
  const resp = await steerResp;
  const raw = await resp.text();
  let json = null; try { json = JSON.parse(raw); } catch { /* 留 null */ }
  expect(resp.status(), `G11:/api/chat/steer 应答状态(原文 ${raw.slice(0, 200)})`).toBe(200);
  const [e] = await waitReceived(page, ctx, T);
  expect(e.steer, 'G11:命令行是在回合进行中读到的并入消息').toBe(true);
  expectArrayShape(e, 1, 'G11');
  expect(imageBlocks(e)[0].sha256, 'G11:并入消息里的图片块应是那张大图').toBe(big.sha);
  expect(json && json.imageAttach, 'G11:steer 应答里的 imageAttach').toEqual({ inlined: 1, skipped: [] });
  // 让开场回合收尾,再刷新页面、重新打开会话:并入消息仍显示原文字和图片卡片。
  requestAbort(ctx.workspaceName);
  await expect.poll(() => { const st = readStatus(ctx.workspaceName); return Boolean(st && st.ended); }, { message: 'G11:开场回合应在 40 秒内收尾', timeout: 40_000 }).toBe(true);
  await expect(stopBtn(page), 'G11:回合结束后停止键应消失').toBeHidden({ timeout: 40_000 });
  await page.waitForTimeout(1000);
  await openJia(page, ctx);
  await expect.poll(() => readUserCard(page, T).then((s) => ({ cards: s.cards, imgs: s.imgs.map((i) => i.loaded) })), { message: 'G11:刷新后对话里应有文字为 T 的用户消息及 1 个加载成功的图片卡片', timeout: 25_000 })
    .toEqual({ cards: 1, imgs: [true] });
});

test('G12 【复现】在新会话界面发第一条消息「T + 大图」:命令行收到 1 个图片块', async ({ page }) => {
  const ctx = prepare();
  await openNewSession(page, ctx);
  writeScenario(SHORT);
  const big = bigImage('r193-g12.png');
  await addImage(page, big, 1);
  const T = `G12-${uniqueTag()}`;
  const r = await sendAndGetResponse(page, T);
  expect(r.status, `G12:POST /api/chat 应答状态(原文 ${r.raw.slice(0, 200)})`).toBe(200);
  const [e] = await waitReceived(page, ctx, T);
  expectArrayShape(e, 1, 'G12');
  expect(imageBlocks(e)[0].sha256, 'G12:图片块应是那张大图').toBe(big.sha);
});
