// r193:发送前把附件段里、应用上传目录内的图片读成图片块,和原文字一起作为数组交给命令行。
// 依据(.devflow/r193-image-attach-inline.md):命令行对 @图片路径 按 256KiB 分界决定带不带(S1),
// 改成「文字块 + 图片块」数组后每张图都到模型(S4、S8、S12)。本模块只做改写,不接入发送流程。
//
// 安全要点(路径来自请求):
//   - 先取真实路径并判定在上传目录内,再打开;只打开判定过的真实路径(能用就加 O_NOFOLLOW);
//   - 大小、是否普通文件、内容都从打开的句柄取,不按路径读第二次;超过上限在读内容之前拒绝;
//   - skipped[].name 只取提交路径最后一段,返回值里不出现任何目录;
//   - 任何未预期的异常都退回原字符串,只报一个不带路径的错误标记。
import nodePath from 'path';
import { promises as nodeFs, constants as fsConstants } from 'fs';
import { parseAttachmentPrompt } from './attachment-prompt-format.js';
import { UPLOAD_DIR, realpathNative, isPathInsideWith } from './safe-path.js';

export const IMAGE_INLINE_MAX_BYTES = 20 * 1024 * 1024; // S12:19.8MB 原图命令行能处理,更大的没测
// 一条消息里已带上图片的合计字节上限;实测过的最大一行是单张 19.8MB(S12),更大的合计量没验证,不放行。
export const IMAGE_INLINE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const IMAGE_INLINE_MAX_IMAGES = 20;
export const IMAGE_INLINE_ERROR = 'IMAGE_INLINE_FAILED';

// 按扩展名分「图片候选」与文档类;文档类不读、不进 skipped(方案第 2 节第 3 条)。
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'avif']);

function lastSegment(submitted) {
  const parts = String(submitted).split(/[\\/]/);
  return parts[parts.length - 1];
}

export function isImageCandidatePath(submitted) {
  const name = lastSegment(submitted);
  const dot = name.lastIndexOf('.');
  return dot > 0 && IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

// ---- 格式识别与结构检查(不解码像素,只在已读入的缓冲区上做下标访问) ----

let crcTable = null;
function crc32(buf, start, end) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = start; i < end; i += 1) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const startsWithBytes = (buf, bytes, at = 0) => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);
const startsWithAscii = (buf, text, at = 0) => buf.length >= at + text.length && buf.toString('latin1', at, at + text.length) === text;

