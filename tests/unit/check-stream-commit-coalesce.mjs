#!/usr/bin/env node
// r119 流式提交合并器的白盒自检(utils/streamCommit.js + App.jsx 的接线)。
// 要锁住的三件事:
//   ① 合并:同一帧里来多少 delta 都只提交一次,且提交的是【累积结果》—— 正文一个字不丢、
//      有序块顺序完整(病理风险:最后几个字停在闭包里没渲染 / 块序错乱);
//   ② 终止路径强制 flush:回合终止(done/error/中止/收尾)必须立刻提交一次,此后挂起的那一帧
//      不许再提交第二次(重复提交 = 白渲染一次,还会把清空后的内容写回界面);
//   ③ 卸载/切会话取消:挂起的那一帧被 cancel 掉之后,回调一次都不许跑(否则就是对已卸载组件
//      setState);收尾清空流式 state 之后同样不许有陈旧提交把内容写回去。
// 纯机制部分真 import;App.jsx 的接线(谁在什么位置 flush/cancel)用源码守卫 —— 与
// check-model-row-badge.mjs 等既有白盒用例同法。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createStreamCommit } from '../../client/src/utils/streamCommit.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
const chatInput = readFileSync(join(root, 'client/src/components/ChatInput.jsx'), 'utf8');

// ── 假调度器:把"帧回调"收在手里,由测试决定什么时候跑 ──────────────────
function fakeScheduler() {
  const queued = [];
  return {
    queued,
    raf: (fn) => { queued.push(fn); return queued.length; },
    cancelRaf: (h) => { queued[h - 1] = null; },
    fireFrame() { const list = queued.splice(0); for (const fn of list) if (fn) fn(); },
  };
}

// ── 模拟 App 的用法:delta 只改闭包累积值 + 标脏;提交把累积值写进 state ──
function makeStream() {
  const sched = fakeScheduler();
  const s = {
    text: '', thinking: '', toolCalls: [], orderedBlocks: [],
    state: { text: '', thinking: '', toolCalls: null, blocks: null },
    commits: 0, setStateOnUnmounted: 0, mounted: true,
  };
  const commit = createStreamCommit(() => {
    s.commits += 1;
    if (!s.mounted) s.setStateOnUnmounted += 1; // 真环境里这里就是 setState
    s.state = {
      text: s.text, thinking: s.thinking,
      toolCalls: [...s.toolCalls], blocks: [...s.orderedBlocks],
    };
  }, { raf: sched.raf, cancelRaf: sched.cancelRaf });
  let dirty = 0;
  const SC_TEXT = 1; const SC_THINKING = 2; const SC_TOOLS = 4; const SC_BLOCKS = 8;
  s.commit = commit;
  s.schedule = (flags) => { dirty |= flags; commit.schedule(); };
  s.forcedFlush = () => commit.flush();
  s.cancel = () => { dirty = 0; commit.cancel(); };
  // delta:与 App 的流式分支同形(累积 + 标脏,不直接 setState)
  s.delta = (chunk) => {
    s.text += chunk;
    const last = s.orderedBlocks.length - 1;
    if (last >= 0 && s.orderedBlocks[last].type === 'text') {
      s.orderedBlocks[last] = { ...s.orderedBlocks[last], content: s.orderedBlocks[last].content + chunk };
    } else {
      s.orderedBlocks.push({ type: 'text', content: chunk });
    }
    s.schedule(SC_TEXT | SC_BLOCKS);
  };
  s.sched = sched;
  return s;
}

// ── ① 同一帧内 N 次 delta → 只提交一次,且内容是累积后的完整值 ─────────────
{
  const s = makeStream();
  const chunks = [];
  for (let i = 0; i < 50; i += 1) { const c = `块${String(i).padStart(3, '0')}-`; chunks.push(c); s.delta(c); }
  assert.equal(s.commits, 0, '帧还没来,一次都不许提交(delta 只写闭包)');
  assert.equal(s.sched.queued.length, 1, '50 次 delta 只排一帧,不是排 50 帧');
  s.sched.fireFrame();
  assert.equal(s.commits, 1, '同一帧提交一次');
  assert.equal(s.state.text, chunks.join(''), '提交的是累积结果,内容一个字不丢');
  assert.equal(s.state.text, s.text, 'state 与累积值一致');
  assert.deepEqual(s.state.blocks.map((b) => b.content), [chunks.join('')], '有序块完整');
}

