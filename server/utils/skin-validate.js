// r11-③:皮肤包校验器(纯函数,零 I/O,零新依赖)。唯一契约源 = .devflow/INTERFACE-skin.md
// (cgui-skin/1)+ FIX-SPEC-r11-b3 §③ 增量(shape token/home/icons/tier:2)。
// 安全三器都在本文件:①解包闸(parseTarListing/validateZipEntries——bsdtar -tvf 清单级
// 拒符号链/硬链/穿越/条目数/声明体积;实测字节闸在路由层计量);②SVG 清洗器
// (sanitizeSvg——白名单标签+黑名单属性,拒 script/foreignObject/外链 href);
// ③T2 JS 静态校验器(validateT2Script——黑名单字样即拒载)。

// ── token 白名单 ─────────────────────────────────────────────────
// 原 31 token(INTERFACE §1.3)+ r11-⑧ 形状 token 11 个 = 42;
// v1 实际接受 41:--glass-shadow 仍延 v2(盲审处置 #11,不复活)。
// --glass-underlay 为内部合成机制 token,刻意不入白名单(皮肤不可写)。
export const SKIN_TOKENS = [
  // 画布(4)
  '--color-canvas', '--color-canvas-warm', '--color-canvas-deep', '--color-canvas-sunken',
  // 墨色(5)
  '--color-ink', '--color-ink-soft', '--color-ink-muted', '--color-ink-faint', '--color-ink-ghost',
  // 强调(4)
  '--color-accent', '--color-accent-hover', '--color-accent-subtle', '--color-accent-muted',
  // 语义(4)
  '--color-success', '--color-error', '--color-error-subtle', '--color-warning',
  // 玻璃(8)
  '--glass-base-bg', '--glass-thick-bg', '--glass-thin-bg', '--glass-bar-bg',
  '--glass-specular', '--glass-shade', '--glass-edge', '--glass-edge-outer',
  // 阴影(1,v1 不接受)
  '--glass-shadow',
  // 圆角(5)
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-2xl',
  // ── r11-⑧ 形状 token(11) ──
  '--radius-panel', '--radius-control',
  '--shadow-panel', '--shadow-bevel', '--shadow-bar', '--shadow-capsule',
  '--shadow-popover', '--shadow-accent', '--shadow-accent-hover',
  '--backdrop-glass', '--backdrop-soft',
];
export const SKIN_TOKENS_REJECTED_V1 = ['--glass-shadow'];

// 值文法(锚定 ^$,无 m flag;进正则前黑名单预筛)。
const ALPHA = '(?:0|1(?:\\.0{1,4})?|0?\\.\\d{1,4})';
const HEX = '#[0-9a-fA-F]{3}(?:[0-9a-fA-F])?(?:[0-9a-fA-F]{2})?(?:[0-9a-fA-F]{2})?';
const RGB = `rgba?\\(\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*(?:,\\s*${ALPHA}\\s*)?\\)`;
const HSL = `hsla?\\(\\s*\\d{1,3}\\s*,\\s*\\d{1,3}%\\s*,\\s*\\d{1,3}%\\s*(?:,\\s*${ALPHA}\\s*)?\\)`;
const COLOR_RE = new RegExp(`^(?:${HEX}|${RGB}|${HSL})$`);
const LENGTH_RE = /^\d{1,2}(\.\d)?px$/;
// SHADOW(r11-⑧ 形状阴影 token 专用;--glass-shadow 本身仍 v2):逗号分隔的
// 常规 shadow 列表,长度/颜色成分复用上面文法;单值 ≤240 字符。
const SLEN = '-?\\d{1,3}(?:\\.\\d{1,2})?(?:px)?';
const SCOLOR = `(?:${HEX}|${RGB}|${HSL})`;
const ONE_SHADOW = `(?:inset\\s+)?${SLEN}\\s+${SLEN}(?:\\s+${SLEN}){0,2}\\s+${SCOLOR}`;
const SHADOW_RE = new RegExp(`^${ONE_SHADOW}(?:\\s*,\\s*${ONE_SHADOW})*$`);
// BACKDROP:none 或 blur(N px),N ≤ 99。
const BACKDROP_RE = /^(?:none|blur\(\d{1,2}(\.\d)?px\))$/;

