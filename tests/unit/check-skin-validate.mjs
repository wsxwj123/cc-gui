#!/usr/bin/env node
// 单测:r11-③ 皮肤包校验器(安全三器 + 契约矩阵)。全部 import 真函数。
//  ①解包闸:parseTarListing/validateZipEntries/isTraversalPath/resolveRootPrefix
//  ②SVG 清洗器:sanitizeSvg
//  ③T2 JS 静态校验器:validateT2Script
//  另:值文法(黑名单预筛+锚定正则)/manifest 两级口径/图片头解析/dsw 映射/id 生成。
// 变异哨兵(实际验证过红,见交付报告):
//  S1 validateZipEntries 删符号链类型拒判 → t2 红
//  S2 sanitizeSvg 删标签白名单循环 → t5 红
//  S3 validateT2Script 恒 ok → t6 红
import assert from 'node:assert/strict';
import {
  SKIN_TOKENS, SKIN_TOKENS_REJECTED_V1, validateSkinVar,
  parseTarListing, validateZipEntries, isTraversalPath, resolveRootPrefix, ZIP_LIMITS,
  validateManifest, imageDimensions, sanitizeSvg, validateT2Script, T2_SCRIPT_BLACKLIST,
  convertDswVars, skinIdFrom, SKIN_ID_RE, ICON_SEMANTIC_NAMES,
} from '../../server/utils/skin-validate.js';

// t1 token 白名单与值文法
{
  assert.equal(SKIN_TOKENS.length, 42, 't1: 42 token(31 原始 + 11 形状)');
  assert.deepEqual(SKIN_TOKENS_REJECTED_V1, ['--glass-shadow'], 't1: --glass-shadow 仍 v2(盲审 #11 不复活)');
  assert.ok(!SKIN_TOKENS.includes('--glass-underlay'), 't1: 内部合成 token 不入白名单');
  assert.ok(validateSkinVar('--color-accent', '#5E81AC').ok, 't1: HEX 通过');
  assert.ok(validateSkinVar('--color-accent', 'rgba(255, 0, 0, 0.5)').ok, 't1: rgba 通过');
  assert.ok(validateSkinVar('--color-accent', 'rgba(255,0,0,1.0)').ok, 't1: alpha 1.0 写法通过(盲审 #12)');
  assert.equal(validateSkinVar('--color-accent', 'url(http://x)').reason, 'blacklist', 't1: url( 黑名单拒');
  assert.equal(validateSkinVar('--color-accent', 'URL(http://x)').reason, 'blacklist', 't1: 大小写变体同闸(toLowerCase)');
  assert.equal(validateSkinVar('--color-accent', 'var(--x)').reason, 'blacklist', 't1: var( 拒');
  assert.equal(validateSkinVar('--color-accent', 'red;}body{').reason, 'blacklist', 't1: 分号/花括号拒');
  assert.equal(validateSkinVar('--color-accent', '#GGG').reason, 'grammar', 't1: 非法 hex 拒');
  assert.equal(validateSkinVar('--glass-shadow', '0 0 #0000').reason, 'rejected_v1', 't1: glass-shadow v1 拒收');
  assert.equal(validateSkinVar('--not-a-token', '#fff').reason, 'not_in_whitelist', 't1: 白名单外拒');
  assert.ok(validateSkinVar('--radius-panel', '12px').ok, 't1: LENGTH 通过');
  assert.equal(validateSkinVar('--radius-panel', '80px').reason, 'grammar', 't1: LENGTH >64 拒');
  assert.ok(validateSkinVar('--shadow-panel', '0 0 #0000').ok, 't1: SHADOW 无影哨位通过');
  assert.ok(validateSkinVar('--shadow-panel', 'inset 0 1px 0 rgba(0,0,0,0.1), 0 12px 32px -12px rgba(20,30,60,0.18)').ok, 't1: SHADOW 列表通过');
  assert.equal(validateSkinVar('--shadow-panel', '0 0 url(x)').reason, 'blacklist', 't1: SHADOW 内 url 拒');
  assert.ok(validateSkinVar('--backdrop-glass', 'blur(18px)').ok, 't1: BACKDROP blur 通过');
  assert.ok(validateSkinVar('--backdrop-glass', 'none').ok, 't1: BACKDROP none 通过');
  assert.equal(validateSkinVar('--backdrop-glass', 'blur(120px)').reason, 'grammar', 't1: blur 超两位拒');
  // 正则锚定断言:COLOR 文法不吃前后缀(等价于 ^$ 锚 + 无 m flag)
  assert.equal(validateSkinVar('--color-accent', 'x #fff').reason, 'grammar', 't1: 前缀垃圾拒(锚定)');
  assert.equal(validateSkinVar('--color-accent', '#fff\nurl(').reason, 'blacklist', 't1: 换行携带拒');
}

