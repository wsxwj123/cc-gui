// r11-③:皮肤包导入/管理路由(cgui-skin/1)。契约 = .devflow/INTERFACE-skin.md +
// FIX-SPEC-r11-b3 §③。校验全部在 ../utils/skin-validate.js(纯函数,单测先行);
// 本文件只做 I/O 编排:流式收包 → bsdtar 清单校验 → 解压(实测字节闸)→ manifest
// 校验 → 资源闸(字节/像素/SVG 清洗/T2 静态校验)→ 原子搬入 ~/.claude-gui/skins/<id>/。
// 文件名避开已存在的 skills.js(Claude 技能),端点用 /api/skins。
import express, { Router } from 'express';
import { mkdir, unlink, stat, readFile, writeFile, readdir, rename, rm } from 'fs/promises';
import { createWriteStream, existsSync } from 'fs';
import { pipeline } from 'stream/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dirname, extname, join } from 'path';
import { homedir, tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { isPathInside } from '../utils/safe-path.js';
import { broadcast } from '../broadcast.js';
import {
  parseTarListing, validateZipEntries, resolveRootPrefix, stripJunkEntries, validateManifest,
  imageDimensions, sanitizeSvg, validateT2Script, convertDswVars, ZIP_LIMITS,
  skinIdFrom, slugOf, SKIN_ID_RE, SKIN_ASSET_RE,
} from '../utils/skin-validate.js';

const execFileP = promisify(execFile);
const router = Router();

export const SKINS_DIR = join(homedir(), '.claude-gui', 'skins');

// bsdtar 定位:win = 系统绝对路径(Win10 1803+ 自带;不走 shell 不套 login shell——
// memory win 三坑);mac/linux 优先 /usr/bin/tar(mac 自带即 bsdtar),缺了回落 PATH。
export function tarBinary(platform = process.platform) {
  if (platform === 'win32') return 'C:\\Windows\\System32\\tar.exe';
  return existsSync('/usr/bin/tar') ? '/usr/bin/tar' : 'tar';
}

const CONTENT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
};
const ERROR_MESSAGES = {
  dir_invalid: '导入数据格式不正确:files 需为非空数组',
  dir_entries_exceeded: '文件夹内文件数超过 64 个上限',
  not_zip: '导入文件不是有效的 zip 或 .cguiskin 压缩包',
  zip_too_large: '皮肤包超过 30MB 上限',
  zip_entries_exceeded: '压缩包内条目数超过 40 个上限',
  zip_bomb_suspected: '压缩包解压体积超过 100MB 上限,已中止',
  path_traversal: '压缩包含非法路径条目,已拒绝',
  manifest_missing: '包内未找到 skin.json(或可识别的 CodeFace theme.json)',
  unsupported_format: '皮肤格式版本不受支持,当前支持 cgui-skin/1',
  manifest_invalid: 'skin.json 校验失败',
  asset_missing: 'manifest 引用的文件不在包内',
  asset_type: '不支持的资源类型,允许 png/jpg/jpeg/webp/gif(图标 svg)',
  asset_too_large: '图片超过 20MB 上限',
  image_too_large_px: '图片尺寸超过 8192px 上限',
  image_invalid: '图片无法解析,可能已损坏或不是声明的格式',
  empty_skin: '皮肤包不含任何可应用内容(变量与背景均为空或全部被忽略)',
  svg_rejected: '图标 SVG 未通过安全清洗',
  script_rejected: 'client.js 含被禁止的调用,已拒绝载入',
  not_found: '皮肤不存在',
  internal: '导入失败,详见服务端日志',
};
const HTTP_OF = {
  dir_invalid: 400, dir_entries_exceeded: 400,
  not_zip: 400, zip_too_large: 413, zip_entries_exceeded: 400, zip_bomb_suspected: 400,
  path_traversal: 400, manifest_missing: 400, unsupported_format: 400, manifest_invalid: 422,
  asset_missing: 422, asset_type: 400, asset_too_large: 413, image_too_large_px: 413,
  image_invalid: 422, empty_skin: 422, svg_rejected: 422, script_rejected: 422, not_found: 404, internal: 500,
};
function failCode(code, extra = {}) {
  const err = new Error(ERROR_MESSAGES[code] || code);
  err.skinCode = code;
  Object.assign(err, extra);
  return err;
}