// 黑名单预筛(toLowerCase 后):任一子串命中直接拒(大小写变体同闸)。
const VALUE_BLACKLIST = ['url(', 'var(', ';', '}', '\\', '/*', '@'];

function grammarFor(token) {
  if (token.startsWith('--color-') || token.startsWith('--glass-')) return COLOR_RE; // glass-shadow 在白名单层已拒
  if (token.startsWith('--radius-')) return LENGTH_RE;
  if (token.startsWith('--shadow-')) return SHADOW_RE;
  if (token.startsWith('--backdrop-')) return BACKDROP_RE;
  return null;
}

/** 单变量校验:{ ok } | { ok:false, reason }。reason ∈ not_in_whitelist/rejected_v1/blacklist/grammar/too_long。 */
export function validateSkinVar(token, value) {
  if (!SKIN_TOKENS.includes(token)) return { ok: false, reason: 'not_in_whitelist' };
  if (SKIN_TOKENS_REJECTED_V1.includes(token)) return { ok: false, reason: 'rejected_v1' };
  if (typeof value !== 'string') return { ok: false, reason: 'grammar' };
  const v = value.trim();
  const maxLen = grammarFor(token) === SHADOW_RE ? 240 : 64;
  if (!v || v.length > maxLen) return { ok: false, reason: 'too_long' };
  const low = v.toLowerCase();
  for (const bad of VALUE_BLACKLIST) {
    if (low.includes(bad)) return { ok: false, reason: 'blacklist' };
  }
  const re = grammarFor(token);
  if (!re || !re.test(v)) return { ok: false, reason: 'grammar' };
  // LENGTH 数值 ≤64 附加约束
  if (re === LENGTH_RE && parseFloat(v) > 64) return { ok: false, reason: 'grammar' };
  return { ok: true };
}

// ── ①解包闸:bsdtar -tvf 清单解析与整包校验 ─────────────────────
export const ZIP_LIMITS = {
  maxZipBytes: 30 * 1024 * 1024,
  maxEntries: 40,
  maxUnpackedBytes: 100 * 1024 * 1024,
  maxAssetBytes: 20 * 1024 * 1024,
  maxImagePx: 8192,
  maxSvgBytes: 32 * 1024,
};

/**
 * 解析 `bsdtar -tvf x.zip` 输出 → [{ mode, type, size, path }]。
 * type:'-' 文件 / 'd' 目录 / 'l' 符号链接 / 'h' 硬链接 / '?' 其它。
 * 符号链接按【条目类型】判(mode 首字符 l / " -> " 指示),不是条目名(盲审 #7)。
 */
