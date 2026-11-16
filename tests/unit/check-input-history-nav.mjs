#!/usr/bin/env node
// 输入框 ↑↓ 历史导航状态机护栏(ChatInput.jsx handleKeyDown 的历史分支)。
// 回归对象:7342b29「单行恒放行 ↑↓」引入的两个新 bug ——
//   ① historyCursor=-1 时按 ↓ 会 setText(draftBeforeHistoryRef,初始 '')清空正在输入的文本;
//   ② 同一按键把 cursor 减到 -2,之后 ↑ 的 min(cursor+1, len-1) 恒 <0 → ↑ 变死键。
// 同时锁住 7342b29 本来修好的三条路径不回归(空文本 ↑↓ / 单行非空 ↑ / 历史中编辑后 ↑)。
// 路径 6/7 是 #15:历史里翻出 `/compact` 之类后 ↑↓ 卡死(canUseHistory 写死 `/` 排除 +
// 斜杠菜单抢箭头),判据统一改成"浏览态 historyCursor>=0 优先于 / 排除"。
// r192 起放行条件改按光标所在的【显示行】判断:行的部分直接调用组件用的纯函数
// caretLineAllowsHistory(client/src/utils/caretLines.js),不再复刻;页面上量行的那一步
// (measureCaretLines)在这里用 linesFor() 按「手动换行 + 固定列宽自动折行」模拟。
// 其余按键顺序(召回待发、菜单、早退)仍按组件写法复刻。无框架,纯 assert。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { caretLineAllowsHistory } from '../../client/src/utils/caretLines.js';

// —— 模拟量行:wrap 为每个显示行最多容纳的字符数(不给 = 不自动折行)。
// 断点上的位置算下一行(与任务文件「已知边界」一致)。返回 { onFirstLine, onLastLine } ——
function linesFor(text, selStart, selEnd, wrap = Infinity) {
  const lineOf = (pos) => {
    let line = 0;
    let lineStart = 0;
    for (const part of text.split('\n')) {
      const end = lineStart + part.length;
      if (pos <= end) return line + (Number.isFinite(wrap) ? Math.floor((pos - lineStart) / wrap) : 0);
      line += Number.isFinite(wrap) ? Math.max(1, Math.ceil(part.length / wrap)) : 1;
      lineStart = end + 1;
    }
    return line;
  };
  return { onFirstLine: lineOf(selStart) === lineOf(0), onLastLine: lineOf(selEnd) === lineOf(text.length) };
}

