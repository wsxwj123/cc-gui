#!/usr/bin/env node
// reattach 闩锁(reattachedPidRef)护栏 —— 直接 import 真实实现
// (client/src/utils/reattach.js 的 nextReattachGuard),不复刻逻辑,改坏了这里必红。
//
// 防的事故(R5 用户实报「子代理都完成了 AI 还卡在那个状态」):
//   闩锁原本只有「backgroundPid state 变成 null 且此刻没有本地流」这一个复位入口,而轮询
//   在 reattach 流还跑着的时候就已经把 state 写成 null 了 → 这次跳变被「正在流,别清」那支
//   吃掉 → reattach 流真结束时 state 早已是 null、再写 null 被 Object.is 短路、effect 不再
//   运行 → 闩锁永远停在旧 pid。#26 会话常驻下整个会话共用一个 pid,于是「一个 pid 只
//   reattach 一次」= 一个会话只 reattach 一次:服务端进程第二次复活时横幅挂着、没有流、
//   也没有历史刷新,界面完全静止,只能切走再切回才复活。
//
// 锁住的行为:
//   ① 首次复活 → 发起 reattach 并上闩(同一次复活不重复接);
//   ② reattach 流以 done 正常收尾 → 清闩,下一次复活还能再接;
//   ③ takeover(服务端 detached)/ 传输掉线 → 【不清】闩(不互踢、不打穿三振重试);
//   ④ 连续两次复活 → 两次 reattach,不是一次;
//   ⑤ 本地正在流时的 backgroundPid=null 不算复位信号(轮询恒写 null);
//   ⑥ 横幅 backgroundWorking 有存在门槛,而 composer 的 isStreaming 口径一字不动。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BG_BANNER_DELAY_MS, nextReattachGuard } from '../../client/src/utils/reattach.js';

const PID = 'sdk-7';

// ── ① 首次复活:允许 reattach,并上闩 ────────────────────────────
{
  const r = nextReattachGuard({ guard: null, backgroundPid: PID, streaming: false });
  assert.deepEqual(r, { guard: PID, reattach: true },
    '首次发现后台进程(无本地流)必须发起 reattach 并把闩锁记成该 pid');
  // 同一次复活里轮询每 1.5s 再来一次:已经接过了,不许重复起流(会与自己互踢)。
  assert.deepEqual(nextReattachGuard({ guard: PID, backgroundPid: PID, streaming: false }),
    { guard: PID, reattach: false }, '同一次复活的后续轮询不得重复 reattach');
  // 本地已有流:进程有人听着,不该再接(接了就是自己踢自己)。
  assert.deepEqual(nextReattachGuard({ guard: null, backgroundPid: PID, streaming: true }),
    { guard: null, reattach: false }, '本地正在流时不得 reattach');
}

// ── ② reattach 以 done 收尾 → 清闩(本 bug 的修复点) ───────────
{
  const r = nextReattachGuard({ guard: PID, streamEnd: 'done' });
  assert.equal(r.guard, null,
    'reattach 流收到 done = 这一次复活接完了,必须清闩,否则第二次复活永不 reattach(界面静止)');
  assert.equal(r.reattach, false, '收尾本身不得直接触发新的 reattach(起流由轮询驱动)');
  // 清了闩之后,同一个 pid(#26 常驻会话全程同一个 pid)再复活必须能再接。
  assert.deepEqual(nextReattachGuard({ guard: r.guard, backgroundPid: PID, streaming: false }),
    { guard: PID, reattach: true }, '清闩后同一 pid 的下一次复活必须能再接');
}

// ── ③ takeover / 传输掉线 → 不清闩 ─────────────────────────────
{
  assert.equal(nextReattachGuard({ guard: PID, streamEnd: 'takeover' }).guard, PID,
    '被别的视图接管(服务端 detached)后清闩 = 立刻回连反踢对方,两边 1.5s 一轮互踢不停');
  assert.equal(nextReattachGuard({ guard: PID, streamEnd: 'dropped' }).guard, PID,
    '传输被静默掐断归 recoverAttach 的 per-pid 三振重试管,这里清闩会打穿三振保护');
  // 接管后的轮询照样命中同一个 pid —— 闩还在,所以不回连。
  assert.deepEqual(nextReattachGuard({ guard: PID, backgroundPid: PID, streaming: false }),
    { guard: PID, reattach: false }, '被接管后轮询再命中同一 pid 也不得自动回连');
}