export function parseTarListing(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    // bsdtar -tvf 形如:`-rw-r--r--  0 user group  1234 Jul 20 12:00 dir/file.png`
    const m = line.match(/^([-dlhbcps][rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
    if (!m) { out.push({ mode: '?', type: '?', size: 0, path: line }); continue; }
    let [, mode, size, path] = m;
    let type = mode[0] === '-' ? '-' : mode[0];
    // 硬链接:bsdtar 显示 `file link to other`;符号链接:`name -> target`
    if (/ -> /.test(path)) { type = 'l'; path = path.split(' -> ')[0]; }
    else if (/ link to /.test(path)) { type = 'h'; path = path.split(' link to ')[0]; }
    out.push({ mode, type, size: Number(size) || 0, path });
  }
  return out;
}

/** 条目路径是否含穿越/绝对路径/盘符(../ 与 ..\\ 双写,Windows 双端 dogfood)。 */
export function isTraversalPath(p) {
  if (typeof p !== 'string' || !p) return true;
  if (p.startsWith('/') || p.startsWith('\\')) return true;
  if (/^[A-Za-z]:/.test(p)) return true;
  const segs = p.split(/[/\\]/);
  return segs.some((s) => s === '..');
}

/**
 * r26-D3:Finder 压缩杂质判定 —— __MACOSX/ 目录段与 ._ 开头的 AppleDouble 文件。
 * 此类条目是 macOS 压缩的固定副产物,永不落盘(referenced 白名单兜底),因此
 * 在条目数上限与安全闸之前剥离:junk 里的穿越形态也不再触发 path_traversal。
 */
export function isJunkEntry(p) {
  const segs = String(p || '').split(/[/\\]/);
  return segs.includes('__MACOSX') || segs.some((s) => s.startsWith('._'));
}
/** 路径数组剥杂质 → 新数组。 */
export function stripJunkEntries(files) {
  return (Array.isArray(files) ? files : []).filter((p) => !isJunkEntry(p));
}

/**
 * 整包清单校验(解压前快速失败层):
 * → { ok:true, entries } | { ok:false, code }(code ∈ INTERFACE §2.5)。
 * r26-D3:__MACOSX/._ 杂质先剥离,不计入 40 条上限、不过安全闸(永不落盘);
 * 目录条目计入 40;声明体积仅快速失败(实测字节闸在解压过程另计,盲审 #1)。
 * maxDeclaredBytes 仅供单测把声明闸与实测闸隔离(生产两者同值 100MB);
 * 实测取证:本机 bsdtar 对假 usize 会按声明值截断输出并报错(假头矢量被解包器
 * 中和),实测闸是针对"其它 tar 行为/版本"的防御纵深,仍保留。
 */
export function validateZipEntries(entries, limits = ZIP_LIMITS) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => !isJunkEntry(e && e.path));
  if (list.length > limits.maxEntries) return { ok: false, code: 'zip_entries_exceeded' };
  let declared = 0;
  for (const e of list) {
    if (e.type === 'l' || e.type === 'h') return { ok: false, code: 'path_traversal' };
    if (e.type !== '-' && e.type !== 'd') return { ok: false, code: 'path_traversal' };
    if (isTraversalPath(e.path)) return { ok: false, code: 'path_traversal' };
    declared += e.size;
  }
  if (declared > (limits.maxDeclaredBytes ?? limits.maxUnpackedBytes)) return { ok: false, code: 'zip_bomb_suspected' };
  return { ok: true, entries: list };
}

/**
 * 定位 manifest 与根前缀:根目录直放或整体嵌套一层(超一层 = manifest_missing)。
 * files = 文件型条目路径数组 → { prefix, byName: Map<包内相对名, 原路径> }。
 * r26-D3:先剥 __MACOSX/._ 杂质(Finder 压缩必带),否则 tops.size 被顶成 2 必败。
 */
export function resolveRootPrefix(files) {
  const names = stripJunkEntries(files).filter((p) => p && !p.endsWith('/'));
  const direct = names.find((p) => !p.includes('/') && p === 'skin.json');
  if (direct) return { prefix: '' };
  const tops = new Set(names.map((p) => p.split('/')[0]));
  if (tops.size === 1 && names.every((p) => p.includes('/'))) {
    const prefix = [...tops][0] + '/';
    if (names.some((p) => p === prefix + 'skin.json' && p.split('/').length === 2)) return { prefix };
  }
  return null;
}

// ── manifest 校验 ────────────────────────────────────────────────
const ASSET_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const THEME_FAMILY_IDS = new Set([
  'default', 'glass', 'claude', 'opencode', 'tokyonight', 'nord', 'rosepine', 'catppuccin',
  'dracula', 'gruvbox', 'kanagawa', 'everforest', 'solarized', 'github', 'flexoki', 'wechat',
]);
const FIT_ENUM = new Set(['cover', 'contain', 'tile']);
const POS_ENUM = new Set(['center', 'top', 'bottom', 'left', 'right']);
// 图标语义名白名单(首批 30 高频;与 client/src/components/Icon.jsx 的注册表一致,
// 单测跨文件钉一致性)。
export const ICON_SEMANTIC_NAMES = [
  'send', 'stop', 'new-session', 'settings', 'folder', 'folder-open', 'search', 'pin',
  'close', 'copy', 'refresh', 'edit', 'delete', 'archive', 'branch', 'terminal',
  'file', 'image', 'globe', 'check', 'chevron-down', 'chevron-right', 'chevron-left',
  'plus', 'menu', 'sparkles', 'clock', 'user', 'bot', 'warning', 'sliders',
];

function assetExt(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}
const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * skin.json 全量校验(纯函数)。files = 包内文件名集合(已剥根前缀)。
 * → { ok:true, manifest, warnings, referenced } | { ok:false, code, message?, details? }
 * 两级口径:结构性类型错整包拒(manifest_invalid);可选叶子非法丢弃回默认 + warning。
 */