/**
 * r45:清单被拒时给出【可行动原因】。校验规则本体(validateManifest)一字不动,这里只把
 * 「拒了」翻成「为什么拒、下一步该做什么」——前端 report() 只展示 message,原来统一显示
 * 「skin.json 校验失败」,用户拿 dsh 项目文件夹来导入时完全无从下手。三类:
 *   a) 缺 format 且形如 dsh 皮肤库清单(id/accent/bodyAttr/order 这类键命中 ≥2 个)——
 *      最常见的误导入;dsh 皮肤代码绑定 dsh 页面结构,不是改个字段就能用;
 *   b) 缺 format 但不像 dsh —— 只报缺标记;
 *   c) 其余 —— 现有具体校验点(字段名)拼进 message。
 * 命中 ≥2 个键才算 dsh 形:单个 id/order 在别的清单里也常见,两个以上才具备判别力。
 */
export function manifestRejectMessage(raw, vm) {
  const base = ERROR_MESSAGES[vm.code] || vm.code;
  const details = Array.isArray(vm.details) ? vm.details.filter(Boolean) : [];
  const isObj = raw && typeof raw === 'object' && !Array.isArray(raw);
  if (vm.code === 'unsupported_format') return vm.format ? `${base}(包内 format 为 ${vm.format})` : base;
  if (vm.code === 'manifest_invalid' && isObj && !(typeof raw.format === 'string' && raw.format)) {
    const dshKeys = ['id', 'accent', 'bodyAttr', 'order'].filter((k) => raw[k] !== undefined);
    if (dshKeys.length >= 2) {
      return `该 skin.json 是 dsh 皮肤库格式(含 ${dshKeys.join('/')} 字段),与本应用不通用:`
        + 'dsh 皮肤代码绑定 dsh 页面结构。需按「AI 提示词生成器」产出 cgui 皮肤,或做一次移植改写。';
    }
    return 'skin.json 缺少 format:\'cgui-skin/1\' 标记,无法识别为本应用的皮肤包。';
  }
  return details.length ? `${base}:${details.join(';')}` : base;
}

/**
 * r26-D4:stage 目录搬入 skinsDir 的统一出口。rename 优先;EXDEV(tmp 与 home 跨卷,
 * 如 Linux tmpfs /tmp)回落 mkdir+逐文件拷贝+rm stage。renameFn 仅供单测注入失败形态。
 * 非 EXDEV 错误原样上抛不吞(清 stage 是调用方 catch 的职责)。
 */
export async function moveStageDir(stage, dest, renameFn = rename) {
  try {
    await renameFn(stage, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await mkdir(dest, { recursive: true });
    for (const n of await readdir(stage)) await writeFile(join(dest, n), await readFile(join(stage, n)));
    await rm(stage, { recursive: true, force: true });
  }
}

/** stage 创建后任何失败都必须清 stage(防 tmpdir 泄漏)——两条导入路径同口径。 */
async function cleanupStage(stage) {
  await rm(stage, { recursive: true, force: true }).catch(() => {});
}

/**
 * r26-D6 覆盖式去重:同 slug 视为同一皮肤(语义声明:「导入=换成新版」)。
 * skinsDir 里找 id === slug 或 id 为 `${slug}-<6位随机后缀>` 形态的既有目录 → 复用其 id;
 * 未命中/slug 为空(CJK 退化 skin- 随机后缀,无归属语义)→ null 走新 id。
 * r31:后缀段必须是恰 6 位 [a-z0-9](与 skinIdFrom 的随机后缀形态一致)——旧实现只按
 * `startsWith(slug + '-')` 判断,导入「whale」会误命中不同皮肤的「whale-song-abc123」
 * (slug=whale-song),复用其 id 后整目录 rm 覆盖,用户已装的 whale-song 皮肤被误删。
 */
export async function findExistingSkinId(slug, skinsDir = SKINS_DIR) {
  if (!slug) return null;
  let ids = [];
  try { ids = await readdir(skinsDir); } catch { return null; }
  return ids.find((d) => {
    if (!SKIN_ID_RE.test(d)) return false;
    if (d === slug) return true;
    if (!d.startsWith(`${slug}-`)) return false;
    // 随机后缀形态:slug 段可以含连字符(如 whale-song),后缀段必须恰 6 位 [a-z0-9]。
    return /^[a-z0-9]{6}$/.test(d.slice(slug.length + 1));
  }) || null;
}

async function dirBytes(dir) {
  let total = 0;
  let names = [];
  try { names = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const d of names) {
    const p = join(dir, d.name);
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) total += await dirBytes(p);
    else { try { total += (await stat(p)).size; } catch {} }
  }
  return total;
}