// —— 复刻:一次按键作用于 { text, cursor, draft } 状态,返回新状态 + 是否吞键 ——
// selectionStart / selectionEnd 不给 = 光标在末尾;lines 不给 = 用 linesFor 按 wrap 模拟;
// lines: null = 量不出来(走保守判据)。
function keyDown(state, key, history, {
  selectionStart = null, selectionEnd = null, showCommands = false, wrap = Infinity, lines,
  queueRecall = false, atPanelOpen = false, composing = false, modifier = false,
} = {}) {
  const { text, cursor, draft } = state;
  const selStart = selectionStart == null ? text.length : selectionStart;
  const selEnd = selectionEnd == null ? selStart : selectionEnd;
  if (composing) return { ...state, prevented: false, ignored: true };           // 函数顶部 IME 早退
  if (atPanelOpen && (key === 'ArrowUp' || key === 'ArrowDown')) return { ...state, prevented: true, menu: true };
  // 斜杠菜单开着时只在【非浏览历史】(cursor<0)消费箭头(ChatInput.jsx:696/:704)
  if (showCommands && (key === 'ArrowUp' || key === 'ArrowDown') && cursor < 0) {
    return { ...state, prevented: true, menu: true };
  }
  if (key === 'ArrowUp' && !modifier && text.trim() === '' && queueRecall) return { ...state, prevented: true, recalled: true };
  if (modifier) return { ...state, prevented: false };
  const measured = lines === undefined ? linesFor(text, selStart, selEnd, wrap) : lines;
  const canUseHistory = (!text.startsWith('/') || cursor >= 0)
    && caretLineAllowsHistory({ key, lines: measured, selectionStart: selStart, selectionEnd: selEnd, textLength: text.length });
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

// ── 路径 5:【手打】斜杠命令不劫持(slash 菜单优先)────────────────
{
  const slash = { text: '/comp', cursor: -1, draft: '' };
  assert.equal(keyDown(slash, 'ArrowUp', HIST).prevented, false, '手打 / 开头不进历史导航');
  assert.equal(keyDown(slash, 'ArrowDown', HIST).prevented, false, '手打 / 开头不进历史导航');
}

// ── 路径 6(#15):历史里有 / 开头条目时不得卡死 ────────────────────
// 修前 canUseHistory 写死 !text.startsWith('/'):翻出 '/compact' 后下一次 ↑↓ 整个历史分支
// 被跳过,退化成光标移动 —— 历史一有 / 开头的条目就再也翻不过去。
{
  const H = ['/compact', '第二条'];
  let s = keyDown(S0, 'ArrowUp', H);
  assert.equal(s.text, '/compact', '空框 ↑ → 最新一条(/compact)');
  s = keyDown(s, 'ArrowUp', H);
  assert.equal(s.text, '第二条', '停在 /compact 上再 ↑ 必须能继续往上翻(修前失败)');
  s = keyDown(s, 'ArrowDown', H);
  assert.equal(s.text, '/compact', '↓ 回到 /compact');
  s = keyDown(s, 'ArrowDown', H);
  assert.equal(s.cursor, -1, '↓ 到底退出历史');
  assert.equal(s.text, '', '退出历史回填草稿');
  // 退出历史后又变回"手打 /"语义:此时 ↑ 从空框重新进历史,不受影响
  assert.equal(keyDown(s, 'ArrowUp', H).text, '/compact');
}

// ── 路径 7(#15):斜杠菜单只在非浏览态吃箭头 ──────────────────────
{
  const H = ['/compact', '第二条'];
  // 浏览历史中翻出 /compact → 菜单会自动弹出(text 以 / 开头),箭头必须仍归历史
  const browsing = { text: '/compact', cursor: 0, draft: '' };
  const up = keyDown(browsing, 'ArrowUp', H, { showCommands: true });
  assert.equal(up.menu, undefined, '浏览历史中箭头不得被斜杠菜单吃掉');
  assert.equal(up.text, '第二条', '浏览历史中 ↑ 继续翻历史');
  // 手打 /compact(cursor=-1)→ 箭头归菜单(既有行为不能变)
  const typed = { text: '/compact', cursor: -1, draft: '' };
  assert.equal(keyDown(typed, 'ArrowDown', H, { showCommands: true }).menu, true, '手打时箭头归斜杠菜单');
  // 浏览态下手打一个字符 → cursor 复位 -1 → 菜单箭头恢复
  const afterTyping = typeText(browsing, '/comp');
  assert.equal(keyDown(afterTyping, 'ArrowDown', H, { showCommands: true }).menu, true, '打字复位后箭头归菜单');
}

// ── 源码守卫:防止改回写死的 `/` 排除 ────────────────────────────
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../client/src/components/ChatInput.jsx'), 'utf8');
  assert.ok(src.includes("(!text.startsWith('/') || historyCursor >= 0)"),
    'canUseHistory 必须放行浏览态的 / 开头条目');
  const kd = src.slice(src.indexOf('const handleKeyDown ='));
  assert.ok(kd.split('historyCursor < 0').length - 1 >= 3,
    'handleKeyDown 里 historyCursor < 0 门控至少 3 处(斜杠菜单两个箭头 + ↓ 早退)');
  // 补全后必须退出浏览态:否则紧接着按 ↑ 会继续翻历史,把刚补全的命令覆盖掉。
  const sc = src.slice(src.indexOf('const selectCommand ='), src.indexOf('// ── @ 引用选择器'));
  assert.ok(/setHistoryCursor\(-1\)/.test(sc), 'selectCommand 必须 setHistoryCursor(-1) 退出历史浏览态');
  // r192:放行条件 = 原样保留的 `/` 段 && 按显示行判断的纯函数;旧的「没有换行就一律放行」不得回来
  const arrowBlock = kd.slice(kd.indexOf("if ((e.key === 'ArrowUp' || e.key === 'ArrowDown')"), kd.indexOf('if (canUseHistory)'));
  assert.ok(/const canUseHistory = \(!text\.startsWith\('\/'\) \|\| historyCursor >= 0\) && caretLineAllowsHistory\(\{/.test(arrowBlock),
    'canUseHistory 必须是「/ 段 && caretLineAllowsHistory(...)」');
  assert.ok(arrowBlock.includes('measureCaretLines(el)'), '行信息必须由 measureCaretLines 从输入框量出');
  assert.ok(/selectionStart: el \? el\.selectionStart/.test(arrowBlock) && /selectionEnd: el \? el\.selectionEnd/.test(arrowBlock),
    '保守判据要拿选区起点(上键)与选区终点(下键)');
  assert.ok(!arrowBlock.includes("!text.includes('\\n')"), '旧的「没有换行符就一律翻历史」不得回来');
  assert.ok(/if \(e\.key === 'ArrowDown' && historyCursor < 0\) return;/.test(kd), '↓ 未浏览历史早退原样保留');
}

// ── r192 路径表(任务文件 B 项「进入路径」逐行)───────────────────────
{
  const H = ['M2 第一行\nM2 第二行\nM2 第三行', 'M1'];
  // 行 1:文本为空 + 有待发消息 → ↑ 召回待发;↓ 不处理
  assert.equal(keyDown(S0, 'ArrowUp', H, { queueRecall: true }).recalled, true, '空文本有待发:↑ 召回待发');
  assert.equal(keyDown(S0, 'ArrowDown', H, { queueRecall: true }).prevented, false, '空文本有待发:↓ 不处理');
  // 行 2:文本为空 + 没有待发 → ↑ 翻上一条;↓ 未浏览不处理
  assert.equal(keyDown(S0, 'ArrowUp', H).cursor, 0, '空文本:↑ 翻上一条');
  assert.equal(keyDown(S0, 'ArrowDown', H).prevented, false, '空文本未浏览:↓ 不处理');
  // 行 3:一个显示行 → ↑ 翻上一条(先存草稿),光标在哪都一样;↓ 浏览中翻下一条、未浏览不处理
  const one = { text: 'K 单行', cursor: -1, draft: '' };
  const oneUp = keyDown(one, 'ArrowUp', H, { selectionStart: 2 });
  assert.equal(oneUp.cursor, 0, '单行光标在中间:↑ 也翻');
  assert.equal(oneUp.draft, 'K 单行', '进历史前存草稿');
  assert.equal(keyDown(one, 'ArrowDown', H, { selectionStart: 0 }).prevented, false, '单行未浏览:↓ 不处理');
  // 行 4–6:多个显示行(翻出的 M2,三行)
  const m2 = { text: H[0], cursor: 0, draft: '' };
  const a = 'M2 第一行'.length;
  const b = 'M2 第二行'.length;
  const endUp = keyDown(m2, 'ArrowUp', H);                                  // 光标在末尾(第三行)
  assert.equal(endUp.prevented, false, '多行光标在最后一行:↑ 不拦,光标上移(修前直接翻到 M1)');
  assert.equal(keyDown(m2, 'ArrowUp', H, { selectionStart: a + 1 + 2 }).prevented, false, '光标在第二行:↑ 不拦');
  const topUp = keyDown(m2, 'ArrowUp', H, { selectionStart: 3 });
  assert.equal(topUp.text, 'M1', '光标在第一行:↑ 翻上一条');
  assert.equal(keyDown(m2, 'ArrowDown', H, { selectionStart: 0 }).prevented, false, '光标在第一行:↓ 不拦,光标下移(修前直接退出历史)');
  assert.equal(keyDown(m2, 'ArrowDown', H, { selectionStart: a + 1 + b }).prevented, false, '第二行末尾:↓ 不拦');
  const lastDown = keyDown(m2, 'ArrowDown', H, { selectionStart: a + 1 + b + 1 });
  assert.equal(lastDown.cursor, -1, '光标在最后一行且浏览中:↓ 翻下一条(到底回草稿)');
  const typedMulti = { text: 'x\ny', cursor: -1, draft: '' };
  assert.equal(keyDown(typedMulti, 'ArrowDown', H).prevented, false, '最后一行但未浏览:↓ 不处理');
  // 选区:↑ 看起点,↓ 看终点
  assert.equal(keyDown(m2, 'ArrowUp', H, { selectionStart: 1, selectionEnd: H[0].length }).text, 'M1', '选区起点在第一行:↑ 翻');
  assert.equal(keyDown(m2, 'ArrowDown', H, { selectionStart: 1, selectionEnd: H[0].length }).cursor, -1, '选区终点在最后一行:↓ 翻');
  assert.equal(keyDown(m2, 'ArrowDown', H, { selectionStart: 1, selectionEnd: a + 2 }).prevented, false, '选区终点在第二行:↓ 不拦');
  // 自动折行:600 字没有换行,按 100 列折成 6 行
  const longText = 'word '.repeat(120);
  const long = { text: longText, cursor: -1, draft: '' };
  assert.equal(keyDown(long, 'ArrowUp', H, { wrap: 100 }).prevented, false, '自动折行、光标在末尾:↑ 不拦(修前直接进历史)');
  assert.equal(keyDown(long, 'ArrowUp', H, { wrap: 100, selectionStart: 50 }).cursor, 0, '自动折行、光标在第一行:↑ 翻');
  assert.equal(keyDown(long, 'ArrowUp', H, { wrap: 100, selectionStart: 100 }).prevented, false, '断点位置算下一行(已知边界)');
  // 行 7:手打「/」开头 → 不翻(已由路径 5 覆盖);行 8:翻出的「/」开头多行条目按行规则
  const slashItem = { text: '/compact\n说明', cursor: 0, draft: '' };
  assert.equal(keyDown(slashItem, 'ArrowUp', ['/compact\n说明', 'M1']).prevented, false, '翻出的 / 多行条目、光标在末行:↑ 不拦');
  assert.equal(keyDown(slashItem, 'ArrowUp', ['/compact\n说明', 'M1'], { selectionStart: 0 }).text, 'M1', '翻出的 / 条目、光标在首行:↑ 翻');
  // 行 9:@ 面板 / 斜杠菜单(未浏览)开着 → 归面板
  assert.equal(keyDown(one, 'ArrowUp', H, { atPanelOpen: true }).menu, true, '@ 面板开着:箭头归面板');
  // 行 10:输入法合成中 → 不处理;行 11:带修饰键 → 不处理
  assert.equal(keyDown(S0, 'ArrowUp', H, { composing: true }).ignored, true, '输入法合成中不处理');
  const mod = keyDown(S0, 'ArrowUp', H, { modifier: true });
  assert.equal(mod.prevented, false, '带修饰键不处理');
  assert.equal(mod.cursor, -1, '带修饰键不进历史');
}

// ── r192 纯函数本身:量不出行时的保守判据 ─────────────────────────────
{
  const f = (key, selectionStart, selectionEnd, textLength, lines = null) => caretLineAllowsHistory({ key, lines, selectionStart, selectionEnd, textLength });
  assert.equal(f('ArrowUp', 0, 0, 10), true, '量不出:↑ 光标在最开头才放行');
  assert.equal(f('ArrowUp', 3, 3, 10), false, '量不出:↑ 不在最开头不放行');
  assert.equal(f('ArrowUp', 0, 10, 10), true, '量不出:↑ 看选区起点');
  assert.equal(f('ArrowDown', 10, 10, 10), true, '量不出:↓ 光标在最末尾才放行');
  assert.equal(f('ArrowDown', 0, 3, 10), false, '量不出:↓ 看选区终点');
  assert.equal(f('ArrowDown', 0, 0, 0), true, '量不出 + 空文本:↓ 放行');
  assert.equal(f('ArrowUp', 5, 5, 10, { onFirstLine: true, onLastLine: false }), true, '有行信息:↑ 看 onFirstLine');
  assert.equal(f('ArrowDown', 5, 5, 10, { onFirstLine: true, onLastLine: false }), false, '有行信息:↓ 看 onLastLine');
  assert.equal(f('Enter', 0, 0, 0, { onFirstLine: true, onLastLine: true }), false, '其它键不放行');
  // 量不出行时组件走保守判据:翻出的多行条目光标在末尾,↑ 不翻
  assert.equal(keyDown({ text: 'a\nb', cursor: 0, draft: '' }, 'ArrowUp', HIST, { lines: null }).prevented, false, '量不出 + 光标在末尾:↑ 不翻');
}

// ── 补全后 ↑ 不再覆盖:复刻"选中命令 → cursor 复位 → ↑ 走菜单而非历史" ────
{
  const H = ['第一条', '第二条'];
  // 浏览历史翻出 /compact(cursor≥0)后点选补全 → cursor 必须回 -1
  const afterSelect = { text: '/compact ', cursor: -1, draft: '' };
  assert.equal(keyDown(afterSelect, 'ArrowUp', H, { showCommands: true }).menu, true,
    '补全后 ↑ 归斜杠菜单,不得继续翻历史覆盖补全文本');
}

console.log('✓ check-input-history-nav: 7 条路径 + 源码守卫 + r192 显示行路径表与纯函数全过');
