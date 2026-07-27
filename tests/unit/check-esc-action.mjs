#!/usr/bin/env node
// Esc 会话级语义护栏(client/src/utils/escAction.js —— App.jsx keydown handler 的判定内核)。
// 直接 import 真实实现(不复刻),改坏了这里必红。
// 锁住的行为(对齐 CLI 2.1.220 pty 实测):
//   ① 生成中单击即停,且不受双击窗口影响(E2 的核心,回归=又要按两下才停)
//   ② 空闲首击只 arm、不产生任何副作用(回归=单击 Esc 误清输入/误弹面板)
//   ③ 双击窗口 800ms:边界内算双击、超出重新 arm
//   ④ 空闲双击的三条落点:有字清空 → 清空后可恢复 → 空手开回退;draft 无 sessionId 只提示
import assert from 'node:assert/strict';
import { ESC_DOUBLE_MS, escRoute, idleEscAction } from '../../client/src/utils/escAction.js';

assert.equal(ESC_DOUBLE_MS, 800, '双击窗口按 CLI 实测取 800ms');

// ── ① 生成中:单击即停,双击窗口不参与 ─────────────────────────
{
  assert.equal(escRoute({ hasStream: true, lastEscAt: 0, now: 1000 }), 'stop', '有流单击即停');
  assert.equal(escRoute({ hasStream: true, lastEscAt: 999, now: 1000 }), 'stop', '有流时第二击同样是停(不改语义)');
  assert.equal(escRoute({ hasStream: true, lastEscAt: 0, now: 999999 }), 'stop', '有流与时间窗无关');
}

// ── ② + ③ 空闲:首击 arm,800ms 内第二击才算双击 ────────────────
{
  assert.equal(escRoute({ hasStream: false, lastEscAt: 0, now: 1000 }), 'arm', '空闲首击只记一笔');
  assert.equal(escRoute({ hasStream: false, lastEscAt: 1000, now: 1800 }), 'idle-double', '正好 800ms 算双击');
  assert.equal(escRoute({ hasStream: false, lastEscAt: 1000, now: 1801 }), 'arm', '801ms 超窗 → 重新 arm,不误触');
  assert.equal(escRoute({ hasStream: false, lastEscAt: 1000, now: 1000 }), 'idle-double', '零间隔(同帧)算双击');
  // 停止后紧跟着的那一击:流已没了 + lastEsc 被调用方清零 → 只 arm,不会顺手弹回退面板
  assert.equal(escRoute({ hasStream: false, lastEscAt: 0, now: 1005 }), 'arm', '停止后紧跟的一击被吞成 arm');
}

// ── ④ 空闲双击落点 ────────────────────────────────────────────
{
  assert.equal(idleEscAction({ draftText: '写一半的话', clearedText: '', hasSession: true }), 'clear-input');
  assert.equal(idleEscAction({ draftText: '   \n ', clearedText: '', hasSession: true }), 'rewind', '纯空白不算有字');
  assert.equal(idleEscAction({ draftText: '', clearedText: '写一半的话', hasSession: true }), 'restore-input', '清空后再双击=找回');
  assert.equal(idleEscAction({ draftText: '新写的', clearedText: '旧的', hasSession: true }), 'clear-input', '又写了字 → 先清空(clearedText 被覆盖)');
  assert.equal(idleEscAction({ draftText: '', clearedText: '', hasSession: true }), 'rewind', '真空手 → 开回退');
  assert.equal(idleEscAction({ draftText: '', clearedText: '', hasSession: false }), 'rewind-empty', 'draft 会话没有可回退的点');
  assert.equal(idleEscAction({}), 'rewind-empty', '缺省参数不炸');
}

console.log('✓ check-esc-action: 4 组断言全过');
