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

// ── 5. B3:attach 非 2xx 不再静默(本文件并入,与 B1 同一条故障链)────────
// 修前:409 的响应体是 JSON,逐行解析一条 `data: ` 都匹配不到 → 循环空转一圈就结束、
// 不抛错 → finally 把 isStreaming 关掉 → 只剩后台横幅,而 reattachedPidRef 已被赋值,
// 同一 pid 永不重试 = 窗格永久没有追加通道。
{
  const i = src.indexOf('if (!streamRes.ok) {');
  assert.ok(i > 0, 'handleSend 必须显式处理 attach 非 2xx');
  const seg = src.slice(i, i + 1400);
  assert.ok(/reattachedPidRef\.current = null/.test(seg),
    '非 2xx 必须清 reattachedPidRef,否则同一 pid 永不重试');
  assert.ok(/attachFailRef\.current = \(attachFailRef\.current \|\| 0\) \+ 1/.test(seg), '必须累加失败次数');
  assert.ok(/fetchMessagesForTab\(streamSid, streamOwnerPh/.test(seg),
    '必须回落重拉历史(用发起时闭包的 sid/ph,不得读 getLocalSession)');
  assert.ok(/attachFailRef\.current >= 3/.test(seg), '必须有重试上限(3 次)后把错误亮给用户');
  assert.ok(/attachFailRef\.current = 0;/.test(src.slice(i, i + 1600)), 'attach 成功必须归零计数');
  // 提前 return 只能落在 try 内(要走 finally 完成 finalizeInFlightRef 的 -1)
  assert.ok(seg.indexOf('return;') < seg.indexOf('const reader'), '提前 return 必须在取 reader 之前');
}
// attach 预算随后台进程消失重置
assert.ok(/if \(!backgroundPid\) \{ reattachedPidRef\.current = null; attachFailRef\.current = 0; return; \}/.test(src),
  '后台进程消失时必须同时重置 attachFailRef,否则上个进程攒的失败次数会把下一个直接判死');

// ── 6. 复刻:三次累加后抛错、成功归零、提前 return 仍走 finally ──────────
{
  const attachFailRef = { current: 0 };
  let inFlight = 0;
  // 复刻 handleSend 的 try/finally 骨架:+1 在 try 第一行,-1 在 finally。
  const runAttach = (ok, status = 409) => {
    inFlight += 1;
    try {
      if (!ok) {
        attachFailRef.current = (attachFailRef.current || 0) + 1;
        if (attachFailRef.current >= 3) throw new Error(`连接失败(${status})`);
        return 'silent-retry';
      }
      attachFailRef.current = 0;
      return 'streaming';
    } finally {
      inFlight = Math.max(0, inFlight - 1);
    }
  };

  assert.equal(runAttach(false), 'silent-retry');
  assert.equal(inFlight, 0, '提前 return 也必须走 finally,否则 finalizeInFlightRef 永久压死排空');
  assert.equal(runAttach(false), 'silent-retry');
  assert.throws(() => runAttach(false), /连接失败/, '第三次必须把错误亮给用户,不再静默');
  assert.equal(inFlight, 0, '抛错路径同样要走 finally');
  assert.equal(attachFailRef.current, 3);
  // 成功一次即归零 —— 偶发 409 不该在几分钟后攒够 3 次误报
  attachFailRef.current = 2;
  assert.equal(runAttach(true), 'streaming');
  assert.equal(attachFailRef.current, 0);
}

console.log('✓ check-detach-stream: detachStream 抽取 + 卸载 detach + 稳定 paneKey + attach 非 2xx 不静默,守卫全过');