// t2 ①解包闸:清单解析 + 整包校验
{
  const listing = [
    '-rw-r--r--  0 u g  1234 Jul 20 12:00 2026 skin.json',
    'drwxr-xr-x  0 u g     0 Jul 20 12:00 2026 assets/',
    '-rw-r--r--  0 u g  9999 Jul 20 12:00 2026 assets/bg.png',
  ].join('\n');
  const entries = parseTarListing(listing);
  assert.equal(entries.length, 3, 't2: 三条目');
  assert.deepEqual(entries.map((e) => e.type), ['-', 'd', '-'], 't2: 类型解析');
  assert.equal(entries[2].size, 9999, 't2: 尺寸解析');
  assert.ok(validateZipEntries(entries).ok, 't2: 正常包通过');
  // 符号链接按【类型】拒(盲审 #7:不是看条目名)
  const sym = parseTarListing('lrwxr-xr-x  0 u g  0 Jul 20 12:00 2026 evil -> /etc/passwd');
  assert.equal(sym[0].type, 'l', 't2: 符号链接类型识别');
  assert.equal(validateZipEntries(sym).code, 'path_traversal', 't2: 符号链接拒(S1 哨兵锚)');
  const hard = parseTarListing('hrw-r--r--  0 u g  0 Jul 20 12:00 2026 a link to b');
  assert.equal(validateZipEntries(hard).code, 'path_traversal', 't2: 硬链接拒');
  // 穿越双写 + 绝对路径 + 盘符
  assert.ok(isTraversalPath('../x'), 't2: ../ 拒');
  assert.ok(isTraversalPath('a/../x'), 't2: 中段 ../ 拒');
  assert.ok(isTraversalPath('a\\..\\x'), 't2: ..\\ 拒(Windows 双写)');
  assert.ok(isTraversalPath('/abs'), 't2: 绝对路径拒');
  assert.ok(isTraversalPath('C:\\x'), 't2: 盘符拒');
  assert.ok(!isTraversalPath('a/b.png'), 't2: 正常相对路径过');
  const evil = [{ type: '-', size: 1, path: '../evil.png' }];
  assert.equal(validateZipEntries(evil).code, 'path_traversal', 't2: 清单级穿越拒');
  // 条目数(目录计入)与声明体积快速失败
  const many = Array.from({ length: 41 }, (_, i) => ({ type: '-', size: 1, path: `f${i}` }));
  assert.equal(validateZipEntries(many).code, 'zip_entries_exceeded', 't2: >40 条目拒');
  const boom = [{ type: '-', size: 200 * 1024 * 1024, path: 'big.bin' }];
  assert.equal(validateZipEntries(boom).code, 'zip_bomb_suspected', 't2: 声明体积快速失败');
  assert.equal(ZIP_LIMITS.maxUnpackedBytes, 100 * 1024 * 1024, 't2: 实测字节闸上限=100MB(路由层计量同一常量)');
  // 根前缀:直放 / 嵌套一层 / 超一层
  assert.deepEqual(resolveRootPrefix(['skin.json', 'bg.png']), { prefix: '' }, 't2: 根目录直放');
  assert.deepEqual(resolveRootPrefix(['my-skin/skin.json', 'my-skin/bg.png']), { prefix: 'my-skin/' }, 't2: 嵌套一层');
  assert.equal(resolveRootPrefix(['a/b/skin.json']), null, 't2: 超一层 = 找不到 manifest');
}

