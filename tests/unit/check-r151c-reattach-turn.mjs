#!/usr/bin/env node
// r151c 派工 7:同一常驻进程上紧接着开始的新回合,页面要重新接流。真 import client/src/utils/reattach.js 的
// nextReattachGuard / backgroundTurnKey,只把 React 的 state / effect 语义(同值 set 被 Object.is 短路、
// 依赖不变 effect 不重跑)做成小模拟器,按 App.jsx 的接线驱动它。
//   ① 回合身份 pid#turnEpoch 的形态;缺 turnEpoch 退回只按 pid
//   ② 同一 pid 上的新回合要接,同一回合不重复接;本地在流不接;裸 pid 闩(接管 / 三振 / 转后台)新回合也不接
//   ③ 时间线(验收 P21 的失败形态):打开会话时接了上一回合 → 上一回合 done → 40–70ms 后同一 pid 开新回合,
//      轮询看不到中间空闲。旧接线(只按 pid)不接;新接线接。另含"上一回合的流被提前收尾、state 没变"一支
//   ④ 源码契约:轮询写回合身份、effect 传它并依赖它;/api/agents/active 的 chat-process 条目带 turnEpoch;
//      chat.js 复用进程开新回合时 turnEpoch 加一(回合身份成立的前提)
// node tests/unit/check-r151c-reattach-turn.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backgroundTurnKey, nextReattachGuard } from '../../client/src/utils/reattach.js';

const PID = 'sdk-1';

// ── ① 回合身份 ────────────────────────────────────────────────
{
  assert.equal(backgroundTurnKey({ pid: PID, turnEpoch: 0 }), 'sdk-1#0', '首个回合(代数 0)也有身份');
  assert.equal(backgroundTurnKey({ pid: PID, turnEpoch: 3 }), 'sdk-1#3');
  assert.notEqual(backgroundTurnKey({ pid: PID, turnEpoch: 3 }), backgroundTurnKey({ pid: PID, turnEpoch: 4 }),
    '同一进程上的两个回合身份必须不同');
  assert.notEqual(backgroundTurnKey({ pid: PID, turnEpoch: 3 }), PID, '回合身份不得等于裸 pid(裸 pid 是"整个进程上闩")');
  for (const bad of [undefined, null, '3', -1, 1.5, NaN]) {
    assert.equal(backgroundTurnKey({ pid: PID, turnEpoch: bad }), null, `turnEpoch=${String(bad)} → 没有回合身份,退回按 pid`);
  }
  assert.equal(backgroundTurnKey(null), null);
  assert.equal(backgroundTurnKey({ turnEpoch: 2 }), null, '没有 pid 就没有回合身份');
}

// ── ② 判据 ────────────────────────────────────────────────────
{
  const T1 = 'sdk-1#1';
  const T2 = 'sdk-1#2';
  assert.deepEqual(nextReattachGuard({ guard: null, backgroundPid: PID, backgroundTurn: T1, streaming: false }),
    { guard: T1, reattach: true }, '首次发现后台回合 → 接,闩锁记回合身份');
  assert.deepEqual(nextReattachGuard({ guard: T1, backgroundPid: PID, backgroundTurn: T1, streaming: false }),
    { guard: T1, reattach: false }, '同一回合的后续轮询不得重复接');
  assert.deepEqual(nextReattachGuard({ guard: T1, backgroundPid: PID, backgroundTurn: T2, streaming: false }),
    { guard: T2, reattach: true }, '同一 pid 上的新回合必须接(闩锁停在上一回合不算"接过了")');
  assert.deepEqual(nextReattachGuard({ guard: T1, backgroundPid: PID, backgroundTurn: T2, streaming: true }),
    { guard: T1, reattach: false }, '本地正在流时新回合也不接');
  // 裸 pid 闩:被接管(detached)/ 三振出局 / 用户转后台都直接写 String(pid) —— 整个进程都不自动接,新回合也一样。
  assert.deepEqual(nextReattachGuard({ guard: PID, backgroundPid: PID, backgroundTurn: T2, streaming: false }),
    { guard: PID, reattach: false }, '裸 pid 闩下新回合也不得自动接(否则被接管方回连反踢、三振保护被打穿)');
  // 没有回合身份(旧服务端)→ 与改动前逐字同口径。
  assert.deepEqual(nextReattachGuard({ guard: null, backgroundPid: PID, streaming: false }), { guard: PID, reattach: true });
  assert.deepEqual(nextReattachGuard({ guard: PID, backgroundPid: PID, streaming: false }), { guard: PID, reattach: false });
  // 收尾三态不变:done 清闩;takeover / dropped 不清(回合身份闩同样适用)。
  assert.equal(nextReattachGuard({ guard: T1, streamEnd: 'done' }).guard, null);
  assert.equal(nextReattachGuard({ guard: T1, streamEnd: 'takeover' }).guard, T1);
  assert.equal(nextReattachGuard({ guard: T1, streamEnd: 'dropped' }).guard, T1);
  // 进程真闲下来(无 pid 无本地流)照旧清闩;在流时的 null 不算。
  assert.deepEqual(nextReattachGuard({ guard: T1, backgroundPid: null, backgroundTurn: null, streaming: false }), { guard: null, reattach: false });
  assert.deepEqual(nextReattachGuard({ guard: T1, backgroundPid: null, backgroundTurn: null, streaming: true }), { guard: T1, reattach: false });
}

