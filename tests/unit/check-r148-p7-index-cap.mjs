#!/usr/bin/env node
// 单测:r148 P7 —— 会话索引缓存的上限不在可预见用量内触顶。
//
// 现象:画像缓存上限 4000 条,越过后按最旧淘汰。本机顶层会话文件已约 2800 个;触顶之后每次列项目
// 都会把刚淘汰的再扫回来、又挤掉别的 —— 反复淘汰重扫。
//
// 可数的量:塞进 6000 个不同会话文件的画像之后,最早那一条还在不在缓存里。
// Run: node tests/unit/check-r148-p7-index-cap.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'r148-p7-'));
process.env.CGUI_SESSION_INDEX_DIR = join(tmp, 'index');   // 不碰真实的 ~/.claude-gui
delete process.env.CGUI_SESSION_INDEX;
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').join('\n      ')}`); }
};

console.log('r148 P7 会话索引缓存上限');

const idx = await import(root + 'server/services/session-index.js');
// 键只要是"一个绝对路径";不在 ~/.claude/projects 下的不会触发落盘(本测试不写任何索引文件)
const fileOf = (i) => join(tmp, 'sessions', `s-${i}.jsonl`);

await check('塞进 6000 个会话的画像后,最早的那些仍在缓存里(原上限 4000 → 前 2000 个已被淘汰)', async () => {
  for (let i = 0; i < 6000; i += 1) idx.putEntry(fileOf(i), { n: i });
  const missing = [];
  for (const i of [0, 1, 999, 1999, 2000, 5999]) if (!idx.getRawEntry(fileOf(i))) missing.push(i);
  assert.deepEqual(missing, [], `这些序号的画像已被淘汰:${missing.join(', ')}`);
});

const src = readFileSync(root + 'server/services/session-index.js', 'utf8');
await check('上限提高了但仍是有限值(防御还在):20000 ≤ MAX_ENTRIES ≤ 200000', async () => {
  const m = src.match(/const MAX_ENTRIES = ([\d_]+)/);
  assert.ok(m, '找不到 MAX_ENTRIES 常量');
  const n = Number(m[1].replace(/_/g, ''));
  assert.ok(n >= 20000 && n <= 200000, `MAX_ENTRIES = ${n}`);
});
await check('单个项目索引文件的体积防御保留(MAX_INDEX_BYTES 仍在、仍被用来挡落盘)', async () => {
  assert.match(src, /const MAX_INDEX_BYTES = /);
  assert.ok((src.match(/MAX_INDEX_BYTES/g) || []).length >= 2, 'MAX_INDEX_BYTES 只剩定义、没有使用处');
});

try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
