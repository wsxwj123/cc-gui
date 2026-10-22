#!/usr/bin/env node
// 粘贴乱码还原:UTF-8 字节被当 MacRoman/CP1252 解码后的文本 → 还原为中文;
// 正常中文/英文/法文/日文、Mac Option 键符号对、会拼成私用区/控制字符的串原样放行(宁可不改,不能把正常文本改坏)。
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

// t11 还原后不含中文、但含符号/全角标点(用户 18:48 实报样本):也应还原
{
  const raw = '✻ API error · Retrying in 0s · attempt 1/10';
  const moj = toMojibake(raw);
  assert.equal(repairMojibake(moj), raw, '无中文的符号/标点乱码也应还原');
  assert.equal(repairMojibake('‚úª'), '✻', '单个符号也应还原');
}

// t12 还原后只有 Latin-1 外文(法/德等)→ 不改,避免误伤
{
  const s = toMojibake('café');
  assert.equal(repairMojibake(s), s, '外文乱码串不被改');
}

// t13 Mac 用 Option 键打出的符号对 / 正常外文 / 会拼成私用区的串 → 原样(r151q 行为 1)。
//     ∆µ 反推是合法的双字节 UTF-8(→ Ƶ,U+01B5),旧门槛"≥U+0100"会把它改坏;
//     Ôéé 反推是合法的三字节 UTF-8(→ U+F38E,私用区),只靠"≥U+0800"拦不住,要靠私用区排除。
{
  for (const s of ['∆µ = 5 kJ', '≈∞', '∆Ω', '∆π', '«é»', 'Größe', 'Ôéé', '∆µ']) {
    assert.equal(repairMojibake(s), s, `正常符号/外文不得改写:${s}`);
  }
  const dec = new TextDecoder('utf-8', { fatal: true });
  const macBytes = (s) => Uint8Array.from([...s].map((ch) => {
    for (let b = 0; b < 256; b += 1) if (mac.decode(Uint8Array.of(b)) === ch) return b;
    throw new Error(`not in MacRoman: ${ch}`);
  }));
  assert.equal(dec.decode(macBytes('∆µ')).codePointAt(0), 0x1b5, '前提:∆µ 确实能拼成双字节 UTF-8');
  assert.equal(dec.decode(macBytes('Ôéé')).codePointAt(0), 0xf38e, '前提:Ôéé 确实能拼成私用区字符');
}

// t14 还原结果含制表符/换行/回车以外的控制字符(C0、C1)→ 不改;制表符/换行/回车照常允许
{
  const c0 = toMojibake('中文' + String.fromCharCode(1));
  assert.equal(repairMojibake(c0), c0, '还原结果含 C0 控制字符时不改');
  const c1 = toMojibake('中文' + String.fromCharCode(0x85));
  assert.equal(repairMojibake(c1), c1, '还原结果含 C1 控制字符时不改');
  const lines = ['中文', '第一行' + String.fromCharCode(9) + '列', '第二行' + String.fromCharCode(13)].join(String.fromCharCode(10));
  assert.equal(repairMojibake(toMojibake(lines)), lines, '制表符/换行/回车不妨碍还原');
}

// t15 真乱码里夹着只拼得出双字节的部分(¬∑ → ·):随整段一起还原;单独的 ¬∑ 不还原(与符号对分不开)
{
  assert.equal(repairMojibake('‚úª API error ¬∑ Retrying in 0s'), '✻ API error · Retrying in 0s');
  assert.equal(repairMojibake('¬∑'), '¬∑', '单独的双字节乱码不还原');
}

// t16 insertTextAtCaret:有 execCommand 时走原生编辑(进撤销栈),成功就不碰 setRangeText、不手动补 input;
//     返回 false / 抛错 → 回落 setRangeText + 手动 input;聚焦不了 → 不调 execCommand(免得插到别处),直接回落
{
  const mk = (execImpl, { focusable = true } = {}) => {
    const calls = { exec: [], range: 0, events: [], focus: 0 };
    const doc = { activeElement: null, execCommand(...args) { calls.exec.push(args); return execImpl(el, args[2]); } };
    const el = {
      ownerDocument: doc, value: 'abcdef', selectionStart: 1, selectionEnd: 4,
      focus() { calls.focus += 1; if (focusable) doc.activeElement = el; },
      setRangeText(text, start, end) { calls.range += 1; this.value = this.value.slice(0, start) + text + this.value.slice(end); },
      dispatchEvent(ev) { calls.events.push(ev.type); return true; },
    };
    return { el, calls };
  };
  const nativeInsert = (el, text) => { el.value = el.value.slice(0, el.selectionStart) + text + el.value.slice(el.selectionEnd); return true; };
  {
    const { el, calls } = mk(nativeInsert);
    assert.equal(insertTextAtCaret(el, 'XY'), true);
    assert.equal(el.value, 'aXYef');
    assert.deepEqual(calls.exec, [['insertText', false, 'XY']]);
    assert.equal(calls.focus, 1, '焦点不在目标上时先聚焦');
    assert.equal(calls.range, 0, '成功时不走 setRangeText');
    assert.deepEqual(calls.events, [], '成功时不手动补 input(浏览器自己派发)');
  }
  for (const impl of [() => false, () => { throw new Error('boom'); }, () => undefined]) {
    const { el, calls } = mk(impl);
    assert.equal(insertTextAtCaret(el, 'XY'), true);
    assert.equal(el.value, 'aXYef', 'execCommand 不可用时回落写法照常插入');
    assert.equal(calls.range, 1);
    assert.deepEqual(calls.events, ['input']);
  }
  {
    const { el, calls } = mk(nativeInsert, { focusable: false });
    assert.equal(insertTextAtCaret(el, 'XY'), true);
    assert.deepEqual(calls.exec, [], '焦点不在目标上就不调 execCommand');
    assert.equal(el.value, 'aXYef');
    assert.equal(calls.range, 1);
  }
}

console.log('check-mojibake-repair: all passed');
