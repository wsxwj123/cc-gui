// r192-queue-edit-attach-arrows 黑盒验收:
//   (一)把待发列表里的消息取出到输入框:图片恢复成输入框上方的卡片,输入框里只有当初打的字(不出现「@」加图片路径);
//   (二)输入框上方的图片卡片没有内存预览时(大图 / 从待发列表取出的图)改从图片文件读取来显示;
//   (三)上下键翻输入历史改按光标所在的显示行判断(第一行才翻上一条、最后一行才翻下一条,其余只移动光标)。
// 只依据接口文件的行为清单(Q1–Q10,一条对一条);只通过页面观测(文案 / data-* 锚点 / 输入框的值与光标);假命令行见 helpers/fake-claude.mjs。
// 标【复现】的用例在改动之前应当因断言不成立而失败;标【相邻回归】的应当通过。
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { test as base, expect } from '@playwright/test';
import { seedPair, writeScenario, resetStatus, readStatus, requestAbort } from './helpers/fixtures.mjs';
import { openJia, sendMessage, stopBtn, composerBox, uniqueTag } from './helpers/runtime.mjs';

// 监听页面的未捕获错误(pageerror),出现即失败。
const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await use(page);
    expect(errors, '页面出现未捕获错误(pageerror)').toEqual([]);
  },
});

