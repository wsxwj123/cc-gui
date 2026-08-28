#!/usr/bin/env node
// 哨兵(PLAN §2.0.2):验收测试的 contract.mjs 用**裸 node** import 这些 .ts 模块,
// 上游有两处 TS 专有语法在 strip-only 下直接炸(参数属性 / 值导入一个 interface),
// 已按 CGUI-PATCH 修掉。日后谁重新同步上游把补丁丢了,这里立刻红——
// 而不是等验收时才发现 contract.mjs 整个加载失败。
// 注:裸 node 加载不了 .tsx(ERR_UNKNOWN_FILE_EXTENSION,与语法无关),
// 所以往 contract.mjs 加函数前先确认它不在 .tsx 里。
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = join(root, 'client/src/genui/upstream');

// 前 4 个 = 契约模块;第 5 个不在契约路径上,但它带着第 3 个 CGUI-PATCH,一并盯住
const MODULES = ['safe-math.ts', 'guard.ts', 'parse-partial.ts', 'fence-repair.ts', 'blocks/diagram/layout.ts'];

const mods = {};
for (const rel of MODULES) {
  const url = new URL(`file://${join(base, rel)}`);
  let m;
  try {
    m = await import(url.href);
  } catch (e) {
    assert.fail(`裸 node 加载 ${rel} 失败(CGUI-PATCH 是不是被上游同步冲掉了?): ${e.code ?? ''} ${e.message}`);
  }
  mods[rel] = m;
}

// 契约的 4 个纯函数必须真的在(模块能加载 ≠ 导出还在)
assert.equal(typeof mods['safe-math.ts'].compileMathExpr, 'function');
assert.equal(typeof mods['guard.ts'].repairGenuiSpec, 'function');
assert.equal(typeof mods['parse-partial.ts'].parsePartialGenuiSpec, 'function');
assert.equal(typeof mods['fence-repair.ts'].repairFenceJson, 'function');
assert.equal(typeof mods['blocks/diagram/layout.ts'].resolveLayout, 'function');

// 补丁改的是类型层,行为必须零变化:两处参数属性各走一条真实路径
assert.equal(mods['safe-math.ts'].compileMathExpr('x*2')(3), 6, 'SafeMathParser 的 src 字段要真的赋上了');
assert.equal(mods['safe-math.ts'].compileMathExpr('a*x', { vars: { a: 4 } })(2), 8, 'vars 字段同上');
assert.equal(mods['safe-math.ts'].compileMathExpr('constructor'), null, 'ParseError 抛得出来(未知标识符)');

console.log('✅ genui 契约模块裸 node 可加载(5 个模块 / 3 个 CGUI-PATCH 全在)');
