#!/usr/bin/env node
// r177:命令行开口前切走再切回 —— ①最初那次发送让位(不再另接一条连接);②没有快照的重接收到
// 服务端 replay_complete 后升级成种回档。直接 import 真实纯函数,另用源码文字核对接线位置。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldYieldOrphanSend, shouldUpgradeReattachOnReplayComplete } from '../../client/src/utils/reattach.js';

// ① 让位判据:三条任一成立就让位
{
  const ok = { paneOnOwner: true, switchCountAtSend: 2, switchCountNow: 2, isCurrentTurn: true };
  assert.equal(shouldYieldOrphanSend(ok), false, '没切走、仍是当前这一代流:照常认领');
  assert.equal(shouldYieldOrphanSend({ ...ok, paneOnOwner: false }), true, '窗格已切走(r140 原判据)');
  assert.equal(shouldYieldOrphanSend({ ...ok, switchCountNow: 4 }), true, '切走又切回(计数变了):让位');
  assert.equal(shouldYieldOrphanSend({ ...ok, isCurrentTurn: false }), true, '已不是当前这一代流:让位');
  assert.equal(shouldYieldOrphanSend({ ...ok, paneOnOwner: false, switchCountNow: 3, isCurrentTurn: false }), true);
}

// ② 升级判据:只有没有快照的重接 + 有效开始时刻
{
  assert.equal(shouldUpgradeReattachOnReplayComplete({ isReattach: true, seeded: false, turnStartedAt: 1700000000000 }), true);
  assert.equal(shouldUpgradeReattachOnReplayComplete({ isReattach: false, seeded: false, turnStartedAt: 1700000000000 }), false, '正常发送的首次连接:忽略');
  assert.equal(shouldUpgradeReattachOnReplayComplete({ isReattach: true, seeded: true, turnStartedAt: 1700000000000 }), false, '有快照的重接:忽略');
  for (const bad of [undefined, null, '1700000000000', NaN, Infinity, 0, -5]) {
    assert.equal(shouldUpgradeReattachOnReplayComplete({ isReattach: true, seeded: false, turnStartedAt: bad }), false, `开始时刻无效(${String(bad)}):不升级`);
  }
}