/**
 * r43:「已展开的目录 → 皮肤」共享管线。zip 通道(解包后)与文件夹导入通道(写入临时目录后)
 * 跑的是同一段代码 —— 逐字来自 r11 的 installSkinPackage 内联段,仅位置移动、零语义改动:
 * 定位 manifest → validateManifest → 资源闸(图片字节/像素、SVG 清洗、T2 静态校验、CSS 上限)
 * → stage 落盘 → 搬入 skinsDir/<id>(同 slug 覆盖)。
 * tmp = 已展开的临时目录(清理由调用方 finally 负责);fileEntries = 目录内文件相对路径数组
 * (可含一层根前缀,resolveRootPrefix 处理);穿越守卫的包含根仍是 tmp(与 zip 通道原口径一致)。
 */
async function installUnpacked(tmp, fileEntries, { source, skinsDir, limits }) {
  // ── 定位 manifest(根目录直放或嵌套一层)──
  const root = resolveRootPrefix(fileEntries);
  if (!root) {
    // CodeFace theme.json 分支:契约要求实抓 schema 核定映射、不许凭猜写(INTERFACE §1.6);
    // 本批禁网络无法核定 → 明确报不支持,不做臆测转换(缺口记录在交付报告)。
    const hasCodeface = fileEntries.some((p) => p.split('/').pop() === 'theme.json');
    throw failCode('manifest_missing', hasCodeface ? { message: 'CodeFace theme.json 转换需在联网环境核定映射表后支持,当前请转为 skin.json' } : {});
  }
  const rel = (p) => p.slice(root.prefix.length);
  const files = new Set(fileEntries.filter((p) => p.startsWith(root.prefix)).map(rel).filter(Boolean));
  let manifestRaw;
  try { manifestRaw = JSON.parse(await readFile(join(tmp, root.prefix, 'skin.json'), 'utf8')); }
  catch { throw failCode('manifest_invalid', { details: ['skin.json 非法 JSON'], message: 'skin.json 不是合法 JSON,无法解析' }); }
  const vm = validateManifest(manifestRaw, files);
  if (!vm.ok) throw failCode(vm.code, { details: vm.details, name: vm.name, message: manifestRejectMessage(manifestRaw, vm) });
  const { manifest, warnings, referenced } = vm;

  // ── 资源层:仅被引用文件落盘;图片字节/像素闸;SVG 清洗;T2 静态校验 ──
  const keep = new Map(); // 目标名 → { from, content? }
  for (const name of referenced) {
    const src = join(tmp, root.prefix, name);
    if (!isPathInside(src, tmp)) throw failCode('path_traversal');
    const ext = extname(name).slice(1).toLowerCase();
    const st = await stat(src).catch(() => null);
    if (!st) throw failCode('asset_missing', { name });
    if (ext === 'svg') {
      const r = sanitizeSvg(await readFile(src, 'utf8'));
      if (!r.ok) throw failCode('svg_rejected', { name, reason: r.reason });
      keep.set(name, { content: r.svg });
    } else if (ext === 'css') {
      if (st.size > 512 * 1024) throw failCode('asset_too_large', { name });
      keep.set(name, { from: src });
    } else if (ext === 'js') {
      const text = await readFile(src, 'utf8');
      const r = validateT2Script(text);
      if (!r.ok) throw failCode('script_rejected', { name, hits: r.hits });
      keep.set(name, { from: src });
    } else {
      if (st.size > limits.maxAssetBytes) throw failCode('asset_too_large', { name });
      const headBuf = await readFile(src).then((b) => b.subarray(0, 256 * 1024));
      const dims = imageDimensions(headBuf, ext);
      if (!dims) throw failCode('image_invalid', { name });
      if (dims.w > limits.maxImagePx || dims.h > limits.maxImagePx) {
        throw failCode('image_too_large_px', { name, w: dims.w, h: dims.h });
      }
      keep.set(name, { from: src });
    }
  }
  // skin.css/codeface.css 未被引用(T1)时按契约给 css_ignored warning
  if (manifest.tier !== 2) {
    for (const f of ['skin.css', 'codeface.css']) {
      if (files.has(f)) warnings.push({ code: 'css_ignored', key: f, message: `包内 ${f} 已忽略:T1 皮肤不支持自定义 CSS` });
    }
  }

  // ── 原子搬入 ~/.claude-gui/skins/<id>/ ──
  // r26-D6:同 slug 已存在 → 复用其 id 覆盖(rm 旧目录后 rename stage 进去)
  const existingId = await findExistingSkinId(slugOf(manifest.name), skinsDir);
  const id = existingId || skinIdFrom(manifest.name);
  const stage = join(tmpdir(), `cgui-skin-stage-${randomUUID()}`);
  try {
    await mkdir(stage, { recursive: true });
    for (const [name, srcInfo] of keep) {
      if (srcInfo.content != null) await writeFile(join(stage, name), srcInfo.content, 'utf8');
      else await writeFile(join(stage, name), await readFile(srcInfo.from));
    }
    await writeFile(join(stage, 'skin.json'), JSON.stringify(manifest, null, 2));
    await writeFile(join(stage, 'meta.json'), JSON.stringify({ source, importedAt: Date.now() }));
    await mkdir(skinsDir, { recursive: true });
    const dest = join(skinsDir, id);
    if (!isPathInside(dest, skinsDir)) throw failCode('internal');
    if (existingId) await rm(dest, { recursive: true, force: true });
    await moveStageDir(stage, dest);
  } catch (e) {
    await cleanupStage(stage);
    throw e;
  }
  return { id, name: manifest.name, warnings, manifest };
}