// t3 manifest 两级口径矩阵
{
  const files = new Set(['skin.json', 'bg-light.jpg', 'bg-dark.jpg', 'preview.png', 'ic.svg']);
  const good = validateManifest({
    format: 'cgui-skin/1', name: '晨雾', base: 'nord', preview: 'preview.png',
    shared: { vars: { '--radius-lg': '14px', '--glass-shadow': '0 0 #0000', '--bogus': '#fff' } },
    light: { vars: { '--color-accent': '#5E81AC' }, background: { image: 'bg-light.jpg', overlayOpacity: 0.5, fit: 'cover' } },
    dark: { vars: { '--color-accent': '#88C0D0' }, background: { image: 'bg-dark.jpg', overlayOpacity: 7 } },
    home: { icon: 'ic.svg', greeting: '你好，{name}' },
    icons: { send: 'ic.svg', 'no-such': 'ic.svg' },
    extraField: 1,
  }, files);
  assert.ok(good.ok, 't3: 合法包通过');
  assert.equal(good.manifest.name, '晨雾', 't3: name');
  assert.deepEqual(good.manifest.shared.vars, { '--radius-lg': '14px' }, 't3: 非法/拒收变量丢弃仅留合法');
  const wcodes = good.warnings.map((w) => w.code);
  assert.ok(wcodes.includes('var_rejected'), 't3: 变量丢弃有 warning');
  assert.ok(wcodes.includes('field_invalid'), 't3: overlayOpacity 越界回默认 + warning(不 clamp)');
  assert.ok(wcodes.includes('unknown_field'), 't3: 未知字段 warning');
  assert.equal(good.manifest.dark.background.overlayOpacity, undefined, 't3: 越界丢弃回默认');
  assert.equal(good.manifest.home.greeting, '你好，{name}', 't3: home.greeting({name} 模板)');
  assert.deepEqual(good.manifest.icons, { send: 'ic.svg' }, 't3: 图标语义名白名单过滤');
  assert.ok(good.referenced.has('bg-light.jpg') && good.referenced.has('ic.svg'), 't3: 引用集完整');
  // 结构性类型错 → 整包拒
  assert.equal(validateManifest({ format: 'cgui-skin/1', name: 'a', light: 'oops' }, files).code, 'manifest_invalid', 't3: light 非对象整包拒');
  assert.equal(validateManifest({ format: 'cgui-skin/1', name: 'a', shared: { vars: [] } }, files).code, 'manifest_invalid', 't3: vars 非对象整包拒');
  assert.equal(validateManifest({ format: 'cgui-skin/2', name: 'a' }, files).code, 'unsupported_format', 't3: 版本不识别');
  assert.equal(validateManifest({ name: 'a' }, files).code, 'manifest_invalid', 't3: format 缺失');
  assert.equal(validateManifest({ format: 'cgui-skin/1', name: '' }, files).code, 'manifest_invalid', 't3: name 空');
  assert.equal(validateManifest({ format: 'cgui-skin/1', name: 'a' }, files).code, 'empty_skin', 't3: 全空 empty_skin');
  assert.equal(validateManifest({ format: 'cgui-skin/1', name: 'a', light: { background: { image: 'nope.png' } } }, files).code, 'asset_missing', 't3: 背景图缺失硬错');
  assert.equal(validateManifest({ format: 'cgui-skin/1', name: 'a', light: { background: { image: 'x.mp4' } } }, new Set(['x.mp4'])).code, 'asset_type', 't3: 被引用非图片 400');
  const prevMiss = validateManifest({ format: 'cgui-skin/1', name: 'a', preview: 'nope.png', shared: { vars: { '--color-ink': '#111' } } }, files);
  assert.ok(prevMiss.ok && prevMiss.warnings.some((w) => w.code === 'asset_ignored'), 't3: preview 缺失仅降级 warning');
  // tier:2 识别 + 三件套引用
  const t2m = validateManifest({ format: 'cgui-skin/1', name: 'dev', tier: 2 }, new Set(['skin.json', 'skin.css', 'client.js']));
  assert.ok(t2m.ok && t2m.manifest.tier === 2, 't3: tier 2 识别');
  assert.equal(t2m.manifest.skin_css, 'skin.css', 't3: T2 css 引用');
  assert.equal(t2m.manifest.client_js, 'client.js', 't3: T2 js 引用');
}