// ───────────────────────── 造 PNG(随机像素,压不小) ─────────────────────────
function crc32(buf) { let crc = 0xFFFFFFFF; for (const b of buf) { crc ^= b; for (let k = 0; k < 8; k += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1; } return (crc ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h) { const row = w * 3 + 1; const raw = Buffer.alloc(row * h); for (let y = 0; y < h; y += 1) { raw[y * row] = 0; crypto.randomFillSync(raw, y * row + 1, w * 3); } const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const smallImage = (name) => ({ name, buf: png(16, 16) }); // 约 850 字节
const bigImage = (name) => ({ name, buf: png(400, 300) }); // 约 360KB

// ───────────────────────── 用例准备与收场 ─────────────────────────
let currentCtx = null;
function prepare() {
  const ctx = seedPair(uniqueTag('t'));
  currentCtx = ctx;
  resetStatus(ctx.workspaceName);
  return ctx;
}

// 用例收场:让假命令行把遗留的长回合尽快正常收尾(最多等 10 秒)。
test.afterEach(async () => {
  if (!currentCtx) return;
  const name = currentCtx.workspaceName;
  requestAbort(name);
  for (let i = 0; i < 100; i += 1) {
    const st = readStatus(name);
    if (!st || st.openedAt == null || st.ended) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  currentCtx = null;
});

// ───────────────────────── 页面操作与观测 ─────────────────────────
const queueLoc = (page) => page.locator('[data-testid="queue-item"]');
// 输入框上方的附件卡片(排除待发列表里的条目内部可能出现的同名锚点)。
const cardsLoc = (page) => page.locator('[data-testid="attachment-item"]:not([data-testid="queue-item"] [data-testid="attachment-item"])');
const pencilOf = (item) => item.locator('button[title="取出到输入框重新编辑"]');
const COMPOSER_SEL = 'textarea[data-cgui="composer-input"]';

/** 往输入框添加一张图片,等附件卡片数变成 expectCards。 */
async function addImage(page, image, expectCards) {
  await page.locator('[data-cgui="composer"] input[type=file]').setInputFiles({ name: image.name, mimeType: 'image/png', buffer: image.buf });
  await expect(cardsLoc(page), `添加 ${image.name} 后附件卡片数应为 ${expectCards}`).toHaveCount(expectCards, { timeout: 20_000 });
}

/** 回合进行中:写长回合场景,发一条开场消息,等停止键出现。 */
async function startRunningTurn(page) {
  const ctx = prepare();
  await openJia(page, ctx);
  writeScenario({ chunkCount: 1200, chunkIntervalMs: 50 });
  await sendMessage(page, `R192-open-${uniqueTag()}`);
  await expect(stopBtn(page), '开场消息发出后停止键应出现(回合进行中)').toBeVisible({ timeout: 30_000 });
  await expect(queueLoc(page), '开始时待发列表应为空').toHaveCount(0);
  await expect(composerBox(page), '开始时输入框应为空').toHaveValue('');
  await expect(cardsLoc(page), '开始时不应有附件卡片').toHaveCount(0);
}

/** 回合进行中往待发列表排一条:可带文字、可带一张图,按回车,等列表多出一条且输入框 / 卡片清空。 */
async function queueMessage(page, { text, image }) {
  const box = composerBox(page);
  const before = await queueLoc(page).count();
  if (text) await box.fill(text);
  if (image) await addImage(page, image, 1);
  await box.focus();
  await box.press('Enter');
  await expect(queueLoc(page), '按回车后待发列表应多出一条').toHaveCount(before + 1, { timeout: 15_000 });
  await expect(box, '排进待发列表后输入框应清空').toHaveValue('');
  await expect(cardsLoc(page), '排进待发列表后输入框上方的卡片应清空').toHaveCount(0, { timeout: 15_000 });
}

/**
 * 读一次「待发列表条数 / 输入框文字 / 输入框上方各卡片」。
 * names 给了就用卡片上的文件名认出每张卡(who);没给就只读「图片是否加载成功」(img 的 complete 且 naturalWidth > 0)。
 */
function readComposerState(page, names) {
  return page.evaluate(({ sel, nm }) => {
    const ta = document.querySelector(sel);
    const cards = Array.from(document.querySelectorAll('[data-testid="attachment-item"]'))
      .filter((c) => !c.closest('[data-testid="queue-item"]'))
      .map((c) => {
        const img = c.querySelector('img');
        const loaded = Boolean(img) && img.complete && img.naturalWidth > 0;
        if (!nm) return { loaded };
        const text = (c.innerText || '').trim();
        const hit = Object.keys(nm).find((k) => text.includes(nm[k]));
        return { who: hit || `?${text.slice(0, 40)}`, loaded };
      });
    return { queue: document.querySelectorAll('[data-testid="queue-item"]').length, value: ta ? ta.value : null, cards };
  }, { sel: COMPOSER_SEL, nm: names || null });
}

/** 读输入框的文字与光标位置。 */
function readBox(page) {
  return page.evaluate((sel) => {
    const ta = document.querySelector(sel);
    return { value: ta.value, pos: ta.selectionStart };
  }, COMPOSER_SEL);
}
function setCursor(page, pos) {
  return page.evaluate(({ sel, p }) => { const ta = document.querySelector(sel); ta.focus(); ta.setSelectionRange(p, p); }, { sel: COMPOSER_SEL, p: pos });
}

const POLL = { timeout: 12_000 };

// ───────────────────────── 待发列表一组(Q1–Q6) ─────────────────────────
test('Q1 【复现】文字加小图排进待发列表,点铅笔取出:列表少一条、输入框恰好是原文、恰好 1 张图片卡片且加载成功', async ({ page }) => {
  await startRunningTurn(page);
  const T = `T1-${uniqueTag()}`;
  await queueMessage(page, { text: T, image: smallImage('r192-q1.png') });
  await pencilOf(queueLoc(page).first()).click();
  await expect.poll(() => readComposerState(page), { ...POLL, message: 'Q1:取出后的读数(待发条数 / 输入框文字 / 卡片)' })
    .toEqual({ queue: 0, value: T, cards: [{ loaded: true }] });
});

test('Q2 【复现】文字加大图排进待发列表,输入框为空时按上键取出:列表少一条、输入框恰好是原文、恰好 1 张图片卡片且加载成功', async ({ page }) => {
  await startRunningTurn(page);
  const T = `T2-${uniqueTag()}`;
  await queueMessage(page, { text: T, image: bigImage('r192-q2.png') });
  await composerBox(page).focus();
  await composerBox(page).press('ArrowUp');
  await expect.poll(() => readComposerState(page), { ...POLL, message: 'Q2:按上键后的读数(待发条数 / 输入框文字 / 卡片)' })
    .toEqual({ queue: 0, value: T, cards: [{ loaded: true }] });
});

test('Q3 【复现】只有小图没有文字排进待发列表,点铅笔取出:输入框文字为空、恰好 1 张图片卡片且加载成功', async ({ page }) => {
  await startRunningTurn(page);
  await queueMessage(page, { text: '', image: smallImage('r192-q3.png') });
  await pencilOf(queueLoc(page).first()).click();
  await expect.poll(() => readComposerState(page), { ...POLL, message: 'Q3:取出后的读数(待发条数 / 输入框文字 / 卡片)' })
    .toEqual({ queue: 0, value: '', cards: [{ loaded: true }] });
});

test('Q4 【复现】取出后不改动再按回车重新排队、再点铅笔取出:输入框恰好是原文、恰好 1 张图片卡片且加载成功', async ({ page }) => {
  await startRunningTurn(page);
  const T = `T4-${uniqueTag()}`;
  await queueMessage(page, { text: T, image: smallImage('r192-q4.png') });
  await pencilOf(queueLoc(page).first()).click();
  // 第一次取出落定(列表空、输入框里已是以 T 开头的内容),不做任何修改。
  await expect(queueLoc(page), 'Q4:第一次取出后待发列表应为空').toHaveCount(0, { timeout: 15_000 });
  await expect(composerBox(page), 'Q4:第一次取出后输入框应以原文开头').toHaveValue(new RegExp(`^${T}`), { timeout: 15_000 });
  await composerBox(page).focus();
  await composerBox(page).press('Enter');
  await expect(queueLoc(page), 'Q4:不改动按回车后这条应重新进入待发列表').toHaveCount(1, { timeout: 15_000 });
  await expect(composerBox(page), 'Q4:重新排队后输入框应清空').toHaveValue('', { timeout: 15_000 });
  await pencilOf(queueLoc(page).first()).click();
  await expect.poll(() => readComposerState(page), { ...POLL, message: 'Q4:第二次取出后的读数(待发条数 / 输入框文字 / 卡片)' })
    .toEqual({ queue: 0, value: T, cards: [{ loaded: true }] });
});

test('Q5 【复现】输入框里已挂着乙,再取出带甲的待发消息:输入框恰好是原文、恰好 2 张卡片,乙在前甲在后,两张都加载成功', async ({ page }) => {
  await startRunningTurn(page);
  const T = `T5-${uniqueTag()}`;
  const jia = smallImage('r192-q5-jia.png');
  const yi = smallImage('r192-q5-yi.png');
  await queueMessage(page, { text: T, image: jia });
  await addImage(page, yi, 1);
  await pencilOf(queueLoc(page).first()).click();
  await expect.poll(() => readComposerState(page, { yi: 'r192-q5-yi', jia: 'r192-q5-jia' }), { ...POLL, message: 'Q5:取出后的读数(待发条数 / 输入框文字 / 各卡片的文件名归属与加载情况)' })
    .toEqual({ queue: 0, value: T, cards: [{ who: 'yi', loaded: true }, { who: 'jia', loaded: true }] });
});

test('Q6 【相邻回归】纯文字排进待发列表,点铅笔取出:输入框恰好是原文、没有附件卡片', async ({ page }) => {
  await startRunningTurn(page);
  const T = `T6-${uniqueTag()}`;
  await queueMessage(page, { text: T });
  await pencilOf(queueLoc(page).first()).click();
  await expect.poll(() => readComposerState(page), { ...POLL, message: 'Q6:取出后的读数(待发条数 / 输入框文字 / 卡片)' })
    .toEqual({ queue: 0, value: T, cards: [] });
});

// ───────────────────────── 输入历史一组(Q7–Q10) ─────────────────────────
/** 发一条消息并等这一轮回复结束(停止键先出现再消失)。 */
async function sendAndFinish(page, text) {
  writeScenario({ chunkCount: 3, chunkIntervalMs: 50 });
  await sendMessage(page, text);
  await expect(stopBtn(page), `发出「${text.slice(0, 12)}」后停止键应出现`).toBeVisible({ timeout: 30_000 });
  await expect(stopBtn(page), `「${text.slice(0, 12)}」这一轮应在 40 秒内结束`).toBeHidden({ timeout: 40_000 });
}

/** 本会话先后发出并完成 M1(单行)、M2(三行,换行打出来)两条消息;之后无回合、待发列表空、输入框空。 */
async function prepareHistory(page) {
  const ctx = prepare();
  await openJia(page, ctx);
  const u = uniqueTag();
  const M1 = `M1-${u}`;
  const lines = [`alpha-${u}`, `bravo-${u}-x`, `charlie-${u}`];
  const M2 = lines.join('\n');
  await sendAndFinish(page, M1);
  await sendAndFinish(page, M2);
  await expect(composerBox(page), '两轮结束后输入框应为空').toHaveValue('');
  await expect(queueLoc(page), '两轮结束后待发列表应为空').toHaveCount(0);
  return { M1, M2, lines };
}

/** 光标 pos 落在 M2 的第几行(1/2/3);不在任何一行范围内返回 0。两端都算在内。 */
function lineOf(lines, pos) {
  const [a, b, c] = lines.map((l) => l.length);
  if (pos >= 0 && pos <= a) return 1;
  if (pos >= a + 1 && pos <= a + 1 + b) return 2;
  if (pos >= a + b + 2 && pos <= a + b + 2 + c) return 3;
  return 0;
}
/** 把输入框当前文字认成已知的哪一条('empty' / 已知键 / other:前缀)。 */
function labelOf(value, known) {
  if (value === '') return 'empty';
  const hit = Object.keys(known).find((k) => known[k] === value);
  return hit || `other:${value.slice(0, 30)}`;
}
/** 读一次:输入框文字认成谁、(是 M2 时)光标在第几行、光标是否在末尾。 */
async function readHistory(page, h) {
  const { value, pos } = await readBox(page);
  const who = labelOf(value, { M1: h.M1, M2: h.M2 });
  return { who, line: who === 'M2' ? lineOf(h.lines, pos) : null, atEnd: pos === value.length };
}

test('Q7 【复现】三行的 M2 里连按上键:光标在第三行、第二行时只移动光标,到第一行再按才翻到 M1', async ({ page }) => {
  const h = await prepareHistory(page);
  const box = composerBox(page);
  await box.focus();
  await box.press('ArrowUp');
  await expect.poll(() => readHistory(page, h), { ...POLL, message: 'Q7 第 1 次上键后(应变成 M2、光标在末尾)' })
    .toEqual({ who: 'M2', line: 3, atEnd: true });
  await box.press('ArrowUp');
  await expect.poll(() => readHistory(page, h), { ...POLL, message: 'Q7 第 2 次上键后(应仍是 M2、光标在第二行)' })
    .toMatchObject({ who: 'M2', line: 2 });
  await box.press('ArrowUp');
  await expect.poll(() => readHistory(page, h), { ...POLL, message: 'Q7 第 3 次上键后(应仍是 M2、光标在第一行)' })
    .toMatchObject({ who: 'M2', line: 1 });
  await box.press('ArrowUp');
  await expect.poll(() => readHistory(page, h), { ...POLL, message: 'Q7 第 4 次上键后(应翻到 M1)' })
    .toMatchObject({ who: 'M1', line: null });
});

test('Q8 【复现】翻到 M2 后光标放最开头连按下键:第一行、第二行时只移动光标,到第三行再按才回到空', async ({ page }) => {
  const h = await prepareHistory(page);
  const box = composerBox(page);
  await box.focus();
  await box.press('ArrowUp');
  await expect.poll(() => readHistory(page, h), { ...POLL, message: 'Q8 上键后(应变成 M2、光标在末尾)' })
    .toEqual({ who: 'M2', line: 3, atEnd: true });
  await setCursor(page, 0);
  await expect.poll(() => readBox(page), { ...POLL, message: 'Q8 光标应已放到最开头' }).toMatchObject({ pos: 0 });
  await box.press('ArrowDown');
  await expect.poll(() => readHistory(page, h), { ...POLL, message: 'Q8 第 1 次下键后(应仍是 M2、光标在第二行)' })
    .toMatchObject({ who: 'M2', line: 2 });
  await box.press('ArrowDown');
  await expect.poll(() => readHistory(page, h), { ...POLL, message: 'Q8 第 2 次下键后(应仍是 M2、光标在第三行)' })
    .toMatchObject({ who: 'M2', line: 3 });
  await box.press('ArrowDown');
  await expect.poll(() => readHistory(page, h), { ...POLL, message: 'Q8 第 3 次下键后(应变回空)' })
    .toMatchObject({ who: 'empty', line: null });
});

test('Q9 【复现】一段自动折成多行的长文字,光标在末尾按上键:文字不变、光标向上移到前面某处(大于 0)', async ({ page }) => {
  const h = await prepareHistory(page);
  const L = Array.from({ length: 130 }, () => 'lorem').join(' ').replace(/^lorem/, `Lq9${uniqueTag()}`);
  expect(L.length, 'L 应至少 600 个字符、不含换行').toBeGreaterThanOrEqual(600);
  expect(L.includes('\n')).toBe(false);
  const box = composerBox(page);
  await box.focus();
  const h0 = await page.evaluate((sel) => document.querySelector(sel).scrollHeight, COMPOSER_SEL);
  await box.fill(L);
  const h1 = await page.evaluate((sel) => document.querySelector(sel).scrollHeight, COMPOSER_SEL);
  expect(h1, `L 应在输入框里折成 3 行以上:空输入框内容高 ${h0},填入 L 后 ${h1}`).toBeGreaterThan(h0 * 2);
  await setCursor(page, L.length);
  await expect.poll(() => readBox(page), { ...POLL, message: 'Q9 光标应在 L 的末尾' }).toEqual({ value: L, pos: L.length });
  await box.press('ArrowUp');
  await expect.poll(async () => {
    const { value, pos } = await readBox(page);
    return { who: labelOf(value, { L, M1: h.M1, M2: h.M2 }), moved: pos < L.length && pos > 0 };
  }, { ...POLL, message: 'Q9 上键后(文字应仍是 L、光标应小于末尾且大于 0)' }).toEqual({ who: 'L', moved: true });
});

test('Q10 【相邻回归】单行草稿 K 光标在末尾按上键翻到 M2,再按下键回到 K', async ({ page }) => {
  const h = await prepareHistory(page);
  const K = `K10-${uniqueTag()}`;
  expect(K.length, 'K 应少于 20 个字符').toBeLessThan(20);
  const box = composerBox(page);
  await box.fill(K);
  await setCursor(page, K.length);
  await box.press('ArrowUp');
  await expect.poll(() => readHistory(page, h), { ...POLL, message: 'Q10 上键后(应变成 M2、光标在末尾)' })
    .toEqual({ who: 'M2', line: 3, atEnd: true });
  await box.press('ArrowDown');
  await expect.poll(async () => labelOf((await readBox(page)).value, { K, M1: h.M1, M2: h.M2 }), { ...POLL, message: 'Q10 下键后(应回到 K)' })
    .toBe('K');
});