// r43 文件夹导入闸(服务端硬校验,不信客户端)。
// r49a-⑤:maxFiles 与 ZIP_LIMITS.maxEntries 对齐取 40 —— 两条通道最终跑同一段
// installUnpacked,上限不同等于同一个包换个导入方式一个过一个拒。
export const DIR_LIMITS = {
  maxFiles: 40,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 30 * 1024 * 1024,
  maxDepth: 3,       // 段数上限(如 a/b/c.png)
  maxPathLen: 128,
};
/**
 * 包内相对路径合法性(纯函数,单测跑矩阵)。拒绝:非字符串/空、超长、反斜杠、控制字符、
 * 绝对路径、盘符、`..` 与 `.` 段、空段(含 `//` 与末尾 `/`)、段数超 maxDepth。
 */
export function isSafeSkinRelPath(p, limits = DIR_LIMITS) {
  if (typeof p !== 'string' || !p) return false;
  if (p.length > limits.maxPathLen) return false;
  if (p.includes('\\')) return false;                     // 反斜杠(Win 分隔符/UNC 形态)
  // 控制字符(含 NUL):按码点判,不在正则里写不可见转义
  if ([...p].some((c) => c.codePointAt(0) < 32 || c.codePointAt(0) === 127)) return false;
  if (p.startsWith('/')) return false;                    // 绝对路径
  if (/^[A-Za-z]:/.test(p)) return false;                 // 盘符
  const segs = p.split('/');
  if (segs.length > limits.maxDepth) return false;        // 深度
  return segs.every((s) => s && s !== '.' && s !== '..');
}

/**
 * r43 文件夹导入管线:客户端逐文件 base64 → 服务端硬校验(路径/数量/单文件/总量/skin.json
 * 在位)→ 写入临时目录 → 走与 zip 完全相同的 installUnpacked。成功/失败形状与
 * installSkinPackage 一致(skinCode 错);skinsDir/limits 仅供单测注入。
 */
