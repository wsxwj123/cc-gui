#!/usr/bin/env node
// 批B B1:关窗格时 detach SSE(抽 detachStream,与切会话共用)。
// 回归对象:关掉分屏窗格从不 abort 客户端 SSE → 服务端 slot.attached 永远为真 →
// 重新打开该会话时 attach 吃 409 → 循环一秒死 → 窗格永久空白,只剩"后台工作中"横幅
// (而横幅承诺的"自动追加"通道根本不存在)。切会话有 abort、关窗格没有,两条路径非对称
// 正是根因,故抽成同一个函数,任何一条改了另一条自动跟随。
// 纯 JSX 内联逻辑不能真 import,用源码守卫 + 复刻状态机双保险。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { nextAttachTry } from '../../client/src/utils/reattach.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');

// ── 1. detachStream 存在,且切会话路径确实改用了它 ──────────────────
assert.ok(/const detachStream = useCallback\(/.test(src),
  'App.jsx 必须有 const detachStream = useCallback(...)');
assert.ok(/useEffect\(\(\) => detachStream[,)]/.test(src),
  'SessionDetail 必须有卸载 effect:useEffect(() => detachStream, [detachStream])——关窗格的唯一 detach 入口');

// 切会话 effect 里那段"abort + 清 activeProcRef"必须已经换成 detachStream(),
// 不能两条路径各写一份(漂移就是本 bug 的成因)。
{
  const i = src.indexOf('// Do NOT POST /api/chat/:pid/stop here');
  assert.ok(i > 0, '切会话 detach 段的定位注释不该被删');
  const seg = src.slice(i, i + 260);
  assert.ok(/detachStream\(\);/.test(seg), '切会话 detach 段必须调用 detachStream()');
  assert.ok(!/abortRef\.current\.abort\(\)/.test(seg),
    '切会话 detach 段不得再内联 abortRef.current.abort()(要走 detachStream 共用)');
}

// ── 2. detachStream 只做两件事,绝不含 setState / POST stop ──────────
{
  const i = src.indexOf('const detachStream = useCallback(');
  const body = src.slice(i, src.indexOf('}, []);', i) + 7);
  assert.ok(/abortRef\.current\.abort\(\)/.test(body), 'detachStream 必须 abort 本端 fetch');
  assert.ok(/activeProcRef\.current = null/.test(body), 'detachStream 必须清 activeProcRef');
  assert.ok(!/\/stop/.test(body), 'detachStream 绝不能 POST /stop —— detach 不杀进程');
  assert.ok(!/\bset[A-Z]/.test(body) && !/updateStreaming/.test(body),
    'detachStream 不得含任何 setState:卸载路径会调它,组件正在拆除');
  // handleBackgroundify 的语义是"留在本会话但转后台",多做 reattachedPidRef/backgroundedRef,
  // 不能并进 detachStream —— 并了会让切会话/关窗格也抑制 auto-reattach。
  assert.ok(!/reattachedPidRef|backgroundedRef/.test(body),
    'detachStream 不得掺 backgroundify 的 reattachedPidRef/backgroundedRef');
  // 三振重试排的 1.5s 定时器:不在这里清,卸载/切走之后它照样触发 handleSendRef,
  // 起一条没人要的僵尸 attach。
  assert.ok(/clearTimeout\(attachRetryTimerRef\.current\)/.test(body),
    'detachStream 必须 clearTimeout(attachRetryTimerRef.current) —— 否则留 1.5s 僵尸 attach 缝隙');
}

// ── 3. SplitMain 必须用稳定 paneId 当 key,不能用数组下标 ────────────
// 用下标当 key 时,关掉 pane i 会让 React 复用该实例给"补位上来"的窗格 →
// 本次新增的卸载 detach 会从修复变成回归放大器(关一个窗格把别人的流也断了)。
{
  const i = src.indexOf('function SplitMain(');
  assert.ok(i > 0, '找不到 SplitMain');
  const seg = src.slice(i, i + 6000);
  assert.ok(/const paneKey = \(paneIds && paneIds\[i\]\)/.test(seg),
    'paneKey 必须由 paneIds[i] 推导(稳定 id),不能改成位置派生');
  assert.ok(/<React\.Fragment key=\{paneKey\}>/.test(seg), '窗格 Fragment 必须 key={paneKey}');
  assert.ok(!/<React\.Fragment key=\{i\}/.test(seg) && !/<React\.Fragment key=\{`pane-\$\{i\}`\}/.test(seg),
    '窗格 key 不得直接用下标 i 或 `pane-${i}`(那是 paneIds 缺失时的兜底,不能当唯一来源)');
}
// closePane 必须让 paneIds 与 paneSessions 同步 splice,否则幸存窗格 key 变化 = 全体重挂
{
  const store = readFileSync(join(root, 'client/src/stores/sessionStore.js'), 'utf8');
  const i = store.indexOf('closePane: (i) =>');
  assert.ok(i > 0, '找不到 closePane');
  const seg = store.slice(i, i + 2200);
  assert.ok(/ids\.splice\(i, 1\)/.test(seg) && /sessions\.splice\(i, 1\)/.test(seg),
    'closePane 必须让 paneIds 与 paneSessions 同步 splice(错位会让幸存窗格换 key 被重挂)');
}

// ── 4. 复刻 detachStream 的作用:幂等 + null 不抛 ────────────────────
{
  const mkPane = () => {
    const abortRef = { current: null };
    const activeProcRef = { current: null };
    let aborts = 0;
    const detachStream = () => {
      if (abortRef.current) { try { abortRef.current.abort(); } catch { /* 已 abort */ } abortRef.current = null; }
      activeProcRef.current = null;
    };
    return { abortRef, activeProcRef, detachStream, aborted: () => aborts, mkCtrl: () => ({ abort: () => { aborts++; } }) };
  };

  // ① 挂载瞬间(无流)调 cleanup:纯 no-op,不抛 —— StrictMode 的 mount→cleanup→mount 走这条
  {
    const p = mkPane();
    assert.doesNotThrow(() => { p.detachStream(); p.detachStream(); });
    assert.equal(p.aborted(), 0, '无流时 detach 不该 abort 任何东西');
  }
  // ② 有流时 detach:abort 一次,ref 清空
  {
    const p = mkPane();
    p.abortRef.current = p.mkCtrl();
    p.activeProcRef.current = 'sdk-7';
    p.detachStream();
    assert.equal(p.aborted(), 1);
    assert.equal(p.abortRef.current, null);
    assert.equal(p.activeProcRef.current, null);
    // ③ 二次调用幂等(切会话已 detach 过 → 随后卸载再调一次,不重复 abort)
    p.detachStream();
    assert.equal(p.aborted(), 1, '二次 detach 必须幂等,不得重复 abort');
  }
  // ④ abort() 自身抛错也要吞掉(卸载路径不能因此炸整棵树)
  {
    const p = mkPane();
    p.abortRef.current = { abort: () => { throw new Error('boom'); } };
    assert.doesNotThrow(() => p.detachStream());
    assert.equal(p.abortRef.current, null, 'abort 抛错也要清 ref');
  }
}


// ── 5. B3:attach 非 2xx 不再静默,且重试机制真能跑到上限 ─────────────
// 修前①:409 的响应体是 JSON,逐行解析一条 `data: ` 都匹配不到 → 循环空转一圈就结束、
// 不抛错 → 只剩后台横幅,而 reattachedPidRef 已被赋值,同一 pid 永不重试。
// 修前②(审查揪出):失败计数没按 pid 记,还指望 backgroundPid 轮询驱动重试 —— 轮询每轮
// setBackgroundPid(同一个 pid 字符串) 被 Object.is 短路,effect 根本不重跑,"三振出局"
// 是永远够不着的死代码。
// 批J J2:恢复逻辑抽成 recoverAttach,两个调用点共用(attach 非 2xx + 流被静默掐断)。
// 下面按 recoverAttach 的函数体核对,再核对非 2xx 分支确实调它。
{
  const i = src.indexOf('const recoverAttach = () => {');
  assert.ok(i > 0, 'attach 断链的恢复逻辑必须抽成 recoverAttach(两处共用,避免漂移)');
  const seg = src.slice(i, i + 1800);
  assert.ok(/reattachedPidRef\.current = null/.test(seg),
    '恢复时必须清 reattachedPidRef,否则同一 pid 永不重试');
  assert.ok(/nextAttachTry\(attachFailRef\.current, String\(pid\), ATTACH_MAX_TRIES\)/.test(seg),
    '失败计数必须按 pid 记(nextAttachTry),裸自增会把上一个进程的账算到下一个头上');
  assert.ok(/attachRetryTimerRef\.current = setTimeout\(\(\) => \{[\s\S]{0,400}?reattachPid: pid/.test(seg),
    '未到上限必须自己排定时器重连(id 挂 attachRetryTimerRef,供 detachStream 清)—— 靠 backgroundPid 轮询等于不重试');
  assert.ok(/if \(streamingRef\.current \|\| reattachedPidRef\.current\) return;/.test(seg),
    '重试前必须复查:已有流 / 已被别处接管就放弃');
  assert.ok(/getLocalSession\(\)\?\.sessionId !== streamSid\) return;/.test(seg),
    '重试前必须复查本 pane 没切走');
  assert.ok(/tries\.exhausted/.test(seg) && /sticky: true/.test(seg),
    '到上限要亮【可关闭且不自动消失】的提示');
  assert.ok(/retryPid: String\(pid\)/.test(seg),
    'sticky 提示要带 retryPid,横幅上的「重试」按钮据此清对应 pid 的计数');
  // 判官 B1:三振分支必须【重新上闩】。本函数开头刚清空闩锁,而流式期间 poll 恒写
  // backgroundPid=null,流一关 poll 就把 pid 翻回来 → auto-reattach effect 两条早退
  // (!backgroundPid / 已 reattach)都不命中 → 照样自动重连,三振拦不住任何东西,
  // 且 attach 2xx 会把刚挂上的 sticky 横幅清掉,用户只看见它闪一下。
  const exI = seg.indexOf('if (tries.exhausted) {');
  const exSeg = seg.slice(exI, seg.indexOf('return;', exI));
  assert.ok(exI > 0 && /reattachedPidRef\.current = String\(pid\)/.test(exSeg),
    '三振分支 return 前必须重新上闩(reattachedPidRef),否则 poll 会绕过三振继续自动重连');

  const j = src.indexOf('if (!streamRes.ok) {');
  assert.ok(j > i, 'handleSend 必须显式处理 attach 非 2xx');
  const seg2 = src.slice(j, j + 1200);
  assert.ok(/fetchMessagesForTab\(streamSid, streamOwnerPh/.test(seg2),
    '必须回落重拉历史(用发起时闭包的 sid/ph,不得读 getLocalSession)');
  assert.ok(/recoverAttach\(\);/.test(seg2), '非 2xx 必须走 recoverAttach');
  // 计数复位判据:必须是"本流真跑完(done)"而非"attach 拿到 2xx"——被中途掐断的流每次都
  // attach 成功,按 2xx 复位会让三振保护成死代码,坏传输每 1.5s 无限重连。
  assert.ok(/if \(sawDoneEvent\) attachFailRef\.current = null;/.test(src),
    'attach 失败计数只许在收到 done 时复位');
  // sticky 横幅不会自己过期(下面豁免了 5s 定时器),attach 成功后不清就一直挂着报错。
  assert.ok(/setProviderSwitchNotice\(\(n\) => \(n\?\.sticky \? null : n\)\);/.test(src.slice(j, j + 2000)),
    'attach 成功必须清掉三振留下的 sticky 失败横幅(函数式更新,避开闭包陈旧值)');
  // 提前 return 只能落在 try 内(要走 finally 完成 finalizeInFlightRef 的 -1)
  assert.ok(seg2.indexOf('return;') < seg2.indexOf('const reader'), '提前 return 必须在取 reader 之前');
}
// sticky 提示不许被 5s 定时器清掉
assert.ok(/if \(!providerSwitchNotice \|\| providerSwitchNotice\.sticky\) return;/.test(src),
  'sticky 提示必须豁免 5s 自动清除,否则用户还没看清就没了');

// ── 6. 致命1:被接管的一方不得自动回连(否则两个视图无限互踢)───────────
// 链条:窗格A 流式中 → poll 因 !streamingRef 恒写 backgroundPid=null → 清空分支把 A 的
// reattach 守卫清掉 → 第二视图B attach 接管踢掉 A → A 的流结束 → finally 关流 → 下轮 poll
// null→P 翻转 → 守卫已空 → A 回连反踢 B → B 对称 → 每 1.5~3s 互踢无限循环。
// 批J J2:判据从"无 done 却正常结束"(猜)改成服务端明发的 detached 事件(明说)——
// WebView 空闲掐断 / 断网与被接管是同一形态,猜错一次就把 reattach 闩死、本回合永不重连。
// 互踢那条不变量原样保留,只是触发它的判据换了权威来源。
{
  const i = src.indexOf("if (event.type === 'detached')");
  assert.ok(i > 0, '必须有 detached 分支(被接管的唯一权威判据)');
  const seg = src.slice(i, i + 400);
  assert.ok(/reattachedPidRef\.current = String\(pid\)/.test(seg),
    '被接管后必须抑制本 pid 自动回连(与转后台同一手法),否则互踢');
  assert.ok(/sawTakeover = true/.test(seg),
    '被接管要记账,否则下面的静默掉线分支会再叠一次重连 = 回连反踢');
  // 服务端得真发这条事件,否则客户端分支永远等不到 → 退回没有恢复的形态。
  const server = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  assert.ok(/type: 'detached', reason: 'takeover'/.test(server),
    '服务端必须在 end 掉被接管的旧连接之前发 detached 事件');
  // 静默掉线(非接管、非报错、非本端 abort)= 传输断了,走三振重连;误判成"被接管"就是原 bug。
  assert.ok(/!sawDoneEvent && !sawTakeover && !sawError\s*\n?\s*&& !controller\.signal\.aborted && !killedRef\.current && !backgroundedRef\.current/.test(src),
    '静默掉线判据 = 没 done + 没被接管 + 本流没报错 + 不是本端 abort/停止/转后台');
  // 7 个错误分支都是 `sawError = true; break`,同样"无 done 结束"。少了 !sawError,
  // 一次上游报错就会触发一轮没意义的重连。
  assert.ok(src.split('sawError = true;').length - 1 >= 7,
    '错误分支应仍以 sawError=true 收尾(判据依赖它)');
  assert.ok(/if \(event\.type === 'done'\) \{ sawDoneEvent = true; break; \}/.test(src),
    'done 事件必须记账,否则"没收到 done"判据恒真、正常收尾也会被当成掉线去重连');
}
// 双保险:流式期间的 backgroundPid=null 不是"进程没了",不许当重置信号
assert.ok(/if \(!backgroundPid\) \{ if \(!streamingRef\.current\) reattachedPidRef\.current = null; return; \}/.test(src),
  '清空分支必须带 !streamingRef 门控 —— 流式期间 poll 恒写 null,清守卫会让被接管方立刻回连反踢');

// ── 7. 复刻:pid 键计数 + 三振 + 提前 return 仍走 finally ────────────────
{
  const attachFailRef = { current: null };
  let inFlight = 0;
  let notice = null;
  let scheduled = 0;
  // 复刻 handleSend 的 try/finally 骨架:+1 在 try 第一行,-1 在 finally。
  const runAttach = (ok, pid) => {
    inFlight += 1;
    try {
      if (!ok) {
        const tries = nextAttachTry(attachFailRef.current, pid, 3);
        attachFailRef.current = tries;
        if (tries.exhausted) notice = { text: '会话流连接失败。', sticky: true, retryPid: pid };
        else scheduled += 1;
        return 'retry-scheduled';
      }
      // ok=true 只代表 attach 拿到 2xx。此处【不】清计数 —— 与真实代码一致
      // (App.jsx 是 `if (sawDoneEvent) attachFailRef.current = null;`):被中途掐断的流
      // 每次都能 attach 成功,按 2xx 清账会让计数每轮归零,三振永远够不着 = 死代码。
      return 'streaming';
    } finally {
      inFlight = Math.max(0, inFlight - 1);
    }
  };
  // 本流真的跑完(收到 done)才清账 —— 复位判据的唯一入口。
  const finishStream = () => { attachFailRef.current = null; };

  assert.equal(runAttach(false, 'sdk-1'), 'retry-scheduled');
  assert.equal(inFlight, 0, '提前 return 也必须走 finally,否则 finalizeInFlightRef 永久压死排空');
  assert.equal(scheduled, 1, '未到上限必须排重试');
  runAttach(false, 'sdk-1');
  assert.equal(notice, null, '第二次仍不打扰用户');
  runAttach(false, 'sdk-1');
  assert.ok(notice?.sticky, '第三次必须亮 sticky 提示');
  assert.equal(scheduled, 2, '到上限后不再排重试,不能无限重连');
  assert.equal(inFlight, 0);
  // 换了 pid = 另一个进程,旧账清零(修前的裸自增会让新进程一上来就三振)
  notice = null;
  assert.equal(nextAttachTry(attachFailRef.current, 'sdk-2', 3).count, 1, 'pid 变化必须重新计数');
  assert.equal(nextAttachTry(attachFailRef.current, 'sdk-2', 3).exhausted, false);
  // attach 成功【不】清账:被掐断的流每次都 attach 成功,清了三振就永远够不着
  attachFailRef.current = { pid: 'sdk-2', count: 2, exhausted: false };
  assert.equal(runAttach(true, 'sdk-2'), 'streaming');
  assert.deepEqual(attachFailRef.current, { pid: 'sdk-2', count: 2, exhausted: false },
    'attach 拿到 2xx 不得清账(真实代码只在收到 done 时清)');
  // 跑完一整条流(done)才清账
  finishStream();
  assert.equal(attachFailRef.current, null, '收到 done = 通道确实好使,此时才清账');
}

// ── 8. 复刻:互踢链路修复后的稳态(后 attach 者获胜,不再来回踢)──────────
{
  // 两个视图看同一个会话,轮流跑"attach → 被接管 → 是否回连"。
  const mkView = (name) => ({ name, streaming: false, guard: null });
  const server = { holder: null };
  const attach = (v, pid) => {
    const loser = server.holder;
    server.holder = v;
    v.streaming = true;
    v.guard = null;                     // 起流时清自己的守卫(handleSend 起点)
    if (loser && loser !== v) {         // 老连接被 end:reader 无 done 结束
      loser.streaming = false;
      loser.guard = String(pid);        // 致命1 修复:被接管 → 抑制自动回连
    }
  };
  // poll → auto-reattach effect(含双保险门控)
  const poll = (v, pid) => {
    const bg = v.streaming ? null : String(pid);
    if (!bg) { if (!v.streaming) v.guard = null; return false; }
    if (v.streaming) return false;
    if (v.guard === bg) return false;   // 已被接管 → 不回连
    attach(v, pid);
    return true;
  };
  const A = mkView('A'), B = mkView('B');
  attach(A, 'sdk-9');                   // A 先在跑
  attach(B, 'sdk-9');                   // 用户在第二个视图打开同会话 → B 接管
  assert.equal(server.holder, B, '后 attach 者获胜');
  assert.equal(A.streaming, false);
  // 之后无论轮询多少轮,都不能再有任何一方发起接管
  let flips = 0;
  for (let i = 0; i < 20; i++) { if (poll(A, 'sdk-9')) flips++; if (poll(B, 'sdk-9')) flips++; }
  assert.equal(flips, 0, '稳态:双方都不再回连,不存在互踢');
  assert.equal(server.holder, B, '持有者稳定在后 attach 的那一方');
  // 败者切走再切回(切会话 effect 清 guard)→ 可以主动夺回,且夺回后同样只有一次翻转
  A.guard = null;
  assert.equal(poll(A, 'sdk-9'), true, '切走再切回后败者可恢复');
  assert.equal(server.holder, A);
  flips = 0;
  for (let i = 0; i < 20; i++) { if (poll(A, 'sdk-9')) flips++; if (poll(B, 'sdk-9')) flips++; }
  assert.equal(flips, 0, '换手之后依然是稳态,不会退化成互踢');
}

console.log('✓ check-detach-stream: detachStream + 卸载 detach + 稳定 paneKey + attach 非 2xx/pid 键三振 + 被接管不回连,守卫全过');