// t4 图片文件头解析(零依赖不解码)
{
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('0000000d49484452', 'hex'),
    Buffer.from([0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x10, 0x00]), // 8192×4096
  ]);
  assert.deepEqual(imageDimensions(png, 'png'), { w: 8192, h: 4096 }, 't4: PNG IHDR');
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(3)]); // 320×240
  assert.deepEqual(imageDimensions(gif, 'gif'), { w: 320, h: 240 }, 't4: GIF LSD(LE)');
  // JPEG:SOI + APP0(长度16填充) + SOF0 30000×30000(炸内存样本,20MB 字节限拦不住的那类)
  const jpg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x75, 0x30, 0x75, 0x30, 0x03]), Buffer.alloc(10),
  ]);
  assert.deepEqual(imageDimensions(jpg, 'jpeg'), { w: 30000, h: 30000 }, 't4: JPEG SOF 扫描(巨像素样本可测出)');
  const vp8x = Buffer.concat([
    Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('VP8X'),
    Buffer.alloc(8), Buffer.from([0xff, 0x0f, 0x00, 0xff, 0x0f, 0x00]),
  ]);
  assert.deepEqual(imageDimensions(vp8x, 'webp'), { w: 4096, h: 4096 }, 't4: WebP VP8X 24bit+1');
  assert.equal(imageDimensions(Buffer.from('nonsense'), 'png'), null, 't4: 解析失败返回 null(→ image_invalid)');
  assert.equal(imageDimensions(png, 'bmp'), null, 't4: 白名单外格式 null');
}

