#!/usr/bin/env node
// r31:G1【补·读期间追加】 —— repairSessionFileGuarded 的 stat 必须先于 readFile 拍基准,
// 否则「读文件期间 CLI 追加的新行」算进基准(stat 在 read 之后,读到的是追加前尺寸,
// stat 却是追加后尺寸)→ 改写前 mtime/size 比对必通过 → 用旧内容覆盖 → 丢新行,
// 备份(.bak)也是旧内容,救不回。
//
// 本用例用伪造 readFile 在「读完旧内容后立刻追加 cliLine」来确定性地模拟窗口期写入:
//   · 旧实现(先 read 后 stat):before=stat 读到追加后 size → 比对必过 → 覆盖 → 丢行;
//   · 修后(先 stat 后 read):before=stat 是追加前 size → now=stat 变大 → 判 stale → 原文件
//     逐字保留新行。两条路径的差异是唯一区分点,断言【必须 stale + 原文件含追加行】。
//
// 只读/写 /tmp 自建 jsonl,严禁触碰真实 ~/.claude/projects;跑完清干净。
// Run: node tests/unit/check-r31-repair-order.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const fsp = require('fs/promises');
const origRead = fsp.readFile.bind(fsp);
const origStat = fsp.stat.bind(fsp);

const L = (obj) => JSON.stringify(obj);
const DIR = mkdtempSync(join(tmpdir(), 'r31-g1-'));
const file = join(DIR, 's.jsonl');

const fixture = () => [
  L({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: [{ type: 'text', text: 'q' }] } }),
  L({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'text', text: '' }] } }), // 待修空行
  L({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: [{ type: 'text', text: 'follow' }] } }),
].join('\n') + '\n';
const cliLine = L({ type: 'user', uuid: 'u9', parentUuid: 'u2', message: { content: [{ type: 'text', text: '窗口期新消息' }] } }) + '\n';

let failure = null;
try {
  writeFileSync(file, fixture());
  const beforeRaw = readFileSync(file, 'utf8');

  // 伪装 readFile:读完【旧内容】后立即追加 cliLine,再把旧内容原样返回 —— 精确模拟
  // CLI 在 repair 读取文件期间追加了一行,而 raw 里没有它。
  fsp.readFile = async (p, ...rest) => {
    const content = await origRead(p, ...rest);
    if (p === file) appendFileSync(file, cliLine);
    return content;
  };

  const { repairSessionFileGuarded } = await import('../../server/routes/sessions.js');
  const out = await repairSessionFileGuarded(file, () => false);

  // 修前红:旧实现返回 ok 且覆盖掉 cliLine(丢新行);修后必须判 stale 且原文件逐字保留追加行。
  assert.equal(out.status, 'stale',
    `修前红:读期间追加必须判 stale(实际 ${out.status} —— 旧实现先 read 后 stat,比对必过而覆盖,丢新行)`);
  const afterRaw = readFileSync(file, 'utf8');
  assert.ok(afterRaw.includes('窗口期新消息'), '修前红:原文件必须保留读期间追加的新行(旧实现覆盖丢弃)');
  assert.ok(afterRaw.startsWith(beforeRaw), '原文件以原内容开头(追加行在尾部)');
} catch (e) {
  failure = e;
} finally {
  fsp.readFile = origRead;
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
}
if (failure) throw failure;
console.log('PASS check-r31-repair-order');
