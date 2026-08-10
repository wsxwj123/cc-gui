#!/usr/bin/env node
// Bug4 无打断引导注入(设计甲)+ Bug1 ⚡ 失效。
//
// 服务端:POST /api/chat/steer 按 sessionId 找【忙】slot 做 input.push —— CLI 在下一个
// 工具结果边界把它折叠进【同一回合】(实测 1 init / 1 result)。判据是复用块(chat.js:1107)
// 那一行【只把 s.idle 取反】:复用块要 idle(开新回合),注入要 !idle(并进在跑的回合)。
// 对 idle slot 绝不能 push —— 那会开一个前端不知道的新回合(SSE 已 done 关闭,输出无人接)。
//
// 客户端(设计乙,用户实测后改版):发送门在"回合进行中"一律【入队】(0.2.283 行为),
// 注入的唯一入口是队列条目上的「⚡ 并入」;注入成功后消息留在队列区换状态显示,不出队、
// 不画乐观气泡 —— 出不出队由回合收尾的持久化核对(reconcileSteered)决定:
// ⚡ 之后落盘 → 出队,没落盘 → 翻回可编辑排队态(不丢字)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const { findBusySlot } = await import('../../server/routes/chat.js');

// ── 1) 忙 slot 判据(真 import)──────────────────────────────────────
const mkSlot = (o = {}) => ({
  sessionId: 'sid-1', idle: false, closing: false, pumpEnded: false, exitCode: null,
  input: { pushed: [], push(m) { this.pushed.push(m); return true; } },
  ...o,
});

// makeInputQueue 不导出(它是 chat.js 的模块内私有件,导出只为测试属于污染公共面)。
// 这里复刻它的 push/close 语义(与 chat.js:603 同形,repo 既有做法见 check-stop-reuse-reset.mjs),
// 行为断言跑复刻件,真实实现由下面第 2 节的源码正则锁住,防两边漂移。
const makeTestQueue = () => {
  const q = []; let waiting = null; let closed = false;
  return {
    push(msg) {
      if (closed) return false;
      if (waiting) { const w = waiting; waiting = null; w({ value: msg, done: false }); }
      else q.push(msg);
      return true;
    },
    close() { closed = true; if (waiting) { const w = waiting; waiting = null; w({ value: undefined, done: true }); } },
  };
};

// (a) 正在跑的回合 → 命中,pid 一并返回
{
  const busy = mkSlot();
  const procs = new Map([['sdk-9', busy]]);
  const hit = findBusySlot(procs, 'sid-1');
  assert.ok(hit, '非 idle 的活 slot 必须命中');
  assert.equal(hit.pid, 'sdk-9', '返回 pid 供客户端记账');
  assert.equal(hit.slot, busy);
}

// (b) idle slot 一律拒绝 —— 承重点:对它 push = 开一个前端不知道的新回合
{
  const procs = new Map([['sdk-1', mkSlot({ idle: true })]]);
  assert.equal(findBusySlot(procs, 'sid-1'), null, 'idle slot 绝不可注入(回合已收尾)');
}

// (c) 其余存活条件与复用块逐字一致:closing / pumpEnded / exitCode / 会话不符 全拒
{
  assert.equal(findBusySlot(new Map([['p', mkSlot({ closing: true })]]), 'sid-1'), null, 'closing 中的 slot 不接受注入');
  assert.equal(findBusySlot(new Map([['p', mkSlot({ pumpEnded: true })]]), 'sid-1'), null, '泵已结束的 slot 不接受注入');
  assert.equal(findBusySlot(new Map([['p', mkSlot({ exitCode: 0 })]]), 'sid-1'), null, '已退出的 slot 不接受注入');
  assert.equal(findBusySlot(new Map([['p', mkSlot()]]), 'sid-OTHER'), null, '别的会话的 slot 不得被注入(串扰)');
  assert.equal(findBusySlot(new Map([['p', mkSlot({ input: null })]]), 'sid-1'), null, '没有 input 通道 → 无处可推');
  assert.equal(findBusySlot(new Map([['p', mkSlot()]]), ''), null, '无 sessionId → 不猜');
}

