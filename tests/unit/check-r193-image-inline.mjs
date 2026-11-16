// r193 第 2 步:把上传目录里的图片读成图片块的改写模块 + 共用的上传目录判定。
// 真实读写系统临时目录下自建的目录;Windows 那组用注入的 path.win32 与假的真实路径函数。
// 运行:node tests/unit/check-r193-image-inline.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, chmod, rm, rmdir, realpath, open as fsOpen } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { deflateSync, crc32 as zlibCrc32 } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import {
  inlineImageAttachments, isImageCandidatePath, sniffImageMediaType, imageStructureOk,
  IMAGE_INLINE_ERROR, IMAGE_INLINE_MAX_BYTES, IMAGE_INLINE_MAX_IMAGES,
} from '../../server/utils/image-attach-inline.js';
import { isInsideUploadDir, isPathInsideWith, UPLOAD_DIR } from '../../server/utils/safe-path.js';
import { formatAttachmentPrompt } from '../../server/utils/attachment-prompt-format.js';

let count = 0;
const pending = [];
const check = (name, fn) => pending.push([name, fn]);

// ---- 夹具:自建临时目录(lexical 是 /var/...,真实路径是 /private/var/...)----
const root = await mkdtemp(join(tmpdir(), 'cgui-r193-inline-'));
const rootReal = await realpath(root);
const up = join(root, 'cgui-attachments'); // 上传目录(字面写法)
const upReal = join(rootReal, 'cgui-attachments'); // 上传目录(真实路径)
const outsideDir = join(root, 'outside');
const upLink = join(root, 'up-link'); // 指向上传目录的符号链接
await mkdir(up);
await mkdir(outsideDir);
await symlink(upReal, upLink);

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlibCrc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
function makePng(width = 1, height = 1, random = false) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 位 RGB
  const rows = [];
  for (let y = 0; y < height; y += 1) rows.push(Buffer.from([0]), random ? randomBytes(width * 3) : Buffer.alloc(width * 3, 0x7f));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
// GIF / WebP 用公开的 1×1 最小文件;JPEG 只造结构检查要看的头尾(结构检查不解码像素)。
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
const JPEG = Buffer.concat([
  Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'),
  Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0]), randomBytes(40), Buffer.from([0xFF, 0xD9]),
]);
const PNG = makePng(4, 3, true);

async function put(dir, name, data) { const p = join(dir, name); await writeFile(p, data); return p; }
const promptWith = (paths, text = '看图') => formatAttachmentPrompt(text, paths);
const opts = (extra = {}) => ({ uploadDir: up, ...extra });
const assertNoDir = (value) => {
  const json = JSON.stringify(value);
  for (const dir of [root, rootReal, up, upReal, outsideDir, upLink]) assert.ok(!json.includes(dir), `不含目录 ${dir}`);
};

// ---- 候选分类 ----
check('候选分类:图片扩展名(不区分大小写)/ 文档类', () => {
  for (const p of ['/a/x.png', '/a/x.PNG', '/a/x.jpeg', '/a/x.JPG', '/a/x.gif', '/a/x.webp', '/a/x.heic',
    '/a/x.heif', '/a/x.bmp', '/a/x.tif', '/a/x.tiff', '/a/x.avif', 'C:\\a b\\x.Png']) {
    assert.equal(isImageCandidatePath(p), true, p);
  }
  for (const p of ['/a/x.txt', '/a/x.pdf', '/a/x.md', '/a/png', '/a/.png', '/a/x.png.txt', '/a/x']) {
    assert.equal(isImageCandidatePath(p), false, p);
  }
});

