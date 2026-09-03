#!/usr/bin/env node
// r94 B1 线自测:像素尺寸 / 1:1 原始像素 / 模型输入框布局。
//
// 与 check-r94-panel.mjs(黑盒验收,只抄 INTERFACE 字面)互补:这里锁的是【接线是否自洽】——
// 验收测试能证明"meta 这个字传了",证明不了"传进去的永远是空串"。JSX 进不了 node,
// 只能读源码断言,所以每条都挑那种"改坏了必定断"的结构关系,不做字面复述。
//
// 零网络、零配置、只读仓库文件。Run: node tests/unit/check-r94-dev-panel-a.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const count = (s, re) => (s.match(re) || []).length;

let PASS = 0;
let FAILS = 0;
const failed = [];
function check(name, fn) {
  try {
    fn();
    PASS++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    FAILS++;
    failed.push(name);
    console.log(`  ✗ ${name}\n      ${String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

const P = read('client/src/components/ImagePanel.jsx');
const LB = read('client/src/components/ImageLightbox.jsx');

console.log('\n[B1-①] 像素尺寸:测量点与消费点必须指同一个 URL');

check('预览区那张图挂了 onLoad={measureShot}(唯一测量点,少了两处尺寸永远为空)', () => {
  const at = P.indexOf('src={shotUrl(current)}');
  assert.ok(at > 0, '找不到预览区大图');
  const tag = P.slice(at, P.indexOf('/>', at) + 2);
  assert.ok(tag.includes('onLoad={measureShot}'), `预览区大图缺 onLoad={measureShot}(实得 ${tag})`);
});

check('measureShot 的键取 getAttribute(\'src\') 原文,不取 el.src(会被补成绝对地址,与 shotUrl 对不上)', () => {
  const m = P.match(/const measureShot = \(e\) => \{[\s\S]*?\n  \};/);
  assert.ok(m, '找不到 measureShot');
  assert.match(m[0], /getAttribute\('src'\)/, "键必须是 src 属性原文");
  assert.ok(!/=\s*el\.src\b/.test(m[0]), 'el.src 是绝对地址,拿它当键查不到');
  assert.match(m[0], /naturalWidth/, '尺寸只能从图片本身读');
  assert.match(m[0], /naturalHeight/);
  // 同尺寸不换对象:每 1.5s 轮询重渲染都新建一份 dims 会让消费方无谓重算/闪烁。
  assert.match(m[0], /\?\s*m\s*:/, '同尺寸必须原样返回旧 state');
});

check('放大层的 src 与 meta 同源(都取 zoomSrc),否则测到的尺寸查不到', () => {
  const at = P.indexOf('<ImageLightbox');
  const tag = P.slice(at, P.indexOf('/>', at) + 2);
  assert.ok(tag.includes('src={zoomSrc}'), '放大层的图必须走 zoomSrc');
  assert.ok(tag.includes('meta={dimText(zoomSrc)}'), 'meta 必须查同一个 zoomSrc 的尺寸');
  assert.match(P, /const zoomSrc = /, '缺 zoomSrc 定义');
});

check('预览区状态行显示 dimText(shotUrl(current))(B15:看得到 W×H)', () => {
  assert.ok(P.includes('{dimText(shotUrl(current))}'), '状态行没消费像素尺寸');
});

check('dimText 拿不到尺寸时给空串(不显示 0×0 / undefined)', () => {
  const m = P.match(/const dimText = [^\n]*/);
  assert.ok(m, '找不到 dimText');
  assert.match(m[0], /: ''/, '无值分支必须是空串');
  assert.match(m[0], /\$\{d\.w\}×\$\{d\.h\}/, '形如 1456×816');
});

console.log('\n[B1-②] 1:1 原始像素:开关在面板、渲染在放大层');

check('actualSize 必须同时驱动【遮罩可滚动】与【图片去掉尺寸上限】(只改一处 = 点了滚不动或没变大)', () => {
  assert.match(LB, /actualSize \? 'overflow-auto'/, '遮罩缺 overflow-auto 分支');
  assert.match(LB, /actualSize\s*\n?\s*\?\s*'shrink-0 max-w-none max-h-none/, '图片缺"按原始像素"分支');
  assert.ok(/m-auto/.test(LB), '溢出时用 justify-center 会裁掉左上角且滚不回来,必须靠 auto margin 居中');
});

check('1:1 按钮吃掉冒泡(否则点一下顺手把放大层关了)', () => {
  const m = LB.match(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); onToggleActualSize\(\); \}\}/);
  assert.ok(m, '1:1 按钮的 onClick 必须先 stopPropagation 再切换');
});

check('三个新 prop 全可选:工具条整块由 counter/meta/onToggleActualSize 门控', () => {
  assert.match(LB, /\{\(counter \|\| meta \|\| onToggleActualSize\) && \(/,
    '会话气泡/输入框那两处一个都不传,必须整块不渲染(B18)');
  assert.match(LB, /\{onToggleActualSize && \(/, '没接开关的调用方不许画出 1:1 按钮');
});

check('工具条用 fixed 不用 absolute(1:1 档遮罩自己滚动,absolute 会把「自适应」滚出视口)', () => {
  assert.match(LB, /className="fixed top-4 left-4/, '工具条必须 fixed');
});

check('关掉放大层时复位 actualSize(下次打开别莫名其妙是 1:1)', () => {
  assert.match(P, /onClose=\{\(\) => \{ setZoom\(null\); setActualSize\(false\); \}\}/);
});

check('D8:放大层仍是哑组件 —— 新增能力没有引入 state', () => {
  assert.ok(!/\buseState\b/.test(LB), 'r95 锁死 Lightbox 不许有自有状态');
  assert.equal(count(LB, /useEffect\(/g), 2, '仍是滚动锁 + 键盘两个 effect,1:1 不该再加一个');
});

console.log('\n[B1-③] 模型输入框布局');

check('「模型」独占一行:密钥与模型之间不再有 grid-cols-2 两栏容器', () => {
  const a = P.indexOf('>密钥{form.id');
  const b = P.indexOf('>浏览</button>');
  assert.ok(a > 0 && b > a, '切不出密钥→模型这一段');
  assert.ok(!P.slice(a, b).includes('grid-cols-2'),
    '模型行被塞回两栏后,右半栏被两枚按钮吃光,输入框只剩十几像素');
});

check('模型输入框与「浏览」「拉取模型」同一行,且输入框可收缩(min-w-0)', () => {
  const at = P.indexOf('list="cgui-image-model-options"');
  assert.ok(at > 0, '找不到模型输入框');
  const line = P.slice(P.lastIndexOf('\n', at) + 1, P.indexOf('\n', at));
  assert.ok(line.includes('min-w-0'), `模型输入框那行缺 min-w-0:${line.trim().slice(0, 140)}`);
  const row = P.slice(at, P.indexOf('拉取模型\n', at)); // 到「拉取模型」按钮文本为止(title 里那个带引号,不会误命中)
  assert.ok(row.includes('>浏览</button>'), '「浏览」按钮仍与输入框同一行(r87 锁)');
});

console.log(`\n—— check-r94-dev-panel-a: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
console.log('✓ check-r94-dev-panel-a: 像素尺寸接线 + 1:1 两处联动 + 模型行布局 全绿');