export function validateManifest(json, files) {
  const warnings = [];
  const referenced = new Set();
  const fileSet = files instanceof Set ? files : new Set(files || []);
  if (!isPlainObject(json)) return { ok: false, code: 'manifest_invalid', details: ['skin.json 不是对象'] };
  if (json.format !== 'cgui-skin/1') {
    if (typeof json.format === 'string' && json.format) return { ok: false, code: 'unsupported_format', format: json.format };
    return { ok: false, code: 'manifest_invalid', details: ['format 缺失'] };
  }
  const name = typeof json.name === 'string' ? json.name.trim() : '';
  if (!name || name.length > 40) return { ok: false, code: 'manifest_invalid', details: ['name 缺失或超长(1-40)'] };
  const out = { format: 'cgui-skin/1', name };
  for (const k of ['author', 'version', 'homepage', 'license']) {
    if (json[k] == null) continue;
    if (typeof json[k] === 'string' && json[k].length <= 120) out[k] = json[k];
    else warnings.push({ code: 'field_invalid', key: k, message: `${k} 非法,已忽略` });
  }
  // tier:2 = 开发者代码皮肤;其余一律 1
  out.tier = json.tier === 2 ? 2 : 1;
  if (json.base != null) {
    if (typeof json.base === 'string' && THEME_FAMILY_IDS.has(json.base)) out.base = json.base;
    else warnings.push({ code: 'unknown_base', key: String(json.base), message: `基底主题 ${json.base} 不存在,已忽略` });
  }
  if (json.preview != null) {
    if (typeof json.preview === 'string' && ASSET_NAME_RE.test(json.preview) && !json.preview.startsWith('.')
        && IMAGE_EXTS.has(assetExt(json.preview)) && fileSet.has(json.preview)) {
      out.preview = json.preview;
      referenced.add(json.preview);
    } else {
      warnings.push({ code: 'asset_ignored', key: String(json.preview), message: '预览图缺失或非法,已忽略' });
    }
  }
  const readVars = (obj, where) => {
    if (obj == null) return undefined;
    if (!isPlainObject(obj)) throw { code: 'manifest_invalid', details: [`${where}.vars 不是对象`] };
    const vars = {};
    for (const [k, v] of Object.entries(obj)) {
      const r = validateSkinVar(k, v);
      if (r.ok) vars[k] = String(v).trim();
      else warnings.push({ code: 'var_rejected', key: k, message: `变量 ${k} 被忽略(${r.reason})` });
    }
    return Object.keys(vars).length ? vars : undefined;
  };
  const readBackground = (obj, where) => {
    if (obj == null) return undefined;
    if (!isPlainObject(obj)) throw { code: 'manifest_invalid', details: [`${where}.background 不是对象`] };
    const img = obj.image;
    if (typeof img !== 'string' || !ASSET_NAME_RE.test(img) || img.startsWith('.')) {
      throw { code: 'manifest_invalid', details: [`${where}.background.image 非法`] };
    }
    if (!IMAGE_EXTS.has(assetExt(img))) throw { code: 'asset_type', name: img, ext: assetExt(img) };
    if (!fileSet.has(img)) throw { code: 'asset_missing', name: img };
    referenced.add(img);
    const bg = { image: img };
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    if (obj.overlayOpacity != null) {
      const v = num(obj.overlayOpacity);
      if (v != null && v >= 0 && v <= 0.95) bg.overlayOpacity = v;
      else warnings.push({ code: 'field_invalid', key: `${where}.background.overlayOpacity`, message: 'overlayOpacity 越界,回默认 0.45' });
    }
    if (obj.fit != null) {
      if (FIT_ENUM.has(obj.fit)) bg.fit = obj.fit;
      else warnings.push({ code: 'field_invalid', key: `${where}.background.fit`, message: 'fit 非法,回默认 cover' });
    }
    if (obj.position != null) {
      if (POS_ENUM.has(obj.position)) bg.position = obj.position;
      else warnings.push({ code: 'field_invalid', key: `${where}.background.position`, message: 'position 非法,回默认 center' });
    }
    if (obj.blur != null) {
      const v = num(obj.blur);
      if (v != null && v >= 0 && v <= 40) bg.blur = v;
      else warnings.push({ code: 'field_invalid', key: `${where}.background.blur`, message: 'blur 越界,回默认 0' });
    }
    return bg;
  };
  try {
    if (json.shared != null) {
      if (!isPlainObject(json.shared)) throw { code: 'manifest_invalid', details: ['shared 不是对象'] };
      const vars = readVars(json.shared.vars, 'shared');
      if (vars) out.shared = { vars };
    }
    for (const mode of ['light', 'dark']) {
      if (json[mode] == null) continue;
      if (!isPlainObject(json[mode])) throw { code: 'manifest_invalid', details: [`${mode} 不是对象`] };
      const block = {};
      const vars = readVars(json[mode].vars, mode);
      if (vars) block.vars = vars;
      const bg = readBackground(json[mode].background, mode);
      if (bg) block.background = bg;
      if (Object.keys(block).length) out[mode] = block;
    }
  } catch (e) {
    if (e && e.code) return { ok: false, ...e };
    throw e;
  }
  // r11-③ 增量:home.{icon,greeting}(greeting ≤60,支持 {name} 占位符)
  if (json.home != null) {
    if (!isPlainObject(json.home)) return { ok: false, code: 'manifest_invalid', details: ['home 不是对象'] };
    const home = {};
    if (json.home.icon != null) {
      const ic = json.home.icon;
      if (typeof ic === 'string' && ASSET_NAME_RE.test(ic) && !ic.startsWith('.')
          && (IMAGE_EXTS.has(assetExt(ic)) || assetExt(ic) === 'svg') && fileSet.has(ic)) {
        home.icon = ic;
        referenced.add(ic);
      } else warnings.push({ code: 'asset_ignored', key: String(ic), message: 'home.icon 缺失或非法,已忽略' });
    }
    if (json.home.greeting != null) {
      if (typeof json.home.greeting === 'string' && json.home.greeting.trim() && json.home.greeting.length <= 60) {
        home.greeting = json.home.greeting.trim();
      } else warnings.push({ code: 'field_invalid', key: 'home.greeting', message: 'greeting 非法(≤60 字符),已忽略' });
    }
    if (Object.keys(home).length) out.home = home;
  }
  // r11-③ 增量:icons(语义名白名单 → 包内 svg,≤32KB 清洗后落盘)
  if (json.icons != null) {
    if (!isPlainObject(json.icons)) return { ok: false, code: 'manifest_invalid', details: ['icons 不是对象'] };
    const icons = {};
    for (const [sem, file] of Object.entries(json.icons)) {
      if (!ICON_SEMANTIC_NAMES.includes(sem)) {
        warnings.push({ code: 'unknown_field', key: `icons.${sem}`, message: `图标语义名 ${sem} 不在白名单,已忽略` });
        continue;
      }
      if (typeof file !== 'string' || !ASSET_NAME_RE.test(file) || file.startsWith('.') || assetExt(file) !== 'svg') {
        warnings.push({ code: 'field_invalid', key: `icons.${sem}`, message: `图标 ${sem} 必须是包内 .svg 文件` });
        continue;
      }
      if (!fileSet.has(file)) return { ok: false, code: 'asset_missing', name: file };
      icons[sem] = file;
      referenced.add(file);
    }
    if (Object.keys(icons).length) out.icons = icons;
  }
  // T2 三件套:tier 2 才收;文件存在才记(client.js 必经静态校验,路由层做)
  if (out.tier === 2) {
    for (const f of ['skin.css', 'client.js', 'a11y.css']) {
      if (fileSet.has(f)) { out[f.replace('.', '_')] = f; referenced.add(f); }
    }
  }
  // 未知字段 warning(向前兼容)
  const known = new Set(['format', 'name', 'author', 'version', 'homepage', 'license', 'base',
    'preview', 'shared', 'light', 'dark', 'home', 'icons', 'tier']);
  for (const k of Object.keys(json)) {
    if (!known.has(k)) warnings.push({ code: 'unknown_field', key: k, message: `未知字段 ${k} 已忽略` });
  }
  const hasVars = !!(out.shared?.vars || out.light?.vars || out.dark?.vars);
  const hasBg = !!(out.light?.background || out.dark?.background);
  const hasExtra = !!(out.home || out.icons || out.tier === 2);
  if (!hasVars && !hasBg && !hasExtra) return { ok: false, code: 'empty_skin' };
  return { ok: true, manifest: out, warnings, referenced };
}