// (d) 复活守卫自洽:主 agent 在 4s 去抖 finalize 之后续跑 → chat.js 把 idle 翻回 false 并
//     置 revived。那正是"确实有回合在跑",此时必须可注入(判据用 idle 而非不回退的时刻字段)。
{
  const revived = mkSlot({ idle: true, finishedAt: Date.now() - 1000 });
  assert.equal(findBusySlot(new Map([['p', revived]]), 'sid-1'), null, '转 idle 期间不可注入');
  revived.idle = false; revived.revived = true; // ← chat.js:1561 复活守卫做的事
  assert.ok(findBusySlot(new Map([['p', revived]]), 'sid-1'), '复活(续跑)后必须重新可注入');
}

// (e) 多 slot:只挑本会话那个忙的
{
  const busy = mkSlot({ sessionId: 'sid-B' });
  const procs = new Map([
    ['p1', mkSlot({ sessionId: 'sid-A' })],
    ['p2', mkSlot({ sessionId: 'sid-B', idle: true })],
    ['p3', busy],
  ]);
  assert.equal(findBusySlot(procs, 'sid-B').slot, busy);
}

// (f) 判官致命-1:input 已 close 但三面旗还没落地的"伪忙"slot。findBusySlot 仍会命中
//     (旗就是那样),所以最后一道防线必须是 push 的返回值 —— 路由据此回 409。
//     真实窗口:keepAlive=false 时 finalize 走 else 分支只 input.close(),不置 closing/idle,
//     到泵 finally→finishSlot 置 pumpEnded 之间(CLI 进程退净,百毫秒级)。
{
  const q = makeTestQueue();
  q.close();
  const fake = mkSlot({ input: q });
  assert.ok(findBusySlot(new Map([['p', fake]]), 'sid-1'), '旗面上它仍是"忙"(这正是坑)');
  assert.equal(q.push({ type: 'user' }), false, 'close 之后 push 必须返回 false(不能静默吞)');
}

// (g) 未关的队列 push 返回 true 且消息真的进队(返回值不是恒 false 的摆设)
{
  const q = makeTestQueue();
  assert.equal(q.push({ type: 'user', message: { role: 'user', content: 'x' } }), true, '正常 push 返回 true');
}

