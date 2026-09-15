#!/usr/bin/env node
// computer-use 按键解析与效果预期单测(批次3/R17):
//   * parseKeySpec:别名/大小写等价;空串、重复修饰符、多键、不支持键整串拒绝(无部分按键)
//   * expectedAfter:方向键/退格/回车/可打印字符/全选的期望文本-选择状态
// 跑法:node tests/unit/check-cu-keys.mjs
import assert from 'node:assert/strict';

const { parseKeySpec, expectedAfter } = await import('../../server/computer-use/mcp-server.js');

// ── 合同点名的别名/大小写都等价 ────────────────────────────────────
const OK = ['up', 'down', 'left', 'right', 'arrow_up', 'arrow_down', 'arrow_left', 'arrow_right',
  'escape', 'esc', 'return', 'enter', 'tab', 'space', 'backspace', 'delete', 'a', 'Z', '7',
  'cmd+c', 'command+c', 'option+a', 'alt+a', 'ctrl+a', 'control+a', 'Shift+Tab', 'shift+tab', 'cmd+shift+4'];
for (const raw of OK) {
  assert.equal(parseKeySpec(raw).ok, true, `"${raw}" 必须被接受`);
}
assert.equal(parseKeySpec('up').key, parseKeySpec('arrow_up').key, 'up 与 arrow_up 同键');
assert.equal(parseKeySpec('esc').key, 'escape', 'esc 别名');
assert.equal(parseKeySpec('enter').key, 'return', 'enter 别名');
assert.equal(parseKeySpec('delete').key, 'backspace', 'delete 是 backspace 的别名(向后删)');
assert.equal(parseKeySpec('cmd+c').flags, parseKeySpec('command+c').flags, 'cmd/command 同修饰符');
assert.equal(parseKeySpec('Shift+Tab').flags, parseKeySpec('shift+tab').flags, '大小写忽略');
assert.equal(parseKeySpec('Z').unicode, 'Z', '大写字母保留大小写');
assert.equal(parseKeySpec('cmd+c').unicode, null, 'cmd 组合不塞 unicode(不能变成插入文字)');

// ── 整串拒绝(投递前,无部分按键)────────────────────────────────
const BAD = ['', 'f13', 'meta+a', 'a+b', 'cmd+c+d', 'cmd+cmd+a', 'cmd+', '+a', 'unknown_key',
  'shift+shift+a', 'option+', 'alt+alt+a', 'a+cmd'];
for (const raw of BAD) {
  assert.equal(parseKeySpec(raw).ok, false, `"${raw}" 必须被拒绝`);
}
assert.equal(parseKeySpec(42).ok, false, '非字符串拒绝');
assert.equal(parseKeySpec(null).ok, false, 'null 拒绝');

// ── 期望状态转移 ─────────────────────────────────────────────────
const before = { readable: true, text: 'hello', selStart: 5, selEnd: 5 };
assert.deepEqual(expectedAfter(before, parseKeySpec('arrow_left')),
  { text: 'hello', selStart: 4, selEnd: 4 }, '左移一位');
assert.deepEqual(expectedAfter(before, parseKeySpec('arrow_right')),
  { text: 'hello', selStart: 5, selEnd: 5 }, '右移一位(文末夹住不越界,不产生想象的位移)');
assert.deepEqual(expectedAfter({ ...before, selStart: 1, selEnd: 4 }, parseKeySpec('backspace')),
  { text: 'ho', selStart: 1, selEnd: 1 }, '退格删除选区');
assert.deepEqual(expectedAfter(before, parseKeySpec('backspace')),
  { text: 'hell', selStart: 4, selEnd: 4 }, '退格删前一个字符');
assert.deepEqual(expectedAfter({ ...before, selStart: 0, selEnd: 0 }, parseKeySpec('backspace')),
  { text: 'hello', selStart: 0, selEnd: 0 }, '文首退格是空操作(不越界)');
assert.deepEqual(expectedAfter(before, parseKeySpec('return')),
  { text: 'hello\n', selStart: 6, selEnd: 6 }, '回车插入换行');
assert.deepEqual(expectedAfter(before, parseKeySpec('space')),
  { text: 'hello ', selStart: 6, selEnd: 6 }, '空格插入空格');
assert.deepEqual(expectedAfter(before, parseKeySpec('a')),
  { text: 'helloa', selStart: 6, selEnd: 6 }, '字符插在光标处');
assert.deepEqual(expectedAfter(before, parseKeySpec('cmd+a')),
  { text: 'hello', selStart: 0, selEnd: 5 }, 'cmd+a = 全选');
assert.equal(expectedAfter(before, parseKeySpec('cmd+c')), null, 'cmd+c 文本状态不可预测');
assert.equal(expectedAfter(before, parseKeySpec('arrow_up')), null, '上下方向键不可预测');
assert.equal(expectedAfter({ readable: false }, parseKeySpec('a')), null, '读不回时没有预期');

console.log('check-cu-keys: 全部断言通过 ✓');
process.stdin.destroy();