check('常量:20MB / 20 张', () => {
  assert.equal(IMAGE_INLINE_MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(IMAGE_INLINE_MAX_IMAGES, 20);
});

// ---- 不改写的几种 ----
check('未启用:原样返回,imageAttach undefined', async () => {
  const p = await put(up, 'off.png', PNG);
  const prompt = promptWith([p]);
  const r = await inlineImageAttachments(prompt, opts({ enabled: false }));
  assert.equal(r.content, prompt);
  assert.equal(r.imageAttach, undefined);
  assert.ok(!('error' in r));
});

check('没有附件段 / 不是字符串:原样返回', async () => {
  const r = await inlineImageAttachments('只是文字\n\n附件:\n普通行', opts());
  assert.deepEqual(r, { content: '只是文字\n\n附件:\n普通行', imageAttach: undefined });
  const arr = [{ type: 'text', text: 'x' }];
  assert.equal((await inlineImageAttachments(arr, opts())).content, arr);
});

check('只有文档类附件:原样返回,imageAttach undefined,不读文件', async () => {
  const txt = await put(up, 'note.txt', 'hello');
  const prompt = promptWith([txt, '/elsewhere/report.pdf']);
  let opened = 0;
  const fsImpl = { open: (...a) => { opened += 1; return fsOpen(...a); } };
  const r = await inlineImageAttachments(prompt, opts({ fsImpl }));
  assert.deepEqual(r, { content: prompt, imageAttach: undefined });
  assert.equal(opened, 0);
});

// ---- 四种格式 ----
check('四种格式各一张:数组写法,文字块逐字相同,媒体类型与 base64 对上', async () => {
  const files = [
    [await put(up, 'p.png', PNG), 'image/png', PNG],
    [await put(up, 'j.jpg', JPEG), 'image/jpeg', JPEG],
    [await put(up, 'g.gif', GIF), 'image/gif', GIF],
    [await put(up, 'w.webp', WEBP), 'image/webp', WEBP],
  ];
  const prompt = promptWith(files.map((f) => f[0]), '  四张 图 ');
  const r = await inlineImageAttachments(prompt, opts());
  assert.ok(Array.isArray(r.content));
  assert.equal(r.content.length, 5);
  assert.deepEqual(r.content[0], { type: 'text', text: prompt });
  files.forEach(([, mediaType, bytes], i) => {
    assert.deepEqual(r.content[i + 1], { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } });
  });
  assert.deepEqual(r.imageAttach, { inlined: 4, skipped: [] });
  assertNoDir(r.imageAttach);
});

check('媒体类型以文件头为准(.png 里装的是 JPEG)', async () => {
  const p = await put(up, 'fake.png', JPEG);
  const r = await inlineImageAttachments(promptWith([p]), opts());
  assert.equal(r.content[1].source.media_type, 'image/jpeg');
});

check('图与文档混合:文字块里文档的路径行还在,只有图片块', async () => {
  const img = await put(up, 'mix.png', PNG);
  const txt = await put(up, 'mix.txt', 'doc');
  const prompt = promptWith([img, txt]);
  const r = await inlineImageAttachments(prompt, opts());
  assert.equal(r.content.length, 2);
  assert.equal(r.content[0].text, prompt);
  assert.ok(r.content[0].text.includes(`@${txt}`));
  assert.deepEqual(r.imageAttach, { inlined: 1, skipped: [] });
});

// ---- 坏图与格式 ----
check('损坏:PNG 文件头完好后面乱码 / 截断 / IEND 后有尾巴;其他三种结构不对', async () => {
  const big = makePng(64, 64, true);
  const garbled = Buffer.concat([big.subarray(0, 64), randomBytes(big.length - 64)]);
  const cases = [
    ['garbled.png', garbled],
    ['trunc.png', PNG.subarray(0, PNG.length - 5)],
    ['tail.png', Buffer.concat([PNG, Buffer.from('xx')])],
    ['trunc.jpg', JPEG.subarray(0, JPEG.length - 1)],
    ['trunc.gif', GIF.subarray(0, GIF.length - 1)],
    ['bad.webp', Buffer.concat([WEBP, Buffer.from([0, 0])])],
  ];
  const paths = [];
  for (const [name, data] of cases) paths.push(await put(up, name, data));
  const prompt = promptWith(paths);
  const r = await inlineImageAttachments(prompt, opts());
  assert.equal(r.content, prompt, '没有能带的图 → 原字符串');
  assert.deepEqual(r.imageAttach, { inlined: 0, skipped: cases.map(([name]) => ({ name, reason: 'damaged' })) });
  // 模块自己的 CRC 与 zlib.crc32 交叉验证:好图过、改一个字节不过
  assert.equal(imageStructureOk(PNG, 'image/png'), true);
  const flipped = Buffer.from(PNG); flipped[20] ^= 1;
  assert.equal(imageStructureOk(flipped, 'image/png'), false);
});