/** 以文件头认格式;认不出返回 null。 */
export function sniffImageMediaType(buf) {
  if (startsWithBytes(buf, PNG_SIGNATURE)) return 'image/png';
  if (startsWithBytes(buf, [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (startsWithAscii(buf, 'GIF87a') || startsWithAscii(buf, 'GIF89a')) return 'image/gif';
  if (startsWithAscii(buf, 'RIFF') && startsWithAscii(buf, 'WEBP', 8)) return 'image/webp';
  return null;
}

function pngStructureOk(buf) {
  let offset = PNG_SIGNATURE.length;
  let first = true;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const dataEnd = offset + 8 + length;
    if (dataEnd + 4 > buf.length) return false; // 截断
    const type = buf.toString('latin1', offset + 4, offset + 8);
    if (first && type !== 'IHDR') return false;
    first = false;
    if (crc32(buf, offset + 4, dataEnd) !== buf.readUInt32BE(dataEnd)) return false;
    offset = dataEnd + 4;
    // 走到 IEND 且之前各块 CRC 都对就算通过;IEND 后面的多余字节不算损坏(能正常显示的图常见)。
    if (type === 'IEND') return true;
  }
  return false;
}

// JPEG:从文件头逐段走到「开始扫描」(DA),之后能找到 FFD9 才算通过。
// 不要求以 FFD9 结尾:手机照片常在结束标记后附带别的数据。
function jpegStructureOk(buf) {
  const n = buf.length;
  let offset = 2; // 跳过 SOI(FFD8)
  while (offset + 1 < n) {
    if (buf[offset] !== 0xFF) return false; // 段头不是 FF
    const marker = buf[offset + 1];
    if (marker === 0xFF) { offset += 1; continue; } // 段前填充的 FF
    // 不带段长的独立标记:TEM、RST0–7;段头区出现 SOI / EOI 视为损坏
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { offset += 2; continue; }
    if (marker === 0xD8 || marker === 0xD9) return false;
    if (offset + 4 > n) return false;
    const segmentLength = buf.readUInt16BE(offset + 2);
    const segmentEnd = offset + 2 + segmentLength;
    if (segmentLength < 2 || segmentEnd > n) return false; // 段长越界
    if (marker === 0xDA) {
      for (let i = segmentEnd; i + 1 < n; i += 1) {
        if (buf[i] === 0xFF && buf[i + 1] === 0xD9) return true;
      }
      return false;
    }
    offset = segmentEnd;
  }
  return false;
}

/** 结构检查(方案第 2 节第 4 条,按主会话修订放宽)。mediaType 来自 sniffImageMediaType。 */
export function imageStructureOk(buf, mediaType) {
  const n = buf.length;
  switch (mediaType) {
    case 'image/png': return pngStructureOk(buf);
    case 'image/jpeg': return jpegStructureOk(buf);
    case 'image/gif': return n > 6 && buf[n - 1] === 0x3B;
    case 'image/webp': {
      if (n < 12) return false;
      const declared = buf.readUInt32LE(4) + 8;
      return declared === n || declared === n - 1; // 奇数长度时末尾多一个填充字节
    }
    default: return false;
  }
}

// ---- 单个候选:判定 → 打开 → 按句柄读 → 检查 ----

const callAsync = (fn, ...args) => Promise.resolve().then(() => fn(...args));

async function classifyPath(submitted, ctx) {
  const { pathModule, realpathFn, uploadDir, uploadReal } = ctx;
  if (!pathModule.isAbsolute(submitted)) return { reason: 'outside' };
  let real;
  try {
    real = await callAsync(realpathFn, submitted);
  } catch (err) {
    // 取不到真实路径(多半是文件已被清理):只有它所在目录确实在上传目录内,才报 missing / unreadable;
    // 否则一律 outside,不对目录外的路径给出「存在与否」的信息。
    const parentReal = await callAsync(realpathFn, pathModule.dirname(submitted)).catch(() => null);
    const inside = parentReal
      ? !!uploadReal && isPathInsideWith(pathModule, parentReal, uploadReal)
      : isPathInsideWith(pathModule, submitted, uploadDir); // 上一级也不在(整个上传目录被清掉)时按字面判断
    if (!inside) return { reason: 'outside' };
    return { reason: err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'missing' : 'unreadable' };
  }
  if (!uploadReal || !isPathInsideWith(pathModule, real, uploadReal)) return { reason: 'outside' };
  return { real };
}

async function readHandleFully(handle, size) {
  const buf = Buffer.allocUnsafe(size); // 只按句柄 stat 出的大小分配,且已过大小上限检查
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buf, offset, size - offset, offset);
    if (!bytesRead) break; // 读的过程中文件变短:按实际读到的检查,结构检查会拦下截断
    offset += bytesRead;
  }
  return offset === size ? buf : buf.subarray(0, offset);
}

