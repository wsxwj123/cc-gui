// r193-image-attach-inline 黑盒验收(二):带不上的图与错误契约 G13–G21(含 15b、16b)。
// 带不上的图:消息照常发出,页面在发出的那个会话里提示一句「有 N 张图没能带上:{原因}。消息已照常发出。」;应答里 imageAttach.skipped 逐项给出文件名(不含目录)与原因。
// 「命令行收到的」读假命令行收信日志,应答读 POST /api/chat 的 JSON,提示读页面文字。标【复现】的用例在改动之前应当失败;标【相邻回归】的应当通过。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect, prepare } from './helpers/base.mjs';
import { writeScenario, tmpReal } from './helpers/fixtures.mjs';
import { openJia, uniqueTag } from './helpers/runtime.mjs';
import {
  smallImage, bigImage, hugeImage, damagedImage, textFile, heicFile, png, addImage, addImages, addFile, sendAndGetResponse, apiFetch,
  entryText, waitReceived, expectedText, finishTurn, hintEverShown, expectHint, hintTemplate, REASON, HINT_KEY, readUserCard, imageBlocks, textBlocks,
} from './helpers/ui.mjs';

const SHORT = { chunkCount: 3, chunkIntervalMs: 50 };

/** 只许删用例自己刚上传的文件:路径必须在名为 cgui-attachments 的目录里。 */
function deleteOwnUpload(p) {
  expect(path.basename(path.dirname(p)), `删文件前自检:${path.basename(p)} 应在 cgui-attachments 目录里`).toBe('cgui-attachments');
  fs.unlinkSync(p);
}

// ───────────────────────── 图片文件已经不在 ─────────────────────────
test('G13 【复现】添加大图后、发送前把上传目录里这个文件删掉:这一轮照常开始;页面提示「文件已不在」;命令行收到与改动前相同的字符串;应答 skipped 1 项 missing(只有文件名)', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  writeScenario(SHORT);
  const p = await addImage(page, bigImage('r193-g13.png'), 1);
  deleteOwnUpload(p);
  const T = `G13-${uniqueTag()}`;
  const r = await sendAndGetResponse(page, T);
  expect(r.status, `G13:POST /api/chat 应答状态(原文 ${r.raw.slice(0, 200)})`).toBe(200);
  const [e] = await waitReceived(page, ctx, T);
  expect(e.kind, 'G13:命令行收到的内容应是字符串(没有别的能带的图)').toBe('string');
  expect(e.text, 'G13:字符串应与改动前相同(T、空行、附件:、一行 @路径)').toBe(expectedText(T, [p]));
  await expectHint(page, hintTemplate(1, [REASON.missing]), 'G13');
  expect(r.json && r.json.imageAttach, 'G13:应答里的 imageAttach').toEqual({ inlined: 0, skipped: [{ name: path.basename(p), reason: 'missing' }] });
  expect(r.raw.includes(p), 'G13:应答里不应出现完整路径').toBe(false);
  await finishTurn(page, ctx, T);
});

test('G14 【复现】添加两张大图、发送前删掉其中一张的文件:命令行收到 1 个图片块(另一张);页面提示「有 1 张图没能带上:…」', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  writeScenario(SHORT);
  const bigA = bigImage('r193-g14-a.png');
  const bigB = bigImage('r193-g14-b.png');
  const pA = await addImage(page, bigA, 1);
  await addImage(page, bigB, 2);
  deleteOwnUpload(pA);
  const T = `G14-${uniqueTag()}`;
  const r = await sendAndGetResponse(page, T);
  const [e] = await waitReceived(page, ctx, T);
  expect(e.kind, 'G14:命令行收到的内容应是数组').toBe('array');
  expect(imageBlocks(e).map((b) => b.sha256), 'G14:图片块应恰好 1 个,且是没被删的那张').toEqual([bigB.sha]);
  expect(r.json && r.json.imageAttach, 'G14:应答里的 imageAttach').toEqual({ inlined: 1, skipped: [{ name: path.basename(pA), reason: 'missing' }] });
  await expectHint(page, hintTemplate(1, [REASON.missing]), 'G14');
});

