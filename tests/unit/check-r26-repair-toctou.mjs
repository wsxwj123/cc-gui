#!/usr/bin/env node
// 单测:r26-G1 repair TOCTOU 双闸(写前复查 + mtime/size 双判)。
// 根因:入口 409 检查到 rename 落盘之间有窗口,期间 CLI 追加的新行被 repair 后的
// 文件覆盖丢失。修法见 sessions.js repairSessionFileGuarded 头部注释。
// 样本全部 /tmp 自建 jsonl,严禁触碰真实 ~/.claude/projects。
// 变异哨兵(实际验证过红):
//   S1 删闸二(mtime/size 比对)→ t2 红
//   S2 删闸一(checkRunning 复查)→ t3 红
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairSessionFileGuarded } from '../../server/routes/sessions.js';

const L = (obj) => JSON.stringify(obj);
const DIR = mkdtempSync(join(tmpdir(), 'r26-g1-'));
const baks = (file) => readdirSync(DIR).filter((n) => n.startsWith(file.split('/').pop() + '.bak-'));

const fixture = () => [
  L({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: [{ type: 'text', text: 'q' }] } }),
  L({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'text', text: '' }] } }), // 待修空行
  L({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: [{ type: 'text', text: 'follow' }] } }),
].join('\n') + '\n';

// t1 正常路径:repair 成功 + .bak 生成(原文逐字)+ 原文件已修复
{
  const file = join(DIR, 's1.jsonl');
  writeFileSync(file, fixture());
  const before = readFileSync(file, 'utf8');
  const out = await repairSessionFileGuarded(file, () => false);
  assert.equal(out.status, 'ok', 't1: 正常路径 ok');
  assert.equal(out.changed, true, 't1: changed');
  const after = readFileSync(file, 'utf8');
  assert.ok(!after.includes('"a1"'), 't1: 空行已被删');
  assert.ok(after.includes('"u2"'), 't1: 其余行保留');
  const b = baks(file);
  assert.equal(b.length, 1, 't1: 生成一份 .bak');
  assert.equal(readFileSync(join(DIR, b[0]), 'utf8'), before, 't1: .bak 是原文逐字');
  rmSync(file, { force: true }); for (const x of b) rmSync(join(DIR, x), { force: true });
}

// t2 TOCTOU 哨兵:「写前复查」后目标文件被追加(模拟 CLI 窗口期写入)→ stale,
//    原文件内容逐字 = 原文 + 追加行(repair 没覆盖),.bak 留着
{
  const file = join(DIR, 's2.jsonl');
  writeFileSync(file, fixture());
  const before = readFileSync(file, 'utf8');
  const cliLine = L({ type: 'user', uuid: 'u9', parentUuid: 'u2', message: { content: [{ type: 'text', text: '窗口期新消息' }] } }) + '\n';
  const out = await repairSessionFileGuarded(file, () => {
    appendFileSync(file, cliLine); // checkRunning 回调=「写前复查」时点,在此注入窗口期写入
    return false;
  });
  assert.equal(out.status, 'stale', 't2: 窗口期写入必须检出 stale(409)');
  assert.equal(readFileSync(file, 'utf8'), before + cliLine,
    't2: 原文件逐字 = 原文 + CLI 新行,repair 没覆盖(丢行根治)');
  assert.equal(baks(file).length, 1, 't2: .bak 留着(按 PLAN 口径)');
  rmSync(file, { force: true }); for (const x of baks(file)) rmSync(join(DIR, x), { force: true });
}

// t3 闸一哨兵:窗口期内会话又跑起来了 → running,文件不动、不产生 .bak
{
  const file = join(DIR, 's3.jsonl');
  writeFileSync(file, fixture());
  const before = readFileSync(file, 'utf8');
  const out = await repairSessionFileGuarded(file, () => true);
  assert.equal(out.status, 'running', 't3: 写前复查命中在跑 → running');
  assert.equal(readFileSync(file, 'utf8'), before, 't3: 文件逐字未动');
  assert.equal(baks(file).length, 0, 't3: 不产生 .bak');
  rmSync(file, { force: true });
}

// t4 无可修内容:不备份不写盘(既有语义保留)
{
  const file = join(DIR, 's4.jsonl');
  const clean = L({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: [{ type: 'text', text: 'ok' }] } }) + '\n';
  writeFileSync(file, clean);
  const out = await repairSessionFileGuarded(file, () => { throw new Error('不该被调用'); });
  assert.equal(out.status, 'ok', 't4: 无可修 → ok');
  assert.equal(out.changed, false, 't4: 无可修 → changed:false(checkRunning 不被调用)');
  assert.equal(readFileSync(file, 'utf8'), clean, 't4: 文件不动');
  assert.equal(baks(file).length, 0, 't4: 无 .bak');
  rmSync(file, { force: true });
}

rmSync(DIR, { recursive: true, force: true });
console.log('PASS r26-g1-repair-toctou');
