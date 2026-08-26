#!/usr/bin/env node
// r62【单测】:更新长流保活心跳 + 断流自动续看对账。
// 事故:原生/npm 更新都真成功了(版本已到位),面板仍红字「更新失败:Load failed」。
// 根因在连接不在更新 —— WKWebView(NSURLSession)约 60s **无活动**就掐断请求,而原生
// 安装器下大包时长时间零输出,流被内核断掉 → reader.read() 抛 TypeError "Load failed"。
// 验收点:
//   ①/stream 与 /attach 在【静默期】都会持续吐 ping 帧(≥1 帧)——删心跳则红;
//   ②前端 catch 先自动改走 attach 续看(有 3 次上限),连不上才认输报错 —— 改回直接
//     setResult(ok:false) 则红;
//   ③attach 流没给终态帧(更新已完成退出)→ 走既有 /status 对账链路拿结论。
// 端口 6703;隔离 HOME;绝不 spawn 任何更新(任务标 running → 两个通道都走纯续看分支)。
// Run: node tests/unit/check-r62-update-stream.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTmpHome, cleanupDirs, listenWithRetry, stopServer, sleep } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('r62'); // version-check 顶层固化 PREFS_FILE,先隔离 HOME

let server = null;
try {
  const vc = await import('../../server/routes/version-check.js');
  const { updateTask, heartbeat, startStreamHeartbeat } = vc;
  assert.equal(typeof startStreamHeartbeat, 'function', 'r62: 心跳助手应导出');
  assert.ok(heartbeat && heartbeat.ms <= 30000, 'r62: 心跳间隔必须远小于 WKWebView 约 60s 的无活动上限');

  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api', vc.default);
  server = await listenWithRetry(6703, (port) => app.listen(port, '127.0.0.1'));
  const BASE = 'http://127.0.0.1:6703';

  // 假的「长时间静默的更新进程」:任务标 running + 零日志 —— /stream 与 /attach 都走
  // 纯续看分支(绝不 spawn),挂住连接后一个字节都不写,正是原生安装器下大包时的形态。
  // 间隔缩到 30ms 才在单测里等得起(线上 15s)。
  heartbeat.ms = 30;
  updateTask.status = 'running';
  updateTask.cmd = 'fake-silent-update';
  updateTask.log = [];
  updateTask.child = null;
  updateTask.listeners.clear();

  // 静默窗口里读流,数 ping。无心跳时 read() 永不返回 → 用超时兜底,否则变异成挂死不是红。
  const pingsInSilence = async (path) => {
    const ctrl = new AbortController();
    const r = await fetch(`${BASE}/api/claude-update/${path}`, { method: 'POST', signal: ctrl.signal });
    assert.equal(r.status, 200, `r62: ${path} 应 200`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let pings = 0;
    while (pings < 2) {
      const chunk = await Promise.race([reader.read(), sleep(1500).then(() => 'timeout')]);
      if (chunk === 'timeout' || chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const ln of lines) {
        if (!ln.trim()) continue;
        let ev; try { ev = JSON.parse(ln); } catch { assert.fail(`r62: 非法帧 ${ln}`); }
        if (ev.type === 'ping') pings += 1;
      }
    }
    try { ctrl.abort(); } catch {}
    updateTask.listeners.clear();
    return pings;
  };

  assert.ok(await pingsInSilence('stream') >= 1, 'r62: /stream 静默期必须出 ping 帧(否则 60s 后被内核掐断 → 假失败)');
  assert.ok(await pingsInSilence('attach') >= 1, 'r62: /attach 静默期同样必须出 ping 帧(续看通道一样会被掐)');

  // 心跳只是加帧:既有终态帧形态一字不改(前端 done 分支照常消化)。
  heartbeat.ms = 15000;
  updateTask.status = 'done'; updateTask.code = 0; updateTask.error = '';
  {
    const body = await (await fetch(`${BASE}/api/claude-update/attach`, { method: 'POST' })).text();
    const frames = body.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(frames.find((f) => f.type === 'done' && f.code === 0), 'r62: 终态帧不受心跳影响(r26-C9 语义)');
  }
  updateTask.status = 'idle'; updateTask.cmd = ''; updateTask.log = [];

  // ── 前端源码钉 ─────────────────────────────────────────────────────────
  const ui = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
  const fn = ui.slice(ui.indexOf('const doUpdateStream'), ui.indexOf('const doUpdateCancel'));
  assert.ok(fn.length > 200, 'r62: 没切到 doUpdateStream 函数体');
  const catchBody = fn.slice(fn.indexOf('} catch (e) {'));
  const attachIdx = catchBody.indexOf('doUpdateStream({ attach: true })');
  const failIdx = catchBody.indexOf('setResult({ ok: false');
  assert.ok(attachIdx > 0, 'r62: 断流 catch 必须先自动改走 attach 续看,不能直接报 Load failed');
  assert.ok(failIdx > attachIdx, 'r62: 认输报错只能排在续看重试之后');
  assert.match(ui, /UPDATE_STREAM_MAX_RECONNECT = 3/, 'r62: 自动续看上限 = 3 次');
  assert.match(catchBody, /reconnectRef\.current < UPDATE_STREAM_MAX_RECONNECT/, 'r62: 重连必须受上限门控(防死循环)');
  assert.match(fn, /attach && !sawFinal[\s\S]{0,240}applyUpdateStatus/, 'r62: attach 无终态帧 → 复用既有 /status 对账链路');
  assert.match(ui, /applyUpdateStatus\(d\)/, 'r62: 挂载对账也走同一个落点(别各写一份结论展示)');
} finally {
  await stopServer(server);
  cleanupDirs(TMP_HOME);
}

console.log('PASS check-r62-update-stream');
