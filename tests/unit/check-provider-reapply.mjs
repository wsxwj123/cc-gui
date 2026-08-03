#!/usr/bin/env node
// 自定义 provider 改默认模型/档位映射后立刻生效(#13)。
// 修前:改模型有两条路径,只有 PUT /provider-overrides/:id 会重跑 switch;
// 编辑表单走的 PUT /custom-providers/:id 只调 syncActiveProviderSnapshot,
// 而它只在"当前 model 已不在 models[] 内"时才写 settings.json —— 只改 defaultModel 零写入。
// CLI 只认 settings.json 的 env(ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL),
// 于是用户保存后毫无反应。
// node tests/unit/check-provider-reapply.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import router from '../../server/routes/settings.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'server/routes/settings.js'), 'utf8');
const count = (s, sub) => s.split(sub).length - 1;
const layers = router.stack.filter((l) => l.route);
const has = (path, method) => layers.some((l) => l.route.path === path && l.route.methods?.[method]);

// ── 1. 真 import:reapplyIfActive 靠 router.stack 找 switch 路由,路由必须真的在 ──
// (改了路径名 = reapply 静默变空操作,这条断言就是防这个)
assert.ok(has('/provider/switch', 'post'), 'POST /provider/switch 必须存在——reapplyIfActive 按这个路径在 router.stack 里找它');
{ // reapply 直接取 layer.route.stack[0].handle 调用,这个形状必须是个函数(express 换版会变)
  const sw = layers.find((l) => l.route.path === '/provider/switch');
  assert.equal(typeof sw.route.stack[0].handle, 'function', 'switch 处理函数取法(route.stack[0].handle)必须有效');
}
assert.ok(has('/custom-providers/:id', 'put'), 'PUT /custom-providers/:id 必须存在');
assert.ok(has('/provider-overrides/:id', 'put'), 'PUT /provider-overrides/:id 必须存在');

// ── 2. 两条改模型路径共用同一个 reapply(定义 1 处、调用 2 处)────────
assert.equal(count(src, 'async function reapplyIfActive('), 1, 'reapplyIfActive 只该定义一次');
assert.equal(count(src, 'await reapplyIfActive('), 2, '两条改模型路径(custom-providers / provider-overrides)都要调 reapplyIfActive');

// ── 3. 清空 override 也要 reapply ────────────────────────────────
// 原来的条件是 `activeId === id && Object.keys(entry).length`:清空档位映射时不重跑 switch,
// 旧映射就一直留在 settings.json 里。整个条件已并进 reapplyIfActive(只判激活)。
assert.ok(!/activeId === id/.test(src), 'reapply 不得再带 `activeId === id && entry 非空` 的旧条件(清空 override 同样要生效)');
// map[id] 的增删仍按 entry 是否为空,这条不能被误删
assert.ok(/if \(Object\.keys\(entry\)\.length\) map\[id\] = entry;/.test(src), '空 entry 仍应删除 override 条目');

// ── 4. reapply 不得把模型覆盖成 models[] 外的值 ───────────────────
// 重跑 switch 时不传 model → switch 用 provider 自己的 defaultModel(已校验在 models[] 内),
// 拿不到就回落 models[0]。传了 model 就有写出列表外模型的风险。
{
  const fn = src.slice(src.indexOf('async function reapplyIfActive('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
  assert.ok(/body: \{ id \}/.test(body), 'reapply 重跑 switch 时只传 id,不传 model');
  assert.ok(!/body: \{ id, model/.test(body), 'reapply 不得指定 model');
}

// ── 5. 不碰 PUT /api/settings 的补丁/全文两种语义 ───────────────────
assert.equal(count(src, 'export function computeUpdatedSettings('), 1, 'computeUpdatedSettings 仍是唯一实现(补丁/全文语义不得被本改动波及)');

console.log('✓ check-provider-reapply: 两条改模型路径共用 reapply + 路由存在性全过');