// t5 ②SVG 清洗器(S2 哨兵锚)
{
  const good = sanitizeSvg('<?xml version="1.0"?><!-- c --><svg viewBox="0 0 24 24"><path d="M0 0h24v24z" fill="currentColor"/></svg>');
  assert.ok(good.ok, 't5: 正常图标通过');
  assert.ok(!good.svg.includes('<!--') && !good.svg.includes('<?xml'), 't5: 注释/XML 声明剥除');
  assert.equal(sanitizeSvg('<svg><script>alert(1)</script></svg>').ok, false, 't5: script 拒');
  assert.equal(sanitizeSvg('<svg><foreignObject><body/></foreignObject></svg>').ok, false, 't5: foreignObject 拒');
  assert.equal(sanitizeSvg('<svg><image href="http://x/a.png"/></svg>').ok, false, 't5: image 标签拒(白名单外)');
  assert.equal(sanitizeSvg('<svg onload="alert(1)"><path/></svg>').ok, false, 't5: on* 事件属性拒');
  // 判官b3挂账#1:HTML 允许 / 作属性分隔(<svg/onload=…>),旧正则只认 \s 前导会放行。
  assert.equal(sanitizeSvg('<svg/onload="alert(1)"><rect/></svg>').ok, false, 't5: 斜杠分隔 on* 事件属性拒');
  assert.equal(sanitizeSvg('<svg><a href="javascript:x"><path/></a></svg>').ok, false, 't5: javascript: 拒');
  assert.equal(sanitizeSvg('<svg><use xlink:href="http://evil/x.svg#i"/></svg>').ok, false, 't5: 外链 href 拒');
  assert.ok(sanitizeSvg('<svg><use xlink:href="#local"/></svg>').ok, 't5: #fragment href 通过');
  assert.equal(sanitizeSvg('<svg><rect style="fill:url(http://x)"/></svg>').ok, false, 't5: style 内 url( 拒');
  assert.equal(sanitizeSvg('<svg><style>*{}</style></svg>').ok, false, 't5: style 标签拒');
  assert.equal(sanitizeSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>').ok, false, 't5: DOCTYPE/ENTITY 拒');
  assert.equal(sanitizeSvg('<div>x</div>').ok, false, 't5: 非 svg 根拒');
  assert.equal(sanitizeSvg('<svg>' + 'a'.repeat(33 * 1024) + '</svg>').ok, false, 't5: >32KB 拒');
}

// t6 ③T2 JS 静态校验器(S3 哨兵锚)
{
  assert.ok(validateT2Script('document.body.classList.add("x"); window.__cguiSkinDispose = () => {};').ok, 't6: 无害脚本通过');
  for (const bad of ['fetch("/x")', 'new XMLHttpRequest()', 'new WebSocket("ws://x")', 'import("m")', 'eval("1")', 'new Function("x")', 'navigator.sendBeacon("/x")']) {
    assert.equal(validateT2Script(`const a = 1; ${bad};`).ok, false, `t6: ${bad} 拒载`);
  }
  assert.equal(validateT2Script('FETCH("/x")').ok, false, 't6: 大小写变体同拒(toLowerCase)');
  // r26-D5 换锚:子串七字样 → 正则九形态(形态矩阵全量见 check-r26-t2-blacklist.mjs)
  assert.equal(T2_SCRIPT_BLACKLIST.length, 9, 't6: r26-D5 黑名单九形态(正则集)');
  const r = validateT2Script('eval("x"); fetch("/y")');
  assert.deepEqual(r.hits.sort(), ['(?:^|[^\\w$])eval\\s*\\(', '(?:^|[^\\w$])fetch\\s*\\('], 't6: 命中清单=正则 source 串,可报给用户(r31 去 lookbehind:等价 `(?:^|[^\\w$])` 前缀)');
}

// t7 dsw 尽力映射 + id 生成
{
  const { vars, warnings } = convertDswVars({ vars: {
    '--dsw-bg': '#101010', '--dsw-accent': '#FAB283', '--dsw-mystery': '#fff', '--dsw-fg': 'url(x)', 'foo': '#000',
  } });
  assert.deepEqual(vars, { '--color-canvas': '#101010', '--color-accent': '#FAB283' }, 't7: 可确证名映射,值仍全套闸');
  assert.equal(warnings.filter((w) => w.code === 'var_rejected').length, 2, 't7: 不可映射/值非法均入清单');
  assert.equal(warnings.filter((w) => w.code === 'unknown_field').length, 1, 't7: 非 dsw 变量提示');
  assert.match(skinIdFrom('My Cool Skin', 'abc123'), /^my-cool-skin-abc123$/, 't7: slug 生成');
  assert.match(skinIdFrom('晨雾', 'abc123'), /^skin-abc123$/, 't7: CJK 退化回退 skin-(盲审 #10,首字符非 -)');
  assert.ok(SKIN_ID_RE.test(skinIdFrom('晨雾')), 't7: id 匹配白名单正则');
  assert.equal(skinIdFrom('ABC', 'XY12ab'), 'abc-xy12ab', 't7: id 小写归一(win 大小写不敏感 FS)');
  assert.ok(ICON_SEMANTIC_NAMES.length >= 30 && new Set(ICON_SEMANTIC_NAMES).size === ICON_SEMANTIC_NAMES.length, 't7: 图标语义名 ≥30 且无重复');
}

console.log('check-skin-validate: all passed');
