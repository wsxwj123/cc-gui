#!/usr/bin/env node
// 单测:r26-G10 的「repair 备份 .bak-<ts> GC(留最新 5 份)」已随 r209 卡点 1(用户选 B)退役 ——
// 体检与清理不再另写 `<sid>.jsonl.bak-<时刻>`(它与调用方先写的 `.histbak-<时刻>-<令牌>` 内容相同,纯属冗余),
// gcRepairBackups / BAK_KEEP 随之删除;会话目录里早先留下的 `.bak-<时刻>` 改由 r209 的保留规则
// (14 天、每会话 3 份,server/services/history-backup-retention.js)清理。本文件改为锁住退役后的行为:
//   t1 sessions.js 不再导出 gcRepairBackups / BAK_KEEP;
//   t2 repair 成功:不新增 `.bak-<ts>`;已有的 `.bak-<ts>`、`.jsonl.bak`、他会话的备份一份不动(repair 自己不再收敛);
//   t3 无可修内容 / 会话在跑 / 窗口期写入(stale):同样不产生 `.bak-<ts>`。
// 样本全部 /tmp 自建,严禁触碰真实 ~/.claude/projects。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sessions from '../../server/routes/sessions.js';

const { repairSessionFileGuarded } = sessions;
const L = (obj) => JSON.stringify(obj);
const DIR = mkdtempSync(join(tmpdir(), 'r26-g10-'));
const NOW = Date.now();
const repairable = () => [
  L({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: [{ type: 'text', text: 'q' }] } }),
  L({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: [{ type: 'text', text: '' }] } }), // 待修空行
].join('\n') + '\n';
const bakTsOf = (base) => readdirSync(DIR).filter((n) => n.startsWith(`${base}.bak-`)).sort();

// t1 退役的导出不在了
assert.equal('gcRepairBackups' in sessions, false, 't1: gcRepairBackups 已删除');
assert.equal('BAK_KEEP' in sessions, false, 't1: BAK_KEEP 已删除');

// t2 repair 成功:不新增 .bak-<ts>,已有的一份不动
{
  const file = join(DIR, 'gc4.jsonl');
  writeFileSync(file, repairable());
  const pre = [];
  for (let i = 0; i < 6; i++) {
    const n = `gc4.jsonl.bak-${NOW - i * 1000}`;
    writeFileSync(join(DIR, n), 'b');
    pre.push(n);
  }
  writeFileSync(join(DIR, 'gc4.jsonl.bak'), 'trim-channel');
  writeFileSync(join(DIR, 'other.jsonl.bak-1'), 'other-session');
  const out = await repairSessionFileGuarded(file, () => false);
  assert.equal(out.status, 'ok', 't2: 修复成功');
  assert.equal(out.changed, true, 't2: changed');
  assert.deepEqual(bakTsOf('gc4.jsonl'), [...pre].sort(), 't2: 不新增 .bak-<ts>,已有的 6 份一份不动');
  const all = readdirSync(DIR);
  assert.ok(all.includes('gc4.jsonl.bak'), 't2: .jsonl.bak 不动');
  assert.ok(all.includes('other.jsonl.bak-1'), 't2: 他会话的备份不动');
}

// t3 其余三种返回同样不产生 .bak-<ts>
{
  const cases = [
    ['clean', L({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: [{ type: 'text', text: 'ok' }] } }) + '\n', () => false, 'ok'],
    ['running', repairable(), () => true, 'running'],
    ['stale', repairable(), (file) => { appendFileSync(file, L({ type: 'user', uuid: 'u9', parentUuid: 'a1', message: { content: 'late' } }) + '\n'); return false; }, 'stale'],
  ];
  for (const [name, content, check, want] of cases) {
    const file = join(DIR, `${name}.jsonl`);
    writeFileSync(file, content);
    const out = await repairSessionFileGuarded(file, () => check(file));
    assert.equal(out.status, want, `t3 ${name}: status`);
    assert.deepEqual(bakTsOf(`${name}.jsonl`), [], `t3 ${name}: 不产生 .bak-<ts>`);
  }
}

rmSync(DIR, { recursive: true, force: true });
console.log('PASS r26-g10-bak-gc(已退役,锁住 r209 选 B 之后的行为)');
