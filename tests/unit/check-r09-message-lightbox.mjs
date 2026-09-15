#!/usr/bin/env node
// R09：用户消息灯箱 —— 序列只限本消息、计数 N / M、左右键切邻图、首尾不循环、Escape 关闭、
// 打开时方向键不穿透聊天快捷键。
//
// 纯函数部分真 import 真跑；JSX 部分沿用本仓既有做法（tests/unit/check-r95-image-nav.mjs）：
// node 跑不了 JSX，读文件做结构断言，断言消息直接对回 INTERFACE 条款。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageAttachmentSequence, imageAttachmentSrc } from '../../client/src/utils/attachments.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// ── A. 消息内图片序列（灯箱导航的范围与顺序）─────────────────────────────
{
  const preview = (name) => ({ kind: 'image', name, path: `/tmp/${name}`, preview: `data:image/png;base64,${name}` });
  const attachments = [
    preview('a.png'),
    { kind: 'file', name: 'note.txt', path: '/tmp/note.txt', preview: null },
    { kind: 'image', name: 'missing.png', path: '', preview: null }, // 显示不出来 → 不进序列
    { kind: 'image', name: 'raw.png', path: '/tmp/raw.png', preview: null }, // 无 preview 但有路径 → 进序列
    preview('b.png'),
  ];
  const seq = imageAttachmentSequence(attachments);
  assert.deepEqual(seq.map((a) => a.name), ['a.png', 'raw.png', 'b.png'],
    '只数能显示的图片、跳过非图片与不可用图片，顺序保持附件原顺序');
  assert.deepEqual(imageAttachmentSequence(undefined), []);
  assert.deepEqual(imageAttachmentSequence([{ kind: 'image', name: 'x', preview: null, path: '' }]), [],
    '既无 preview 又无 path 的图片不进序列（它显示为「图片不可用」，不可预览）');
  assert.equal(imageAttachmentSrc(seq[1]), `/api/files/read?path=${encodeURIComponent('/tmp/raw.png')}&raw=1`);
}

// ── B. 灯箱组件契约：模态身份与键盘归属 ───────────────────────────────────
const LB = read('client/src/components/ImageLightbox.jsx');
assert.match(LB, /role="dialog"/, '灯箱必须是 role=dialog（黑盒可观察身份）');
assert.match(LB, /aria-modal="true"/, '灯箱是模态对话框');
assert.match(LB, /const nav = !!\(onPrev \|\| onNext\)/, 'nav 判定必须保留（没接导航的调用点不拦方向键）');
assert.match(LB, /if \(!nav\) return/, '没接导航时不消费方向键');
assert.match(LB, /'Escape'\)[^\n]*stopImmediatePropagation\(\)[^\n]*preventDefault\(\)[^\n]*onClose\(\)/,
  'Esc：先吃事件再关闭');
assert.match(LB, /Arrow(Left|Right)[\s\S]{0,240}stopImmediatePropagation/,
  '方向键在灯箱打开时归灯箱所有，不漏给聊天快捷键');

// ── C. 消息侧接线：计数、序列范围、首尾边界 ───────────────────────────────
const MB = read('client/src/components/MessageBubble.jsx');
assert.match(MB, /imageAttachmentSequence\(message\.attachments\)/,
  '序列必须来自本消息的图片附件（跨消息导航是错的）');
assert.match(MB, /counter=\{zoomImage \? `\$\{zoomIndex \+ 1\} \/ \$\{messageImages\.length\}` : ''\}/,
  '计数形如「当前 / 总数」，关闭时为 0 值');
assert.match(MB, /onPrev=\{zoomImage && zoomIndex > 0 \?/,
  '第一张时不给 onPrev（首不循环，到头那侧没有可按的按钮）');
assert.match(MB, /onNext=\{zoomImage && zoomIndex < messageImages\.length - 1 \?/,
  '最后一张时不给 onNext（尾不循环）');
assert.match(MB, /data-message-id=\{message\.uuid \|\| undefined\}/,
  '消息提供 data-message-id（灯箱与消息身份的对应关系）');

// ── D. 序列与实际能显示的图一致（阶段05 抽查第 2 条）────────────────────────
// 元数据说有来源、实际加载失败（文件被删/越界/解码失败）的图必须退出灯箱序列，否则
// 卡上是 2 张、灯箱写 1/3，还能翻到破图上。
assert.match(MB, /\.filter\(\(attachment\) => imageStates\.get\(attachment\)\?\.state !== 'failed'\)/,
  '加载失败的图片必须退出灯箱序列');
assert.match(MB, /onImageState=\{reportImageState\}/, '卡片把加载结局上报给消息体');
assert.match(MB, /onImageState\(attachment, failed \? 'failed' : \(displaySrc \? 'ok' : 'loading'\), displaySrc \|\| null\)/,
  '卡片按 失败/成功/加载中 三态上报');
assert.match(MB, /src: imageStates\.get\(messageImages\[zoomIndex\]\)\?\.src \|\| imageAttachmentSrc\(messageImages\[zoomIndex\]\)/,
  '灯箱复用卡片已取到的字节（点开不再重打一次原图请求）');

console.log('✓ check-r09-message-lightbox: 图片序列/不可用跳过、灯箱模态与键盘归属、计数与首尾边界全过');
