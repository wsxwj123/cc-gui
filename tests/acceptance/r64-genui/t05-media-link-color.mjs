#!/usr/bin/env node
// r64-genui【安全重点 / 错误路径】§5.4 媒体与链接协议 + §2.7 颜色白名单。
// 场景:媒体地址一渲染出来浏览器就会自己去拉,用户零点击。所以外部主机一律拒绝
// (IP/内容外泄),javascript:/data:/file: 等更不用说。颜色字段则是 CSS 注入面。
// 注意两种拒绝方式不同:媒体节点**整个丢弃**;link 只是**去掉 href 变纯文本**;颜色**降级为默认色**。
// Run: node tests/acceptance/r64-genui/t05-media-link-color.mjs
import assert from 'node:assert/strict';
import { genui } from './lib.mjs';
import { parse, node, nodeR, t, done } from './lib.mjs';

await genui(); // 未实现时整个文件只报一次"缺少交付物",而不是每条用例各报一遍

// ── 媒体地址:audio.src / video.src / video.poster 走同一套 ────────────────
const MEDIA_OK = ['/api/files/x.mp3', './a.mp4', '/a/b/c.webm'];
const MEDIA_BAD = [
  ['外部 http 主机', 'http://example.com/x.mp4'],
  ['外部 https 主机', 'https://cdn.example.com/x.mp4'],
  ['协议相对', '//evil.com/x.mp4'],
  ['javascript:', 'javascript:alert(1)'],
  ['JavaScript: 大小写变形', 'JavaScript:alert(1)'],
  ['JAVASCRIPT: 全大写', 'JAVASCRIPT:alert(1)'],
  ['data:', 'data:audio/mpeg;base64,AAAA'],
  ['file://', 'file:///etc/passwd'],
  ['blob:', 'blob:http://localhost/abc'],
  ['vbscript:', 'vbscript:msgbox(1)'],
  ['首尾带空白的 javascript:', '  javascript:alert(1)  '],
  ['内嵌 TAB 的 java<TAB>script:', 'java\tscript:alert(1)'],
  ['内嵌换行', 'java\nscript:alert(1)'],
  ['前置控制符', '\u0001javascript:alert(1)'],
  ['内嵌 NUL', 'java\u0000script:alert(1)'],
  ['空字符串', ''],
  ['纯空白', '   '],
  ['超 2048 字符', '/a/' + 'b'.repeat(2100) + '.mp3'],
];

for (const src of MEDIA_OK) {
  await t('媒体地址放行(同源相对):' + src, async () => {
    const a = await node({ type: 'audio', src });
    assert.ok(a, 'audio 不该被丢弃');
    assert.equal(a.src, src);
    const v = await node({ type: 'video', src });
    assert.ok(v, 'video 不该被丢弃');
  });
}

for (const [why, src] of MEDIA_BAD) {
  await t('audio.src 被拒 → 节点丢弃并计数(' + why + ')', async () => {
    const { r, n } = await nodeR({ type: 'audio', src });
    assert.equal(n, null, '非法媒体地址必须让该节点不渲染,实际:' + JSON.stringify(n));
    assert.equal(r.ok, false, '本例只有这一个节点,全丢 → 保留原始代码块');
  });
  await t('video.src 被拒 → 节点丢弃,同围栏其它组件照常(' + why + ')', async () => {
    const r = await parse({ items: [{ type: 'video', src }, { type: 'text', content: 'KEEP' }] });
    assert.equal(r.ok, true, '一个坏媒体不该牵连整块');
    assert.deepEqual(r.root.items.map((x) => x.type), ['text']);
    assert.equal(r.ignored, 1);
    assert.ok(!JSON.stringify(r).includes('evil.com'), '被拒地址不得残留在结果里');
  });
}

await t('video.poster 非法但 src 合法:video 照常渲染,只丢掉 poster', async () => {
  const n = await node({ type: 'video', src: '/a.mp4', poster: 'https://evil.com/p.png' });
  assert.ok(n, 'poster 是选填,非法只降级不该丢整个节点(§2 表头)');
  assert.ok(n.poster === undefined || n.poster === null, 'poster 应被去掉,实际:' + n.poster);
  assert.ok(!JSON.stringify(n).includes('evil.com'));
});

await t('非字符串 src 被拒(数字/对象/数组/null)', async () => {
  for (const src of [123, {}, [], null, true]) {
    const { n } = await nodeR({ type: 'audio', src });
    assert.equal(n, null, 'src=' + JSON.stringify(src) + ' 应丢弃节点');
  }
});

