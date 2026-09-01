#!/usr/bin/env node
// r26-C6【单测】:prefs.js 导出共享写函数 updatePrefs(mutator)。
// 验收点(PLAN C6):
//   ①并发 Promise.all([updatePrefs(写A键), updatePrefs(写B键)]) → 最终 prefs.json 两键俱在
//     (lost-update 哨兵:绕队列的裸 read-merge-write 必丢一路,本用例钉住串行化);
//   ②updatePrefs 内 mutator 抛错 → 队列不断链,下一次写仍成功;
//   ③导出签名逐字按 PLAN:updatePrefs(mutator),函数存在且为 async 函数。
// Run: node tests/unit/check-r26-c6-update-prefs.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpHome, cleanupDirs } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('c6-unit'); // prefs.js 顶层固化 PREFS_PATH,先隔离 HOME

try {
  const { updatePrefs } = await import('../../server/routes/prefs.js');

  // ③签名钉:导出存在、名为 updatePrefs、单参 mutator、async
  assert.equal(typeof updatePrefs, 'function', 'C6: prefs.js 应导出 updatePrefs');
  assert.equal(updatePrefs.name, 'updatePrefs', 'C6: 导出名逐字 updatePrefs(PLAN C-C6 契约)');
  assert.equal(updatePrefs.length, 1, 'C6: 签名 updatePrefs(mutator) 单参');
  assert.equal(updatePrefs.constructor.name, 'AsyncFunction', 'C6: updatePrefs 应为 async');

  // ①lost-update 哨兵:两路并发写不同键,最终两键俱在
  await Promise.all([
    updatePrefs((p) => { p.sentinelKeyA = 'A'; }),
    updatePrefs((p) => { p.sentinelKeyB = 'B'; }),
  ]);
  let raw = JSON.parse(readFileSync(join(TMP_HOME, '.claude-gui', 'prefs.json'), 'utf8'));
  assert.equal(raw.sentinelKeyA, 'A', 'C6: 并发写后 A 键必须在(lost-update 哨兵)');
  assert.equal(raw.sentinelKeyB, 'B', 'C6: 并发写后 B 键必须在(lost-update 哨兵)');

  // 更高压:10 路并发各写一键 + 各读改既有计数,全部存活
  await updatePrefs((p) => { p.counter = 0; });
  await Promise.all(Array.from({ length: 10 }, (_, i) => updatePrefs((p) => {
    p[`lane${i}`] = i;
    p.counter = (p.counter || 0) + 1; // read-merge-write 计数:串行化则恒到 10
  })));
  raw = JSON.parse(readFileSync(join(TMP_HOME, '.claude-gui', 'prefs.json'), 'utf8'));
  assert.equal(raw.counter, 10, `C6: 10 路 read-merge-write 计数应为 10(丢更新则 <10),实际 ${raw.counter}`);
  for (let i = 0; i < 10; i++) assert.equal(raw[`lane${i}`], i, `C6: lane${i} 键丢失`);

  // ②断链哨兵:mutator 抛错 → 错误抛回调用方,但队列不断,下一次写仍成功
  await assert.rejects(
    updatePrefs((p) => { p.shouldNotPersist = true; throw new Error('mutator boom'); }),
    /mutator boom/,
    'C6: mutator 抛错应原样抛回调用方',
  );
  await updatePrefs((p) => { p.afterThrow = 'ok'; });
  raw = JSON.parse(readFileSync(join(TMP_HOME, '.claude-gui', 'prefs.json'), 'utf8'));
  assert.equal(raw.afterThrow, 'ok', 'C6: mutator 抛错后队列必须不断链,后续写仍成功');
  assert.equal(raw.shouldNotPersist, undefined, 'C6: 抛错的 mutator 不得落盘(整段任务失败不写)');

  // 与既有 PUT 路由同队列:并发 updatePrefs + PUT hidden-projects 互不覆盖
  // (经路由层再验一次共享队列语义 —— updatePrefs 与 withPrefsQueue 是同一条链)
  const express = (await import('express')).default;
  const prefsRouter = (await import('../../server/routes/prefs.js')).default;
  const { stopServer } = await import('../acceptance/r26/lib.mjs');
  const app = express();
  app.use(express.json());
  app.use('/api', prefsRouter);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const BASE = `http://127.0.0.1:${server.address().port}`;
    await Promise.all([
      updatePrefs((p) => { p.routeRaceKey = 'from-updatePrefs'; }),
      fetch(`${BASE}/api/prefs/hidden-projects`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: ['h1'] }),
      }),
    ]);
    raw = JSON.parse(readFileSync(join(TMP_HOME, '.claude-gui', 'prefs.json'), 'utf8'));
    assert.equal(raw.routeRaceKey, 'from-updatePrefs', 'C6: 与路由 PUT 并发后 updatePrefs 的键必须在(同队列哨兵)');
    assert.deepEqual(raw.hiddenProjects, ['h1'], 'C6: 与 updatePrefs 并发后路由 PUT 的键必须在(同队列哨兵)');
  } finally {
    await stopServer(server);
  }
} finally {
  cleanupDirs(TMP_HOME);
}

console.log('PASS check-r26-c6-update-prefs');