// ── ③ 时间线:按 App.jsx 的接线跑 React 语义 ────────────────────
/**
 * 模拟一个窗格:poll(entry) = 共用轮询交来的本会话 chat-process 条目(null = 没在跑 / idle);
 * effect 依赖 deps(state) 变了才重跑(React 的 Object.is 逐项比较)。wiring='turn' 是改后的接线,'pid' 是改前的。
 */
function makePane(wiring) {
  const st = { backgroundPid: null, backgroundTurn: null, nonce: 0 };
  let guard = null;          // reattachedPidRef.current
  let streaming = false;     // streamingRef.current
  const attaches = [];       // 每次真正发起的 reattach(GET /api/chat/<pid>/stream)
  const depsOf = () => (wiring === 'turn' ? [st.backgroundPid, st.backgroundTurn, st.nonce] : [st.backgroundPid, st.nonce]);
  let lastDeps = null;
  const runEffectIfDepsChanged = () => {
    const deps = depsOf();
    if (lastDeps && deps.length === lastDeps.length && deps.every((v, i) => Object.is(v, lastDeps[i]))) return;
    lastDeps = deps;
    const r = nextReattachGuard({ guard, backgroundPid: st.backgroundPid, streaming,
      ...(wiring === 'turn' ? { backgroundTurn: st.backgroundTurn } : {}) });
    guard = r.guard;
    if (r.reattach) { attaches.push(wiring === 'turn' ? (st.backgroundTurn || st.backgroundPid) : st.backgroundPid); streaming = true; }
  };
  runEffectIfDepsChanged(); // 挂载时 effect 跑一次
  return {
    get guard() { return guard; },
    get streaming() { return streaming; },
    attaches,
    poll(entry) {
      // 与 App.jsx poll 同口径:本地在流时写 null。
      const next = entry && !streaming ? String(entry.pid) : null;
      st.backgroundPid = next;
      st.backgroundTurn = next ? backgroundTurnKey(entry) : null;
      runEffectIfDepsChanged();
    },
    streamEnds(streamEnd) {
      streaming = false;
      guard = nextReattachGuard({ guard, streamEnd }).guard;
    },
  };
}

const running = (epoch) => ({ pid: PID, turnEpoch: epoch, status: 'starting' });

// 失败形态 A:打开会话时接了上一回合(epoch 1,结果已出、还在等输入预测),这条流很短、期间没有轮询;
// 上一回合 done → 40–70ms 后同一 pid 开新回合(epoch 2),下一次轮询直接看到新回合,看不到中间空闲。
for (const wiring of ['pid', 'turn']) {
  const pane = makePane(wiring);
  pane.poll(running(1));               // 打开会话:发现后台回合 → 接
  assert.deepEqual(pane.attaches, [wiring === 'turn' ? 'sdk-1#1' : PID], `${wiring}:打开会话时接上一回合`);
  pane.streamEnds('done');             // 上一回合收尾(turn-complete 同刻)
  pane.poll(running(2));               // xs:turn 触发的立即探测:同一 pid 的新回合
  if (wiring === 'pid') {
    assert.equal(pane.attaches.length, 1, '对照:改前的接线(只按 pid)在这条时间线上不接新回合 —— 正是 P21 偶发失败的形态');
  } else {
    assert.deepEqual(pane.attaches, ['sdk-1#1', 'sdk-1#2'], '同一 pid 紧跟着开始的新回合必须重新接流');
  }
}

