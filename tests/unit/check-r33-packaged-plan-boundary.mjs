#!/usr/bin/env node
// 共享纯规则(ExitPlanMode 的计划折叠/批准判定)住在仓库根的 server/utils/plan.js。
// 两个方向都会炸,本文件把两边都钉死:
//   · server → client/src:安装包只带 client/dist,后端启动即 ERR_MODULE_NOT_FOUND。
//     此前只 grep session-reader.js 一个文件,任何别的 server 模块反向导入都漏检 → 改成遍历 server/**/*.js。
//   · client → server(现行方向,正确):跨出 vite root,dev 走 /@fs/ 需要 fs.allow 放行,
//     否则 403 断模块图 = `npm run dev` 白屏(生产 build 不经这道门,只在 dev 现形)。
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url);
const tauri = JSON.parse(await readFile(new URL('src-tauri/tauri.conf.json', root), 'utf8'));
const resources = tauri?.bundle?.resources || [];

assert.ok(resources.includes('../server'), 'Tauri bundle must include the server source tree');
assert.ok(!resources.includes('../client/src'), 'Tauri bundle intentionally ships client/dist, not client/src');

// ── 1. server/**/*.js 零跨界 import ────────────────────────────────────────
// 只看 import/export 语句里的模块说明符(静态 + 动态),注释里提 client/src 是合法的
// 交叉引用注释(server 里现有 5 处),不该红。
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*(?:import|export)\s+)(['"])([^'"]+)\1/gm;

async function jsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) out.push(...await jsFiles(child));
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) out.push(child);
  }
  return out;
}

const serverDir = new URL('server/', root);
const files = await jsFiles(serverDir);
assert.ok(files.length > 40, `server 树应被完整遍历到(实得 ${files.length} 个 js 文件)`);

const offenders = [];
for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const [, , specifier] of source.matchAll(IMPORT_SPECIFIER)) {
    if (/(?:^|\/)client\/src\//.test(specifier)) {
      offenders.push(`${file.pathname.split('/server/').pop()} → ${specifier}`);
    }
  }
}
assert.deepEqual(offenders, [],
  `packaged server modules must not import client/src(安装包里没有该目录):\n${offenders.join('\n')}`);

// 共享模块确实在 server 侧、且被 client wrapper 复用(方向没被反过来"修")。
const clientPlan = await readFile(new URL('client/src/utils/plan.js', root), 'utf8');
assert.match(clientPlan, /from\s+'\.\.\/\.\.\/\.\.\/server\/utils\/plan\.js'/,
  'client wrapper 必须复用 server/utils/plan.js,不得各造一份规则');

// ── 2. vite dev 必须放行被跨根 import 的那个目录,否则 403 白屏;但只放行它 ──────
// 放行范围收窄到 ../server/utils(不是整个仓库根 '..'):后者会让 dev 下 /@fs 可读
// CLAUDE.local.md / LEARNINGS.md / .devflow 等敏感文件。client/src/utils/plan.js 的
// import 落在 ../server/utils 内,足够;这条断言同时挡"放太宽"和"没放"两个方向。
const viteConfig = await readFile(new URL('client/vite.config.js', root), 'utf8');
const serverBlock = viteConfig.slice(viteConfig.indexOf('server: {'));
assert.ok(viteConfig.includes('server: {'), 'vite.config.js 必须有 server 配置块');
const allowMatch = serverBlock.match(/fs\s*:\s*\{[^}]*allow\s*:\s*\[([^\]]*)\]/);
assert.ok(allowMatch, 'vite dev server 必须配置 fs.allow(否则跨根 import 走 /@fs/ 被 403 = 白屏)');
const allowEntries = [...allowMatch[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
assert.deepEqual(allowEntries, ['../server/utils'],
  "fs.allow 必须恰好放行 ../server/utils —— 既覆盖共享模块 import,又不把整个仓库根暴露给 dev /@fs");
// 被 import 的文件确实落在放行目录内(否则 dev 仍 403)。
assert.match(clientPlan, /server\/utils\/plan\.js/, '共享 import 必须落在 ../server/utils 放行范围内');

console.log('✓ check-r33-packaged-plan-boundary: server 树零跨界 import(全量遍历)+ vite dev 精确放行 ../server/utils');
