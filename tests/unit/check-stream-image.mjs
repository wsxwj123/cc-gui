#!/usr/bin/env node
// 聊天气泡图片渲染纯函数自检(utils/markdownImages.js):
// 四种形态(空格路径 markdown / data URL / 裸路径独立行 / 裸 base64 独立行) + 围栏免疫 + 大小上限。
// 跑法:node tests/unit/check-stream-image.mjs
import assert from 'node:assert/strict';
import {
  IMAGE_DATA_MAX_CHARS, oversizedImageDataNote, wrapSpacedImageUrls, resolveImageSrc,
  sniffImageMime, embedBareImagePaths, embedBareBase64Images, preprocessImages,
} from '../../client/src/utils/markdownImages.js';

// ── 真实 PNG magic 的足够长 base64(≥512 才被裸 base64 分支认)─────────
const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600, 7)]);
const PNG_B64 = pngBytes.toString('base64');
assert.ok(PNG_B64.length >= 512, '样本 base64 需过长度门槛');

// ── ① markdown 路径含空格:补 <> ─────────────────────────────────────
assert.equal(
  wrapSpacedImageUrls('![图](/Users/a/界 面.png)'),
  '![图](</Users/a/界 面.png>)',
  '空格路径补 <>',
);
assert.equal(wrapSpacedImageUrls('![a](</Users/a/b.png>)'), '![a](</Users/a/b.png>)', '已包裹不重复补');
assert.equal(wrapSpacedImageUrls('![a](https://x.com/a b.png)'), '![a](https://x.com/a b.png)', '外链不碰');

// ── resolveImageSrc:聊天气泡(无 basePath)绝对路径也改写 ─────────────
assert.match(resolveImageSrc('/Users/a/b.png', undefined), /^\/api\/files\/read\?path=%2FUsers%2Fa%2Fb\.png/, '气泡绝对路径 → raw 端点');
assert.match(resolveImageSrc('/Users/a/b.png', '/tmp/x.md'), /path=%2FUsers%2Fa%2Fb\.png/, '预览绝对路径 → raw 端点');
assert.match(resolveImageSrc('img/b.png', '/tmp/x.md'), /path=%2Ftmp%2Fimg%2Fb\.png/, '预览相对路径按 md 目录解析');
assert.equal(resolveImageSrc('img/b.png', undefined), 'img/b.png', '气泡相对路径无法定位,保持原样');
assert.equal(resolveImageSrc('data:image/png;base64,AA', undefined), 'data:image/png;base64,AA', 'data: 原样');
assert.equal(resolveImageSrc('..//Users/a/b.png', '/tmp/'), '/api/files/read?path=%2FUsers%2Fa%2Fb.png&raw=1', '畸形 ..// 前缀剥成绝对路径');

// ── R05:Windows 绝对路径(反斜杠/空格/Markdown 编码后的 %5C %20) ────
// 同一目标路径的三种写法必须解析成同一个 raw 端点:原始反斜杠、%5C 编码、正斜杠。
const WIN_RAW = '/api/files/read?path=C%3A%2FUsers%2Ffb%2Fmy%20pic.png&raw=1';
assert.equal(resolveImageSrc('C:\\Users\\fb\\my pic.png', undefined), WIN_RAW, 'Windows 原始反斜杠 + 空格');
assert.equal(resolveImageSrc('C:%5CUsers%5Cfb%5Cmy%20pic.png', undefined), WIN_RAW, 'Markdown 编码后的 %5C/%20 解码一次');
assert.equal(resolveImageSrc('C:/Users/fb/my%20pic.png', undefined), WIN_RAW, '正斜杠 + 编码空格');
// 真实百分号:markdown 里的 %25 解一次,末尾再编一次,不能反复解码
assert.equal(
  resolveImageSrc('C:\\Users\\fb\\100%25.png', undefined),
  '/api/files/read?path=C%3A%2FUsers%2Ffb%2F100%25.png&raw=1',
  '%25 只解码一次',
);
assert.equal(
  resolveImageSrc('C:\\Users\\fb\\100%.png', undefined),
  '/api/files/read?path=C%3A%2FUsers%2Ffb%2F100%25.png&raw=1',
  '文件名里的裸 % 不炸(非法转义保原文)',
);
assert.match(
  resolveImageSrc('fb%20spaced%20img.png', '/tmp/x.md'),
  /path=%2Ftmp%2Ffb%20spaced%20img\.png&raw=1$/,
  '预览相对路径:编码空格解一次后按 md 目录拼',
);
assert.equal(resolveImageSrc('fb 100%.png', undefined), 'fb 100%.png', '气泡相对路径无法定位仍保持原样');

