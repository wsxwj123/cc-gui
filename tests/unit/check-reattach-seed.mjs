#!/usr/bin/env node
// r68 直播快照(切走再切回的"种回")护栏 —— 直接 import 真实实现,改坏了这里必红。
//
// 修的是:流式中切走再切回,正文整段空窗几十秒(等落盘才一次性画出)。做法是切走时
// 把已流出的正文存成模块级快照,切回的 reattach 以它为起点续挂重放的 delta。
//
// 锁住四件事(每条都对应一种"看起来修好了、其实半修/更坏"的失败):
//   ① 生命周期:存 → 取即删 → 作废,三个动作都得算数;
//   ② 用一次即弃:分屏同 sid 两窗格互踢时,第二个消费者不能拿到同一份陈旧快照;
//   ③ 会话键隔离 + 容量兜底(LRU / 单条上限),快照不许串会话、不许无限涨;
//   ④ 接线契约(源码级):块索引表必须种回、溢出必须退回、回合结束必须作废 ——
//      这三条漏任何一条都不会让上面的纯逻辑变红,只会在真机上悄悄坏掉。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dropStreamSnapshot,
  putStreamSnapshot,
  resolveStreamHistCutoff,
  takeStreamSnapshot,
} from '../../client/src/utils/reattach.js';

const snap = (over = {}) => ({
  text: 'hello',
  thinking: '',
  toolCalls: [],
  orderedBlocks: [{ type: 'text', content: 'hello' }],
  blockIndexMap: { 0: { type: 'text', orderIdx: 0 } },
  steerAnchors: {},
  cutoff: { sinceTs: 1_700_000_000_000, keepUser: true },
  streamStart: 1_700_000_000_000,
  ...over,
});

// ── ① 生命周期:存 / 取 / 作废 ─────────────────────────────────────
{
  assert.equal(putStreamSnapshot('s1', snap()), true, '正常快照必须存得下');
  const got = takeStreamSnapshot('s1');
  assert.equal(got?.text, 'hello', '取回的必须是存进去那份');
  assert.deepEqual(got.blockIndexMap, { 0: { type: 'text', orderIdx: 0 } },
    '块索引表必须原样带回:少了它,重放的首批 delta 仍是孤儿 → 气泡冻住不再增长(半修)');

  putStreamSnapshot('s2', snap({ text: 'x' }));
  dropStreamSnapshot('s2');
  assert.equal(takeStreamSnapshot('s2'), null, '作废(回合结束/被接管)后必须再也取不到');

  assert.equal(takeStreamSnapshot('never-existed'), null, '没有快照必须返回 null(=退回今天的行为)');
  assert.equal(takeStreamSnapshot(null), null, 'sessionId 为空不得抛错');
  assert.equal(putStreamSnapshot(null, snap()), false, 'sessionId 为空不得写入');
  assert.doesNotThrow(() => dropStreamSnapshot(null));
}

// ── ② 用一次即弃(分屏同 sid 互踢的安全阀)────────────────────────
{
  putStreamSnapshot('dual', snap({ text: 'A 消费到这里' }));
  const first = takeStreamSnapshot('dual');
  const second = takeStreamSnapshot('dual');
  assert.ok(first, '第一个消费者拿到快照');
  assert.equal(second, null,
    '第二个消费者必须拿不到:两个窗格种回同一份陈旧快照 = 正文中段缺一块(悄悄丢字比空窗更坏)');
}

// ── ③ 会话键隔离 + 容量兜底 ──────────────────────────────────────
{
  putStreamSnapshot('ka', snap({ text: 'a' }));
  putStreamSnapshot('kb', snap({ text: 'b' }));
  assert.equal(takeStreamSnapshot('kb').text, 'b', '快照按会话键取,不许串会话');
  assert.equal(takeStreamSnapshot('ka').text, 'a', '另一个会话的快照不受影响');

  // 单条上限:MB 级正文不存 —— 放弃种回、退回今天的行为,不是抛错。
  assert.equal(putStreamSnapshot('huge', snap({ text: 'x'.repeat(1_000_001) })), false,
    '超大回合不存(放弃种回而不是把 MB 级正文长期留在内存)');
  assert.equal(takeStreamSnapshot('huge'), null, '没存下就必须取不到');

  // LRU:只留最近 8 个会话。第 9 个进来时最早的那个被挤掉。
  for (let i = 0; i < 9; i++) putStreamSnapshot(`lru${i}`, snap({ text: String(i) }));
  assert.equal(takeStreamSnapshot('lru0'), null, '超出上限时最早的快照被挤掉');
  assert.equal(takeStreamSnapshot('lru8')?.text, '8', '最近的快照必须还在');
  for (let i = 1; i < 8; i++) takeStreamSnapshot(`lru${i}`);
}