check('heic / 认不出的内容 / 空文件 → unsupported', async () => {
  const heic = await put(up, 'photo.heic', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'latin1'), randomBytes(300)]));
  const textAsPng = await put(up, 'text.png', 'not an image at all');
  const empty = await put(up, 'empty.png', Buffer.alloc(0));
  const r = await inlineImageAttachments(promptWith([heic, textAsPng, empty]), opts());
  assert.deepEqual(r.imageAttach.skipped, [
    { name: 'photo.heic', reason: 'unsupported' }, { name: 'text.png', reason: 'unsupported' }, { name: 'empty.png', reason: 'unsupported' },
  ]);
  assert.equal(sniffImageMediaType(Buffer.from('GIF89a;', 'latin1')), 'image/gif');
});

// ---- 上限 ----
check('超过大小上限(注入小上限):读内容之前拒绝', async () => {
  const p = await put(up, 'big.png', PNG);
  let reads = 0;
  const fsImpl = { open: async (...a) => { const h = await fsOpen(...a); const read = h.read.bind(h); h.read = (...x) => { reads += 1; return read(...x); }; return h; } };
  const r = await inlineImageAttachments(promptWith([p]), opts({ fsImpl, maxBytes: PNG.length - 1 }));
  assert.deepEqual(r.imageAttach, { inlined: 0, skipped: [{ name: 'big.png', reason: 'too-large' }] });
  assert.equal(reads, 0, '超限不读内容');
  const ok = await inlineImageAttachments(promptWith([p]), opts({ maxBytes: PNG.length }));
  assert.equal(ok.imageAttach.inlined, 1, '等于上限照带');
});

check('超过张数上限(注入小上限):前 N 张照带,其余 too-many', async () => {
  const paths = [];
  for (let i = 0; i < 4; i += 1) paths.push(await put(up, `n${i}.png`, PNG));
  const r = await inlineImageAttachments(promptWith(paths), opts({ maxImages: 2 }));
  assert.equal(r.content.length, 3);
  assert.deepEqual(r.imageAttach, { inlined: 2, skipped: [{ name: 'n2.png', reason: 'too-many' }, { name: 'n3.png', reason: 'too-many' }] });
});

// ---- 缺文件、目录、读不了 ----
check('缺文件 → missing;两张删一张时带 1 张', async () => {
  const keep = await put(up, 'keep.png', PNG);
  const gone = join(up, 'gone.png');
  const r1 = await inlineImageAttachments(promptWith([gone]), opts());
  assert.equal(typeof r1.content, 'string');
  assert.deepEqual(r1.imageAttach, { inlined: 0, skipped: [{ name: 'gone.png', reason: 'missing' }] });
  const r2 = await inlineImageAttachments(promptWith([keep, gone]), opts());
  assert.equal(r2.content.length, 2);
  assert.deepEqual(r2.imageAttach.skipped, [{ name: 'gone.png', reason: 'missing' }]);
  assertNoDir(r2.imageAttach);
});

check('整个上传目录不存在时,目录内的路径 → missing,目录外 → outside', async () => {
  const noDir = join(root, 'never-created');
  const r = await inlineImageAttachments(promptWith([join(noDir, 'a.png'), join(outsideDir, 'b.png')]), { uploadDir: noDir });
  assert.deepEqual(r.imageAttach.skipped, [{ name: 'a.png', reason: 'missing' }, { name: 'b.png', reason: 'outside' }]);
});

