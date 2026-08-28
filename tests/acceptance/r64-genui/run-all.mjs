#!/usr/bin/env node
// r64-genui 验收测试总入口(只含【纯逻辑】用例,零依赖,不需要浏览器)。
// 功能没实现时整片红是预期:会明确报"缺少交付物:genui 纯逻辑契约模块"。
// Run:      node tests/acceptance/r64-genui/run-all.mjs
// 单文件:   node tests/acceptance/r64-genui/t04-identifiers.mjs
// 换模块位置:GENUI_TEST_MODULE=/abs/path/to/contract.mjs node tests/acceptance/r64-genui/run-all.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here).filter((f) => /^t\d+-.*\.mjs$/.test(f)).sort();
const bad = [];
for (const f of files) {
  console.log('\n=== ' + f + ' ===');
  const r = spawnSync(process.execPath, [path.join(here, f)], { stdio: 'inherit', timeout: 600000 });
  if (r.status !== 0) bad.push(f);
}
console.log('\n========================================');
console.log(`共 ${files.length} 个测试文件,失败 ${bad.length} 个${bad.length ? ':' + bad.join(', ') : ''}`);
process.exit(bad.length ? 1 : 0);
