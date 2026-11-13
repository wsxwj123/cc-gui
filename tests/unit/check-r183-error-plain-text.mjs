// 单测:r183 报错原文原样显示 —— 回合里哪几段是报错原文(errorTextIndexes)与给 blocks 打标(markErrorTextBlocks)。
// 行为断言,不按源码文本计数。
import assert from 'node:assert/strict';
import {
  errorTextIndexes, markErrorTextBlocks,
} from '../../client/src/utils/apiErrorActions.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; };
const turn = (extra) => ({ type: 'turn', uuid: 'u1', ...extra });
const txt = (content, more = {}) => ({ type: 'text', content, ...more });

t('普通回合:一段都不算报错原文,blocks 原样返回(同一引用)', () => {
  const blocks = [txt('看图 ![图](http://x/ok.png)')];
  const m = turn({ model: 'claude-x', blocks });
  assert.equal(errorTextIndexes(m, ['a']).size, 0);
  assert.equal(markErrorTextBlocks(m), blocks);
});

t('有后端标记:只标内容等于 apiError.text 的那段,前面的正常正文不标', () => {
  const blocks = [txt('前面是**正文**'), { type: 'tool_use', toolCall: { id: 't1' } }, txt('  API Error: 401 ![x](http://p/a.png)\n')];
  const m = turn({ model: 'claude-x', apiError: { text: 'API Error: 401 ![x](http://p/a.png)' }, blocks });
  const out = markErrorTextBlocks(m);
  assert.notEqual(out, blocks);
  assert.equal(out.length, blocks.length);
  assert.equal(out[0].errorText, undefined);
  assert.equal(out[1], blocks[1]);
  assert.equal(out[2].errorText, true);
  assert.equal(out[2].content, blocks[2].content, '只加标记,不改内容');
  assert.equal(blocks[2].errorText, undefined, '不改原对象');
});

t('有后端标记但原文为空 / 没有相等的段:一段都不标', () => {
  const blocks = [txt('别的内容')];
  assert.equal(markErrorTextBlocks(turn({ apiError: { text: '' }, blocks })), blocks);
  assert.equal(markErrorTextBlocks(turn({ apiError: {}, blocks })), blocks);
  assert.equal(markErrorTextBlocks(turn({ apiError: { text: '报错' }, blocks })), blocks);
});

t('老会话无标记、模型 <synthetic>:标最后一段非空文字', () => {
  const blocks = [txt('第一段'), txt('报错原文'), txt('')];
  const out = markErrorTextBlocks(turn({ model: '<synthetic>', blocks }));
  assert.equal(out[0].errorText, undefined);
  assert.equal(out[1].errorText, true);
  assert.equal(out[2].errorText, undefined);
});

t('已有块带标记(本地 ❌ 块 / 流式打的):原样返回', () => {
  const blocks = [txt('❌ x', { errorText: true })];
  assert.equal(markErrorTextBlocks(turn({ model: '<synthetic>', blocks })), blocks);
});

t('没有 blocks:原样返回;legacy text 数组同口径', () => {
  const m = turn({ model: '<synthetic>', text: ['正文', '报错'] });
  assert.equal(markErrorTextBlocks(m), undefined);
  assert.deepEqual([...errorTextIndexes(m, m.text)], [1]);
  const k = turn({ apiError: { text: '报错' }, text: ['报错', '正文'] });
  assert.deepEqual([...errorTextIndexes(k, k.text)], [0]);
});

t('非回合条目不算', () => {
  assert.equal(errorTextIndexes({ type: 'user', model: '<synthetic>' }, ['x']).size, 0);
  assert.equal(errorTextIndexes(null, ['x']).size, 0);
});

console.log(`check-r183-error-plain-text: ${passed} passed`);