// ③ 接线:App.jsx 里让位在认领 pid 之前、切会话清理处递增计数(草稿升级分支之内)、升级分支四件事
{
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const iYield = app.indexOf('if (shouldYieldOrphanSend({');
  const iClaim = app.indexOf('pid = respJson.pid;');
  assert.ok(iYield > 0 && iClaim > iYield, '让位判定在认领 pid 之前');
  const yieldCall = app.slice(iYield, iClaim);
  assert.ok(/switchCountNow: paneSwitchCountRef\.current/.test(yieldCall) && /isCurrentTurn: isCurrentTurn\(\)/.test(yieldCall)
    && /paneOnOwner: queueKeyFor\(getLocalSession\(\)\) === sessionQueueKey/.test(yieldCall), '让位判定带上三个条件');
  assert.ok(/\}\)\) \{ yieldedToReattach = true; return; \}\s*\n\s*pid = respJson\.pid;/.test(app), '让位走既有的 return,且 return 之前置上让位标记');
  assert.equal((app.match(/yieldedToReattach = true;/g) || []).length, 1, '让位标记只有一个置位点');
  assert.ok(/let yieldedToReattach = false;/.test(app), '让位标记是本次发送闭包里的变量,初值 false');
  // 收尾:队列排空与四处窗格级写入都在让位标记守卫之内
  const iFin = app.indexOf('const teardownMine = () => isCurrentTurn() && !streamingRef.current;');
  assert.ok(iFin > iClaim, '定位到收尾段');
  const fin = app.slice(iFin, app.indexOf('}, [selectedSession, selectedProject, streamingModel', iFin));
  const iGuard4 = fin.indexOf('if (!yieldedToReattach) {');
  assert.ok(iGuard4 > 0, '四处写入有让位守卫');
  const guard4 = fin.slice(iGuard4, fin.indexOf('}', iGuard4));
  for (const w of ['setRetryActiveUuid(null);', 'setCompacting(false);', 'setLiveStatus(null);', 'setAuditChecking([]);']) {
    assert.ok(guard4.includes(w), `${w} 在让位守卫之内`);
    assert.equal(fin.split(w).length - 1, 1, `收尾里 ${w} 只有守卫内这一处`);
  }
  const iDrain = fin.indexOf('if (!backgroundedRef.current && !yieldedToReattach) {');
  const iShift = fin.indexOf('useStore.getState().shiftMessage(drainKey)');
  const iResend = fin.indexOf('handleSendRef.current?.(next.text');
  assert.ok(iDrain > 0 && iShift > iDrain && iResend > iShift, '队列排空(弹队首与再发送)整段在让位守卫之内');
  assert.equal(fin.split('shiftMessage(').length - 1, 1, '收尾里没有守卫外的弹队首');
  // 让位的发送不做回合收尾:等落盘循环(含 reconcileSteeredQueue)、起标题、复位转后台标记
  const iLoopGuard = fin.indexOf('if (!yieldedToReattach && finalizeSid && finalizePh) {');
  assert.ok(iLoopGuard > 0, '等落盘 / 空回合循环整段在让位守卫之内');
  const iReconcileDef = fin.indexOf('const reconcileSteeredQueue = ');
  const iLoopFor = fin.indexOf('for (let i = 0; i < 12; i++) {');
  assert.ok(iReconcileDef > iLoopGuard && iLoopFor > iLoopGuard, '对账函数与轮询循环都在守卫块里');
  assert.equal(fin.split('if (finalizeSid && finalizePh) {').length - 1, 0, '不再有无让位守卫的循环入口');
  const reconcileCalls = [...fin.matchAll(/reconcileSteeredQueue\(/g)].map((m) => m.index);
  assert.ok(reconcileCalls.length >= 3 && reconcileCalls.every((i) => i > iLoopGuard && i < fin.indexOf('// BF-1:回合收尾清历史截断', iLoopGuard)),
    '收尾里每一处 reconcileSteeredQueue 调用都在守卫块里');
  assert.ok(/if \(!yieldedToReattach && titleSid && !titleAttempted\.has\(titleSid\)/.test(fin), '起标题在让位守卫之内');
  assert.equal(fin.split("fetch('/api/chat/title'").length - 1, 1, '收尾里只有一处起标题请求');
  assert.ok(/if \(!yieldedToReattach\) backgroundedRef\.current = false;/.test(fin), '复位转后台标记在让位守卫之内');
  assert.equal(fin.split('backgroundedRef.current = false;').length - 1, 1, '收尾里没有守卫外的转后台复位');
  // 配对计数:内层 finally 的减一不在任何让位守卫里
  const decLine = 'finalizeInFlightRef.current = Math.max(0, finalizeInFlightRef.current - 1);';
  const iDec = fin.indexOf(decLine);
  assert.ok(iDec > 0, '配对计数减一仍在收尾里');
  const lineStart = fin.lastIndexOf('\n', iDec);
  assert.ok(!/yieldedToReattach/.test(fin.slice(lineStart, iDec)), '减一那行不带让位条件');
  const innerFinally = fin.lastIndexOf('} finally {', iDec);
  assert.ok(innerFinally > 0 && !/yieldedToReattach/.test(fin.slice(innerFinally, iDec)), '内层 finally 到减一之间没有让位守卫');
  assert.ok(/const paneSwitchCountAtSend = paneSwitchCountRef\.current;/.test(app), '发送开始时记下切换计数');
  const iPromo = app.indexOf('if (!isPromotion) {');
  const iInc = app.indexOf('paneSwitchCountRef.current += 1;');
  const iDetach = app.indexOf('detachStream();', iPromo);
  assert.ok(iPromo > 0 && iDetach > iPromo && iInc > iDetach && iInc - iDetach < 80, '计数只在非草稿升级的切会话清理处(紧跟 detachStream)递增');
  assert.equal((app.match(/paneSwitchCountRef\.current \+= 1;/g) || []).length, 1, '切换计数只有一个递增点');
  const iEv = app.indexOf("if (event.type === 'replay_complete') {");
  assert.ok(iEv > 0, '流内处理 replay_complete');
  const evBody = app.slice(iEv, app.indexOf('continue;', iEv));
  assert.ok(/shouldUpgradeReattachOnReplayComplete\(\{ isReattach: !!reattachPid, seeded,/.test(evBody), '按纯函数判据');
  assert.ok(/seeded = true;/.test(evBody), '已种回置真');
  assert.ok(/setReattachStream\(false\);/.test(evBody), '本流自己画直播气泡');
  assert.ok(/setStreamHistCutoff\(\{ sinceTs: event\.turnStartedAt, keepUser: true \}\);/.test(evBody), '历史按回合开始时刻截断');
  assert.ok(/turnStreamStart = event\.turnStartedAt;/.test(evBody) && /streamStartRef\.current = event\.turnStartedAt;/.test(evBody), '计时起点改成回合开始时刻');
  assert.ok(iEv > app.indexOf("if (event.type === 'early_overflow') {"), '与 early_overflow 同处处理');
}

console.log('✓ check-r177-reattach-upgrade: 最初那次发送让位 + 无快照重接收到声明后升级种回');
