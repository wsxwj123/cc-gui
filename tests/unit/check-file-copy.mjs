#!/usr/bin/env node
// 单测:r11-⑦ 文件预览复制 —— 显隐判定(文本/图片 vs 二进制)+ 内容来源(截断态取全文)
// + 图片位图复制能力检测 gate + 格式转换判定(import 真函数)。
// 变异哨兵(实际验证过红):
//   S1 copyButtonKind 删二进制排除判定(binary 也返回 'text')→ t1 红
//   S2 canCopyImageBitmap 删能力检测回退(恒 true)→ t3 红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copyButtonKind, pickCopySource, canCopyImageBitmap, COPY_TEXT_MAX_BYTES } from '../../client/src/utils/fileCopy.js';

// t1 显隐矩阵:文本→复制全文;图片→复制位图;非文本非图片二进制不显示
{
  assert.equal(copyButtonKind({}), 'text', 't1: 普通文本预览 → text');
  assert.equal(copyButtonKind({ binary: false, truncated: true }), 'text', 't1: 截断文本仍显示(复制全文)');
  assert.equal(copyButtonKind({ isImage: true }), 'image', 't1: 图片 → image(复制位图)');
  assert.equal(copyButtonKind({ isImage: true, binary: true }), 'image', 't1: 图片走 raw 渲染,binary 标记不排除它');
  assert.equal(copyButtonKind({ isPdf: true }), null, 't1: pdf 不显示');
  assert.equal(copyButtonKind({ isVideo: true }), null, 't1: 视频不显示');
  assert.equal(copyButtonKind({ isAudio: true }), null, 't1: 音频不显示');
  assert.equal(copyButtonKind({ binary: true }), null, 't1: word/压缩包等二进制不显示');
  assert.equal(copyButtonKind({ loading: true }), null, 't1: 读取中不显示');
  assert.equal(copyButtonKind({ error: '读失败' }), null, 't1: 出错不显示');
  assert.equal(copyButtonKind({ editing: true }), null, 't1: 编辑态不显示(头部是编辑工具组)');
}

// t2 内容来源:截断态必须回后端取完整文件;未截断用已加载内容
{
  assert.deepEqual(pickCopySource({ truncated: true, content: '前 256KB…' }), { from: 'backend' }, 't2: 截断 → 后端全文');
  assert.deepEqual(pickCopySource({ truncated: false, content: 'abc' }), { from: 'preview', text: 'abc' }, 't2: 未截断 → 已载内容');
  assert.deepEqual(pickCopySource({}), { from: 'preview', text: '' }, 't2: 空预览安全');
  assert.equal(COPY_TEXT_MAX_BYTES, 5 * 1024 * 1024, 't2: 全文复制上限 5MB(超限拒绝并说明)');
}

// t3 图片复制能力检测 gate(WKWebView/WebView2 支持度不齐,不支持必须显式提示):
{
  assert.equal(canCopyImageBitmap({}), false, 't3: 无 ClipboardItem → 不支持');
  assert.equal(canCopyImageBitmap({ ClipboardItem: function C() {} }), false, 't3: 无 clipboard.write → 不支持');
  assert.equal(canCopyImageBitmap({ navigator: { clipboard: { write: () => {} } } }), false, 't3: 只有 write 无 ClipboardItem → 不支持');
  assert.equal(
    canCopyImageBitmap({ ClipboardItem: function C() {}, navigator: { clipboard: { write: () => {} } } }),
    true, 't3: 两者齐备 → 支持');
}

// t4 格式转换判定 + 组件接线仪表化
{
  const util = readFileSync(new URL('../../client/src/utils/fileCopy.js', import.meta.url), 'utf8');
  const png = /if \(extension === 'png'\) \{[\s\S]*?\}/.exec(util)?.[0] || '';
  assert.ok(png && !/canvas/.test(png), 't4: png 直接写不走 canvas');
  assert.match(util, /canvas\.toBlob[\s\S]*?'image\/png'/, 't4: 非 png(jpeg\/webp\/gif 静帧\/svg)经 canvas 转 png');
  assert.match(util, /new ClipboardItem\(\{ 'image\/png': blob \}\)/, 't4: ClipboardItem 只喂 image\/png');
  assert.match(util, /reason: 'unsupported'/, 't4: 不支持走显式 reason,不静默');
  const panel = readFileSync(new URL('../../client/src/components/FileExplorerPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /import \{ copyText \} from '\.\.\/utils\/clipboard\.js'/, 't4: 文本复制复用消息气泡同一 copyText,不重造');
  assert.match(panel, /copyButtonKind\(\{/, 't4: 显隐走纯函数判定');
  assert.match(panel, /canCopyImageBitmap\(\)/, 't4: 图片路径先过能力检测');
  assert.match(panel, /当前环境不支持复制图片/, 't4: 不支持的显式文案在');
  assert.match(panel, /pickCopySource\(preview\)/, 't4: 内容来源走纯函数(截断态取全文)');
  assert.match(panel, /COPY_TEXT_MAX_BYTES/, 't4: 5MB 上限接线');
  assert.match(panel, /已复制/, 't4: 成功提示在');
  assert.doesNotMatch(panel, /window\.alert|window\.confirm/, 't4: 不用原生 alert\/confirm(Tauri 禁用)');
}

console.log('check-file-copy: all passed');
