#!/usr/bin/env node
// Q8 审查项 12(回合记录满 512 后所有发送 503 锁死,已结束记录不驱逐):
//   a. 反向:512 条【未结束】记录满额时,第 513 条必须仍被拒(活跃 turn 一条都不许驱逐)(修前应绿)
//   b. 512 条全部【已结束】(24h 内)时,新回合必须能开(驱逐最早结束的记录),而不是 503 锁死一天(修前应红)
//   c. b 成功后,被驱逐的必须是已结束记录之一(新记录在,至少一条旧的已结束记录不在了)(修前应红,随 b)
// 测法:直接 import chat.js 导出的 openTurnRecord/settleTurnRecord/findTurnRecord(模块级账本,单进程内自洽)。
// 跑法:node tests/unit/check-q8-turn-capacity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const base = join(HERE, 'q8-helpers', '.artifacts', 'turn-capacity');
fs.rmSync(base, { recursive: true, force: true });
const home = join(base, 'home');
fs.mkdirSync(join(home, '.claude-gui'), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

const chat = await import('../../server/routes/chat.js');
const report = makeReport('check-q8-turn-capacity');
const MAX = 512;
const open = (id) => chat.openTurnRecord({ key: `local|${id}`, principal: 'local', clientTurnId: id, fingerprint: 'q8' });

const records = [];
for (let i = 0; i < MAX; i += 1) {
  const r = open(`q8-${i}`);
  assert.ok(r, `第 ${i + 1} 条记录应能开`);
  records.push(r);
}

await report.check('Q8-12a', '反向:512 条记录全部未结束时,第 513 条必须被拒(活跃 turn 不驱逐)', 'green', async () => {
  assert.equal(open('q8-overflow-active'), null, '满额且全活跃时不该再开新记录');
});

for (const r of records) chat.settleTurnRecord(r, 'completed');

await report.check('Q8-12b', '512 条记录全部已结束(24h 内)时,新回合必须能开(驱逐已结束记录),不能 503 锁死到 24h 后', 'red', async () => {
  const r = open('q8-after-settled');
  assert.ok(r, '全部记录都已结束仍拒绝新回合:用户被锁死直到最老的记录满 24h');
  assert.equal(r.clientTurnId, 'q8-after-settled');
});

await report.check('Q8-12c', '新回合开成后:新记录可查到,且至少一条旧的已结束记录被驱逐', 'red', async () => {
  assert.ok(chat.findTurnRecord('local', 'q8-after-settled'), '新记录应在账本里');
  const evicted = records.filter((r) => chat.findTurnRecord('local', r.clientTurnId) !== r);
  assert.ok(evicted.length >= 1, '没有任何已结束记录被驱逐(新记录是怎么进来的?)');
});

process.exit(report.finish());
