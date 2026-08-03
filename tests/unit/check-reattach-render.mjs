#!/usr/bin/env node
// reattach(流式中切走再切回)渲染口径护栏 —— 直接 import 真实实现(client/src/utils/reattach.js),
// 不复刻逻辑,改坏了这里必红。
// 锁住的行为:
//   ① reattach 一律不截断历史(旧的 { sinceTs: detachTs } 按 turn 粒度过滤,对在跑的回合
//      恒失效 → 内容既在历史卡又被重放进流式气泡 = 一条回复被劈成两个气泡);
//   ② 正常发送的截断口径不变({ sinceTs: 起流时刻 }),分屏/普通发送零行为变化;
//   ③ reattach 期间用 SSE 事件节流刷历史(1.5s),回合结束 force 立刻收尾;
//   ④ 非 reattach 永不触发这条刷新(不给正常流加任何额外请求)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REATTACH_REFRESH_MS,
  histSig,
  isCurrentStreamTurn,
  resolveStreamHistCutoff,
  shouldRefreshHist,
} from '../../client/src/utils/reattach.js';

// ── ① / ② 截断口径 ────────────────────────────────────────────
{
  const now = 1_700_000_000_000;
  assert.equal(resolveStreamHistCutoff(true, now), null, 'reattach:不截断,历史完整显示在跑的 turn');
  assert.deepEqual(resolveStreamHistCutoff(false, now), { sinceTs: now }, '正常发送:仍按起流时刻截断(行为不变)');
}

// ── ③ 节流:够 1.5s 才刷 ───────────────────────────────────────
{
  assert.equal(REATTACH_REFRESH_MS, 1500, '节流窗按 CLI 每条 assistant 记录 1-3s 落盘取 1.5s');
  const base = 10_000;
  const o = (dt, extra) => ({ isReattach: true, now: base + dt, lastAt: base, ...extra });
  assert.equal(shouldRefreshHist(o(0)), false, '刚刷过:不重复请求');
  assert.equal(shouldRefreshHist(o(1499)), false, '未到窗口:不刷');
  assert.equal(shouldRefreshHist(o(1500)), true, '边界即到:刷(>= 而非 >)');
  assert.equal(shouldRefreshHist(o(9000)), true, '超窗:刷');
  assert.equal(shouldRefreshHist(o(0, { force: true })), true, '回合结束 force:无视节流,立刻收尾刷');
  assert.equal(shouldRefreshHist(o(300, { intervalMs: 200 })), true, 'intervalMs 可覆写');
}

// ── ④ 非 reattach 一律不刷(含 force) ─────────────────────────
{
  const o = (extra) => ({ isReattach: false, now: 99_999, lastAt: 0, ...extra });
  assert.equal(shouldRefreshHist(o()), false, '正常发送:流式气泡实时画,不刷历史');
  assert.equal(shouldRefreshHist(o({ force: true })), false, 'force 也不能给正常发送开这条路径');
}

// ── ⑤ 回合 generation:新回合尚无 pid 时旧 finally 也不得清理 ─────
{
  let currentToken = 0;
  const turn1Token = ++currentToken;
  const state = {
    messages: ['turn-1 reply'],
    streamHistCutoff: { sinceTs: 100 },
    reattachStream: true,
  };

  // turn-2 已同步进入起流、写入用户消息，但 checkpoint/provider 和 /api/chat 仍在等待，
  // 所以 pid 还是 null。旧实现只看 pid 会误清；generation 必须立刻判 turn-1 已过期。
  const turn2Token = ++currentToken;
  state.messages.push('turn-2 user');
  const turn2Pid = null;
  assert.equal(turn2Pid, null, '场景前提:turn-2 尚未拿到 pid');
  assert.equal(isCurrentStreamTurn(currentToken, turn1Token), false,
    'turn-2 一进入起流就应使 turn-1 finalize 失效,不能等待 pid');
  if (isCurrentStreamTurn(currentToken, turn1Token)) {
    state.messages = [];
    state.streamHistCutoff = null;
    state.reattachStream = false;
  }
  assert.deepEqual(state, {
    messages: ['turn-1 reply', 'turn-2 user'],
    streamHistCutoff: { sinceTs: 100 },
    reattachStream: true,
  }, 'turn-1 不得清理 turn-2 的消息、截断或 reattach 状态');
  assert.equal(isCurrentStreamTurn(currentToken, turn2Token), true,
    'turn-2 自己仍拥有最终清理权');
}

