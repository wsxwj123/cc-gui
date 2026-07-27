#!/usr/bin/env node
// 输入框 ↑↓ 历史导航状态机护栏(ChatInput.jsx handleKeyDown 的历史分支)。
// 回归对象:7342b29「单行恒放行 ↑↓」引入的两个新 bug ——
//   ① historyCursor=-1 时按 ↓ 会 setText(draftBeforeHistoryRef,初始 '')清空正在输入的文本;
//   ② 同一按键把 cursor 减到 -2,之后 ↑ 的 min(cursor+1, len-1) 恒 <0 → ↑ 变死键。
// 同时锁住 7342b29 本来修好的三条路径不回归(空文本 ↑↓ / 单行非空 ↑ / 历史中编辑后 ↑)。
// 无框架,纯 assert;复刻组件内那段键盘逻辑(见 ChatInput.jsx:721-763)。
import assert from 'node:assert/strict';

// —— 复刻:一次按键作用于 { text, cursor, draft } 状态,返回新状态 + 是否吞键 ——
function keyDown(state, key, history, { selectionStart = null } = {}) {
  const { text, cursor, draft } = state;
  const pos = selectionStart == null ? text.length : selectionStart;
  const atStart = pos === 0;
  const atEnd = pos === text.length;
  const canUseHistory = !text.startsWith('/')
    && (text.trim() === '' || cursor >= 0 || !text.includes('\n') || (key === 'ArrowUp' ? atStart : atEnd));
  if (!canUseHistory) return { ...state, prevented: false };
  // 本次修复:↓ 在未浏览历史时不吞键,让光标正常下移
  if (key === 'ArrowDown' && cursor < 0) return { ...state, prevented: false };
  if (!(history.length > 0 || cursor >= 0)) return { ...state, prevented: false };
  if (key === 'ArrowUp') {
    const next = Math.min(cursor + 1, history.length - 1);
    const nextDraft = cursor === -1 ? text : draft;
    if (next >= 0) return { text: history[next], cursor: next, draft: nextDraft, prevented: true };
    return { ...state, draft: nextDraft, prevented: true };
  }
  const next = Math.max(cursor - 1, -1); // 本次修复:钳位 -1
  return { text: next >= 0 ? history[next] : draft, cursor: next, draft, prevented: true };
}
// —— 复刻:用户手打字(非导航)会把 cursor 复位 -1、清草稿(ChatInput.jsx:447-449)——
const typeText = (state, text) => ({ text, cursor: -1, draft: '' });

const HIST = ['第三条', '第二条', '第一条']; // readHistory():最新在前
const S0 = { text: '', cursor: -1, draft: '' };

// ── 路径 1:空文本 ↑↓ 翻历史并能回到空草稿 ──────────────────────
{
  let s = keyDown(S0, 'ArrowUp', HIST);
  assert.equal(s.text, '第三条', '空文本 ↑ → 最新一条');
  assert.equal(s.cursor, 0);
  s = keyDown(s, 'ArrowUp', HIST);
  assert.equal(s.text, '第二条', '再 ↑ → 上一条');
  s = keyDown(s, 'ArrowDown', HIST);
  assert.equal(s.text, '第三条', '↓ 回到更新的一条');
  s = keyDown(s, 'ArrowDown', HIST);
  assert.equal(s.cursor, -1, '↓ 到底退出历史');
  assert.equal(s.text, '', '退出历史回填原草稿(空)');
  // 到底后再 ↓:必须放行(不吞键)且 cursor 不再下溜
  const s2 = keyDown(s, 'ArrowDown', HIST);
  assert.equal(s2.prevented, false, '非浏览态 ↓ 不吞键(光标正常下移)');
  assert.equal(s2.cursor, -1, 'cursor 钳在 -1,不减成 -2');
}

// ── 路径 2(本次修复的 bug):单行非空 + 未浏览历史时按 ↓ ────────
{
  const typing = { text: '正在输入的重要内容', cursor: -1, draft: '' };
  const s = keyDown(typing, 'ArrowDown', HIST);
  assert.equal(s.text, '正在输入的重要内容', '↓ 不得清空正在输入的文本');
  assert.equal(s.cursor, -1, '↓ 不得把 cursor 减到 -2');
  assert.equal(s.prevented, false, '↓ 不吞键');
  // 紧接着 ↑ 必须仍能进历史(修复前这里是死键)
  const up = keyDown(s, 'ArrowUp', HIST);
  assert.equal(up.text, '第三条', '↓ 之后 ↑ 仍能进历史(非死键)');
  assert.equal(up.draft, '正在输入的重要内容', '进历史前先存草稿');
  const back = keyDown(up, 'ArrowDown', HIST);
  assert.equal(back.text, '正在输入的重要内容', '↓ 到底找回原文本');
}

// ── 路径 3:历史中编辑(退格)后 ↑ 仍能回历史(7342b29 修的,别回归)──
{
  let s = keyDown(S0, 'ArrowUp', HIST);       // 进历史:'第三条'
  s = typeText(s, '第三');                     // 退格 → cursor 复位 -1
  assert.equal(s.cursor, -1);
  s = keyDown(s, 'ArrowUp', HIST);
  assert.equal(s.text, '第三条', '编辑后 ↑ 重新进历史,不是死键');
  assert.equal(s.draft, '第三', '编辑后的文本被存为草稿,↓ 可找回');
}

// ── 路径 4:多行文本 ↑↓ 仍受光标位置门槛保护(不劫持跨行移动)──────
{
  const multi = { text: 'a\nb', cursor: -1, draft: '' };
  const midUp = keyDown(multi, 'ArrowUp', HIST, { selectionStart: 2 }); // 非行首
  assert.equal(midUp.prevented, false, '多行且光标不在开头 → ↑ 不劫持');
  const topUp = keyDown(multi, 'ArrowUp', HIST, { selectionStart: 0 });
  assert.equal(topUp.text, '第三条', '多行但光标在开头 → ↑ 进历史');
  // 多行浏览历史中 ↓ 到底同样钳位
  const down1 = keyDown(topUp, 'ArrowDown', HIST);
  assert.equal(down1.cursor, -1);
  assert.equal(down1.text, 'a\nb', '↓ 到底找回多行草稿');
}

// ── 路径 5:斜杠命令永不劫持(slash 菜单优先)──────────────────
{
  const slash = { text: '/comp', cursor: -1, draft: '' };
  assert.equal(keyDown(slash, 'ArrowUp', HIST).prevented, false, '/ 开头不进历史导航');
  assert.equal(keyDown(slash, 'ArrowDown', HIST).prevented, false, '/ 开头不进历史导航');
}

console.log('✓ check-input-history-nav: 5 条路径全过');