export async function installSkinDirectory(files, { source = 'user', skinsDir = SKINS_DIR, limits = ZIP_LIMITS, dirLimits = DIR_LIMITS } = {}) {
  if (!Array.isArray(files) || !files.length) throw failCode('dir_invalid');
  // 判官r49a:计数取剥杂质后口径,与 zip 通道(validateZipEntries)一致——
  // 同一个包"40 真实 + 2 杂质"不许 dir 拒而 zip 放。
  if (stripJunkEntries(files.map((f) => f && f.path)).length > dirLimits.maxFiles) throw failCode('dir_entries_exceeded');
  const decoded = [];
  let total = 0;
  for (const f of files) {
    const p = f && f.path;
    if (!isSafeSkinRelPath(p, dirLimits)) throw failCode('path_traversal');
    const buf = Buffer.from(typeof f.dataB64 === 'string' ? f.dataB64 : '', 'base64');
    if (buf.length > dirLimits.maxFileBytes) throw failCode('asset_too_large', { name: p });
    total += buf.length;
    if (total > dirLimits.maxTotalBytes) throw failCode('zip_too_large');
    decoded.push({ path: p, buf });
  }
  const paths = decoded.map((d) => d.path);
  if (!resolveRootPrefix(paths)) throw failCode('manifest_missing');
  const tmp = join(tmpdir(), `cgui-skin-dir-${randomUUID()}`);
  try {
    for (const { path: p, buf } of decoded) {
      const dest = join(tmp, p);
      if (!isPathInside(dest, tmp)) throw failCode('path_traversal'); // 校验已挡,兜底纵深
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
    }
    return await installUnpacked(tmp, paths, { source, skinsDir, limits });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 导入管线单函数(PLAN §5 付费衔接口:本地导入 source:'user',将来下发同函数)。
 * zipPath = 已收好的临时 zip。成功 → { id, name, warnings, manifest };失败抛 skinCode 错。
 * skinsDir/limits 仅供单测注入(默认生产值;测试用 scratch 目录,不碰真实 home)。
 */
export async function installSkinPackage(zipPath, { source = 'user', skinsDir = SKINS_DIR, limits = ZIP_LIMITS } = {}) {
  // 魔数:PK\x03\x04(空包 PK\x05\x06 对皮肤无意义,一并拒)
  const head = Buffer.alloc(4);
  try {
    const fh = await import('fs/promises').then((m) => m.open(zipPath, 'r'));
    await fh.read(head, 0, 4, 0);
    await fh.close();
  } catch { throw failCode('not_zip'); }
  if (!(head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)) throw failCode('not_zip');

  const tar = tarBinary();
  // ── 清单层(解压前快速失败):条目类型/穿越/条目数/声明体积 ──
  let listing;
  try {
    ({ stdout: listing } = await execFileP(tar, ['-tvf', zipPath], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }));
  } catch { throw failCode('not_zip'); }
  const entries = parseTarListing(listing);
  const gate = validateZipEntries(entries, limits);
  if (!gate.ok) throw failCode(gate.code);

  // ── 解压到临时目录:固定 -C、禁 -P;过程中轮询实测字节数 >100MB 杀进程清目录(真闸)──
  const tmp = join(tmpdir(), `cgui-skin-${randomUUID()}`);
  await mkdir(tmp, { recursive: true });
  try {
    await new Promise((resolve, reject) => {
      const child = execFile(tar, ['-xf', zipPath, '-C', tmp], { timeout: 30000 }, (err) => {
        clearInterval(meter);
        if (err) reject(bombed ? failCode('zip_bomb_suspected') : failCode('not_zip'));
        else resolve();
      });
      let bombed = false;
      const meter = setInterval(async () => {
        if (bombed) return;
        if (await dirBytes(tmp) > limits.maxUnpackedBytes) {
          bombed = true;
          try { child.kill('SIGKILL'); } catch {}
        }
      }, 120);
    });
    // 解压完成后终检(短包在首个轮询前就结束,必须补一次)
    if (await dirBytes(tmp) > limits.maxUnpackedBytes) throw failCode('zip_bomb_suspected');

    // ── 解包完成后的共享管线(r43 抽出;文件夹导入通道走同一函数)──
    const fileEntries = entries.filter((e) => e.type === '-').map((e) => e.path);
    return await installUnpacked(tmp, fileEntries, { source, skinsDir, limits });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// POST /api/skins/import-inline — 裸内容导入(免 zip):
//   kind:'trio'     = T2 三件套 {name, css?, js?, a11y?}(「保存为皮肤」通道;试穿在客户端不落盘)
//   kind:'dsw'      = dsh theme-gallery JSON {name, dswJson}(--dsw-* → cgui token 尽力映射)
//   kind:'skinjson' = cgui-skin/1 skin.json 文本 {name, skinJson}(r26-D10,契约 C-D10;
//                     仅纯 vars/home.greeting 形态可通过,引用资产必 asset_missing)
// 校验全复用:T2 走 validateT2Script,dsw 走 convertDswVars(值全套文法闸),skinjson 走
// validateManifest(空 files 集);落盘与 zip 导入同构(skin.json + meta.json + 文件,
// id/响应形状一致;同 slug 覆盖式去重 r26-D6)。
router.post('/skins/import-inline', async (req, res) => {
  try {
    const { kind, name, css, js, a11y, dswJson, skinJson } = req.body || {};
    const skinName = typeof name === 'string' ? name.trim().slice(0, 40) : '';
    if (!skinName) return res.status(422).json({ error: 'manifest_invalid', message: '皮肤名称必填(1-40 字符)' });
    const warnings = [];
    const files = {};
    let manifest;
    if (kind === 'trio') {
      const parts = { 'skin.css': css, 'client.js': js, 'a11y.css': a11y };
      let any = false;
      for (const [fname, text] of Object.entries(parts)) {
        if (typeof text !== 'string' || !text.trim()) continue;
        if (Buffer.byteLength(text, 'utf8') > 512 * 1024) {
          return res.status(413).json({ error: 'asset_too_large', message: `${fname} 超过 512KB 上限` });
        }
        if (fname === 'client.js') {
          const v = validateT2Script(text);
          if (!v.ok) return res.status(422).json({ error: 'script_rejected', message: ERROR_MESSAGES.script_rejected, hits: v.hits });
        }
        files[fname] = text;
        any = true;
      }
      if (!any) return res.status(422).json({ error: 'empty_skin', message: ERROR_MESSAGES.empty_skin });
      manifest = { format: 'cgui-skin/1', name: skinName, tier: 2 };
      for (const f of Object.keys(files)) manifest[f.replace('.', '_')] = f;
    } else if (kind === 'dsw') {
      let parsed = dswJson;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); }
        catch { return res.status(422).json({ error: 'manifest_invalid', message: 'dsh JSON 无法解析' }); }
      }
      const { vars, warnings: w } = convertDswVars(parsed);
      warnings.push(...w);
      if (!Object.keys(vars).length) return res.status(422).json({ error: 'empty_skin', message: '没有可映射的变量(不可映射项见 warnings)', warnings });
      manifest = { format: 'cgui-skin/1', name: skinName, tier: 1, shared: { vars } };
    } else if (kind === 'skinjson') {
      // r26-D10(契约 C-D10):粘贴 cgui-skin/1 skin.json 纯文本导入。skinJson 为文本
      // 或已 parse 对象;以空 files 集走 validateManifest 全量校验——纯 vars/home.greeting
      // 形态可通过,background/icons 引用资产必 asset_missing(无资产通道),
      // preview/home.icon 引用按可选叶子 warning 丢弃(validateManifest 既有口径)。
      let parsed = skinJson;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); }
        catch { return res.status(422).json({ error: 'manifest_invalid', message: 'skin.json 无法解析' }); }
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // body 的 name 为权威(与 trio/dsw 同口径),覆盖进 parsed 再走全量校验
        parsed = { ...parsed, name: skinName };
      }
      const vm = validateManifest(parsed, new Set());
      if (!vm.ok) {
        return res.status(HTTP_OF[vm.code] || 422).json({
          error: vm.code,
          message: manifestRejectMessage(parsed, vm),   // r45:粘贴通道同口径给可行动原因
          ...(vm.details ? { details: vm.details } : {}),
        });
      }
      // skinjson 通道只收 T1(契约:仅纯 vars/home.greeting 形态可通过)——
      // tier:2 无包内文件等于空壳 T2,明确拒
      if (vm.manifest.tier === 2) {
        return res.status(422).json({ error: 'manifest_invalid', message: 'skinjson 通道仅支持 T1 皮肤(纯 vars/home.greeting 形态)', details: ['tier 2 请走三件套(trio)通道'] });
      }
      warnings.push(...vm.warnings);
      manifest = vm.manifest;
    } else {
      return res.status(400).json({ error: 'manifest_invalid', message: 'kind 必须是 trio、dsw 或 skinjson' });
    }
    // r26-D6:与 zip 通道同口径——同 slug 复用既有 id 覆盖
    const existingId = await findExistingSkinId(slugOf(skinName), SKINS_DIR);
    const id = existingId || skinIdFrom(skinName);
    const stage = join(tmpdir(), `cgui-skin-stage-${randomUUID()}`);
    try {
      await mkdir(stage, { recursive: true });
      for (const [fname, text] of Object.entries(files)) await writeFile(join(stage, fname), text, 'utf8');
      await writeFile(join(stage, 'skin.json'), JSON.stringify(manifest, null, 2));
      await writeFile(join(stage, 'meta.json'), JSON.stringify({ source: 'user', importedAt: Date.now() }));
      await mkdir(SKINS_DIR, { recursive: true });
      const dest = join(SKINS_DIR, id);
      if (!isPathInside(dest, SKINS_DIR)) throw new Error('internal');
      if (existingId) await rm(dest, { recursive: true, force: true });
      // r26-D4:与 zip 通道同走 moveStageDir(EXDEV 跨卷逐文件拷贝兜底)
      await moveStageDir(stage, dest);
    } catch (e) {
      // r26-D4:stage 创建后任何失败清 stage(修前 rename 失败即泄漏 tmpdir)
      await cleanupStage(stage);
      throw e;
    }
    res.status(201).json({ id, name: skinName, warnings, manifest });
  } catch (err) {
    console.error('[skins] import-inline failed:', err);
    res.status(500).json({ error: 'internal', message: ERROR_MESSAGES.internal });
  }
});