// 失败形态 B:上一回合的接流期间轮询照常写过 null(本地在流),上一回合的流以 done 收尾;新回合到来前没有一次
// 轮询看到 idle。改后接线照样只接一次新回合;同一回合后续轮询不重复接。
{
  const pane = makePane('turn');
  pane.poll(running(1));
  pane.poll(running(1));               // 流期间:写 null
  pane.streamEnds('done');
  pane.poll(running(2));
  pane.poll(running(2));               // 新回合流期间的轮询:写 null
  pane.poll(running(2));
  assert.deepEqual(pane.attaches, ['sdk-1#1', 'sdk-1#2'], '新回合只接一次,流期间的轮询不重复接');
}

// 隔了一会儿才开始的新回合(中间轮询看到过 idle)照旧能接。
{
  const pane = makePane('turn');
  pane.poll(running(1));
  pane.streamEnds('done');
  pane.poll(null);                     // idle:进程闲下来
  pane.poll(running(2));
  assert.deepEqual(pane.attaches, ['sdk-1#1', 'sdk-1#2']);
}

// 上一回合的流被提前收尾(例如回放到缓冲里的 done),state 没变:同一回合不再接;新回合照接。
{
  const pane = makePane('turn');
  pane.poll(running(1));
  pane.streamEnds('done');             // 打开即收尾,期间无轮询
  pane.poll(running(1));               // 同一回合还在收尾:值没变,effect 不重跑
  assert.equal(pane.attaches.length, 1, '同一回合 state 未变时不重复接');
  pane.poll(running(2));
  assert.deepEqual(pane.attaches, ['sdk-1#1', 'sdk-1#2']);
}

// 被别的视图接管(detached → 闩写裸 pid)后,同一进程的新回合不自动接(否则两边互踢)。
{
  const pane = makePane('turn');
  pane.poll(running(1));
  pane.streamEnds('takeover');
  // App.jsx 的 detached 分支先把闩写成 String(pid),收尾时 takeover 保持。
  const afterTakeover = nextReattachGuard({ guard: PID, streamEnd: 'takeover' }).guard;
  assert.equal(afterTakeover, PID);
  const r = nextReattachGuard({ guard: afterTakeover, backgroundPid: PID, backgroundTurn: 'sdk-1#2', streaming: false });
  assert.equal(r.reattach, false, '被接管后同一进程的新回合不得自动回连');
}

// 本地正在流(用户自己发的回合)时新回合也不接。
{
  const pane = makePane('turn');
  pane.poll(running(1));               // 接上 epoch 1,此刻 streaming
  pane.poll(running(2));               // 流还没结束:写 null,不接
  assert.deepEqual(pane.attaches, ['sdk-1#1']);
}

// ── ④ 源码契约 ────────────────────────────────────────────────
{
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /setBackgroundTurn\(next \? backgroundTurnKey\(hit\) : null\);/,
    '轮询必须与 backgroundPid 同口径写回合身份(本地在流时为 null)');
  assert.match(app, /nextReattachGuard\(\{\s*guard: reattachedPidRef\.current, backgroundPid, streaming: streamingRef\.current, backgroundTurn,\s*\}\)/,
    'auto-reattach effect 必须把回合身份交给判据');
  assert.match(app, /\}, \[backgroundPid, backgroundTurn, attachRetryNonce\]\);/,
    'auto-reattach effect 必须依赖回合身份(同 pid 新回合时 backgroundPid 不变,effect 靠它重跑)');
  const agents = readFileSync(new URL('../../server/routes/agents.js', import.meta.url), 'utf8');
  assert.match(agents, /kind: 'chat-process',[\s\S]{0,1600}?turnEpoch: p\.turnEpoch \| 0,/,
    '/api/agents/active 的 chat-process 条目必须带 turnEpoch(只新增字段)');
  const chat = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  assert.match(chat, /turnEpoch: slot\.turnEpoch \| 0,/, 'getActiveChatProcesses 必须给出 turnEpoch');
  assert.match(chat, /s\.turnEpoch = \(s\.turnEpoch \| 0\) \+ 1;/, '复用常驻进程开新回合时回合代数加一(回合身份成立的前提)');
}

console.log('PASS check-r151c-reattach-turn');
