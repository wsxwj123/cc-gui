#!/usr/bin/env node
// 模型下拉行:tier 徽章与选中勾互斥 + 空 tier 不渲染(#14)。
// 修前:SessionSelectors.jsx:514 / App.jsx:8019 的 <span>{m.tier}</span> 无条件渲染,
// 勾追加其后 → 选中行显示 [Sonnet] ✓;m.tier 推不出来时(gpt-5.6-terra 之类)是个空灰药丸,
// 用户看成"莫名标记"。两处渲染同一份 availableModels,必须一起改(桌面下拉 + 手机 MobileModelPage)。
// 纯 JSX 无法真 import,用源码守卫。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sel = readFileSync(join(root, 'client/src/components/SessionSelectors.jsx'), 'utf8');
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

// ── 1. 选中判据抽成常量,不再原地重复 ─────────────────────────
// 批P 起判据前可带外部模型名守卫(!foreign &&,官方端点下的第三方残留行不给勾),
// 表达式本体不变、仍是唯一一处常量。见 check-model-residue-guard.mjs。
assert.ok(/const isSelected = [^;]*currentModel === m\.id \|\| currentModel === `\$\{m\.id\}\[1m\]`[^;]*;/.test(sel),
  'SessionSelectors:availableModels 行内必须有 const isSelected 常量');
// 桌面:availableModels 组 2 处内联判据 → 1 处常量;customRows/fetchedRows(各 2 处)按方案不动。
assert.ok(count(sel, 'currentModel === `${m.id}[1m]`') <= 5,
  '选中判据表达式不得再膨胀(availableModels 组已消重,应 ≤5)');

// ── 2. tier 徽章不再无条件渲染(两处渲染点都要有条件)────────────
for (const [name, src, cond] of [
  ['SessionSelectors.jsx', sel, '{m.tier && !isSelected && ('],
  ['App.jsx(MobileModelPage)', app, '{m.tier && !active && ('],
]) {
  assert.equal(count(src, cond), 1, `${name}:tier 徽章必须带「非空 且 未选中」条件,且只有一处`);
  // 每个 {m.tier} 渲染点前面 200 字符内必须有 `m.tier && !` 门控 —— 无条件渲染直接判失败
  for (let i = src.indexOf('>{m.tier}<'); i >= 0; i = src.indexOf('>{m.tier}<', i + 1)) {
    assert.ok(/m\.tier && !/.test(src.slice(Math.max(0, i - 200), i)),
      `${name}:第 ${src.slice(0, i).split('\n').length} 行的 {m.tier} 徽章无「非空+未选中」门控`);
  }
}

// ── 3. 勾用同一个常量(不是又写一遍长表达式)────────────────────
assert.ok(sel.includes('{isSelected && <Check'), 'SessionSelectors:勾必须用 isSelected');
assert.ok(app.includes('{active && <Check size={16}'), 'App.jsx:勾必须用 active');

console.log('✓ check-model-row-badge: tier 徽章互斥 + 空 tier 守卫(两处渲染点)全过');
