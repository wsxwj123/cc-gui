#!/usr/bin/env node
// 批B B4(#4):关右侧面板后会话区空白、上滑才找得回内容。
// 定位实测(vite dev :6702 + 长会话 249 条 + 开/关监控面板):
//   开面板 scrollTop 3248→3549、关回来 3549→3248,scrollHeight 6689↔7227。
//   即容器宽度一变,消息重新折行、全文总高变化几百像素;Chrome 靠 scroll anchoring
//   自己把 scrollTop 补偿回去(CSS.supports('overflow-anchor','auto') === true),
//   WKWebView(Tauri 的 webview)不实现该特性 → scrollTop 原地不动、内容整体位移,
//   视口就可能停在两条消息之间的空白段。故自己按比例补一次锚定。
// 纯函数,真 import。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  advanceScrollTransaction,
  beginScrollTransaction,
  clampScrollTop,
  keyRequestsReading,
  resizeScrollTop,
} from '../../client/src/utils/scroll.js';

// ── clampScrollTop ────────────────────────────────────────────────
assert.equal(clampScrollTop({ scrollTop: 9999, scrollHeight: 6689, clientHeight: 193 }), 6496,
  '超界必须钳到底(内容变矮后 scrollTop 还停在旧值 = 视口落在内容之外)');
assert.equal(clampScrollTop({ scrollTop: 3248, scrollHeight: 6689, clientHeight: 193 }), 3248,
  '未超界不得改动用户的阅读位置');
assert.equal(clampScrollTop({ scrollTop: 100, scrollHeight: 6689, clientHeight: 193, stickToBottom: true }), 6496,
  'stickToBottom 直接吸底');
assert.equal(clampScrollTop({ scrollTop: 50, scrollHeight: 120, clientHeight: 400 }), 0,
  '内容比视口短 → 上限 0');
assert.equal(clampScrollTop({ scrollTop: -20, scrollHeight: 6689, clientHeight: 193 }), 0, '负值钳到 0');

// ── resizeScrollTop:宽度变化后的等比还原 ──────────────────────────
{
  // 实测数值:关面板 sh 7227→6689(ch 193)。开面板时停在 3549(约 50.4%)。
  const next = resizeScrollTop({ prevTop: 3549, prevMax: 7034, scrollHeight: 6689, clientHeight: 193 });
  assert.ok(Math.abs(next - 3248) <= 40,
    `等比还原应落在 Chrome 的 anchoring 结果 3248 附近(实得 ${next});偏差 >40px 说明公式错了`);
  // 反向:开面板
  const back = resizeScrollTop({ prevTop: 3248, prevMax: 6496, scrollHeight: 7227, clientHeight: 193 });
  assert.ok(Math.abs(back - 3549) <= 40, `反向还原同样要贴近 3549(实得 ${back})`);
}
// 顶部/底部是不动点:不能因为"等比"把贴顶的人推下去、把贴底的人拉上来
assert.equal(resizeScrollTop({ prevTop: 0, prevMax: 6496, scrollHeight: 7227, clientHeight: 193 }), 0,
  '贴顶必须还是贴顶');
assert.equal(resizeScrollTop({ prevTop: 6496, prevMax: 6496, scrollHeight: 7227, clientHeight: 193 }), 7034,
  '贴底必须还是贴底');
// stickToBottom(用户没在看历史)压过一切 → 与吸底 effect 同一目标,两者不会互相拉扯
assert.equal(resizeScrollTop({ prevTop: 10, prevMax: 6496, scrollHeight: 7227, clientHeight: 193, stickToBottom: true }), 7034);
// 变化前不可滚动(短会话)→ 没有比例可言,退回纯钳位,绝不放大成 NaN/Infinity
{
  const v = resizeScrollTop({ prevTop: 0, prevMax: 0, scrollHeight: 7227, clientHeight: 193 });
  assert.equal(v, 0);
  assert.ok(Number.isFinite(v));
}
// 上限快照过期(用户上翻后又流式追加了内容,没有滚动事件来刷新快照):
// prevTop 已经超过 prevMax。拿过期基准算比例 = 100% 直接把人扔到底部,比不动还糟 → 只钳位。
{
  const v = resizeScrollTop({ prevTop: 5000, prevMax: 3000, scrollHeight: 9000, clientHeight: 200 });
  assert.equal(v, 5000, '快照过期时必须原样保留位置,不得当成"已在底部"');
}
// 变化后不可滚动 → 0
assert.equal(resizeScrollTop({ prevTop: 3248, prevMax: 6496, scrollHeight: 120, clientHeight: 400 }), 0);
// 脏输入不得产出 NaN(NaN 写进 scrollTop 会被当 0 = 直接跳到顶)
for (const bad of [{}, { prevTop: NaN, prevMax: 100, scrollHeight: 500, clientHeight: 100 }]) {
  const v = resizeScrollTop(bad);
  assert.ok(Number.isFinite(v), `脏输入必须回落成有限值,实得 ${v}`);
}

