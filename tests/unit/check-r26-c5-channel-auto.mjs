#!/usr/bin/env node
// r26-C5【单测】:渠道可恢复「跟随安装方式」。
// 背景:PUT /claude-update-channel 原只接受 UPDATE_CHANNELS 成员,String(null||'') → 400,
// UI 一旦显式选过就永远回不去「跟随」。
// 验收点(PLAN C5):
//   ①writeUpdateChannel(null) 后 readUpdateChannel() === null 且 prefs.json 中无
//     updateChannel 键(删除而非写 null 哨兵);
//   ②非法值 'ftp' 仍 false;
//   ③路由级:PUT {channel:null} / {channel:'auto'} → {ok:true, channel:null} 且键被删;
//     PUT {channel:'ftp'} → 400;PUT {channel:'npm'} → 200 且键写入(回归);
//   ④前端哨兵:渠道选择器含「跟随安装方式(推荐)」选项,pickChannel 携带 null 发出。
// Run: node tests/unit/check-r26-c5-channel-auto.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpHome, cleanupDirs, listenWithRetry, stopServer } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('c5-unit'); // version-check/prefs 顶层固化 prefs 路径,先隔离 HOME

try {
  const vc = await import('../../server/routes/version-check.js');
  const { writeUpdateChannel, readUpdateChannel } = vc;

  // 先写入一个显式渠道,再清 —— 覆盖「选过之后切回跟随」的完整链路
  assert.equal(await writeUpdateChannel('npm'), true, 'C5: 显式写入 npm 应成功');
  assert.equal(await readUpdateChannel(), 'npm', 'C5: 写入后能读回 npm');

  // ①writeUpdateChannel(null) → 删除语义
  assert.equal(await writeUpdateChannel(null), true, 'C5: writeUpdateChannel(null) 应成功(清除语义)');
  assert.equal(await readUpdateChannel(), null, 'C5: 清除后 readUpdateChannel 必须回 null(跟随)');
  let raw = JSON.parse(readFileSync(join(TMP_HOME, '.claude-gui', 'prefs.json'), 'utf8'));
  assert.ok(!('updateChannel' in raw), 'C5: 必须是删除键而非写 null(prefs.json 不留 updateChannel)');

  // ②非法值仍拒
  assert.equal(await writeUpdateChannel('ftp'), false, 'C5: 非法渠道 ftp 必须拒绝(false)');
  raw = JSON.parse(readFileSync(join(TMP_HOME, '.claude-gui', 'prefs.json'), 'utf8'));
  assert.ok(!('updateChannel' in raw), 'C5: 非法值不得产生写副作用');

  // ③路由级(6703,跑完关闭)
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api', vc.default);
  const server = await listenWithRetry(6703, (port) => app.listen(port, '127.0.0.1'));
  const BASE = 'http://127.0.0.1:6703';
  const put = (body) => fetch(`${BASE}/api/claude-update-channel`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    // 回归:正常渠道仍可用
    let r = await put({ channel: 'native' });
    assert.equal(r.status, 200, 'C5: PUT native 应 200');
    assert.equal((await r.json()).channel, 'native');
    assert.equal(await readUpdateChannel(), 'native', 'C5: 路由写入后读回 native');

    // null → 清除
    r = await put({ channel: null });
    assert.equal(r.status, 200, 'C5: PUT channel:null 应 200(原来 400 永远回不去跟随)');
    assert.deepEqual(await r.json(), { ok: true, channel: null }, 'C5: 响应契约 { ok:true, channel:null }');
    assert.equal(await readUpdateChannel(), null, 'C5: PUT null 后读回 null');
    raw = JSON.parse(readFileSync(join(TMP_HOME, '.claude-gui', 'prefs.json'), 'utf8'));
    assert.ok(!('updateChannel' in raw), 'C5: PUT null 后 prefs.json 无 updateChannel 键');

    // 'auto' → 同清除语义
    await put({ channel: 'npm' });
    r = await put({ channel: 'auto' });
    assert.equal(r.status, 200, 'C5: PUT channel:auto 应 200(归一为清除语义)');
    assert.equal(await readUpdateChannel(), null, 'C5: PUT auto 后读回 null');

    // 非法值 400
    r = await put({ channel: 'ftp' });
    assert.equal(r.status, 400, 'C5: PUT channel:ftp 必须仍 400');
  } finally {
    await stopServer(server);
  }

  // ④前端哨兵:跟随选项 + 显式选中态 + null 透传
  const ui = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
  assert.match(ui, /跟随安装方式\(推荐\)/, 'C5: 渠道选择器必须含「跟随安装方式(推荐)」选项');
  assert.match(ui, /\{ id: null, label: '跟随安装方式\(推荐\)' \}/, 'C5: 跟随选项映射 null');
  assert.match(ui, /channelExplicit === c\.id/, 'C5: 选中态按显式选择画(跟随是真实可选状态)');
  assert.match(ui, /body: JSON\.stringify\(\{ channel: ch \}\)/, 'C5: pickChannel 原样透传(含 null)');
} finally {
  cleanupDirs(TMP_HOME);
}

console.log('PASS check-r26-c5-channel-auto');
