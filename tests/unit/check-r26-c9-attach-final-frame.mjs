#!/usr/bin/env node
// r26-C9【单测】:attach 竞态补终态帧。
// 背景:/claude-update/attach 在 status!=='running' 时直接 res.end() 空流 ——
// 任务恰在 GET /status 与 POST /attach 之间结束时,前端 attach 拿到空流,
// 用户永远看不到 done/error 结论。
// 验收点(PLAN C9):任务 status='done' 时 POST /attach → 响应体含 "type":"done"
// 且 code 正确(竞态结论哨兵);前端 doUpdateStream 的 done 分支零改动消化(源码钉)。
// 补充钉:error 态补 error 字段;idle 态不出帧(没有结论可补,防误报)。
// Run: node tests/unit/check-r26-c9-attach-final-frame.mjs
import assert from 'node:assert/strict';
import { makeTmpHome, cleanupDirs, listenWithRetry, stopServer } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('c9-unit'); // version-check 顶层固化 PREFS_FILE,先隔离 HOME

let server = null;
try {
  const vc = await import('../../server/routes/version-check.js');
  const { updateTask } = vc;
  assert.ok(updateTask && typeof updateTask === 'object', 'C9: updateTask 应导出(单测置态用)');

  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api', vc.default);
  server = await listenWithRetry(6704, (port) => app.listen(port, '127.0.0.1'));
  const BASE = 'http://127.0.0.1:6704';
  const attach = async () => {
    const r = await fetch(`${BASE}/api/claude-update/attach`, { method: 'POST' });
    assert.equal(r.status, 200, 'C9: attach 应 200');
    return await r.text();
  };

  // ①done 态 → 补终态帧(竞态结论哨兵)
  updateTask.status = 'done'; updateTask.code = 0; updateTask.error = '';
  {
    const body = await attach();
    const frames = body.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const done = frames.find((f) => f.type === 'done');
    assert.ok(done, 'C9: done 态 attach 必须补 type:done 帧(修复前空流,用户看不到结论)');
    assert.equal(done.code, 0, 'C9: 终态帧 code 必须正确');
    assert.equal(done.status, 'done', 'C9: 终态帧带 status');
  }

  // ②error 态 → 帧带 error 文案(前端 done 分支按 code!==0 显示失败)
  updateTask.status = 'error'; updateTask.code = 1; updateTask.error = '更新进程退出码 1(详见上方日志)';
  {
    const body = await attach();
    const frames = body.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const done = frames.find((f) => f.type === 'done');
    assert.ok(done, 'C9: error 态 attach 同样补终态帧');
    assert.equal(done.code, 1, 'C9: error 态 code 如实');
    assert.match(done.error, /退出码 1/, 'C9: error 文案随帧下发');
  }

  // ③idle 态 → 不出帧(从未跑过,没有结论可补;出帧会让前端误报「退出码 null」)
  updateTask.status = 'idle'; updateTask.code = null; updateTask.error = '';
  {
    const body = await attach();
    assert.equal(body.trim(), '', 'C9: idle 态 attach 保持空流(无结论可补,防误报)');
  }

  // ④前端钉:doUpdateStream 的 done 分支消化 attach 形态(零改动复用)
  const { readFileSync } = await import('node:fs');
  const ui = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
  assert.match(ui, /ev\.type === 'done'/, 'C9: 前端流消费有 done 分支(attach 终态帧自动复用)');
  assert.match(ui, /ev\.code === 0\s*\?\s*\{ ok: true, done: true \}/, 'C9: done 分支按 code 分成功/失败');
} finally {
  await stopServer(server);
  cleanupDirs(TMP_HOME);
}

console.log('PASS check-r26-c9-attach-final-frame');
