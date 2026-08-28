#!/usr/bin/env node
// r64-genui【错误路径 重点】§5.1 非法 JSON / §5.7 超大围栏。
// 场景:流式期围栏永远是半截的,所以"半截"必须是正常状态而不是错误;定稿后修不好才报错,
// 且报错时原始代码块必须留着(总原则②:永不让用户对着空白发呆)。
// 硬断言:空围栏体(每个围栏开头必经的 1-2 帧)绝不能显示字面量 undefined。
// Run: node tests/acceptance/r64-genui/t08-parse-errors.mjs
import assert from 'node:assert/strict';
import { genui } from './lib.mjs';
import { parse, t, done } from './lib.mjs';

await genui(); // 未实现时整个文件只报一次"缺少交付物",而不是每条用例各报一遍

const STREAM = { finalized: false };
const FINAL = { finalized: true };

// ── 流式期 ───────────────────────────────────────────────────────────────
await t('流式期半截 JSON:已写完的组件先渲染出来,不提示错误', async () => {
  const r = await parse('{"items":[{"type":"text","content":"第一段"},{"type":"tex', STREAM);
  assert.equal(r.ok, true, '已完成的组件前缀应当渲染(§5.1)');
  assert.equal(r.root.items[0].content, '第一段');
  assert.equal(r.notice, null, '用户还在看模型打字,不得弹错误提示');
});

await t('流式期一个组件都没写完:显示原始代码块,不提示错误', async () => {
  const r = await parse('{"items":[{"typ', STREAM);
  assert.equal(r.ok, false, '没有任何完整组件时保留代码块');
  assert.equal(r.notice, null, '流式期不显示任何错误提示');
});

await t('流式期只写了半个左括号:不报错、不崩', async () => {
  for (const body of ['{', '{"', '{"items"', '{"items":', '{"items":[', '{"items":[{']) {
    const r = await parse(body, STREAM);
    assert.equal(r.ok, false, body + ' 不该渲染出组件');
    assert.equal(r.notice, null, body + ' 不该报错');
  }
});

await t('流式期标点级小错:静默修复后渲染,不提示', async () => {
  const r = await parse('{"items":[{"type":"text","content":"a"},]', STREAM);
  assert.equal(r.ok, true);
  assert.equal(r.notice, null);
});

// ── 已定稿:能修的静默修 ─────────────────────────────────────────────────
const REPAIRABLE = [
  ['尾随逗号', '{"items":[{"type":"text","content":"a"},]}'],
  ['缺右方括号与右花括号', '{"items":[{"type":"text","content":"a"}'],
  ['缺最外层右花括号', '{"items":[{"type":"text","content":"a"}]'],
  ['对象内尾随逗号', '{"items":[{"type":"text","content":"a",}]}'],
];
for (const [why, body] of REPAIRABLE) {
  await t('已定稿可修复:静默修好后渲染,不提示(' + why + ')', async () => {
    const r = await parse(body, FINAL);
    assert.equal(r.ok, true, why + ' 应能补全后渲染,实际 notice=' + r.notice);
    assert.equal(r.root.items[0].content, 'a');
    assert.equal(r.notice, null, '补全成功不该给用户看错误条');
  });
}

// ── 已定稿:修不好 → 原始代码块 + 红条 ────────────────────────────────────
const UNREPAIRABLE = [
  ['纯中文散文', '这不是一段 JSON,只是模型写岔了'],
  ['键名没引号且乱', '{items: [type text}}}]'],
  ['只有右括号', '}]}'],
  ['写成了 HTML 而不是 JSON', '<div>hello</div>'],
  ['裸词 undefined', 'undefined'],
];
// 注:'{"items":[]}{"items":[]}'(两个根对象拼一起)故意不测 —— 修复器可以只取第一段,
// 结果落到 §5.2 的"空块"分支而不是红条,契约没钉死哪种,写断言就是过度规定。
for (const [why, body] of UNREPAIRABLE) {
  await t('已定稿修不好:保留原始代码块 + 红色说明条(' + why + ')', async () => {
    const r = await parse(body, FINAL);
    assert.equal(r.ok, false, '修不好就不能渲染');
    assert.equal(r.root, null);
    assert.equal(typeof r.notice, 'string', '必须给一条说明条,不能让用户对着代码块猜');
    assert.ok(r.notice.includes('cgui-ui 围栏 JSON 解析失败'), '文案实际:' + r.notice);
    assert.ok(/字符\s*\d+\s*附近/.test(r.notice), '说明条要指出出错位置,实际:' + r.notice);
    assert.ok(r.notice.includes('围栏保持为代码块'), '文案实际:' + r.notice);
  });
}