// ── programmatic transaction:平滑中间帧 / 动态目标 / 超时 ──────────
{
  const first = beginScrollTransaction('follow', 100, 0);
  const middle = advanceScrollTransaction(first, {
    previousTop: 0,
    currentTop: 32,
    target: 100,
    now: 100,
  });
  assert.equal(middle.handled, true, '朝目标移动的 smooth 中间帧不能误判用户阅读');
  const grown = advanceScrollTransaction(middle.transaction, {
    previousTop: 32,
    currentTop: 64,
    target: 140,
    now: 200,
  });
  assert.equal(grown.transaction.target, 140, 'follow-bottom 内容增长时必须更新动态目标');
  const reached = advanceScrollTransaction(grown.transaction, {
    previousTop: 138,
    currentTop: 139.5,
    target: 140,
    now: 300,
  });
  assert.equal(reached.reached, true, '进入目标 ±1px 必须结束 transaction');
  assert.equal(reached.transaction, null);

  const interrupted = advanceScrollTransaction(beginScrollTransaction('follow', 100, 0), {
    previousTop: 60,
    currentTop: 55,
    now: 100,
  });
  assert.equal(interrupted.userMovedAway, true, '背离向下目标的真实上滑必须立即进入 reading');
  assert.equal(interrupted.transaction, null);

  const expired = advanceScrollTransaction(beginScrollTransaction('follow', 100, 0), {
    previousTop: 50,
    currentTop: 50,
    now: 1001,
  });
  assert.equal(expired.expired, true, 'smooth transaction 最长只能存活 1000ms');
  assert.equal(expired.transaction, null);

  const paneA = beginScrollTransaction('follow', 100, 1);
  const paneB = beginScrollTransaction('follow', 400, 2);
  const paneAResult = advanceScrollTransaction(paneA, { previousTop: 0, currentTop: 100, now: 3 });
  assert.equal(paneAResult.transaction, null);
  assert.equal(paneB.target, 400, '一个 pane 完成 transaction 不得改变另一实例');
}
assert.equal(keyRequestsReading('PageUp'), true);
assert.equal(keyRequestsReading('ArrowUp'), true);
assert.equal(keyRequestsReading('Home'), true);
assert.equal(keyRequestsReading('End'), false, 'End 应由到达底部的几何判据恢复 following');