// ── ④ 时间线:一个回合内连续两次复活 → 两次 reattach ────────────
// 走真实调用序(T5→T9,见 RESEARCH-r5-popup 的时序图),而不是单点断言。
{
  let guard = null;        // reattachedPidRef.current
  let streaming = false;   // streamingRef.current
  const reattaches = [];
  const poll = (backgroundPid) => {
    const r = nextReattachGuard({ guard, backgroundPid, streaming });
    guard = r.guard;
    if (r.reattach) { reattaches.push(backgroundPid); streaming = true; }
  };
  const streamEnds = (streamEnd) => { streaming = false; guard = nextReattachGuard({ guard, streamEnd }).guard; };

  poll(PID);        // T5 第一次复活(误发 done 之后进程又活了)
  poll(null);       // T7 reattach 流跑着,轮询恒写 null —— 这次跳变不许清闩
  assert.equal(guard, PID, 'reattach 流期间的 backgroundPid=null 不算复位信号');
  streamEnds('done'); // T8 reattach 流正常收尾
  poll(PID);        // T9 第二次复活:同一个 pid(常驻会话)
  assert.deepEqual(reattaches, [PID, PID],
    '一个回合内复活两次就要 reattach 两次;只接一次 = 第二次起横幅挂着、无流、无历史刷新');

  // 反面:若 T8 是被接管收尾,第二次复活必须【不】接(否则互踢)。
  const afterTakeover = nextReattachGuard({ guard: PID, streamEnd: 'takeover' }).guard;
  assert.equal(nextReattachGuard({ guard: afterTakeover, backgroundPid: PID, streaming: false }).reattach,
    false, '被接管收尾后不得因为"下一次复活"而回连');
}

// ── ⑤ 真正的复位信号:没进程也没本地流 ──────────────────────────
{
  assert.deepEqual(nextReattachGuard({ guard: PID, backgroundPid: null, streaming: false }),
    { guard: null, reattach: false }, '进程真闲下来(无 pid 无流)= 复位信号,清闩');
  assert.deepEqual(nextReattachGuard({ guard: PID, backgroundPid: null, streaming: true }),
    { guard: PID, reattach: false }, '本地正在流时的 null 是轮询恒写的,不得当复位信号');
  assert.doesNotThrow(() => nextReattachGuard({}), '缺参不得抛错(调用点在 effect 里)');
}

// ── ⑥ 源码契约 ────────────────────────────────────────────────
{
  const src = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  // 闩锁决策必须只走纯函数:裸的 `=== backgroundPid` 早退回来了就是绕开单测的旁路。
  assert.match(src, /const \{ guard, reattach \} = nextReattachGuard\(\{[\s\S]{0,160}\}\);/,
    'auto-reattach effect 必须走 nextReattachGuard');
  assert.doesNotMatch(src, /reattachedPidRef\.current === backgroundPid/,
    '闩锁比较不得再散落在 effect 里(旁路 = 单测测不到)');
  // done 收尾的复位点:必须带 reattachPid 门(只管 reattach 流)+ 三态 streamEnd。
  assert.match(src, /if \(reattachPid\) \{\s*reattachedPidRef\.current = nextReattachGuard\(\{/,
    'reattach 流收尾必须复位闩锁(本次修复点,删了它第二次复活就再次卡死)');
  assert.match(src, /streamEnd: sawDoneEvent \? 'done' : \(sawTakeover \? 'takeover' : 'dropped'\)/,
    '收尾三态必须由 sawDoneEvent / sawTakeover 判定,不得压成布尔');
  // 红线:composer 的 isStreaming 口径不许动 —— 它担着"后台跑着时禁止直发、走入队"。
  assert.match(src, /isStreaming=\{isStreaming \|\| !!backgroundPid\}/,
    'isStreaming 口径是入队门,一字不动');
  // 横幅门槛(方向 B):只门控 backgroundWorking。
  assert.match(src, /backgroundWorking=\{backgroundOnly && bgBannerDue\}/,
    '横幅必须走带存在门槛的派生态');
  assert.doesNotMatch(src, /backgroundWorking=\{!isStreaming && !!backgroundPid\}/,
    '横幅不得再直连轮询瞬时态(一次误判 done 就闪一下"后台工作中",语义正好反了)');
  assert.equal(BG_BANNER_DELAY_MS, 2000, '门槛取 2s:略大于 1.5s 轮询周期,盖住一轮自愈');
  // steer 已在 HTTP 前把队首持久化成 barrier，排空只需保留“转后台”互斥。
  assert.match(src, /if \(!backgroundedRef\.current\) \{/,
    '转后台期间仍不得排空；steer 由队首 barrier 防双发');
  assert.doesNotMatch(src, /acceleratingRef/, '不得退回跨条目共享的 accelerating 布尔锁');
  assert.match(src, /const next = queueKey === curKey \? useStore\.getState\(\)\.shiftMessage\(queueKey\) : null;/,
    '排空的 owner 归属校验必须原样保留(否则跨会话串扰 + 双 resume)');
}

console.log('✅ check-reattach-guard: 闩锁 done 复位 + takeover/掉线不清 + 两次复活两次接 + 横幅门槛 全部通过');
