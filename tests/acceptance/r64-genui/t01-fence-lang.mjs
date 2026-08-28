#!/usr/bin/env node
// r64-genui【正常路径 + 反向断言】§1.1 围栏语言标记命中规则。
// 场景:模型写 ```cgui-ui,界面才把它当界面;写 ```json / ```html 必须一字不变走老路。
// 认多了 = 把普通代码块吃掉;认少了 = 上游写法粘过来不认。
// Run: node tests/acceptance/r64-genui/t01-fence-lang.mjs
import assert from 'node:assert/strict';
import { genui, t, done } from './lib.mjs';

const { matchFenceLang } = await genui();
const yes = (info, why) => assert.equal(matchFenceLang(info), true, `应命中:${JSON.stringify(info)} ${why || ''}`);
const no = (info, why) => assert.equal(matchFenceLang(info), false, `不应命中:${JSON.stringify(info)} ${why || ''}`);

await t('命中:cgui-ui(主推写法)', () => yes('cgui-ui'));
await t('命中:dsh-ui(上游写法,别人的例子要能直接粘)', () => yes('dsh-ui'));
await t('命中:大小写不敏感 CGUI-UI / Dsh-UI / DSH-UI', () => { yes('CGUI-UI'); yes('Dsh-UI'); yes('DSH-UI'); yes('cGuI-Ui'); });
await t('命中:带附加参数 cgui-ui title=x(只取第一个空白分隔词)', () => { yes('cgui-ui title=x'); yes('dsh-ui  a  b  c'); });
await t('命中:标记前有空格 " cgui-ui"', () => { yes(' cgui-ui'); yes('   dsh-ui'); });
await t('命中:标记用 Tab 分隔参数', () => yes('cgui-ui\ttitle=x'));
await t('命中:行尾带 \\r(Windows 换行残留)', () => yes('cgui-ui\r'));

await t('不命中:cgui / ui / genui(近似名一律普通代码块)', () => { no('cgui'); no('ui'); no('genui'); no('dsh'); });
await t('不命中:json / html / svg / mermaid(既有路径必须一字不变)', () => { no('json'); no('html'); no('svg'); no('mermaid'); });
await t('不命中:前后缀变形 cgui-ui2 / xcgui-ui / cgui-uix', () => { no('cgui-ui2'); no('xcgui-ui'); no('cgui-uix'); no('cgui_ui'); });
await t('不命中:第一个词后面直接接中文 cgui-ui中文', () => no('cgui-ui中文'));
await t('不命中:空串与纯空白', () => { no(''); no('   '); no('\t'); });
await t('不命中:全角变形 ｃｇｕｉ-ｕｉ', () => no('ｃｇｕｉ-ｕｉ'));
await t('不命中:带零宽字符的伪装 cgui\\u200b-ui', () => no('cgui​-ui'));

await t('【健壮性】非字符串入参返回 false 且不抛(null/undefined/数字/对象/数组)', () => {
  for (const v of [null, undefined, 0, 42, {}, [], true, NaN]) {
    let out;
    assert.doesNotThrow(() => { out = matchFenceLang(v); }, `matchFenceLang(${String(v)}) 抛异常了`);
    assert.equal(out, false, `matchFenceLang(${String(v)}) 应为 false,实际 ${String(out)}`);
  }
});

await t('【反向】超长语言标记不命中也不卡(10 万字符)', () => {
  const t0 = Date.now();
  no('x'.repeat(100000));
  yes('cgui-ui ' + 'x'.repeat(100000));
  assert.ok(Date.now() - t0 < 1000, '语言标记判定不得随长度爆炸,耗时 ' + (Date.now() - t0) + 'ms');
});

done('t01 围栏语言标记');
