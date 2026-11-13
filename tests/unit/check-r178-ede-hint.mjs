#!/usr/bin/env node
// r178:命令行内部诊断串 [ede_diagnostic] 的中文说明(client/src/utils/apiErrorActions.js 的 deriveApiErrorUi)。
// 白盒,直接 import 纯函数。
import assert from 'node:assert/strict';
import {
  deriveApiErrorUi, EDE_EMPTY_HINT, edeUnknownTypeHint, ONE_M_HINT, LOGIN_HINT, SIGNATURE_HINT,
} from '../../client/src/utils/apiErrorActions.js';

let n = 0;
const t = (name, fn) => {
  try { fn(); n++; } catch (e) { console.error(`FAIL ${name}`); throw e; }
};

const ede = (type) => `[ede_diagnostic] result_type=assistant last_content_type=${type} stop_reason=end_turn`;
const NONE = ede('none');
const REASONING = ede('reasoning');

t('none → 第一条说明', () => {
  const ui = deriveApiErrorUi(NONE);
  assert.deepEqual(ui.hints, [EDE_EMPTY_HINT]);
  assert.ok(ui.hints[0].startsWith('上游返回了内容为空的回复'));
  assert.equal(ui.action, null);
});
t('none 在末尾(无 stop_reason)也认', () => assert.deepEqual(
  deriveApiErrorUi('[ede_diagnostic] result_type=assistant last_content_type=none').hints, [EDE_EMPTY_HINT]));
t('reasoning → 第二条,含半角括号类型名', () => {
  const { hints } = deriveApiErrorUi(REASONING);
  assert.equal(hints.length, 1);
  assert.equal(hints[0], edeUnknownTypeHint('reasoning'));
  assert.ok(hints[0].includes('无法识别的内容类型(reasoning)'));
  assert.ok(!hints[0].includes('上游返回了内容为空的回复'));
});
t('带连字符 / 下划线 / 数字的类型名合规', () => assert.deepEqual(
  deriveApiErrorUi(ede('x_y-2')).hints, [edeUnknownTypeHint('x_y-2')]));
t('40 个字符合规', () => {
  const s = 'a'.repeat(40);
  assert.deepEqual(deriveApiErrorUi(ede(s)).hints, [edeUnknownTypeHint(s)]);
});

// ── 类型名不合规 → 通用说法,不含原串 ──
for (const [name, bad] of [
  ['含空格', 'foo bar'],
  ['中文', '推理内容'],
  ['尖括号', '<script>'],
  ['超过 40 个字符', 'a'.repeat(41)],
  ['空', ''],
]) {
  t(`不合规:${name}`, () => {
    const { hints } = deriveApiErrorUi(ede(bad));
    assert.deepEqual(hints, [EDE_EMPTY_HINT]);
    if (bad) assert.ok(!hints.join('\n').includes(bad));
  });
}
t('没有 last_content_type 字段 → 通用说法', () => assert.deepEqual(
  deriveApiErrorUi('[ede_diagnostic] result_type=assistant stop_reason=end_turn').hints, [EDE_EMPTY_HINT]));

// ── 不带标记不加说明 ──
t('不带标记 → 无说明', () => assert.deepEqual(
  deriveApiErrorUi('result_type=assistant last_content_type=none stop_reason=end_turn').hints, []));
t('普通报错 → 无说明', () => assert.deepEqual(deriveApiErrorUi('API Error: 500 overloaded').hints, []));

// ── 与既有三条同时命中时排在最后 ──
t('与 1M / 登录 / 签名同时命中时排最后', () => {
  const msg = [
    'API Error: 400 long context beta not available',
    'Invalid API key · Please run /login',
    'invalid signature in thinking block',
    NONE,
  ].join('\n');
  const { hints } = deriveApiErrorUi(msg);
  assert.equal(hints[hints.length - 1], EDE_EMPTY_HINT);
  assert.ok(hints.includes(ONE_M_HINT));
  assert.ok(hints.includes(SIGNATURE_HINT));
  assert.ok(hints.length >= 3);
  void LOGIN_HINT;
});
t('多行时只取本行的类型名', () => {
  const { hints } = deriveApiErrorUi(`${REASONING}\nother line`);
  assert.deepEqual(hints, [edeUnknownTypeHint('reasoning')]);
});

// ── 说明文字不含标记词 ──
t('说明文字不含 ede_diagnostic', () => {
  for (const h of [EDE_EMPTY_HINT, edeUnknownTypeHint('reasoning'), ...deriveApiErrorUi(NONE).hints, ...deriveApiErrorUi(REASONING).hints]) {
    assert.ok(!h.includes('ede_diagnostic'), h);
  }
});

console.log(`check-r178-ede-hint: ${n} passed`);