// ── 空围栏体:必经的 1-2 帧,绝不能出现 undefined ─────────────────────────
for (const [why, body] of [['空串', ''], ['只有空格', '   '], ['只有换行', '\n\n'], ['空格+换行+制表', ' \n\t ']]) {
  await t('空围栏体:渲染空代码块,不报错、不显示红条(' + why + ')', async () => {
    for (const opts of [STREAM, FINAL]) {
      const r = await parse(body, opts);
      assert.equal(r.ok, false, why + ' 不该渲染出组件树');
      assert.equal(r.root, null);
      assert.equal(r.notice, null, why + ' 不得报错,实际 notice=' + JSON.stringify(r.notice));
      assert.equal(r.ignored, 0);
    }
  });
}

await t('【硬断言】空围栏体的任何输出里都不得出现字面量 undefined', async () => {
  for (const body of ['', '  ', '\n']) {
    for (const opts of [STREAM, FINAL]) {
      const r = await parse(body, opts);
      for (const [k, v] of Object.entries(r)) {
        assert.notEqual(v, 'undefined', `结果字段 ${k} 是字符串 "undefined"`);
        assert.ok(!(typeof v === 'string' && v.includes('undefined')),
          `结果字段 ${k} 里混进了 undefined:${v}`);
      }
    }
  }
});

// ── 合法 JSON 但根不对(§1.2 末 / §5.1 末两行)────────────────────────────
for (const [why, body] of [['数组', '[1,2]'], ['空数组', '[]'], ['字符串', '"abc"'],
  ['数字', '42'], ['null', 'null'], ['布尔', 'true'],
  ['对象但没有 items 也不是组件', '{"foo":1}'],
  ['items 不是数组', '{"items":"a,b"}'],
  ['items 是数字', '{"items":42}']]) {
  await t('根不合法 → 原始代码块 + 红条(' + why + ')', async () => {
    const r = await parse(body, FINAL);
    assert.equal(r.ok, false, why + ' 应走"无法修复"分支');
    assert.equal(typeof r.notice, 'string', why + ' 应给红条,实际 notice=' + JSON.stringify(r.notice));
    assert.ok(r.notice.includes('cgui-ui 围栏 JSON 解析失败'), '文案实际:' + r.notice);
  });
}

// ── 超大围栏(§5.7)──────────────────────────────────────────────────────
const bodyOfBytes = (bytes) => {
  const head = '{"items":[{"type":"text","content":"';
  const tail = '"}]}';
  return head + 'a'.repeat(bytes - head.length - tail.length) + tail;
};

await t('围栏原文恰好 128 KB:正常渲染(边界内)', async () => {
  const body = bodyOfBytes(128 * 1024);
  assert.equal(Buffer.byteLength(body), 128 * 1024);
  const r = await parse(body, FINAL);
  assert.equal(r.ok, true, '恰好 128 KB 不该被拒,notice=' + r.notice);
});

await t('围栏原文 129 KB:不进渲染,显示原始代码块 + "界面规格过大"说明', async () => {
  const body = bodyOfBytes(129 * 1024);
  const r = await parse(body, FINAL);
  assert.equal(r.ok, false, '超 128 KB 必须退回代码块');
  assert.equal(r.root, null);
  assert.equal(typeof r.notice, 'string');
  assert.ok(r.notice.includes('界面规格过大'), '文案实际:' + r.notice);
  assert.ok(r.notice.includes('已按代码块显示'), '文案实际:' + r.notice);
  assert.ok(/\d+\s*KB/.test(r.notice), '说明条要报出实际体积,实际:' + r.notice);
});

await t('超大判定按字节算:10 万个中文(约 300 KB)也要被拦', async () => {
  const body = '{"items":[{"type":"text","content":"' + '中'.repeat(100000) + '"}]}';
  assert.ok(body.length < 128 * 1024, '本例字符数不到 128K,只有按字节算才会超限');
  const r = await parse(body, FINAL);
  assert.equal(r.ok, false, '按字节应超 128 KB(§1.3 写的是字节数)');
  assert.ok(String(r.notice).includes('界面规格过大'), '文案实际:' + r.notice);
});

await t('流式期越过 128 KB:当场转代码块,不等定稿', async () => {
  const r = await parse(bodyOfBytes(200 * 1024), STREAM);
  assert.equal(r.ok, false, '流式期超限也要立刻转代码块(§5.7)');
  assert.ok(String(r.notice).includes('界面规格过大'), '文案实际:' + r.notice);
});

await t('超大围栏不得卡顿:1 MB 原文 1 秒内返回', async () => {
  const t0 = Date.now();
  await parse(bodyOfBytes(1024 * 1024), FINAL);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, '超限应先量体积再决定要不要解析,耗时 ' + ms + 'ms');
});

await t('【反向】同一份坏 JSON 反复解析结果一致(不累计、不留状态)', async () => {
  const body = '这不是 JSON';
  const a = await parse(body, FINAL);
  const b = await parse(body, FINAL);
  assert.equal(a.ok, b.ok);
  assert.equal(a.notice, b.notice);
});

done('t08 解析错误与超大围栏');