// ── ② 终止路径强制 flush:立刻提交、内容完整;挂起的那一帧不再补交 ─────────
{
  const s = makeStream();
  s.delta('甲'); s.delta('乙');
  s.sched.fireFrame();                       // 正常帧提交
  s.delta('丙'); s.delta('丁');               // 终止前最后一批(还停在闭包里)
  assert.equal(s.state.text, '甲乙', '还没 flush 时 state 落后于累积值(这正是要 flush 的窗口)');
  s.forcedFlush();                           // 终止路径(done/error/中止/收尾)
  assert.equal(s.commits, 2, 'flush 立刻提交一次');
  assert.equal(s.state.text, '甲乙丙丁', 'flush 后累积正文完整 —— 最后两个字不丢');
  assert.deepEqual(s.state.blocks.map((b) => b.content), ['甲乙丙丁'], 'flush 后有序块完整');
  assert.equal(s.commit.pending, false, 'flush 后没有挂起状态');
  s.sched.fireFrame();                       // 那一帧的回调若还在,也不许再提交
  assert.equal(s.commits, 2, 'flush 之后不许重复提交一次(白渲染)');
  s.forcedFlush();                           // 空 flush 是 no-op
  assert.equal(s.commits, 2, '没有脏内容时 flush 不提交');
}

// ── ③ 卸载/切会话取消:挂起回调一次都不跑 ─────────────────────────────────
{
  const s = makeStream();
  s.delta('一'); s.delta('二');
  s.cancel();                                // detachStream(卸载/切会话/收尾清空后)
  s.mounted = false;                         // 组件已拆
  s.sched.fireFrame();                       // 就算那一帧的回调还在队列里
  assert.equal(s.commits, 0, '取消之后挂起的帧回调不许提交');
  assert.equal(s.setStateOnUnmounted, 0, '不允许对已卸载组件 setState');
  s.cancel();                                // 幂等
  assert.equal(s.commits, 0, '重复 cancel 无害');
  // 取消后新回合照常工作(同一个合并器可复用)
  s.mounted = true; s.delta('三'); s.sched.fireFrame();
  assert.equal(s.commits, 1);
  assert.equal(s.state.text, '一二三', '取消只影响挂起的那一帧,不丢后续内容');
}