// POST /api/skins/import — zip 原始字节流(同 backgrounds.js 上传模式),
// x-upload-name 仅用于扩展名判定与报错展示。
router.post('/skins/import', async (req, res) => {
  const tmpZip = join(tmpdir(), `cgui-skin-up-${randomUUID()}.zip`);
  try {
    const name = decodeURIComponent(String(req.headers['x-upload-name'] || ''));
    const ext = extname(name).slice(1).toLowerCase();
    if (!name || !ext || !['zip', 'cguiskin'].includes(ext)) {
      return res.status(400).json({ error: 'not_zip', message: ERROR_MESSAGES.not_zip });
    }
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > ZIP_LIMITS.maxZipBytes) {
      return res.status(413).json({ error: 'zip_too_large', message: ERROR_MESSAGES.zip_too_large });
    }
    let bytes = 0, aborted = false;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > ZIP_LIMITS.maxZipBytes && !aborted) { aborted = true; req.destroy(new Error('zip_too_large')); }
    });
    try {
      await pipeline(req, createWriteStream(tmpZip));
    } catch (err) {
      if (aborted) return res.status(413).json({ error: 'zip_too_large', message: ERROR_MESSAGES.zip_too_large });
      throw err;
    }
    const out = await installSkinPackage(tmpZip, { source: 'user' });
    res.status(201).json(out);
  } catch (err) {
    const code = err.skinCode || 'internal';
    if (code === 'internal') console.error('[skins] import failed:', err);
    res.status(HTTP_OF[code] || 500).json({
      error: code,
      message: err.message || ERROR_MESSAGES[code],
      ...(err.details ? { details: err.details } : {}),
      ...(err.name && typeof err.name === 'string' && code !== 'internal' ? {} : {}),
    });
  } finally {
    await unlink(tmpZip).catch(() => {});
  }
});

