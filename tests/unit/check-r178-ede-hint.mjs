#!/usr/bin/env node
// r178:命令行内部诊断串 [ede_diagnostic] 的中文说明(client/src/utils/apiErrorActions.js 的 deriveApiErrorUi)。
// 只解释取样验证过的形态:[ede_diagnostic] + result_type=assistant + last_content_type 字段;其余不加说明。
// 白盒,直接 import 纯函数。
import assert from 'node:assert/strict';
import {
  deriveApiErrorUi, EDE_EMPTY_HINT, EDE_UNKNOWN_HINT, edeUnknownTypeHint, ONE_M_HINT, LOGIN_HINT, SIGNATURE_HINT,
} from '../../client/src/utils/apiErrorActions.js';

let n = 0;
const t = (name, fn) => {
  try { fn(); n++; } catch (e) { console.error(`FAIL ${name}`); throw e; }
};

const PREFIX = '[ede_diagnostic] result_type=assistant last_content_type=';
const ede = (type) => `${PREFIX}${type} stop_reason=end_turn`;
const NONE = ede('none');
const REASONING = ede('reasoning');

// ── 已验证形态 ──
t('none → 第一条说明', () => {
  const ui = deriveApiErrorUi(NONE);
  assert.deepEqual(ui.hints, [EDE_EMPTY_HINT]);
  assert.ok(ui.hints[0].startsWith('上游返回了内容为空的回复'));
  assert.equal(ui.action, null);
});
t('none 在末尾(无 stop_reason)也认', () => assert.deepEqual(
  deriveApiErrorUi(`${PREFIX}none`).hints, [EDE_EMPTY_HINT]));
t('reasoning → 第二条,含半角括号类型名', () => {
  const { hints } = deriveApiErrorUi(REASONING);
  assert.deepEqual(hints, [edeUnknownTypeHint('reasoning')]);
  assert.ok(hints[0].includes('无法识别的内容类型(reasoning)'));
  assert.ok(!hints[0].includes('上游返回了内容为空的回复'));
});
t('带连字符 / 下划线 / 数字的类型名合规', () => assert.deepEqual(
  deriveApiErrorUi(ede('x_y-2')).hints, [edeUnknownTypeHint('x_y-2')]));
t('40 个字符合规', () => {
  const s = 'a'.repeat(40);
  assert.deepEqual(deriveApiErrorUi(ede(s)).hints, [edeUnknownTypeHint(s)]);
});
t('类型名在行尾且合规 → 第二条', () => assert.deepEqual(
  deriveApiErrorUi(PREFIX + 'reasoning').hints, [edeUnknownTypeHint('reasoning')]));
t('多行时只取本行的类型名', () => assert.deepEqual(
  deriveApiErrorUi(`${REASONING}\nother line`).hints, [edeUnknownTypeHint('reasoning')]));

// ── 有字段但类型名不合规 / 被截断 → 不带类型名的说明,不含原串 ──
for (const [name, bad] of [
  ['含空格', 'foo bar'],
  ['中文', '推理内容'],
  ['尖括号', '<script>'],
  ['超过 40 个字符', 'a'.repeat(41)],
  ['空', ''],
  ['前有空白', ' reasoning'],
]) {
  t(`不合规:${name}`, () => {
    const { hints } = deriveApiErrorUi(ede(bad));
    assert.deepEqual(hints, [EDE_UNKNOWN_HINT]);
    if (bad.trim()) assert.ok(!hints.join('\n').includes(bad.trim()));
  });
}
t('被截断(超出窗口)→ 不带类型名的说明', () => {
  const s = 'a'.repeat(200);
  const { hints } = deriveApiErrorUi(PREFIX + s);
  assert.deepEqual(hints, [EDE_UNKNOWN_HINT]);
  assert.ok(!hints[0].includes('aaaa'));
});

// ── 超长 / 外部可控输入:限定窗口,不出现平方级回溯 ──
const timed = (msg) => {
  const t0 = performance.now();
  const ui = deriveApiErrorUi(msg);
  return { ui, ms: performance.now() - t0 };
};
t('10 万空格 + 10 万个 a:200 毫秒内返回,不带类型名的说明', () => {
  const { ui, ms } = timed(PREFIX + ' '.repeat(100000) + 'a'.repeat(100000));
  assert.ok(ms < 200, `用时 ${ms.toFixed(1)}ms`);
  assert.deepEqual(ui.hints, [EDE_UNKNOWN_HINT]);
  assert.ok(!ui.hints[0].includes('aaaa'));
});
t('20 万组「空格 + a」:200 毫秒内返回,不带类型名的说明', () => {
  const { ui, ms } = timed(PREFIX + ' a'.repeat(200000));
  assert.ok(ms < 200, `用时 ${ms.toFixed(1)}ms`);
  assert.deepEqual(ui.hints, [EDE_UNKNOWN_HINT]);
});

// ── 未验证形态不加说明 ──
t('没有 last_content_type 字段 → 不加说明', () => assert.deepEqual(
  deriveApiErrorUi('[ede_diagnostic] result_type=assistant stop_reason=end_turn').hints, []));
t('result_type 不是 assistant → 不加说明', () => assert.deepEqual(
  deriveApiErrorUi('[ede_diagnostic] result_type=user last_content_type=none').hints, []));
t('result_type=assistantX(后面不是空白或结尾)→ 不加说明', () => assert.deepEqual(
  deriveApiErrorUi('[ede_diagnostic] result_type=assistantX last_content_type=none').hints, []));
t('只有 [ede_diagnostic] → 不加说明', () => assert.deepEqual(deriveApiErrorUi('[ede_diagnostic]').hints, []));
t('不带标记 → 不加说明', () => assert.deepEqual(
  deriveApiErrorUi('result_type=assistant last_content_type=none stop_reason=end_turn').hints, []));
t('普通报错 → 不加说明', () => assert.deepEqual(deriveApiErrorUi('API Error: 500 overloaded').hints, []));

// ── 与既有三条同时命中时排第四 ──
t('1M / 官方未登录 / 签名 三条都命中,ede 说明排第四', () => {
  const msg = [
    'API Error: 400 long context beta not available',
    'Not logged in · Please run /login',
    'invalid signature in thinking block',
    NONE,
  ].join('\n');
  assert.deepEqual(deriveApiErrorUi(msg).hints, [ONE_M_HINT, LOGIN_HINT, SIGNATURE_HINT, EDE_EMPTY_HINT]);
});

// ── 说明文字不含标记词 ──
t('说明文字不含 ede_diagnostic', () => {
  for (const h of [EDE_EMPTY_HINT, EDE_UNKNOWN_HINT, edeUnknownTypeHint('reasoning')]) {
    assert.ok(!h.includes('ede_diagnostic'), h);
  }
});

console.log(`check-r178-ede-hint: ${n} passed`);