// ── ④ 接线契约(源码级)──────────────────────────────────────────
// 下面每条对应一个"变异哨兵":删掉被断言的那处接线,这条断言就红。
{
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const ws = readFileSync(new URL('../../client/src/hooks/useWebSocket.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');

  // 哨兵 1:删掉块索引表的种回 → 续挂的 delta 找不到块,被 `if (!block) continue` 丢弃,
  // 气泡冻在快照那一刻不再增长。纯逻辑测不出来(快照里有,只是没人用),只能锁接线。
  assert.match(app, /const blocks = \{ \.\.\.\(seed\?\.blockIndexMap \|\| \{\}\) \};/,
    '块索引表必须从快照种回(删了 = 续挂的 delta 仍是孤儿 = 半修)');
  assert.match(app, /blockIndexMap: blocksMirror \? \{ \.\.\.blocksMirror \} : null,/,
    '写快照时必须带上块索引表');

  // 哨兵 2:删掉溢出退回 → 回放缺一段而客户端毫不知情,种回的正文中段静默缺失。
  assert.match(server, /else slot\.earlyOverflowed = true;/,
    '服务端 earlyLines 触顶必须置溢出标记(静默丢尾 + 种回 = 悄悄丢字)');
  assert.match(server, /if \(slot\.earlyOverflowed\) \{ slot\.earlyOverflowed = false; onLine\(JSON\.stringify\(\{ type: 'early_overflow' \}\)\); \}/,
    '溢出标记必须在回放【之前】发出,否则客户端已经把不完整的内容画上去了');
  assert.match(server, /s\.earlyOverflowed = false;\s*\/\/ r68/,
    '新回合重置缓冲时必须一并清溢出标记,否则旧账压死新回合的种回');
  assert.match(app, /if \(event\.type === 'early_overflow'\) \{[\s\S]{0,600}?seeded = false;/,
    '客户端收到溢出标记必须就地作废快照(退回历史单一来源)');
  assert.match(app, /if \(event\.type === 'early_overflow'\) \{[\s\S]{0,600}?setReattachStream\(true\);/,
    '溢出退回必须把渲染门也翻回无快照 reattach,否则气泡在画一段缺中间的正文');

  // 哨兵 3:删掉回合结束作废 → 回合早已跑完、历史已全量时还去种回 = 双份内容。
  assert.match(ws, /case 'turn-complete': \{[\s\S]{0,900}?dropStreamSnapshot\(sid\);/,
    'turn-complete 广播必须作废快照(它是不依赖 SSE 在线的唯一可靠信号)');

  // 哨兵 4:删掉"被接管就清快照" → 第三次 attach 会种回一段中间缺失的正文。
  assert.match(app, /if \(streamEndMirror === 'takeover'\) dropStreamSnapshot\(streamSid\);/,
    '被别的窗格接管时必须清掉快照(宁可退回今天的空窗,也不种回中段缺失的正文)');

  // 哨兵 5:删掉"无快照 reattach 不写快照" → 它的缓冲只是重放的半截、cutoff 是 null,
  // 存下来会在下一次种回时与历史双画。
  assert.match(app, /else if \(!reattachPid \|\| seeded\) putStreamSnapshot\(streamSid, \{/,
    '只有【在画直播气泡】的流(普通发送 / 已种回)才许写快照');

  // 哨兵 6:回合真结束/用户真停止不写快照(历史已是全量,再种就是双份)。
  assert.match(app, /if \(streamSid && streamEndMirror !== 'done' && !killedRef\.current\) \{/,
    'done 收尾与用户停止都不得写快照');

  // 哨兵 7:seeded 必须走普通回合那条 finalize(push 本地副本 → roundLanded → 清本地),
  // 不许出现 seeded 专属收尾分支。
  assert.match(app, /if \(!reattachPid \|\| seeded\) setChatMessages\(\(prev\) => \[\.\.\.prev, \{/,
    'seeded 的整回合缓冲必须与普通发送一样 push 本地副本(否则落盘前闪一段空)');

  // 哨兵 8:用户自己那句话的唯一来源。切会话 effect 把本地 chatMessages 清了,种回时
  // 若把历史里的 user 行也按 sinceTs 截掉,界面上"我发的消息"凭空消失。
  assert.match(app, /\|\| \(cut\.keepUser && m\.type === 'user'\)\);/,
    '种回口径必须保留历史里的 user 行(本地副本已被切会话清掉,历史是它唯一来源)');

  // 口径红线:afterLastUser 是记录在案的事故口径(⚡引导折叠会插 user 行 → 切错位置),
  // 种回一律用快照自带的 sinceTs,不许改回去。
  assert.doesNotMatch(app, /seed\?\.cutoff\s*\|\|\s*\{\s*afterLastUser/,
    '种回不得使用 afterLastUser 口径(引导折叠会把已产出的正文切没)');
}

// ── ⑤ 失败即退化:任何一环缺失都必须落回今天的行为,而不是新的错误态 ──
{
  // 没快照 ⇒ cutoff 回落 null ⇒ reattachStream 为真 ⇒ 走历史单一来源(今天的行为)。
  assert.equal(resolveStreamHistCutoff(true, 1, takeStreamSnapshot('absent')?.cutoff || null), null,
    '没快照必须退回今天的 reattach 行为(null 口径),不得抛错、不得半吊子');
}

console.log('✅ check-reattach-seed: 快照生命周期 + 用一次即弃 + 键隔离/容量 + 8 条接线哨兵 全部通过');