// ───────────────────────── 路径在上传目录之外(直接向接口提交) ─────────────────────────
/** 在系统临时目录下建一个只属于本用例的「上传目录之外」目录,里面放一张真实存在的 PNG。 */
function makeOutsideImage(tag) {
  const dir = path.join(tmpReal(), `r193-outside-${tag}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `outside-${tag}.png`);
  fs.writeFileSync(file, png(16, 16));
  return { dir, file };
}
function removeOutsideImage(o) {
  try { fs.unlinkSync(o.file); } catch { /* 已不在 */ }
  try { fs.rmdirSync(o.dir); } catch { /* 目录不空或已不在就留着 */ }
}

/** 先正常发一条纯文字消息抄下页面请求体(除 prompt 以外的字段),等这一轮结束。 */
async function warmUpAndCaptureBody(page, ctx) {
  writeScenario(SHORT);
  const warm = `G15warm-${uniqueTag()}`;
  const w = await sendAndGetResponse(page, warm);
  expect(w.reqBody, 'G15/16 前置:应抄到页面发出的 /api/chat 请求体').not.toBe(null);
  await finishTurn(page, ctx, warm);
  return w.reqBody;
}

/** 直接向 POST /api/chat 提交「T + 附件段(指向 target)」,返回 { r, T, prompt, entry }。 */
async function postWithPath(page, ctx, body, target, label) {
  const T = `${label}-${uniqueTag()}`;
  const prompt = `${T}\n\n附件:\n@${target}`;
  // 页面请求体里带的「回合编号」(同一编号 + 不同参数 = 后端报 TURN_CONFLICT)每次换新;其余字段原样。
  const fresh = {};
  for (const k of Object.keys(body)) if (/turnid$/i.test(k)) fresh[k] = crypto.randomUUID();
  const r = await apiFetch(page, 'POST', '/api/chat', { ...body, ...fresh, prompt });
  expect(r.status, `${label}:POST /api/chat 应答状态(原文 ${r.text.slice(0, 200)})`).toBe(200);
  const [entry] = await waitReceived(page, ctx, T);
  return { r, T, prompt, entry };
}

async function outsideDirect(page, ctx, tag, label) {
  await openJia(page, ctx);
  const body = await warmUpAndCaptureBody(page, ctx);
  const o = makeOutsideImage(tag);
  try {
    const res = await postWithPath(page, ctx, body, o.file, label);
    return { ...res, o };
  } finally { removeOutsideImage(o); }
}

test('G15 【相邻回归】直接向 /api/chat 提交附件路径指向上传目录之外的真实 PNG:命令行收到字符串;应答里不含该文件所在目录路径;页面没有提示', async ({ page }) => {
  const ctx = prepare();
  const { r, prompt, entry, o } = await outsideDirect(page, ctx, uniqueTag('o'), 'G15');
  expect(entry.kind, 'G15:命令行收到的内容应是字符串').toBe('string');
  expect(entry.text, 'G15:字符串应与提交的 prompt 逐字相同').toBe(prompt);
  expect(r.text.includes(o.dir), 'G15:整个应答文本里不应出现这个文件所在目录的路径').toBe(false);
  expect(await hintEverShown(page, 2_000), `G15:页面不应出现含「${HINT_KEY}」的提示`).toBe(false);
});

test('G15b 【复现】同 G15:应答 imageAttach.skipped 里这一项 reason 是 outside,name 只有文件名', async ({ page }) => {
  const ctx = prepare();
  const { r, o } = await outsideDirect(page, ctx, uniqueTag('o'), 'G15b');
  expect(r.json && r.json.imageAttach, 'G15b:应答里的 imageAttach').toEqual({ inlined: 0, skipped: [{ name: path.basename(o.file), reason: 'outside' }] });
});

// ───────────────────────── 上传目录里指向外面的符号链接 ─────────────────────────
async function symlinkDirect(page, ctx, tag, label) {
  await openJia(page, ctx);
  const body = await warmUpAndCaptureBody(page, ctx);
  // 先上传一张图,借它的路径找到真实的上传目录(上传后的卡片留在输入框里,本用例不发它)。
  const upPath = await addImage(page, smallImage(`r193-${label}-probe.png`), 1);
  const uploadDir = path.dirname(upPath);
  expect(path.basename(uploadDir), `${label} 前置:上传目录应叫 cgui-attachments`).toBe('cgui-attachments');
  const o = makeOutsideImage(tag);
  const link = path.join(uploadDir, `r193-link-${tag}.png`);
  fs.symlinkSync(o.file, link);
  try {
    const res = await postWithPath(page, ctx, body, link, label);
    return { ...res, o, link };
  } finally {
    try { fs.unlinkSync(link); } catch { /* 已不在 */ }
    removeOutsideImage(o);
  }
}

test('G16 【相邻回归】上传目录里建符号链接指向目录外的 PNG、提交这个链接的路径:命令行收到字符串;应答不含目录外文件所在目录路径;页面没有提示', async ({ page }) => {
  const ctx = prepare();
  const { r, prompt, entry, o } = await symlinkDirect(page, ctx, uniqueTag('l'), 'G16');
  expect(entry.kind, 'G16:命令行收到的内容应是字符串').toBe('string');
  expect(entry.text, 'G16:字符串应与提交的 prompt 逐字相同').toBe(prompt);
  expect(r.text.includes(o.dir), 'G16:整个应答文本里不应出现目录外文件所在目录的路径').toBe(false);
  expect(await hintEverShown(page, 2_000), `G16:页面不应出现含「${HINT_KEY}」的提示`).toBe(false);
});

test('G16b 【复现】同 G16:应答 imageAttach.skipped 里这一项 reason 是 outside,name 只有符号链接的文件名', async ({ page }) => {
  const ctx = prepare();
  const { r, link } = await symlinkDirect(page, ctx, uniqueTag('l'), 'G16b');
  expect(r.json && r.json.imageAttach, 'G16b:应答里的 imageAttach').toEqual({ inlined: 0, skipped: [{ name: path.basename(link), reason: 'outside' }] });
});

// ───────────────────────── 格式 / 损坏 / 过大 / 过多 ─────────────────────────
test('G17 【复现】发「T + 1 个 .heic」:消息照常发出;页面提示「格式不支持(可用 png、jpg、gif、webp)」;命令行收到字符串', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  writeScenario(SHORT);
  // 实测:.heic 的卡片里放的是一个加载不出来的 img(alt=文件名),没有「KB」字样,所以不用 KB 判断上传完成,改以上传应答已到为准。
  const p = await addFile(page, heicFile('r193-g17.heic'), 1, { expectKB: false });
  const T = `G17-${uniqueTag()}`;
  const r = await sendAndGetResponse(page, T);
  const [e] = await waitReceived(page, ctx, T);
  expect(e.kind, 'G17:命令行收到的内容应是字符串').toBe('string');
  expect(e.text, 'G17:字符串应与改动前相同').toBe(expectedText(T, [p]));
  await expectHint(page, hintTemplate(1, [REASON.unsupported]), 'G17');
  expect(r.json && r.json.imageAttach && r.json.imageAttach.skipped, 'G17:应答里 skipped').toEqual([{ name: path.basename(p), reason: 'unsupported' }]);
});

test('G18 【复现】发「T + 1 张文件头完好、后面被改乱的 PNG」:消息照常发出;页面提示「文件已损坏」;命令行收到字符串', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  writeScenario(SHORT);
  const p = await addFile(page, damagedImage('r193-g18.png'), 1, { expectKB: false });
  const T = `G18-${uniqueTag()}`;
  const r = await sendAndGetResponse(page, T);
  const [e] = await waitReceived(page, ctx, T);
  expect(e.kind, 'G18:命令行收到的内容应是字符串').toBe('string');
  expect(e.text, 'G18:字符串应与改动前相同').toBe(expectedText(T, [p]));
  await expectHint(page, hintTemplate(1, [REASON.damaged]), 'G18');
  expect(r.json && r.json.imageAttach && r.json.imageAttach.skipped, 'G18:应答里 skipped').toEqual([{ name: path.basename(p), reason: 'damaged' }]);
});

test('G19 【复现】发「T + 1 张 21MB 的 PNG」:消息照常发出;页面提示「太大(单张或一条消息合计超过 20MB)」;命令行收到字符串', async ({ page }) => {
  test.setTimeout(120_000);
  const ctx = prepare();
  await openJia(page, ctx);
  writeScenario(SHORT);
  const img = hugeImage('r193-g19-21mb.png', 21);
  expect(img.buf.length, 'G19:夹具图应超过 20MB').toBeGreaterThan(20 * 1024 * 1024);
  const p = await addImage(page, img, 1);
  const T = `G19-${uniqueTag()}`;
  const r = await sendAndGetResponse(page, T);
  const [e] = await waitReceived(page, ctx, T, { timeout: 60_000 });
  expect(e.kind, 'G19:命令行收到的内容应是字符串').toBe('string');
  expect(e.text, 'G19:字符串应与改动前相同').toBe(expectedText(T, [p]));
  await expectHint(page, hintTemplate(1, [REASON.tooLarge]), 'G19');
  expect(r.json && r.json.imageAttach && r.json.imageAttach.skipped, 'G19:应答里 skipped').toEqual([{ name: path.basename(p), reason: 'too-large' }]);
});

test('G20 【复现】发「T + 21 张小图」:命令行收到 20 个图片块(前 20 张);页面提示「有 1 张图没能带上:一条消息最多带 20 张。消息已照常发出。」', async ({ page }) => {
  test.setTimeout(150_000);
  const ctx = prepare();
  await openJia(page, ctx);
  writeScenario(SHORT);
  const imgs = Array.from({ length: 21 }, (_, i) => smallImage(`r193-g20-${String(i + 1).padStart(2, '0')}.png`));
  await addImages(page, imgs);
  const T = `G20-${uniqueTag()}`;
  const r = await sendAndGetResponse(page, T);
  const [e] = await waitReceived(page, ctx, T, { timeout: 60_000 });
  // 前置(改动前后都应成立):附件段里保留全部 21 行 @路径。
  const pathLines = entryText(e).split('\n').filter((l) => l.startsWith('@')).map((l) => l.slice(1));
  expect(pathLines.length, 'G20:命令行收到的文字里应有全部 21 行 @路径').toBe(21);
  expect(e.kind, 'G20:命令行收到的内容应是数组').toBe('array');
  expect(imageBlocks(e).length, 'G20:图片块应恰好 20 个').toBe(20);
  expect(imageBlocks(e).map((b) => b.sha256), 'G20:20 个图片块应是附件段里前 20 张(按卡片添加顺序)').toEqual(imgs.slice(0, 20).map((i) => i.sha));
  expect(r.json && r.json.imageAttach, 'G20:应答里的 imageAttach').toEqual({ inlined: 20, skipped: [{ name: path.basename(pathLines[20]), reason: 'too-many' }] });
  await expectHint(page, hintTemplate(1, [REASON.tooMany]), 'G20');
});

// ───────────────────────── 上游报错 ─────────────────────────
test('G21 【相邻回归】假命令行对这一轮返回上游报错、发「T + 大图」:页面显示这一轮的报错;文字为 T 的用户消息和它的图片卡片仍在;页面没有「没能带上」提示', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  const ERR = 'API Error: 400 Content Exists Risk';
  writeScenario({ apiError: { status: 400, error: 'unknown', text: ERR } });
  const big = bigImage('r193-g21.png');
  await addImage(page, big, 1);
  const T = `G21-${uniqueTag()}`;
  await sendAndGetResponse(page, T);
  const [e] = await waitReceived(page, ctx, T);
  // 行为清单第 21 条只断言页面现象(报错显示、用户消息与图片卡片仍在、无「没能带上」提示),改动前后都应成立;
  // 「照常带图」(错误契约表)在 G1 等用例里已覆盖,这里只把收到的形态记成注释,不作断言,免得本条在改动前红在无关处。
  test.info().annotations.push({ type: 'cli-received-kind', description: `${e.kind},图片块 ${imageBlocks(e).length} 个` });
  expect(entryText(e).includes(T), 'G21:命令行应收到这条消息(文字含 T)').toBe(true);
  await expect(page.getByText(ERR).first(), 'G21:页面应显示这一轮的报错').toBeVisible({ timeout: 30_000 });
  await expect.poll(() => readUserCard(page, T).then((s) => ({ cards: s.cards, imgs: s.imgs.map((i) => i.loaded) })), { message: 'G21:报错之后对话里文字为 T 的用户消息及它的 1 个图片卡片应仍在', timeout: 20_000 })
    .toEqual({ cards: 1, imgs: [true] });
  expect(await hintEverShown(page, 2_000), `G21:页面不应出现含「${HINT_KEY}」的提示`).toBe(false);
});
