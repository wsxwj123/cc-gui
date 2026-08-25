#!/usr/bin/env node
// r49a-④【守卫测试】:tests/unit 里凡改写 process.env.HOME 的,必须同时改写
// process.env.USERPROFILE。根因:os.homedir() 在 POSIX 读 $HOME、在 Windows 读
// %USERPROFILE% —— 只设 HOME 的测试在 Windows 上沙箱不生效,直接读写用户真实
// ~/.claude / ~/.claude-gui(污染真实配置,红线)。
// 计数式而非存在式:同一文件里"开头设、末尾还原"是两次改写,USERPROFILE 的改写
// (赋值或 delete)次数必须跟上,否则会出现"两个都设、只还原 HOME"的半吊子隔离。
// 变异:任一被测文件删掉 USERPROFILE 那行 → 本测试红。
// Run: node tests/unit/check-r49-test-home-isolation.mjs
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

const selfPath = fileURLToPath(import.meta.url);
const self = basename(selfPath);   // 本文件的哨兵字符串含被查形态,自查会假红
const unitDir = dirname(selfPath);
const HOME_WRITE = /process\.env\.HOME\s*=/g;
const PROFILE_WRITE = /(?:delete\s+process\.env\.USERPROFILE|process\.env\.USERPROFILE\s*=)/g;

const offenders = [];
for (const name of readdirSync(unitDir).filter((f) => f.endsWith('.mjs') && f !== self).sort()) {
  const src = readFileSync(join(unitDir, name), 'utf8');
  const homeWrites = (src.match(HOME_WRITE) || []).length;
  if (!homeWrites) continue;
  const profileWrites = (src.match(PROFILE_WRITE) || []).length;
  if (profileWrites < homeWrites) offenders.push(`${name}(HOME×${homeWrites} / USERPROFILE×${profileWrites})`);
}

assert.deepEqual(offenders, [],
  `设 HOME 未同设 USERPROFILE 的测试(Windows 上会写进真实 ~/.claude*):\n  ${offenders.join('\n  ')}`);

// 自测哨兵:判据本身必须能抓到形态,否则上面的空数组是假绿。
const probe = 'process.env.HOME = home;\nprocess.env.USERPROFILE = home;\nprocess.env.HOME = REAL_HOME;\n';
assert.equal((probe.match(HOME_WRITE) || []).length, 2, '哨兵:HOME 改写计数');
assert.equal((probe.match(PROFILE_WRITE) || []).length, 1, '哨兵:USERPROFILE 改写计数(还原缺失可检出)');

console.log('✓ check-r49-test-home-isolation: tests/unit 全部 HOME 沙箱同时覆盖 USERPROFILE');