// ── 图片文件头尺寸解析(零依赖,不解码位图;盲审 #2) ─────────────
/** buf(Buffer/Uint8Array)→ { w, h } | null(解析失败)。 */
export function imageDimensions(buf, ext) {
  const b = buf instanceof Uint8Array ? buf : null;
  if (!b || b.length < 12) return null;
  const u16be = (i) => (b[i] << 8) | b[i + 1];
  const u32be = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const u16le = (i) => b[i] | (b[i + 1] << 8);
  const u24le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const e = String(ext || '').toLowerCase();
  if (e === 'png') {
    if (u32be(0) !== 0x89504e47 || b.length < 24) return null;
    return { w: u32be(16), h: u32be(20) };
  }
  if (e === 'gif') {
    if (!(b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)) return null;
    return { w: u16le(6), h: u16le(8) };
  }
  if (e === 'webp') {
    if (!(b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
       && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)) return null;
    const four = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (four === 'VP8X' && b.length >= 30) return { w: u24le(24) + 1, h: u24le(27) + 1 };
    if (four === 'VP8 ' && b.length >= 30) return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
    if (four === 'VP8L' && b.length >= 25) {
      const n = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (e === 'jpg' || e === 'jpeg') {
    if (!(b[0] === 0xff && b[1] === 0xd8)) return null;
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
      const len = u16be(i + 2);
      if (len < 2) return null;
      // SOF0-15(除 DHT/JPG/DAC):高宽在 payload 偏移 3/5
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (i + 9 >= b.length) return null;
        return { h: u16be(i + 5), w: u16be(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

// ── ②SVG 清洗器(图标替换用,≤32KB;盲审风险口径:拒绝制,非重写) ──
const SVG_ALLOWED_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse',
  'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'title', 'desc', 'symbol', 'use',
]);
/**
 * → { ok:true, svg }(svg = 剥 BOM/XML 声明/注释后的原文)| { ok:false, reason }。
 * 拒:超 32KB、非 svg 根、白名单外标签(script/foreignObject/image/iframe…天然全拒)、
 * on* 事件属性、javascript: 、非 #fragment 的 href/xlink:href、style 内 url(、
 * DOCTYPE/ENTITY、CDATA。
 */
export function sanitizeSvg(text, maxBytes = ZIP_LIMITS.maxSvgBytes) {
  if (typeof text !== 'string') return { ok: false, reason: 'not_text' };
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return { ok: false, reason: 'too_large' };
  let s = text.replace(/^﻿/, '').replace(/<\?xml[\s\S]*?\?>/gi, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const low = s.toLowerCase();
  if (!low.startsWith('<svg')) return { ok: false, reason: 'not_svg' };
  if (low.includes('<!doctype') || low.includes('<!entity') || low.includes('<![cdata[')) {
    return { ok: false, reason: 'forbidden_construct' };
  }
  // 标签白名单(含关闭标签)
  const tagRe = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/g;
  let m;
  while ((m = tagRe.exec(s))) {
    if (!SVG_ALLOWED_TAGS.has(m[1].toLowerCase())) return { ok: false, reason: `forbidden_tag:${m[1].toLowerCase()}` };
  }
  // 事件属性 / javascript: / 外链 href
  if (/[\s\/]on[a-z]+\s*=/i.test(s)) return { ok: false, reason: 'event_attr' };
  if (low.includes('javascript:')) return { ok: false, reason: 'javascript_url' };
  const hrefRe = /(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi;
  while ((m = hrefRe.exec(s))) {
    if (!m[1].startsWith('#')) return { ok: false, reason: 'external_href' };
  }
  if (/style\s*=\s*["'][^"']*url\s*\(/i.test(s)) return { ok: false, reason: 'style_url' };
  if (/<style/i.test(s)) return { ok: false, reason: 'forbidden_tag:style' }; // 冗余兜底(白名单已拒)
  return { ok: true, svg: s };
}

// ── ③T2 client.js 静态校验器(黑名单形态即拒载;FIX-SPEC §③.3 清单) ──
// r26-D5:纯子串升级为正则集——修前 `fetch (`(空格)/`window["fetch"]`/`Function('…')`
// 全可绕。校验前先 toLowerCase,故正则一律小写形态。
// 口径 = 防误导入、不防恶意代码(skinPrompt.js 同口径文案):正则误伤一律朝拒载方向
// (安全向),已知误伤钉在 check-r26-t2-blacklist.mjs:`prefetch(` 命中 /fetch\s*\(/、
// 匿名函数表达式 `function(){}` 命中 /\bfunction\s*\(/——作者改码(箭头函数)即可过。
// 双端同表:客户端 skins.js T2_BLACKLIST_CLIENT 逐字一致(check-skin-client 钉死)。
export const T2_SCRIPT_BLACKLIST = [
  /fetch\s*\(/,
  /xmlhttprequest/,
  /websocket\s*\(/,
  /import\s*\(/,
  /eval\s*\(/,
  /new\s+function/,
  /\bfunction\s*\(/,
  /navigator\s*\.\s*sendbeacon/,
  /\[\s*['"](?:fetch|eval|function|websocket)['"]\s*\]/,
];
/** → { ok:true } | { ok:false, hits: string[] }(命中正则的 source 串)。toLowerCase 全文扫描,命中即拒。 */
export function validateT2Script(text) {
  if (typeof text !== 'string') return { ok: false, hits: ['not_text'] };
  const low = text.toLowerCase();
  const hits = T2_SCRIPT_BLACKLIST.filter((re) => re.test(low)).map((re) => re.source);
  return hits.length ? { ok: false, hits } : { ok: true };
}

// ── dsh theme-gallery JSON 导入(--dsw-* → cgui token,尽力转换) ──
// 映射为"尽力而为"契约(FIX-SPEC §③.6):仅收录语义可确证的少量常用名,
// 其余全部进 warnings 不可映射清单;映射错误的伤害面 = 变成 warning,零执行面。
export const DSW_TOKEN_MAP = {
  '--dsw-bg': '--color-canvas',
  '--dsw-background': '--color-canvas',
  '--dsw-bg-secondary': '--color-canvas-warm',
  '--dsw-fg': '--color-ink',
  '--dsw-foreground': '--color-ink',
  '--dsw-text': '--color-ink',
  '--dsw-text-secondary': '--color-ink-muted',
  '--dsw-accent': '--color-accent',
  '--dsw-primary': '--color-accent',
  '--dsw-accent-hover': '--color-accent-hover',
  '--dsw-border': '--glass-edge',
  '--dsw-success': '--color-success',
  '--dsw-error': '--color-error',
  '--dsw-warning': '--color-warning',
};
/**
 * dsh JSON({vars:{--dsw-*}} 或平铺对象)→ { vars, warnings }。
 * 值仍走 validateSkinVar 全套闸(黑名单+文法)。
 */
export function convertDswVars(input) {
  const warnings = [];
  const vars = {};
  const src = isPlainObject(input) ? (isPlainObject(input.vars) ? input.vars : input) : {};
  for (const [k, v] of Object.entries(src)) {
    if (!k.startsWith('--dsw-')) { warnings.push({ code: 'unknown_field', key: k, message: `${k} 不是 dsh 变量,忽略` }); continue; }
    const target = DSW_TOKEN_MAP[k];
    if (!target) { warnings.push({ code: 'var_rejected', key: k, message: `${k} 无对应 cgui token,未映射` }); continue; }
    const r = validateSkinVar(target, v);
    if (r.ok) vars[target] = String(v).trim();
    else warnings.push({ code: 'var_rejected', key: k, message: `${k} 值非法(${r.reason}),未映射` });
  }
  return { vars, warnings };
}

// ── id 生成(slug + 6 位随机;CJK 退化回退 skin-;小写归一防 win 大小写不敏感撞名) ──
// r26-D6:slug 段算法抽成 slugOf 导出——skins-packs.js 按 slug 找同皮肤既有目录做
// 覆盖式导入(同名=同一皮肤的语义声明,撞 slug 即互相覆盖,验收钉死该语义)。
export function slugOf(name) {
  return String(name || '').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
export function skinIdFrom(name, rand) {
  const slug = slugOf(name);
  const suffix = String(rand || Math.random().toString(36).slice(2, 8)).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || 'r0';
  return (slug ? `${slug}-${suffix}` : `skin-${suffix}`);
}
export const SKIN_ID_RE = /^[a-z0-9-]{1,48}$/;
export const SKIN_ASSET_RE = ASSET_NAME_RE;