// POST /api/skins/import-dir — 文件夹导入(r43):客户端把选中目录逐文件 base64 塞进
// JSON({ name, files:[{path,dataB64}] };name 仅备查,皮肤名以 skin.json 为准,与 zip 同)。
// 解析器单独挂大限:30MB 二进制 base64 后约 40MB,全局 25mb 解析器会先拦(index.js 对
// 本路径让路,全局限额本身不动)。校验/落盘全在 installSkinDirectory,与 zip 共用管线。
router.post('/skins/import-dir', express.json({ limit: '45mb' }), async (req, res) => {
  try {
    const out = await installSkinDirectory(req.body?.files, { source: 'user' });
    res.status(201).json(out);
  } catch (err) {
    const code = err.skinCode || 'internal';
    if (code === 'internal') console.error('[skins] import-dir failed:', err);
    res.status(HTTP_OF[code] || 500).json({
      error: code,
      message: err.message || ERROR_MESSAGES[code],
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

// GET /api/skins — 列表(损坏目录跳过不 500;含完整 manifest,前端应用零二次请求)。
router.get('/skins', async (_req, res) => {
  const skins = [];
  let ids = [];
  try { ids = await readdir(SKINS_DIR); } catch { return res.json({ skins: [] }); }
  for (const id of ids) {
    if (!SKIN_ID_RE.test(id)) continue;
    try {
      const manifest = JSON.parse(await readFile(join(SKINS_DIR, id, 'skin.json'), 'utf8'));
      let meta = {};
      try { meta = JSON.parse(await readFile(join(SKINS_DIR, id, 'meta.json'), 'utf8')); } catch {}
      skins.push({
        id,
        name: manifest.name,
        author: manifest.author,
        version: manifest.version,
        tier: manifest.tier === 2 ? 2 : 1,
        source: meta.source || 'user',
        importedAt: meta.importedAt || 0,
        preview: manifest.preview ? `/api/skins/${id}/asset/${manifest.preview}` : null,
        manifest,
      });
    } catch { /* 损坏皮肤目录:跳过继续(列表韧性,契约 §2.2) */ }
  }
  res.json({ skins });
});

// GET /api/skins/:id/asset/:name — 回源。id+文件名双白名单 + isPathInside 兜底;
// 响应四件套:显式 Content-Type / nosniff / dotfiles:'allow' / immutable(契约 §2.3)。
router.get('/skins/:id/asset/:name', async (req, res) => {
  const { id, name } = req.params;
  if (!SKIN_ID_RE.test(id) || !SKIN_ASSET_RE.test(name) || name.startsWith('.')) {
    return res.status(404).json({ error: 'not_found', message: ERROR_MESSAGES.not_found });
  }
  const ext = extname(name).slice(1).toLowerCase();
  if (!CONTENT_TYPES[ext] || ext === 'json') return res.status(404).json({ error: 'not_found', message: ERROR_MESSAGES.not_found });
  const full = join(SKINS_DIR, id, name);
  if (!isPathInside(full, SKINS_DIR)) return res.status(404).json({ error: 'not_found', message: ERROR_MESSAGES.not_found });
  try { await stat(full); } catch { return res.status(404).json({ error: 'not_found', message: ERROR_MESSAGES.not_found }); }
  res.setHeader('Content-Type', CONTENT_TYPES[ext]);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(full, { dotfiles: 'allow' });
});

// DELETE /api/skins/:id — 整目录删除;客户端下次加载发现 id 失效自动回默认。
router.delete('/skins/:id', async (req, res) => {
  const { id } = req.params;
  if (!SKIN_ID_RE.test(id)) return res.status(404).json({ error: 'not_found', message: ERROR_MESSAGES.not_found });
  const dir = join(SKINS_DIR, id);
  if (!isPathInside(dir, SKINS_DIR)) return res.status(404).json({ error: 'not_found', message: ERROR_MESSAGES.not_found });
  try { await stat(dir); } catch { return res.status(404).json({ error: 'not_found', message: ERROR_MESSAGES.not_found }); }
  try {
    await rm(dir, { recursive: true, force: true });
    // r26-D7:删除成功广播(契约 C-D7 逐字 {type:'skins-changed', deletedId})——
    // 多端场景另一端正在用该皮肤时静默回默认,不再等下次 reconcile 自愈。
    // broadcast 自身逐客户端 catch,不抛;删成功即 200,广播失败不翻转结果。
    broadcast({ type: 'skins-changed', deletedId: id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

export default router;