// ── ③ 裸路径独立行 ──────────────────────────────────────────────────
assert.equal(embedBareImagePaths('/Users/x/screenshot.png'), '![](/Users/x/screenshot.png)', '裸路径成图');
assert.equal(embedBareImagePaths('看这个 /Users/x/screenshot.png'), '看这个 /Users/x/screenshot.png', '行内路径不碰');
assert.equal(embedBareImagePaths('C:\\Users\\x\\shot.png'), '![](C:\\Users\\x\\shot.png)', 'Windows 盘符路径成图');
assert.equal(embedBareImagePaths('- /Users/x/a.md'), '- /Users/x/a.md', '非图片扩展名不碰');
assert.equal(embedBareImagePaths('![](/Users/x/a.png)'), '![](/Users/x/a.png)', '已是图片不碰');
assert.equal(embedBareImagePaths('> /Users/x/a.png'), '> /Users/x/a.png', '引用行不碰');

// ── 围栏免疫 ────────────────────────────────────────────────────────
assert.equal(
  embedBareImagePaths('```\n/Users/x/a.png\n```\n/Users/y/b.png'),
  '```\n/Users/x/a.png\n```\n![](/Users/y/b.png)',
  '围栏内不碰,围栏外成图',
);
assert.equal(
  embedBareImagePaths('~~~sh\n/Users/x/a.png\n'),
  '~~~sh\n/Users/x/a.png\n',
  '未闭合波浪围栏内不碰(流式半截)',
);

// ── R06:四反引号包三反引号 / 围栏长度 / 缩进代码 / 行内代码 ────────────
const NESTED_FENCE = [
  '````markdown',
  'FB_FENCE_20260910',
  '```bash',
  '/Users/x/fence-bare.png',
  '![图](/Users/x/fence spaced.png)',
  '```',
  '````',
].join('\n');
assert.equal(embedBareImagePaths(NESTED_FENCE), NESTED_FENCE, '四反引号里的三反引号不关闭外层围栏');
assert.equal(preprocessImages(NESTED_FENCE), NESTED_FENCE, '四反引号块整段零改写(裸路径/空格图片均保持原文)');
assert.equal(
  preprocessImages(`${NESTED_FENCE}\n\n/Users/x/after.png`),
  `${NESTED_FENCE}\n\n![](/Users/x/after.png)`,
  '四反引号闭合后的正文照常转换',
);
assert.equal(
  embedBareImagePaths('```\n~~~\n/Users/x/a.png\n~~~\n```'),
  '```\n~~~\n/Users/x/a.png\n~~~\n```',
  '三反引号围栏里的波浪行不关围栏',
);
assert.equal(
  embedBareImagePaths('/Users/x/indent.png'),
  '![](/Users/x/indent.png)',
  '文首裸路径仍成图(缩进判定不误伤)',
);
assert.equal(
  embedBareImagePaths('前言\n\n    /Users/x/indent.png'),
  '前言\n\n    /Users/x/indent.png',
  '缩进代码块内不碰',
);
assert.equal(
  embedBareImagePaths('前言\n\n    /Users/x/a.png\n    /Users/x/b.png\n\n后文 /Users/x/c.png'),
  '前言\n\n    /Users/x/a.png\n    /Users/x/b.png\n\n后文 /Users/x/c.png',
  '缩进代码块多行连续 + 块外正文不受影响',
);
// ── 阶段05 抽查修复:闭围栏后紧跟的缩进块(prevBlank 未复位) ───────────
// CommonMark 里围栏块结束后不留段落,紧跟的 4 空格行就是新的缩进代码块,内容必须一字不改。
assert.equal(
  preprocessImages('```sh\necho hi\n```\n    /Users/x/pic.png'),
  '```sh\necho hi\n```\n    /Users/x/pic.png',
  '闭围栏后紧跟的缩进块不被当正文改写(代码块里不冒出 ![](…))',
);
// 相邻不回归:上面两种输入加空行(原本就正常)与闭围栏后的正文照常转换
assert.equal(
  preprocessImages('```sh\necho hi\n```\n\n    /Users/x/pic.png'),
  '```sh\necho hi\n```\n\n    /Users/x/pic.png',
  '有空行时同样不碰(对照,修前修后一致)',
);
assert.equal(
  preprocessImages('```sh\necho hi\n```\n/Users/x/pic.png'),
  '```sh\necho hi\n```\n![](/Users/x/pic.png)',
  '闭围栏后的顶格正文仍照常转换',
);

