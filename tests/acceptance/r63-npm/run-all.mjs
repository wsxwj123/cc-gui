#!/usr/bin/env node
// r63-npm 验收测试总入口。功能没实现时整片红是预期(缺交付物会明确报"缺少交付物:<路径>")。
// Run: node tests/acceptance/r63-npm/run-all.mjs
// 只跑一个文件:node tests/acceptance/r63-npm/t09-install-happy.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here).filter((f) => /^t\d+-.*\.mjs$/.test(f)).sort();
const bad = [];
for (const f of files) {
  console.log('\n=== ' + f + ' ===');
  const r = spawnSync(process.execPath, [path.join(here, f)], { stdio: 'inherit', timeout: 900000 });
  if (r.status !== 0) bad.push(f);
}
console.log('\n========================================');
console.log(`共 ${files.length} 个测试文件,失败 ${bad.length} 个${bad.length ? ':' + bad.join(', ') : ''}`);
process.exit(bad.length ? 1 : 0);