// ── link.href:更严的白名单,且拒绝时**不丢节点**,只变纯文本 ────────────────
for (const href of ['https://example.com/a', 'http://example.com/a', 'mailto:a@b.c']) {
  await t('link.href 放行:' + href, async () => {
    const n = await node({ type: 'link', label: 'L', href });
    assert.ok(n, 'link 节点不该被丢弃');
    assert.equal(n.href, href);
  });
}

const HREF_BAD = ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x', 'file:///etc/passwd',
  '//evil.com/a', 'vbscript:x', 'ftp://x/y', 'tel:123', 'blob:http://x/y', '   javascript:alert(1)'];
for (const href of HREF_BAD) {
  await t('link.href 被拒 → 渲染成纯文本(节点保留、href 去掉):' + href.slice(0, 24), async () => {
    const { r, n } = await nodeR({ type: 'link', label: 'LBL', href });
    assert.ok(n, 'link 被拒时不丢节点,只是不可点(§5.4)');
    assert.equal(n.type, 'link');
    assert.ok(n.href === undefined || n.href === null, 'href 必须被去掉,实际:' + n.href);
    assert.equal(r.ignored, 0, 'link 降级不计入"已忽略"');
    assert.ok(!JSON.stringify(n).includes('javascript'), '被拒地址不得残留');
  });
}

await t('link 无 href:渲染成纯文本,不报错、不计入已忽略', async () => {
  const { r, n } = await nodeR({ type: 'link', label: 'L' });
  assert.ok(n);
  assert.ok(n.href === undefined || n.href === null);
  assert.equal(r.ignored, 0);
});

// ── 颜色字段(§2.7):放行四种形态,其余降级为默认色(不报错、不丢节点)──────
const COLOR_OK = ['#3ecf8e', '#fff', '#11223344', '#ABC', 'rgb(1,2,3)', 'rgba(0,0,0,.2)',
  'hsl(210 40% 50%)', 'hsla(210,40%,50%,.5)', 'var(--color-accent)', 'var(--color-ink)'];
for (const color of COLOR_OK) {
  await t('颜色放行:' + color, async () => {
    const n = await node({ type: 'avatar', name: 'A', color });
    assert.ok(n, 'avatar 不该被丢弃');
    assert.equal(n.color, color, '合法颜色应原样保留');
  });
}

const COLOR_BAD = [
  ['url() 远程图片', 'url(https://evil.com/x.png)'],
  ['image-set()', 'image-set("a.png" 1x)'],
  ['CSS expression', 'expression(alert(1))'],
  ['非 --color- 前缀的变量', 'var(--dsl-g-bg)'],
  ['带分号的 CSS 注入', '#fff; background: url(https://evil.com/x)'],
  ['命名颜色(不在四种形态里)', 'red'],
  ['非法 hex 字母', '#gggggg'],
  ['hex 只有 2 位', '#12'],
  ['hex 9 位', '#123456789'],
  ['超 64 字符', 'rgba(' + '0,'.repeat(40) + '0)'],
  ['注释穿插', '#ff/*x*/ffff'],
  ['空串', ''],
];
for (const [why, color] of COLOR_BAD) {
  await t('颜色降级为默认色(' + why + ')', async () => {
    const { r, n } = await nodeR({ type: 'avatar', name: 'A', color });
    assert.ok(n, '颜色非法只降级,不该丢节点(§2.7)');
    assert.ok(n.color === undefined || n.color === null, '非法颜色必须被去掉,实际:' + n.color);
    assert.equal(r.ignored, 0, '颜色降级不计入"已忽略"');
    assert.equal(r.notice, null, '颜色降级不报错');
  });
}

await t('非字符串颜色降级为默认色,不崩', async () => {
  for (const color of [123, {}, [], null, true]) {
    const n = await node({ type: 'avatar', name: 'A', color });
    assert.ok(n, 'color=' + JSON.stringify(color) + ' 不该丢节点');
    assert.ok(n.color === undefined || n.color === null);
  }
});

await t('chart 序列颜色同样走白名单(非法项降级,数据点不丢)', async () => {
  const n = await node({ type: 'chart', data: [
    { label: 'a', value: 1, color: '#3ecf8e' },
    { label: 'b', value: 2, color: 'url(https://evil.com/x.png)' },
  ] });
  assert.ok(n);
  assert.equal(n.data.length, 2, '颜色非法不该丢数据点');
  assert.equal(n.data[0].color, '#3ecf8e');
  assert.ok(!JSON.stringify(n).includes('evil.com'));
});

done('t05 媒体/链接/颜色');