// ── 2) 路由接线:push 形状与复用块 :1149 逐字一致(外加 uuid)+ 409 语义 ────
const chat = read('server', 'routes', 'chat.js');
assert.ok(/router\.post\('\/chat\/steer'/.test(chat), '独立路由,不动 POST \/chat');
assert.ok(/const hit = findBusySlot\(activeProcesses, String\(sessionId\)\);\s*\n\s*if \(!hit\) return res\.status\(409\)\.json\(\{ error: 'no-active-turn' \}\);/.test(chat),
  '找不到忙 slot → 409 no-active-turn(客户端据此回落入队)');
assert.ok(/const msg = \{ type: 'user', message: \{ role: 'user', content: String\(content\) \} \};/.test(chat),
  'push 形状与复用块 :1149 逐字一致');
assert.ok(/if \(uuid\) msg\.uuid = String\(uuid\);/.test(chat),
  '带 uuid 才有 command_lifecycle 可用(角标数据源)');
// 判官致命-1 的两处承重点:push 有返回值 + 路由据返回值 409(缺一就是"200 空吞")
assert.ok(/push\(msg\) \{\s*\n\s*if \(closed\) return false;[\s\S]{0,200}?return true;\s*\n\s*\},/.test(chat),
  'makeInputQueue.push 必须报告"这条消息有没有真进队"(close 后 false)');
assert.ok(/if \(!hit\.slot\.input\.push\(msg\)\) return res\.status\(409\)\.json\(\{ error: 'no-active-turn' \}\);/.test(chat),
  'push 失败(队列已关)必须回 409,绝不能凭旗面回 200 —— 200 空吞 = 用户文字无声蒸发');
// 现有两个 push 调用点忽略返回值即可,行为零变化(复用块 + 冷启首条)
assert.equal((chat.match(/input\.push\(\{ type: 'user', message: \{ role: 'user', content: String\(prompt\) \} \}\);/g) || []).length, 2,
  '复用块与冷启首条两个既有 push 调用点未被改动(不读返回值)');
// 红线未被碰:复用块仍只认 idle,tearingDown 段仍在
assert.ok(/if \(!s\.idle \|\| s\.closing \|\| s\.pumpEnded \|\| s\.exitCode !== null \|\| s\.sessionId !== sessionId\) continue;/.test(chat),
  'POST /chat 复用块的 idle 门一个字没动');
assert.ok(/lingering\.abort\?\.\abort\(\)/.test(chat), 'tearingDown 等待+强杀段原样保留');

// ── 3) 队列态机(真 import 纯函数)——— 设计乙的核心 ────────────────
const { isSteered, firstDrainableIndex, firstSteerableIndex, reconcileSteered,
  persistedUserSigs, persistedSteerKeys, steerLanded, steerSig, sigLanded,
  stripSteerState } = await import('../../client/src/utils/steerQueue.js');

const q1 = { text: '普通排队', queuedAt: 1 };
const q2 = { text: '已注入', queuedAt: 2, steerId: 'u-1', steerState: 'sent' };
const q3 = { text: '隐藏续跑', queuedAt: 3, hidden: true };

// (a) 已注入的条目:drain 必须跳过 —— 它已送达 CLI,再发一次就是双发
assert.equal(isSteered(q2), true);
assert.equal(isSteered(q1), false);
assert.equal(firstDrainableIndex([q2, q1]), 1, 'drain 跳过已注入条目,取下一条可发的');
assert.equal(firstDrainableIndex([q2]), -1, '全是已注入 → 没得可发(不能退回发它)');
assert.equal(firstDrainableIndex([q3, q1]), 0, 'hidden 项照旧参与 drain(它只是不在 UI 显示)');

// (b) ⚡ 只对"用户可见且没注入过"的条目开放
assert.equal(firstSteerableIndex([q3, q2, q1]), 2, '跳过 hidden 与已注入');
assert.equal(firstSteerableIndex([q3, q2]), -1, '没有可引导的 → ⚡ 该置灰');

// (c) 落地判定:查到了→出队;查不到→翻回普通排队态(可编辑、会被 drain 发出)
{
  const list = [q1, q2];
  const landed = reconcileSteered(list, persistedUserSigs([{ type: 'user', text: '已注入' }]));
  assert.deepEqual(landed.map((m) => m.text), ['普通排队'], '落盘了 → 从队列移除(它已是对话历史)');

  const lost = reconcileSteered(list, persistedUserSigs([{ type: 'user', text: '别的消息' }]));
  assert.deepEqual(lost.map((m) => m.text), ['普通排队', '已注入'], '没落盘 → 留在队列(不丢字)');
  assert.equal(isSteered(lost[1]), false, '没落盘 → 翻回普通排队态(可编辑/可删/会被 drain 发出)');
  assert.equal('steerState' in lost[1], false, '状态字段一并清干净');
  assert.equal(lost[0], q1, '未注入条目原样不动(同一引用)');
}
// 无已注入条目时返回原引用(不打穿 React 引用比较)
{
  const l = [q1];
  assert.equal(reconcileSteered(l, new Set()), l, '没有已注入条目 → 原引用返回');
}
// 文本签名:空白规整后比对(CLI 落盘可能规整空白)
assert.equal(steerSig('  a   b \n'), 'a b');
assert.ok(persistedUserSigs([{ type: 'turn', text: ['x'] }, { type: 'user', text: 'y' }]).has('y'));
assert.equal(persistedUserSigs([{ type: 'turn', text: ['x'] }]).has('x'), false, '只认 user 记录');

// (c2) 判官必修-2:历史同文不算落盘。签名口径是"全会话历史 + 前 80 字",用户以前发过
//      「继续」这类高频短句时,回合中新排队的同文被 ⚡ 并入 → 回合被停(实际没落盘)→
//      旧记录命中签名 → 误判"已落盘" → 静默出队 = 丢字,无痕不可恢复。故只认 ⚡ 之后落盘的。
{
  const T = 1_700_000_000_000;
  const at = (ms) => new Date(ms).toISOString();
  const item = { text: '继续', queuedAt: 9, steerId: 'u-2', steerState: 'sent', steeredAt: T };
  const older = { type: 'user', text: '继续', timestamp: at(T - 60_000) };

  const kept = reconcileSteered([item], persistedUserSigs([older]));
  assert.deepEqual(kept.map((m) => m.text), ['继续'], '历史同文不算落盘 —— 只认 ⚡ 之后写进 jsonl 的记录(误判就是静默丢字)');
  assert.equal(isSteered(kept[0]), false, '历史同文场景下条目翻回可编辑排队态');
  assert.equal('steeredAt' in kept[0], false, '翻回时时刻字段一并清掉');

  const fresh = { type: 'user', text: '继续', timestamp: at(T + 500) };
  assert.deepEqual(reconcileSteered([item], persistedUserSigs([older, fresh])), [],
    '⚡ 之后真落盘了 → 照常出队(别一律翻回,那是双发)');
  assert.equal(persistedUserSigs([fresh, older]).get('继续'), T + 500, '同签名取【最晚】一次落盘时刻,新记录不被旧记录盖掉');
  assert.equal(sigLanded(persistedUserSigs([{ type: 'user', text: '继续' }]), '继续', T), false,
    '记录没 timestamp → 不算落盘(方向定死:宁翻回勿丢字)');
  assert.equal(sigLanded(persistedUserSigs([older]), '继续', undefined), true,
    '条目没记 steeredAt(旧数据)→ 退回"有就算落盘"的老口径,不制造双发');
}

// (c3) R7-2:steerId 精确对账。只认签名的老口径在【折叠形态】上直接破功 ——
//      实测 CLI 2.1.226:回合里还有工具边界时,注入的消息被折叠进同一回合,磁盘上【没有
//      user 行】,原文只存在于 attachment{queued_command}。签名查不到 → 判"没落盘" →
//      翻回队列 → drain 再发一遍 = 双发(乙的两条硬红线之一被打穿,只因用户测的是纯文本
//      回合才没踩到)。修法:reader 合成的消息带 steerUuid,真 user 行本身 uuid 就是
//      command uuid,两个字段一起进 persistedSteerKeys,用 steerId 直接命中。
{
  const T = 1_700_000_000_000;
  const at = (ms) => new Date(ms).toISOString();
  const CMD = 'cmd-uuid-42';
  const item = { text: '改主意了：只数到15就停', queuedAt: 1, steerId: CMD, steerState: 'sent', steeredAt: T };

  // 形态 A:折叠 —— reader 合成的消息,uuid 是 attachment 自己的,steerUuid 才是 command uuid
  const foldMsg = { type: 'user', uuid: 'fb7d5660-attachment', steered: true, steerUuid: CMD,
    text: '改主意了：只数到15就停', timestamp: at(T + 300) };
  const keysA = persistedSteerKeys([foldMsg]);
  assert.ok(keysA.has(CMD), 'steerUuid 必须进集合 —— 折叠形态唯一能指认落盘的 id');
  assert.ok(keysA.has('fb7d5660-attachment'), 'uuid 也进集合(形态 B 靠它)');
  assert.equal(steerLanded(item, persistedUserSigs([foldMsg]), keysA), true, '折叠形态:steerUuid 命中 → 已落盘');
  assert.deepEqual(reconcileSteered([item], persistedUserSigs([foldMsg]), keysA), [], '折叠形态照常出队(不出 = 双发)');

  // 形态 B:排到回合末 —— 真 user 行,uuid 就是 command uuid
  const drainMsg = { type: 'user', uuid: CMD, text: '改主意了：只数到15就停', timestamp: at(T + 300) };
  const keysB = persistedSteerKeys([drainMsg]);
  assert.equal(steerLanded(item, persistedUserSigs([drainMsg]), keysB), true, '形态 B:user 行 uuid 命中 → 已落盘');
  assert.deepEqual(reconcileSteered([item], persistedUserSigs([drainMsg]), keysB), [], '形态 B 照常出队');

  // id 匹配的【独有】承重点:落地判定不再依赖时间戳与文本规整。签名兜底对"没有可用
  // 时间戳的记录"一律判没落盘(它的方向红线:宁翻回勿丢字),放在折叠形态上就是翻回 →
  // drain 再发一遍 = 双发。有 id 就能直接认出"这就是我们推的那条",与时刻无关。
  // (删掉 steerLanded 里的 id 命中那一行,下面两条必红 —— 这是本节的变异哨兵。)
  const noTs = { type: 'user', uuid: 'fb7d5660-attachment', steered: true, steerUuid: CMD, text: '改主意了：只数到15就停' };
  assert.equal(sigLanded(persistedUserSigs([noTs]), item.text, item.steeredAt), false,
    '签名兜底:记录没时间戳 → 判没落盘(它的既有方向,未改)');
  assert.equal(steerLanded(item, persistedUserSigs([noTs]), persistedSteerKeys([noTs])), true,
    'id 命中 → 照样判已落盘,不受时间戳缺失影响(否则同一条消息会被 drain 再发一遍)');
  assert.deepEqual(reconcileSteered([item], persistedUserSigs([noTs]), persistedSteerKeys([noTs])), [],
    'id 命中即出队 —— 精确匹配是主判据,签名只是兜底');

  // 精确匹配不是万能开关:id 命中【只在真有那条记录时】发生,别的会话/别的消息不会误命中
  const foreign = persistedSteerKeys([{ type: 'user', uuid: 'someone-else', text: '别的消息', timestamp: at(T + 300) }]);
  assert.equal(steerLanded(item, persistedUserSigs([]), foreign), false, 'id 不在集合里 → 不算落盘');

  // 时刻过滤仍然生效:id 没命中时退回签名兜底,历史同文旧记录不许把它判成落盘(否则静默丢字)
  const older = { type: 'user', uuid: 'old-row', text: '改主意了：只数到15就停', timestamp: at(T - 60_000) };
  const kept = reconcileSteered([item], persistedUserSigs([older]), persistedSteerKeys([older]));
  assert.deepEqual(kept.map((m) => m.text), ['改主意了：只数到15就停'], 'id 不命中 + 只有更早的同文 → 不出队(时刻过滤没被精确匹配架空)');
  assert.equal(isSteered(kept[0]), false, '不出队时照旧翻回可编辑排队态');

  // 无 steerId 的旧数据(0.2.283 之前入队的条目):走签名兜底,行为与改动前一致
  const legacy = { text: '继续', queuedAt: 2, steerState: 'sent', steeredAt: T };
  assert.equal(isSteered(legacy), false, '没有 steerId 就不是"已注入"条目(判据未变)');
  const legacyWithId = { ...legacy, steerId: 'ghost-id' };
  assert.equal(steerLanded(legacyWithId, persistedUserSigs([{ type: 'user', text: '继续', timestamp: at(T + 10) }]), new Set()),
    true, 'id 集合为空 → 签名+时刻兜底照旧判定落盘');
  assert.equal(steerLanded(legacyWithId, persistedUserSigs([{ type: 'user', text: '继续', timestamp: at(T - 10_000) }]), new Set()),
    false, '兜底路径的时刻口径原样保留');
  assert.equal(steerLanded({ text: 'x' }, new Map(), new Set()), false, '两级都拿不准 → 一律算没落盘(方向红线)');
  assert.equal(persistedSteerKeys([{ type: 'turn', uuid: 'turn-uuid' }]).has('turn-uuid'), false, '只收 user 消息的 id');
}

// (d) 跨重启:steer 态是进程内在飞状态,恢复时必须洗掉 —— 否则 drain 永远跳过它 = 永久卡死
{
  const restored = stripSteerState({ sid: [{ ...q2, steeredAt: 123 }], bad: 'not-an-array' });
  assert.equal(isSteered(restored.sid[0]), false, 'localStorage 恢复的已注入条目退回普通排队态');
  assert.equal('steeredAt' in restored.sid[0], false, 'steeredAt 同属在飞状态,跨重启一并洗掉');
  assert.equal(restored.sid[0].text, '已注入', '文字保留');
  assert.equal('bad' in restored, false, '畸形值滤掉');
}

// ── 4) 接线:store 的 drain 跳过 + 恢复清洗 ───────────────────────
const store = read('client', 'src', 'stores', 'sessionStore.js');
assert.ok(/import \{ firstDrainableIndex, stripSteerState \} from '\.\.\/utils\/steerQueue\.js';/.test(store),
  'store 复用同一份纯函数,不另写一套判据');
assert.ok(/const i = firstDrainableIndex\(list\);\s*\n\s*if \(i < 0\) return s;/.test(store),
  'shiftMessage(两条 drain 的唯一出口)跳过已注入条目 —— 红线:再发一次就是双发');
assert.ok(/return stripSteerState\(out\);/.test(store), 'localStorage 恢复时洗掉 steer 态');
assert.ok(/replaceQueue: \(sessionKey, list\) => set\(/.test(store), '队列整体替换(标记/落地判定共用)');

// ── 5) 发送门:回合进行中【默认入队】,不再默认注入(设计乙 ①)────────
const app = read('client', 'src', 'App.jsx');
assert.ok(/if \(!reattachPid && !opts\.forceSend && \(streamingRef\.current \|\| backgroundPidRef\.current\)\) \{\s*\n\s*useStore\.getState\(\)\.enqueueMessage\(sessionQueueKey, \{ text: prompt, queuedAt: Date\.now\(\), hidden: !!hiddenUserMessage, opts \}\);\s*\n\s*return;\s*\n\s*\}/.test(app),
  '回合进行中直发 = 入队(0.2.283 行为);门里不得再有任何注入分流');
assert.ok(!/_canSteer && !hiddenUserMessage/.test(app), '默认注入分流已撤掉');
assert.ok(!/_internalResend/.test(app), 'fromQueue/freshRetry 等"别注入"的标记随之退役,不留死代码');
assert.ok(/const resendReplacing = useCallback\(\(text, opts = \{\}\) => \{/.test(app)
  && /handleSendRef\.current\?\.\(text, \{ \.\.\.opts, forceSend: true \}\);/.test(app),
  'forceSend 绕门路径(回滚/重做)保持不动');

// ── 6) 不再乐观画气泡(设计乙 ③)─────────────────────────────────
assert.ok(!/steerId: cmdUuid, steerState: 'queued'/.test(app), '撤掉 steer 成功后立即 push 的本地用户气泡');
assert.ok(!/\}, 10_000\);/.test(app), '气泡的 10s 角标兜底随气泡一起退役');
assert.ok(!/msg\.steerState/.test(app), '消息流里不再渲染 steer 角标(位置交给回合结束后的 jsonl 重排)');
assert.ok(/return cmdUuid;/.test(app) && /if \(!r\.ok\) return null;/.test(app),
  'steerCurrentTurn 只回报送没送到(成功返回 command uuid,失败 null),不碰 chatMessages');
assert.ok(/signal: AbortSignal\.timeout\(4000\)/.test(app), '注入请求有超时兜底,不裸等');

// ── 7) ⚡ = 注入并原地标记,不出队(设计乙 ②)────────────────────
assert.ok(/const idx = firstSteerableIndex\(q\);/.test(app), '⚡ 取第一条可引导的(跳过 hidden 与已注入)');
assert.ok(/st\.replaceQueue\(queueKey, now\.map\(\(m, i\) => \(i === at \? \{ \.\.\.m, steerId, steerState: 'sent', steeredAt \} : m\)\)\);/.test(app),
  '注入成功 = 原地标成"已并入",消息留在队列区(不出队、不画气泡)');
assert.ok(/const steeredAt = Date\.now\(\);\s*\n\s*let steerId = null;/.test(app),
  'steeredAt 在 POST 【之前】取 —— CLI 落盘只可能更晚,取晚了会把自己这次落盘判成"旧记录"');
assert.ok(/if \(at < 0\) return; \/\/ 用户在这期间把它删了/.test(app), '注入期间条目被删 → 不凭空塞回去');
assert.ok(/setProviderSwitchNotice\(\{ text: '当前没有可并入的回合/.test(app),
  '409 维持现状:留队 + 客观提示,可以再点');
assert.ok(/acceleratingRef\.current = true;[\s\S]{0,400}?\} finally \{\s*\n\s*acceleratingRef\.current = false;\s*\n\s*\}/.test(app),
  '注入 await 窗内与 drain 互斥(此刻条目还没被标 steerId,shiftMessage 的跳过判据兜不住)');

// ── 8) 回合收尾的落地判定接线(设计乙 ④)───────────────────────
assert.ok(/const reconcileSteeredQueue = \(persisted\) => \{/.test(app), '落地判定函数存在');
assert.ok(/const sigs = persistedUserSigs\(persisted\);\s*\n\s*const keys = persistedSteerKeys\(persisted\);\s*\n\s*const next = reconcileSteered\(list, sigs, keys\);/.test(app),
  '复用纯函数,不另写判据;steerId 精确匹配的 keys 必须一起传进去(不传 = 折叠形态判成没落盘 = 双发)');
assert.ok(/const back = list\.filter\(\(m\) => isSteered\(m\) && !steerLanded\(m, sigs, keys\)\)\.length;/.test(app),
  '"翻回几条"的计数与出队判据必须同一个函数,否则提示条数与实际行为对不上');
assert.equal((app.match(/if \(isCurrentTurn\(\)\) reconcileSteeredQueue\(getLocalMessages\(\)\);/g) || []).length, 2,
  '两个对账清空点(roundLanded 分支 + !producedReply 分支)都做落地判定');
assert.ok(/有 \$\{back\} 条并入的消息本回合没有被读到/.test(app), '翻回时给明确提示,不闷声');
// 判官必修-1:两个判定都写在 break 之前的分支里,12 轮轮询耗尽时循环从【底部掉出】——
// producedReply 为真但 turn 没落盘(手动停止/进程被杀/interrupt 早期)正是这条高频路径。
assert.ok(/if \(isCurrentTurn\(\) && getLocalSession\(\)\?\.sessionId === finalizeSid\) \{\s*\n\s*reconcileSteeredQueue\(lastPeeked \|\| getLocalMessages\(\)\);\s*\n\s*\}/.test(app),
  '轮询耗尽掉出循环后补一次落地判定 —— 否则停止后条目挂死"已引导",不可编辑不可删不可重发');
assert.ok(/let lastPeeked = null;[\s\S]{0,3000}?lastPeeked = peeked;/.test(app),
  '兜底判定用最后一次 peek 到的持久化(store 副本停在回合开始前,更旧)');
assert.ok(/if \(i < 11\) await new Promise\(\(r\) => setTimeout\(r, 200\)\);/.test(app),
  '轮询次数/间隔本身不动(只补兜底调用)');
assert.ok(!/rescueUnfoldedSteer/.test(app), '旧的"气泡回捞"实现已删净(它为旧设计服务)');
assert.ok(/roundLanded = \(persisted, attempt\) => \{/.test(app) && /if \(!tail \|\| attempt >= 9\) return true;/.test(app),
  '对账判据 roundLanded 一字未动');

// ── 9) command_lifecycle:只做文案精确化,不参与落地判定(设计乙 ⑤)──
assert.ok(/if \(event\.type === 'command_lifecycle' && event\.command_uuid && event\.state !== 'queued'\) \{/.test(app),
  '宽松解析(SDK 类型里没有该事件),只认 started/completed');
assert.ok(/\{ \.\.\.m, steerState: 'merged' \} : m\)\)\);/.test(app), '事件到了把队列条目文案精确到"已并入"');

// ── 10) ChatInput:已注入条目不可编辑/不可撤回 + 状态文案 ──────────
const chatInput = read('client', 'src', 'components', 'ChatInput.jsx');
assert.ok(/import \{ isSteered, firstSteerableIndex \} from '\.\.\/utils\/steerQueue\.js';/.test(chatInput),
  'UI 与 store 用同一份判据');
assert.ok(/\{onEditFromQueue && !isSteered\(q\) && \(/.test(chatInput), '已注入 → 不给编辑按钮(撤不回来)');
assert.ok(/\{onRemoveFromQueue && !isSteered\(q\) && \(/.test(chatInput), '已注入 → 不给删除按钮');
assert.ok(/!queueItems\[i\]\?\.hidden && !isSteered\(queueItems\[i\]\)/.test(chatInput),
  'ArrowUp 召回也要跳过已注入条目');
assert.ok(/q\.steerState === 'merged' \? '已并入当前回合 · 等待 AI 处理' : '已引导 · 等待 AI 读取'/.test(chatInput),
  '条目上显示状态(lifecycle 事件到了才精确到"已并入")');
assert.ok(/disabled=\{!canSteer \|\| firstSteerableIndex\(queueItems\) < 0\}/.test(chatInput),
  'connecting 置灰判据保留,外加"没有可引导条目"也置灰');
assert.ok(/canSteer = false/.test(chatInput), 'canSteer 默认 false:没传就按不可注入处理');
assert.ok(/canSteer=\{!!\(liveChatPid \|\| backgroundPid\)\}/.test(app), 'canSteer 判据不动');

// ── 11) Bug8 回滚重复(不变):forceSend + 等停止落地 + 三件对称 ────
assert.ok(/if \(Date\.now\(\) < deadline && \(streamingRef\.current \|\| backgroundPidRef\.current\)\) \{/.test(app),
  '发前轮询【两个】ref(v0.2.191 转后台漏判律)');
assert.ok(/const deadline = Date\.now\(\) \+ 4000;/.test(app), '轮询上限 4s,超时也发(不裸 await 控制调用)');
assert.equal((app.match(/stoppedPidsRef\.current\.add\(String\(_r[bt]Pid\)\)/g) || []).length, 2,
  '回滚与工具重做两个入口都记被杀 pid');
assert.equal((app.match(/backgroundPidRef\.current = null;[^\n]*\n\s*updateStreaming\(false\);/g) || []).length, 2,
  '两个入口都清 backgroundPid(state + ref)');
assert.equal((app.match(/\} else if \(backgroundPidRef\.current\) \{\s*\n(?:\s*\/\/[^\n]*\n)?\s*fetch\(`\/api\/chat\/\$\{backgroundPidRef\.current\}\/stop`[^\n]*hard: true/g) || []).length, 2,
  '后台态也真发 hard /stop(handleStop 的第三件事)');
assert.ok(/resendReplacing\(\s*\n?\s*`<cgui-tool-retry/.test(app), 'handleRetryTool 同批');
assert.ok(/resendReplacing\(resendText\.prompt \|\| originalText, resendText\.options \|\| \{\}\);/.test(app), '编辑重发同一通道');

// ── 12) 附带发现2:旧流 finally 的归属守卫(不变)──────────────────
assert.ok(/if \(isCurrentTurn\(\)\) \{\s*\n\s*updateStreaming\(false\);\s*\n\s*activeProcRef\.current = null;\s*\n\s*abortRef\.current = null;/.test(app),
  'connecting 窗口下迟到的旧 finally 不得把【新回合】的停止句柄清成 null');

console.log('PASS check-steer-inject');