// ── ④ 接线守卫:App.jsx 必须按上面三条用合并器 ────────────────────────────
{
  assert.ok(app.includes('const commitStream = createStreamCommit('), 'App 必须用 createStreamCommit 合并提交');
  assert.ok(app.includes('const scheduleStreamCommit = (flags) =>'), 'App 必须有标脏 + 排帧的入口');
  // 四个 setter 只允许出现在提交回调里(流式热路径一律走 scheduleStreamCommit)
  const commitBody = app.slice(app.indexOf('const commitStream = createStreamCommit('));
  const commitHead = commitBody.slice(0, commitBody.indexOf('const scheduleStreamCommit'));
  assert.equal([...commitHead.matchAll(/setStreaming(?:Text|Thinking|ToolCalls|Blocks)\(/g)].length, 4,
    '四个 setter 都在合并器的提交回调里');
  // 流式分支(content_block_start / content_block_delta / assistant 快照)不许再直接 setState
  const loopStart = app.indexOf("if (ev.type === 'content_block_start') {");
  const loopEnd = app.indexOf('// Snapshot events (non-partial mode, or final reconciliation)');
  assert.ok(loopStart > 0 && loopEnd > loopStart, '能定位到流式分支(源码结构变了就更新本用例)');
  const loop = app.slice(loopStart, loopEnd);
  assert.ok(loop.includes('scheduleStreamCommit('), '内容块/delta 分支走合并提交');
  assert.ok(!/setStreaming(?:Text|Thinking|ToolCalls|Blocks)\(/.test(loop), '内容块/delta 分支不许再直接 setState');
  const snapStart = app.indexOf('// r65:非 partial 的第三方(mimo 等)不发 delta');
  const snapEnd = app.indexOf("if (event.type === 'user' && event.message?.content) {");
  assert.ok(snapStart > 0 && snapEnd > snapStart, '能定位到整条 assistant 快照分支');
  assert.ok(!/setStreaming(?:Text|Thinking|ToolCalls|Blocks)\(/.test(app.slice(snapStart, snapEnd)),
    '整条消息快照分支也不许再直接 setState');
  // 终止路径:收尾里先 flush(归属守卫内)、清空流式 state 后 reset(丢掉挂起帧)
  const finStart = app.indexOf('const teardownMine = () => isCurrentTurn() && !streamingRef.current;');
  assert.ok(finStart > 0, '收尾处有终止 flush 与守卫(源码结构变了就更新本用例)');
  const fin = app.slice(finStart, finStart + 3000);
  assert.ok(fin.includes('commitStream.flush();'), '终止路径强制 flush 一次');
  assert.ok(fin.includes('resetStreamCommit();'), '收尾清空流式 state 后必须 reset(丢掉挂起帧)');
  // 收尾那组(隐藏直播气泡 + 清流式缓冲 + 挂载定稿气泡)必须整体低优先级:
  // 否则那条"卸载直播树 + 挂载定稿树"的秒级长任务会挡住点击反馈的绘制(INTERFACE B1)。
  assert.ok(fin.includes('startTransition(() => {'), '收尾整组必须进 transition');
  for (const decl of ['setIsStreaming((prev) => (teardownMine() ? false : prev))',
    'setStopping((prev) => (teardownMine() ? false : prev))',
    "setStreamingText((prev) => (teardownMine() ? '' : prev))",
    "setStreamingBlocks((prev) => (teardownMine() ? [] : prev))"]) {
    assert.ok(fin.includes(decl), `收尾写入必须带归属守卫(updater 形式):${decl}`);
  }
  assert.ok(fin.includes('streamingRef.current = false;'), 'ref 必须同步翻(推迟的只是 state)');
  // 停止请求回话【不许】把「停止中」翻回去(实测:那一闪短于一帧,反而让反馈延迟算到 1.8 秒)
  const stopBranch = app.slice(app.indexOf('const _stopP = fetch(`/api/chat/${activeProcRef.current}/stop`'));
  assert.ok(!stopBranch.slice(0, 900).includes('setStopping(false)'),
    '停止请求回话不许清「停止中」,只由本轮收尾清');
  // 卸载/切会话取消 + 点停止先 flush
  const detach = app.slice(app.indexOf('const detachStream = useCallback'));
  assert.ok(detach.slice(0, 1200).includes('streamCommitCancelRef.current?.();'),
    '卸载/切会话(detachStream)要取消挂起的帧回调');
  assert.ok(app.includes('streamCommitFlushRef.current?.();\n    if (pid) setStopping(true);'),
    '点「停止」当场:先 flush 挂起的提交,再进「停止中」');
  assert.ok(app.includes('streamCommitFlushRef.current = () => commitStream.flush();'), 'flush 句柄接到合并器');
  // 流式定稿挂载(localCopiesCleared 闩):历史接管后不许再把本地副本补回来(会双画)
  assert.ok(app.includes('let localCopiesCleared = false;') && app.includes('localCopiesCleared ? prev : [...prev,'),
    '定稿挂载要带"历史已接管"闩,避免延迟提交把已清掉的本地副本补回来');
  // markdown 记忆化(每个块的解析成本就是流式卡顿的根因,不许退回逐块重解析)
  const md = readFileSync(join(root, 'client/src/components/MarkdownRenderer.jsx'), 'utf8');
  assert.ok(/export const MarkdownRenderer = React\.memo\(function MarkdownRenderer\(/.test(md),
    'MarkdownRenderer 必须是 React.memo 包住的组件(内容没变 → 不重解析)');
  assert.ok(/^\}\);\s*$/m.test(md.slice(md.indexOf('export const MarkdownRenderer = React.memo('))),
    'memo 的括号要合上(真实现整个进了 memo,不是另抽一层)');
  // 停止的即时反馈:按钮「停止中」+ 状态行「停止中」
  assert.ok(chatInput.includes('disabled={stopping}'), '停止键要在停止请求发出后立刻禁用');
  assert.ok(chatInput.includes("{stopping ? '停止中' : '停止'}"), '停止键文案要变成「停止中」');
  assert.ok(app.includes("label = '停止中';"), '状态行要如实显示「停止中」');
}

console.log('check-stream-commit-coalesce: 4 组断言全部通过');