// ── 阶段05 抽查修复:最外层行内代码改写不认识围栏 ─────────────────────
// 围栏正文里出现与围栏等长的反引号串时,最外层会拿它当行内代码的闭合 → 围栏剩余部分被当正文。
const FENCE_WITH_TICKS = '```md\nUse ``` for fences\n![](my file.png)\n```';
assert.equal(
  preprocessImages(FENCE_WITH_TICKS),
  FENCE_WITH_TICKS,
  '围栏正文里的等长反引号串不让围栏内容被当正文改写(复制原文不变)',
);
assert.equal(
  preprocessImages(`a \` b\n${FENCE_WITH_TICKS}`),
  `a \` b\n${FENCE_WITH_TICKS}`,
  '围栏前的孤立单反引号不与围栏内容配对',
);
assert.equal(
  preprocessImages(`${FENCE_WITH_TICKS}\n\n![ok](my file2.png)`),
  `${FENCE_WITH_TICKS}\n\n![ok](<my file2.png>)`,
  '围栏之外的正文照常补 <>(相邻不回归)',
);
assert.equal(
  preprocessImages(FENCE_WITH_TICKS.replace(/`/g, '~')),
  FENCE_WITH_TICKS.replace(/`/g, '~'),
  '波浪围栏同理(同形输入换同类字符)',
);
assert.equal(
  preprocessImages('前言\n\n    ![a](my file.png)'),
  '前言\n\n    ![a](my file.png)',
  '缩进代码块里的图片文本保持原文(同一根因:最外层改写不认识代码区)',
);
assert.equal(
  preprocessImages('    ![a](my file.png)'),
  '    ![a](my file.png)',
  '文首缩进代码块同理',
);
assert.equal(
  preprocessImages('双反引号 ``a ` b`` 后面 ![x](/p q.png)'),
  '双反引号 ``a ` b`` 后面 ![x](</p q.png>)',
  '等长反引号串算代码段,串后的正文照常改写',
);
assert.equal(
  preprocessImages('```` ``` `````'),
  '```` ``` `````',
  '四个反引号串不会被三反引号串提前闭合(等长配对)',
);

// ── ④ 裸 base64:magic 嗅探 + 上限 ───────────────────────────────────
assert.equal(sniffImageMime(PNG_B64), 'image/png', 'PNG magic');
assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')), 'image/jpeg', 'JPEG magic');
assert.equal(sniffImageMime(Buffer.alloc(600, 65).toString('base64')), null, '全 A 非图片');
assert.equal(embedBareBase64Images(PNG_B64), `![](data:image/png;base64,${PNG_B64})`, '裸 base64 成 data URL 图');
assert.equal(embedBareBase64Images(PNG_B64.slice(0, 100)), PNG_B64.slice(0, 100), '过短不碰');
assert.equal(embedBareBase64Images(`前缀文字\n${PNG_B64}\n后缀`), `前缀文字\n![](data:image/png;base64,${PNG_B64})\n后缀`, '行内上下文保留');

const BIG_B64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(IMAGE_DATA_MAX_CHARS, 9)]).toString('base64');
assert.ok(BIG_B64.length > IMAGE_DATA_MAX_CHARS, '超限样本');
assert.match(embedBareBase64Images(BIG_B64), /图片数据过大/, '超限给占位不进 DOM');

// ── data URL 超限占位 ───────────────────────────────────────────────
assert.equal(oversizedImageDataNote(`data:image/png;base64,${'A'.repeat(IMAGE_DATA_MAX_CHARS + 1)}`), `图片数据过大(约 ${Math.round((IMAGE_DATA_MAX_CHARS + 1 - 22) * 3 / 4 / 1024)} KB),已折叠不渲染`, '超限文案');
assert.equal(oversizedImageDataNote('data:image/png;base64,AAAA'), null, '未超限 null');
assert.equal(oversizedImageDataNote('/Users/a/b.png'), null, '非 data: 恒 null');

// ── 全链路:四种形态一次过 ──────────────────────────────────────────
const merged = preprocessImages([
  '![](/Users/dev/Desktop/cu-render-test/plain.png)',
  '![图](/Users/dev/Desktop/cu-render-test/界 面 图.png)',
  '/Users/dev/Desktop/cu-render-test/plain.png',
  PNG_B64,
].join('\n\n'));
const lines = merged.split('\n\n');
assert.match(lines[0], /^!\[\]\(\/Users\//, '形态1 原样(由 resolveImageSrc 改写)');
assert.match(lines[1], /^!\[图\]\(<\/Users\/.+界 面 图\.png>\)$/, '形态2 补 <>');
assert.match(lines[2], /^!\[\]\(\/Users\/.+plain\.png\)$/, '形态3 裸路径成图');
assert.match(lines[3], /^!\[\]\(data:image\/png;base64,/, '形态4 裸 base64 成 data URL 图');

console.log('check-stream-image: 全部断言通过 ✓');

// ── 盲审修复回归:行内代码保护 / 括号路径 / 流式末行 ────────────────
assert.equal(
  preprocessImages('示例: `![alt](my image.png)` 保持原样'),
  '示例: `![alt](my image.png)` 保持原样',
  '行内代码 span 不被空格路径改写污染',
);
assert.equal(
  preprocessImages('![a](/Users/x/Screenshot (1).png)'),
  '![a](/Users/x/Screenshot (1).png)',
  'URL 含括号放弃包裹(截断产物更糟,保持原文)',
);
const streamingMd = '前文完整行\n\n' + PNG_B64;
const streamed = preprocessImages(streamingMd, true);
assert.ok(streamed.startsWith('前文完整行\n\n'), '流式:首部行正常处理');
assert.ok(!streamed.includes('data:image'), '流式:末行(未完成)不转换,防 src 逐 chunk 增长');
assert.equal(preprocessImages(streamingMd, false), `前文完整行\n\n![](data:image/png;base64,${PNG_B64})`, '定稿后末行转换');
console.log('盲审修复回归: 通过 ✓');
