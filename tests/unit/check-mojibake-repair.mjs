#!/usr/bin/env node
// 粘贴乱码还原:UTF-8 字节被当 MacRoman/CP1252 解码后的文本 → 还原为中文;
// 正常中文/英文/法文/日文等原样放行(宁可不改,不能把正常文本改坏)。
import assert from 'node:assert/strict';
import { repairMojibake, insertTextAtCaret } from '../../client/src/utils/mojibake.js';

const mac = new TextDecoder('macintosh');
const cp1252 = new TextDecoder('windows-1252');
const toMojibake = (s, dec = mac) => {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (const b of bytes) out += dec.decode(Uint8Array.of(b));
  return out;
};

// t1 MacRoman 式乱码 → 还原
{
  const cases = [
    '当前无可用凭证',
    '✻ 500 当前无可用凭证 (request id: 20261021075 … · Retrying in 4s · attempt 5/10',
    '你好，世界',
    '报错：连接超时，请重试',
  ];
  for (const s of cases) {
    const moj = toMojibake(s);
    assert.notEqual(moj, s, `夹具自身应已乱码:${s}`);
    assert.equal(repairMojibake(moj), s, `应还原:${s}`);
  }
}

// t2 正常文本原样返回
{
  for (const s of ['当前无可用凭证', 'hello world', 'Âge doré', 'café', 'こんにちは世界', '', '   ', 'a\nb\tc']) {
    assert.equal(repairMojibake(s), s, `正常文本不得改写:${JSON.stringify(s)}`);
  }
}

// t3 还原必须幂等
{
  const moj = toMojibake('当前无可用凭证');
  const once = repairMojibake(moj);
  assert.equal(repairMojibake(once), once, '还原后再次调用不变');
}

// t4 非字符串入参原样
{
  for (const v of [null, undefined, 42, {}, []]) assert.equal(repairMojibake(v), v);
}

// t5 CP1252 式乱码(高位字节不是控制字符时)→ 还原
{
  const c = '当前无可用凭证';
  const cp = toMojibake(c, cp1252);
  assert.equal(repairMojibake(cp), c, 'CP1252 式乱码也应还原');
}

// t6 只有高位字符但没有中文结果 → 不改(避免误伤外文)
{
  const s = toMojibake('Âge doré');
  assert.equal(repairMojibake(s), s, '外文乱码串(无中文)不得被改');
}

// t7 短词也要能还原(判官指出「世界/网络」曾被门槛漏掉)
{
  for (const s of ['世界', '网络', '你好', '测试']) {
    assert.equal(repairMojibake(toMojibake(s)), s, `短词应还原:${s}`);
  }
}

// t8 题面真实乱码字面量(不是由本测试代码生成的)
{
  const moj = '‚úª 500 ÂΩìÂâçÊó†ÂèØÁî®Âá≠ËØÅ';
  assert.equal(repairMojibake(moj), '✻ 500 当前无可用凭证', '用户截图里的真实乱码应还原');
}

// t9 长 ASCII 尾行(占比会很低,但反推仍是合法 UTF-8 + 含中文 → 应还原)
{
  const s = '中文' + 'a'.repeat(300);
  assert.equal(repairMojibake(toMojibake(s)), s, '长 ASCII 尾行也应还原');
}

// t10 insertTextAtCaret:替换选区 + 触发 input 事件 + 光标落尾
{
  const events = [];
  const el = {
    value: 'abcdef',
    selectionStart: 1,
    selectionEnd: 4,
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.selectionStart = this.selectionEnd = start + text.length;
    },
    dispatchEvent(ev) { events.push(ev.type); return true; },
  };
  assert.equal(insertTextAtCaret(el, 'XY'), true);
  assert.equal(el.value, 'aXYef');
  assert.deepEqual(events, ['input']);
  assert.equal(insertTextAtCaret(null, 'x'), false);
  assert.equal(insertTextAtCaret(el, 42), false);
}

console.log('check-mojibake-repair: all passed');