async function readCandidate(submitted, ctx) {
  const where = await classifyPath(submitted, ctx);
  if (where.reason) return where;
  let handle;
  try {
    handle = await ctx.fsImpl.open(where.real, ctx.openFlags);
  } catch (err) {
    if (err?.code === 'ENOENT') return { reason: 'missing' };
    if (err?.code === 'ELOOP') return { reason: 'outside' }; // 判定之后被换成了符号链接
    return { reason: 'unreadable' };
  }
  try {
    let stats;
    let data;
    try {
      stats = await handle.stat();
      if (!stats.isFile()) return { reason: 'unreadable' };
      // 单张超限,或已带上的加这一张超过一条消息的合计上限:不读内容(后面更小的还能带)
      if (stats.size > ctx.maxBytes || ctx.totalBytes + stats.size > ctx.maxTotalBytes) return { reason: 'too-large' };
      data = await readHandleFully(handle, stats.size);
    } catch {
      return { reason: 'unreadable' };
    }
    const mediaType = sniffImageMediaType(data);
    if (!mediaType) return { reason: 'unsupported' };
    if (!imageStructureOk(data, mediaType)) return { reason: 'damaged' };
    return { bytes: data.length, block: { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } } };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * 把提示词末尾附件段里的图片读成图片块。
 * @param {string} prompt 发给命令行的原提示词(页面 buildAttachmentMessage 的产物)
 * @param {object} [options]
 * @param {boolean} [options.enabled=true] 关掉时原样返回
 * @param {string} [options.uploadDir] 上传目录,默认 <tmpdir>/cgui-attachments
 * @param {object} [options.fsImpl] 需要 open(path, flags) → FileHandle(stat/read/close),默认 fs.promises
 * @param {object} [options.pathModule] 默认 path(单测可注入 path.win32)
 * @param {Function} [options.realpathFn] 默认 fs.realpath.native;上传目录与候选路径共用
 * @param {string} [options.platform] 默认 process.platform;win32 不加 O_NOFOLLOW
 * @param {number} [options.maxBytes] 单张上限,默认 20MB
 * @param {number} [options.maxTotalBytes] 一条消息里已带上图片的合计字节上限,默认 20MB
 * @param {number} [options.maxImages] 一条最多张数,默认 20
 * @returns {Promise<{ content: string | Array<object>, imageAttach: { inlined: number, skipped: Array<{ name: string, reason: string }> } | undefined, error?: string }>}
 */
export async function inlineImageAttachments(prompt, options = {}) {
  const passthrough = { content: prompt, imageAttach: undefined };
  const {
    enabled = true,
    uploadDir = UPLOAD_DIR,
    fsImpl = nodeFs,
    pathModule = nodePath,
    realpathFn = realpathNative,
    platform = process.platform,
    maxBytes = IMAGE_INLINE_MAX_BYTES,
    maxTotalBytes = IMAGE_INLINE_MAX_TOTAL_BYTES,
    maxImages = IMAGE_INLINE_MAX_IMAGES,
  } = options || {};
  if (!enabled || typeof prompt !== 'string') return passthrough;
  try {
    const parsed = parseAttachmentPrompt(prompt);
    if (!parsed) return passthrough;
    const candidates = parsed.paths.filter(isImageCandidatePath);
    if (!candidates.length) return passthrough;

    const noFollow = platform !== 'win32' && fsConstants.O_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0;
    const ctx = {
      fsImpl, pathModule, realpathFn, uploadDir, maxBytes, maxTotalBytes,
      totalBytes: 0,
      openFlags: fsConstants.O_RDONLY | noFollow,
      uploadReal: await callAsync(realpathFn, uploadDir).catch(() => null),
    };
    const blocks = [];
    const skipped = [];
    for (const submitted of candidates) {
      const name = lastSegment(submitted);
      if (blocks.length >= maxImages) { skipped.push({ name, reason: 'too-many' }); continue; }
      const result = await readCandidate(submitted, ctx);
      if (result.block) { blocks.push(result.block); ctx.totalBytes += result.bytes; }
      else skipped.push({ name, reason: result.reason });
    }
    return {
      content: blocks.length ? [{ type: 'text', text: prompt }, ...blocks] : prompt,
      imageAttach: { inlined: blocks.length, skipped },
    };
  } catch {
    return { ...passthrough, error: IMAGE_INLINE_ERROR };
  }
}