// ── ⑥ 源码契约:token 必须早于起流状态/用户消息,finally 清理只认 token ──
{
  const src = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const tokenAt = src.indexOf('const streamTurnToken = ++streamTurnTokenRef.current;');
  const streamingAt = src.indexOf('updateStreaming(true);', tokenAt);
  const userMessageAt = src.indexOf("userMsgUuid = 'chat-user-'", tokenAt);
  assert.ok(tokenAt >= 0 && tokenAt < streamingAt && tokenAt < userMessageAt,
    '回合 token 必须在 updateStreaming(true) 和写用户消息前同步取得');
  assert.match(
    src,
    /if \(isCurrentTurn\(\)\) \{\s*setStreamHistCutoff\(null\);\s*setReattachStream\(false\);\s*\}/,
    'finally 的截断/reattach 复位必须只由当前 token 执行',
  );
  assert.doesNotMatch(src, /const newRoundStarted = \(\) => activeProcRef\.current != null/,
    'finally 不得再用 pid 判断新回合是否开始');
  assert.equal((src.match(/setReattachStream\(false\)/g) || []).length, 1,
    'reattachStream 只应有 finally 那一处复位:多一处裸复位就绕开回合守卫');
  assert.equal((src.match(/setReattachStream\(/g) || []).length, 2,
    'setReattachStream 全仓只应有 2 个调用点(起流置位 + finally 复位)');
  assert.match(src, /if \(histRefreshInFlight\) return;/,
    'reattach 历史刷新必须有 in-flight 去重,慢盘时别把 /messages 请求叠罗汉');
}

// ── ⑦ histSig:「历史真的长出新内容了吗」的判据(批J J2 的"上次更新 N 秒前")──
// 只在内容变化时变。恒变(如掺进 Date.now())会让状态行恒显"0 秒前";恒不变则永远
// 显示一个越来越大的数字 —— 两种坏法都让这行状态回答不了"是在跑还是卡死"。
{
  const turn = (over = {}) => ({
    uuid: 'u1', blocks: [{ type: 'text' }], toolCalls: [], text: ['abc'], ...over,
  });
  assert.equal(histSig(turn()), histSig(turn()), '同样内容必须得到同样签名(纯函数)');
  assert.equal(histSig(null), '', '空历史不得抛错');
  assert.equal(histSig(undefined), '', '空历史不得抛错');
  // 四条变化通道各自都要被捕捉到
  assert.notEqual(histSig(turn()), histSig(turn({ uuid: 'u2' })), '换了回合(uuid)必须判为更新');
  assert.notEqual(histSig(turn()), histSig(turn({ blocks: [{}, {}] })),
    'CLI 每写一条 assistant 记录就多一个块 —— 这是最主要的增长信号');
  assert.notEqual(histSig(turn()), histSig(turn({ toolCalls: [{ id: 't' }] })), '新工具调用必须判为更新');
  assert.notEqual(histSig(turn()), histSig(turn({ text: ['abcd'] })), '末段文本变长必须判为更新');
  // 字段缺失(第三方 provider 形态不全)不得抛错
  assert.doesNotThrow(() => histSig({ uuid: 'x' }));
  assert.doesNotThrow(() => histSig({ text: 'not-an-array' }));
}

// ── ⑧ 源码契约:被接管从"猜"改成服务端明说(批J J2)────────────────────
{
  const src = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  // 服务端必须真的发这条事件,否则客户端的 detached 分支永远等不到 → 退回没有恢复的状态。
  assert.match(server, /type: 'detached', reason: 'takeover'/,
    '服务端必须在接管旧连接前发 detached 事件');
  assert.match(src, /if \(event\.type === 'detached'\)/,
    '客户端必须有 detached 分支(被接管的唯一权威判据)');
  // 五条件猜测判定必须已删:WebView/网络掐断 SSE 与被接管是同一形态,猜错一次就把
  // reattach 闩锁焊死(本回合内永不重连)。
  assert.doesNotMatch(src, /if \(!sawDoneEvent && !sawError && !controller\.signal\.aborted/,
    '"无 done 静默结束 = 被接管"的猜测判定必须删除,改由服务端 detached 明说');
  // 其余静默掉线一律走三振重试路径。
  assert.match(src, /if \(!sawDoneEvent && !sawTakeover && !sawError[\s\S]{0,160}recoverAttach\(\);/,
    '静默掉线(非接管、非报错、非本端 abort)必须走 recoverAttach 重连');
  assert.equal((src.match(/recoverAttach\(\);/g) || []).length, 2,
    'recoverAttach 应有且只有两个调用点:attach 非 2xx + 流被静默掐断');
  // 三振计数的复位判据:必须是"本流真的跑完(done)",不能是"attach 拿到 2xx"——
  // 被掐断的流每次都能 attach 成功,按 2xx 复位会让三振保护变成死代码、无限重连。
  assert.match(src, /if \(sawDoneEvent\) attachFailRef\.current = null;/,
    'attach 失败计数只许在收到 done 时复位');
  assert.equal((src.match(/attachFailRef\.current = null/g) || []).length, 2,
    'attachFailRef 复位点只应有 2 处(done 收尾 + 三振横幅的重试按钮)');
  // 重试按钮的 nonce 必须进 auto-reattach effect 的 deps,否则 pid 不变时 Object.is 短路,
  // effect 永不重跑 = 按钮点了没反应(已知坑)。
  assert.match(src, /\}, \[backgroundPid, attachRetryNonce\]\);/,
    'auto-reattach effect 的 deps 必须含 attachRetryNonce');
  assert.doesNotMatch(src, /会话流连接失败,请切走再切回重试。/,
    '三振文案不得再让用户"切走再切回"猜复位动作,改为横幅上的重试按钮');
}

console.log('✅ check-reattach-render: reattach 截断口径 + 刷新节流 + generation 收尾守卫 + 接管明说 全部通过');
