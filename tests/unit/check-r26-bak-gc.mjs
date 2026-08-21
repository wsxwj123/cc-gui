#!/usr/bin/env node
// 单测:r26-G10 repair 备份 .bak-<ts> GC(保留最新 BAK_KEEP=5 份)。
// 根因:每次 repair 产一份 .bak-<ts>,只增不减。修法:修复成功后按名内时间戳降序
// 保留最新 5 份,其余 unlink(失败静默)。
// 样本全部 /tmp 自建,严禁触碰真实 ~/.claude/projects。
// 变异哨兵(实际验证过红):S1 slice(BAK_KEEP) 改成 slice(0)(全保留不删)→ t1 红。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gcRepairBackups, BAK_KEEP, repairSessionFileGuarded } from '../../server/routes/sessions.js';

const L = (obj) => JSON.stringify(obj);
const DIR = mkdtempSync(join(tmpdir(), 'r26-g10-'));
const NOW = Date.now();

// t1 时间戳最大者存活哨兵:预置 7 份 bak → 剩 5 份最新
{
  const file = join(DIR, 'gc1.jsonl');
  writeFileSync(file, L({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: [{ type: 'text', text: 'x' }] } }));
  const names = [];
  for (let i = 0; i < 7; i++) {
    const n = `gc1.jsonl.bak-${NOW - i * 1000}`; // i 越小越新
    writeFileSync(join(DIR, n), 'backup');
    names.push(n);
  }
  await gcRepairBackups(file);
  const left = readdirSync(DIR).filter((n) => n.startsWith('gc1.jsonl.bak-'));
  assert.equal(left.length, BAK_KEEP, 't1: 7 份收敛到 5 份');
  for (const n of names.slice(0, 5)) assert.ok(left.includes(n), `t1: 最新的 ${n} 存活`);
  for (const n of names.slice(5)) assert.ok(!left.includes(n), `t1: 最旧的 ${n} 已删`);
  assert.equal(BAK_KEEP, 5, 't1: BAK_KEEP 常量钉死为 5');
}

// t2 不足 5 份不删
{
  const file = join(DIR, 'gc2.jsonl');
  writeFileSync(file, 'x');
  for (let i = 0; i < 3; i++) writeFileSync(join(DIR, `gc2.jsonl.bak-${NOW - i * 1000}`), 'b');
  await gcRepairBackups(file);
  assert.equal(readdirSync(DIR).filter((n) => n.startsWith('gc2.jsonl.bak-')).length, 3,
    't2: 不足 5 份原样保留');
}

// t3 不误伤:无时间戳的 .jsonl.bak(trim/strip-thinking 通道)与他会话的 bak 不动;
//    畸形后缀(非纯数字)不删
{
  const file = join(DIR, 'gc3.jsonl');
  writeFileSync(file, 'x');
  writeFileSync(join(DIR, 'gc3.jsonl.bak'), 'trim-channel');            // 无 ts,别碰
  writeFileSync(join(DIR, 'gc3.jsonl.bak-notats'), 'junk');              // 畸形后缀,别碰
  writeFileSync(join(DIR, 'other.jsonl.bak-1'), 'other-session');        // 他会话,别碰
  for (let i = 0; i < 7; i++) writeFileSync(join(DIR, `gc3.jsonl.bak-${NOW - i * 1000}`), 'b');
  await gcRepairBackups(file);
  const all = readdirSync(DIR);
  assert.ok(all.includes('gc3.jsonl.bak'), 't3: 无时间戳 .bak 不动');
  assert.ok(all.includes('gc3.jsonl.bak-notats'), 't3: 畸形后缀不动');
  assert.ok(all.includes('other.jsonl.bak-1'), 't3: 他会话备份不动');
  assert.equal(all.filter((n) => /^gc3\.jsonl\.bak-\d+$/.test(n)).length, 5, 't3: 只 GC 同会话带 ts 的');
}

// t4 集成:repair 成功路径自动 GC;目录不存在/文件不存在静默不抛
{
  const file = join(DIR, 'gc4.jsonl');
  const raw = [
    L({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: [{ type: 'text', text: 'q' }] } }),
    L({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'text', text: '' }] } }),
  ].join('\n') + '\n';
  writeFileSync(file, raw);
  for (let i = 0; i < 6; i++) writeFileSync(join(DIR, `gc4.jsonl.bak-${NOW - i * 1000}`), 'b');
  const out = await repairSessionFileGuarded(file, () => false);
  assert.equal(out.status, 'ok', 't4: 修复成功');
  const left = readdirSync(DIR).filter((n) => /^gc4\.jsonl\.bak-\d+$/.test(n));
  assert.equal(left.length, BAK_KEEP, 't4: 修复后(含本次新产的一份)收敛到 5 份');
  await assert.doesNotReject(gcRepairBackups(join(DIR, 'nonexistent-dir-深/xx.jsonl')),
    't4: 目录不存在静默不抛');
}

rmSync(DIR, { recursive: true, force: true });
console.log('PASS r26-g10-bak-gc');