check('目录当文件 → unreadable;没有读权限 → unreadable', async () => {
  const dirPng = join(up, 'folder.png');
  await mkdir(dirPng);
  const locked = await put(up, 'locked.png', PNG);
  await chmod(locked, 0o000);
  const r = await inlineImageAttachments(promptWith([dirPng, locked]), opts());
  const expectLocked = process.getuid && process.getuid() === 0 ? [] : [{ name: 'locked.png', reason: 'unreadable' }];
  assert.deepEqual(r.imageAttach.skipped, [{ name: 'folder.png', reason: 'unreadable' }, ...expectLocked]);
  await chmod(locked, 0o600);
});

// ---- 路径判定 ----
check('目录外、相对路径、.. 绕出去、符号链接指到外面 → outside,name 只是最后一段', async () => {
  const outsidePng = await put(outsideDir, 'secret.png', PNG);
  const link = join(up, 'evil-link.png');
  await symlink(outsidePng, link);
  const dotdot = join(up, '..', 'outside', 'secret.png');
  const r = await inlineImageAttachments(promptWith([outsidePng, 'secret.png', `${up}/../outside/secret.png`, dotdot, link]), opts());
  assert.equal(r.content.constructor, String);
  assert.deepEqual(r.imageAttach.skipped.map((s) => s.reason), ['outside', 'outside', 'outside', 'outside', 'outside']);
  assert.deepEqual(r.imageAttach.skipped.map((s) => s.name), ['secret.png', 'secret.png', 'secret.png', 'secret.png', 'evil-link.png']);
  assertNoDir(r.imageAttach);
  // 目录外不存在的文件也是 outside(不透露存在与否)
  const r2 = await inlineImageAttachments(promptWith([join(outsideDir, 'nope.png')]), opts());
  assert.deepEqual(r2.imageAttach.skipped, [{ name: 'nope.png', reason: 'outside' }]);
});

check('上传目录的两种写法(符号链接的临时目录 / 真实路径)互相都认', async () => {
  const p = await put(up, 'forms.png', PNG);
  const viaReal = join(upReal, 'forms.png');
  const viaLink = join(upLink, 'forms.png');
  for (const uploadDir of [up, upReal, upLink]) {
    for (const submitted of [p, viaReal, viaLink]) {
      const r = await inlineImageAttachments(promptWith([submitted]), { uploadDir });
      assert.equal(r.imageAttach?.inlined, 1, `${uploadDir} ← ${submitted}`);
    }
  }
  assert.equal(await isInsideUploadDir(viaReal, { uploadDir: up }), true);
  assert.equal(await isInsideUploadDir(join(rootReal, 'cgui-attachments2', 'x.png'), { uploadDir: up }), false, '同前缀的兄弟目录不算');
  assert.equal(await isInsideUploadDir(viaReal, { uploadDir: join(root, 'missing-dir') }), false);
  assert.ok(UPLOAD_DIR.endsWith('cgui-attachments'));
});

check('只打开判定过的真实路径,带 O_NOFOLLOW;判定后被换成符号链接 → outside', async () => {
  const p = await put(up, 'flags.png', PNG);
  const seen = [];
  const fsImpl = { open: (file, flags) => { seen.push([file, flags]); return fsOpen(file, flags); } };
  await inlineImageAttachments(promptWith([join(upLink, 'flags.png')]), opts({ fsImpl }));
  assert.deepEqual(seen, [[join(upReal, 'flags.png'), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW]]);
  // 模拟「判定之后、打开之前被换成符号链接」:真实路径函数把它报成自己,打开时 O_NOFOLLOW 拒绝
  const outsidePng = await put(outsideDir, 'swap-target.png', PNG);
  const swapped = join(upReal, 'swapped.png');
  await symlink(outsidePng, swapped);
  const lyingRealpath = async (x) => (x === swapped ? swapped : realpath(x));
  const r = await inlineImageAttachments(promptWith([swapped]), opts({ realpathFn: lyingRealpath }));
  assert.deepEqual(r.imageAttach.skipped, [{ name: 'swapped.png', reason: 'outside' }]);
  assert.ok(p);
});

