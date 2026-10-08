#!/usr/bin/env node
// 单测:r147 K3 —— 权限类卡片的窗口级 Enter 快捷键,不得抢走"焦点所在按钮"自己的 Enter。
//
// 现象:工具权限卡 / 计划卡 / 越界卡 / 拒答卡 / MCP 表单卡都在 window 上挂 keydown:Enter = 肯定动作
// (允许 / 按计划执行 / 授权目录 / 换模型重试 / 提交表单),只跳过可编辑目标,不跳过按钮,且先
// preventDefault 掉了按钮自身的激活。用户 Tab 到「拒绝」按 Enter → 执行的是「允许」;选了「始终允许」时
// 还会写入永久规则。界面层复现见 tests/acceptance/r147-keys(K3 两条)。
//
// 双层:
//   ① 逻辑层:共用判定 isActivatableTarget(client/src/utils/escAction.js,与 isEditableTarget 同处)真跑;
//   ② 源码锚:五张卡的窗口级 onKey 在执行 Enter 的肯定动作之前先过它。
//      提问卡(AskQuestionCard)不在任务书范围内,不锁(见 r147 报告)。
// Run: node tests/unit/check-r147-key-targets.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').join('\n      ')}`); }
};

console.log('r147 K3 焦点在按钮上按 Enter 由按钮自己响应');

// ── ① 逻辑层 ──────────────────────────────────────────────
let isActivatableTarget = null;
await check('escAction.js 导出 isActivatableTarget', async () => {
  const mod = await import(root + 'client/src/utils/escAction.js');
  isActivatableTarget = mod.isActivatableTarget;
  assert.equal(typeof isActivatableTarget, 'function');
});

const el = (tagName, role = null) => ({ tagName, getAttribute: (n) => (n === 'role' ? role : null) });
await check('按钮 / 链接 / [role=button] 算"会自己响应 Enter 的控件"', async () => {
  assert.ok(isActivatableTarget, '函数不存在');
  assert.equal(isActivatableTarget(el('BUTTON')), true, 'BUTTON');
  assert.equal(isActivatableTarget(el('button')), true, '小写标签名');
  assert.equal(isActivatableTarget(el('A')), true, 'A');
  assert.equal(isActivatableTarget(el('DIV', 'button')), true, 'div[role=button]');
  assert.equal(isActivatableTarget(el('SPAN', 'button')), true, 'span[role=button]');
});
await check('其它目标不算(body / 普通 div / 输入框交给 isEditableTarget);空值与轻量对象不抛错', async () => {
  assert.ok(isActivatableTarget, '函数不存在');
  assert.equal(isActivatableTarget(el('BODY')), false, 'BODY');
  assert.equal(isActivatableTarget(el('DIV')), false, '普通 DIV');
  assert.equal(isActivatableTarget(el('DIV', 'dialog')), false, 'role=dialog');
  assert.equal(isActivatableTarget(el('INPUT')), false, 'INPUT 归 isEditableTarget 管');
  assert.equal(isActivatableTarget(null), false);
  assert.equal(isActivatableTarget(undefined), false);
  assert.equal(isActivatableTarget({ tagName: 'DIV' }), false, '没有 getAttribute 的轻量对象');
});

// ── ② 源码锚 ──────────────────────────────────────────────
function balancedFrom(src, openIdx) {
  assert.equal(src[openIdx], '{', 'balancedFrom 起点必须是 {');
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i += 1;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; }
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  throw new Error('括号不配对');
}
const pp = read('client/src/components/PermissionPrompt.jsx');
/** 某张卡组件里窗口级键盘监听 onKey 的函数体。 */
function cardOnKey(card) {
  const f = pp.indexOf(`function ${card}(`);
  assert.ok(f >= 0, `PermissionPrompt.jsx 里找不到 ${card}`);
  const next = pp.indexOf('\nfunction ', f + 10);
  const k = pp.indexOf('const onKey = (e) =>', f);
  assert.ok(k >= 0 && (next < 0 || k < next), `${card} 里找不到窗口级 onKey`);
  return balancedFrom(pp, pp.indexOf('{', pp.indexOf('=>', k)));
}

const CARDS = [
  { card: 'PermissionCard', what: '工具权限卡(Enter = 允许 / 允许并记住)', action: 'doAllow()' },
  { card: 'PlanReviewCard', what: '计划卡(Enter = 按计划执行)', action: 'onApprove(req)' },
  { card: 'BoundaryCard', what: '越界卡(Enter = 授权此目录)', action: 'onAuthorizeDir(req, permanent)' },
  { card: 'RefusalDialogCard', what: '拒答卡(Enter = 换备用模型重试)', action: "onChoose(req, 'retry_fallback')" },
  { card: 'ElicitCard', what: 'MCP 表单卡(Enter = 提交表单)', action: 'submit()' },
];
for (const c of CARDS) {
  await check(`${c.what}:目标是按钮 / 链接 / [role=button] 时窗口级 Enter 不接管`, async () => {
    const body = cardOnKey(c.card);
    const a = body.indexOf(c.action);
    assert.ok(a >= 0, `onKey 里找不到 Enter 的肯定动作 ${c.action}:\n${body.slice(0, 300)}`);
    const g = body.indexOf('isActivatableTarget(');
    assert.ok(g >= 0, `缺按钮让行:onKey 没有调用 isActivatableTarget(焦点在「拒绝」等按钮上按 Enter 会执行 ${c.action})\n      onKey:${body.replace(/\s+/g, ' ').slice(0, 240)}`);
    assert.ok(g < a, `让行判定在肯定动作之后(isActivatableTarget 应先于 ${c.action})`);
    // Esc 的语义不变:焦点在按钮上按 Esc 仍是卡片的"拒绝 / 取消"(按钮自己不响应 Esc)
    assert.ok(body.includes("'Escape'"), 'onKey 的 Esc 分支不应被删掉');
  });
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