// ── 源码守卫:effect 必须只认宽度、必须打程序滚动标记 ─────────────────
{
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const src = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
  // 必须走 callback ref:SessionDetail 有 EmptyState / loading 两条早退分支,滚动容器会被
  // 销毁重建;useEffect([]) 一次性捕获的节点在第一次切会话后就脱离文档,RO 观察空气,
  // 整个修复从那一刻起失效(审查揪出的"重要2")。
  assert.ok(/const setContainerRef = useCallback\(\(node\) => \{/.test(src),
    '必须用 callback ref 挂 ResizeObserver,不能用 useEffect([]) 一次性捕获容器');
  assert.ok(/ref=\{setContainerRef\}[\s\S]{0,160}onScroll=\{handleScroll\}/.test(src),
    '滚动容器必须绑 setContainerRef');
  assert.ok(!/useEffect\(\(\) => \{\s*\n\s*const el = containerRef\.current;\s*\n\s*if \(!el \|\| typeof ResizeObserver/.test(src),
    '旧的 useEffect([]) 版 ResizeObserver 必须已删除,不能两套并存');
  const i = src.indexOf('const setContainerRef = useCallback(');
  const seg = src.slice(i, i + 2200);
  assert.ok(/scrollRoRef\.current\.disconnect\(\)/.test(seg), '重新挂载时必须先 disconnect 旧 observer');
  assert.ok(/if \(!node \|\| typeof ResizeObserver === 'undefined'\) return;/.test(seg),
    'node 为 null(卸载)时只 disconnect 不再观察');
  assert.ok(/if \(width !== lastWidth\)/.test(seg),
    '只在宽度变化时动作 —— 高度变化是输入框长高,归既有吸底 effect,插手会打架');
  assert.ok(/CSS\.supports\?\.\('overflow-anchor', 'auto'\)/.test(seg) && /if \(!nativeAnchor\)/.test(seg),
    '有原生 scroll anchoring 的引擎不得用等比近似值覆写它已经算准的 scrollTop');
  assert.ok(/prevTop: node\.scrollTop/.test(seg),
    'prevTop 取实时 scrollTop(宽度变化不改它,故实时值即变化前的值,且永不陈旧)');
  assert.ok(/prevMax: scrollMaxRef\.current/.test(seg), '只有上限用快照');
  assert.ok(/stickToBottom: !userScrolledAwayRef\.current/.test(seg),
    '用户没在看历史时必须吸底,与吸底 effect 同一目标');
  assert.ok(/writeProgrammaticScroll\(node, next, 'resize'\)/.test(seg),
    '写 scrollTop 前必须开启程序滚动 transaction,否则被 handleScroll 当成用户手势');
  assert.ok(/Math\.abs\(next - node\.scrollTop\) >= 1/.test(seg),
    '差值不足 1px 不写:否则标记被置真却等不到回弹事件,下一次真实滚动会被吞掉');
  // 基准快照要在 handleScroll 的程序滚动目标早退【之前】刷新,否则用过期基准算位置
  const hs = src.slice(src.indexOf('const handleScroll = () => {'), src.indexOf('// Restore the saved scroll position'));
  assert.ok(hs.indexOf('scrollMaxRef.current =') < hs.indexOf('if (transactionResult.handled)'),
    'scrollMaxRef 必须在程序滚动早退之前刷新');
  assert.ok(/shouldPauseAutoScroll/.test(hs) && hs.indexOf('movedUp') < hs.indexOf('transactionResult.handled'),
    '必须先读取真实向上位移，再判断程序目标，避免尚未回弹的旧标记吞掉用户起手滚动');
  assert.ok(/const scrollOwnerKey = selectedSession\?\.sessionId \? `\$\{paneId\}:\$\{selectedSession\.sessionId\}`/.test(src),
    '主持久位置必须用 paneId:sessionId 复合身份，不能让同会话双 pane 共享');
  assert.ok(/ownSaved \?\? \(legacyKey \? localStorage\.getItem\(legacyKey\)/.test(src)
      && !/localStorage\.setItem\(legacyKey/.test(src),
    '旧 session-only 键只允许兼容读取，不得继续写入');
  assert.ok(/if \(!reattachPid && !opts\.forceSend[\s\S]{0,1800}return;[\s\S]{0,500}真正开始新的空闲回合/.test(src),
    '忙碌 Enter/steer 必须在恢复 following 之前返回');

  const subagent = readFileSync(join(root, 'client/src/components/SubagentView.jsx'), 'utf8');
  assert.ok(/`\$\{paneId\}:\$\{parentSessionId\}:\$\{agentId\}`/.test(subagent),
    '子代理滚动身份必须包含 pane、母会话和 agent');
  assert.ok(/writeProgrammaticScroll\(el, target, 'return-bottom'\)/.test(subagent),
    '子代理回底按钮必须只操作自己的容器 transaction');

  const scrubber = readFileSync(join(root, 'client/src/components/TurnScrubber.jsx'), 'utf8');
  const navigation = scrubber.slice(scrubber.indexOf('const scrollToTurn'), scrubber.indexOf('const enterLine'));
  assert.ok(navigation.indexOf('onNavigate?.()') < navigation.indexOf('requestAnimationFrame(step)'),
    'TurnScrubber 必须在启动滚动 rAF 前显式进入 reading');
}

console.log('✓ check-scroll-clamp: 钳位 + transaction + pane 隔离 + effect 守卫全过');