check('意外异常 → 原字符串、imageAttach undefined、只报不带路径的错误标记', async () => {
  const p = await put(up, 'boom.png', PNG);
  const prompt = promptWith([p]);
  const pathModule = { ...path, isAbsolute: () => { throw new Error(`boom ${p}`); } };
  const r = await inlineImageAttachments(prompt, opts({ pathModule }));
  assert.deepEqual(r, { content: prompt, imageAttach: undefined, error: IMAGE_INLINE_ERROR });
  assert.ok(!IMAGE_INLINE_ERROR.includes('/'));
});

// ---- Windows 模拟:path.win32 + 假的真实路径函数(展开短名)----
const W = path.win32;
const winShortUp = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\cgui-attachments';
const winLongUp = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\cgui-attachments';
const winRealpath = async (p) => {
  if (typeof p !== 'string' || !W.isAbsolute(p)) throw Object.assign(new Error('bad'), { code: 'EINVAL' });
  return p.replace(/^C:\\Users\\RUNNER~1\\/i, 'C:\\Users\\runneradmin\\');
};

check('Windows 模拟:共用判定(短名、大小写不一致、另一个盘、兄弟目录)', async () => {
  const o = { uploadDir: winShortUp, pathModule: W, realpathFn: winRealpath };
  assert.equal(await isInsideUploadDir(`${winLongUp}\\a.png`, o), true, '短名上传目录 vs 长名文件');
  assert.equal(await isInsideUploadDir('c:\\USERS\\RunnerAdmin\\appdata\\LOCAL\\temp\\CGUI-ATTACHMENTS\\a.png', o), true, '大小写不一致');
  assert.equal(await isInsideUploadDir('D:\\Users\\runneradmin\\AppData\\Local\\Temp\\cgui-attachments\\a.png', o), false, '另一个盘');
  assert.equal(await isInsideUploadDir(`${winLongUp}2\\a.png`, o), false, '兄弟目录');
  assert.equal(isPathInsideWith(W, 'C:\\a\\b', 'c:\\A'), true);
});

check('Windows 模拟:改写模块端到端(不加 O_NOFOLLOW,另一个盘不打开)', async () => {
  const disk = await mkdtemp(join(tmpdir(), 'cgui-r193-win-'));
  await writeFile(join(disk, 'shot one.png'), PNG);
  const seen = [];
  // 只把 Windows 路径的文件名映射到真实临时目录里的同名文件,读写仍是真实文件系统
  const fsImpl = { open: (file, flags) => { seen.push([file, flags]); return fsOpen(join(disk, W.basename(file)), fsConstants.O_RDONLY); } };
  const submitted = ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\CGUI-attachments\\shot one.png',
    'D:\\Users\\runneradmin\\AppData\\Local\\Temp\\cgui-attachments\\shot one.png'];
  const prompt = promptWith(submitted);
  const r = await inlineImageAttachments(prompt, { uploadDir: winShortUp, pathModule: W, realpathFn: winRealpath, fsImpl, platform: 'win32' });
  assert.equal(r.content[0].text, prompt);
  assert.equal(r.content.length, 2);
  assert.deepEqual(r.imageAttach, { inlined: 1, skipped: [{ name: 'shot one.png', reason: 'outside' }] });
  assert.deepEqual(seen, [['C:\\Users\\runneradmin\\AppData\\Local\\Temp\\CGUI-attachments\\shot one.png', fsConstants.O_RDONLY]]);
  assert.ok(!JSON.stringify(r.imageAttach).includes('\\'));
  await rm(join(disk, 'shot one.png'));
  await rmdir(disk);
});

// ---- 运行 ----
let failed = 0;
try {
  for (const [name, fn] of pending) {
    try { await fn(); count += 1; console.log(`ok ${count} ${name}`); }
    catch (err) { failed += 1; console.log(`FAIL ${name}\n${err.stack}`); }
  }
} finally {
  await rm(root, { recursive: true, force: true }); // 只删本测试自建的临时目录
}
console.log(`check-r193-image-inline: ${count} passed, ${failed} failed`);
if (failed) process.exit(1);
