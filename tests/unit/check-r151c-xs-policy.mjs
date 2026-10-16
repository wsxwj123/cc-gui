#!/usr/bin/env node
// r151c 派工 3:判定纯函数与调度机关(方案 §3 xsession-policy.js / xsession-scheduler.js;接口 §4 去向表)。
//   ① 权限类别:六档归类;未知档位(含大小写不对、缺失、非字符串)按"读不出";发送方 × 目标 4 种组合只有两种同类。
//   ② 去向表 10 行逐行 + 先后次序;工作目录 / 项目 / provider / 档位宽窄不改变类别结果;hop 边界。
//   ③ 新回合的连锁标记(自动兑换继承消息的、点卡片与用户回合清空、在飞后台任务继承上一回合的)。
//   ④ 10 分钟 20 次的滑动计数(平移时间)。
//   ⑤ 调度机关:回合结束后满 1.5 秒才评估、刚转空闲时评估只记剩余时间、有排队且忙挂 30 秒复查、每会话串行、出错按忙处理。
// node tests/unit/check-r151c-xs-policy.mjs
import assert from 'node:assert/strict';
import { permissionClass, sameClass, decideRoute, chainForNewTurn, XS_CHAIN_DEPTH } from '../../server/services/xsession-policy.js';
import { createXsScheduler, createAutoBudget } from '../../server/services/xsession-scheduler.js';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];

// ① 权限类别
eq(MODES.map(permissionClass), ['guarded', 'guarded', 'guarded', 'guarded', 'guarded', 'permissive'], '六档归类:只有「放任」是 permissive');
for (const v of [undefined, null, '', 'BypassPermissions', 'bypass', 'manual', 1, {}, ['bypassPermissions']]) eq(permissionClass(v), null, `未知档位 ${JSON.stringify(v)} → null`);
const combos = [];
for (const s of ['permissive', 'guarded']) for (const t of ['permissive', 'guarded']) combos.push([s, t]);
const rep = { permissive: 'bypassPermissions', guarded: 'default' };
eq(combos.filter(([s, t]) => sameClass(rep[s], rep[t])), [['permissive', 'permissive'], ['guarded', 'guarded']], '4 种组合只有两种同类');
for (const a of MODES) for (const b of MODES) eq(sameClass(a, b), (a === 'bypassPermissions') === (b === 'bypassPermissions'), `${a} × ${b}`);
for (const m of MODES) { ok(!sameClass(m, 'nope') && !sameClass(undefined, m) && !sameClass(null, null), `未知档位与 ${m} 按不同`); }

// ② 去向表
const BASE = { manual: false, inbound: 'auto', hop: 1, paused: false, hasProfile: true, profileFresh: true, senderMode: 'bypassPermissions', targetMode: 'bypassPermissions', stuck: false, busy: false };
const route = (over) => decideRoute({ ...BASE, ...over });
const held = (r) => ({ status: 'pending', heldReason: r });
eq(route({}), { status: 'processing' }, '⑩ 都满足 → 开始处理');
const rows = [
  ['① 手动转发', { manual: true }, held('target-card')],
  ['② 目标接收设置 card', { inbound: 'card' }, held('target-card')],
  ['③ hop > 4', { hop: XS_CHAIN_DEPTH + 1 }, held('chain-limit')],
  ['④ 已暂停', { paused: true }, held('paused')],
  ['⑤ 没有本次启用之后的档案', { hasProfile: false }, held('no-profile')],
  ['⑥ 指纹不同', { profileFresh: false }, held('profile-stale')],
  ['⑦ 类别不同', { senderMode: 'default' }, held('class-mismatch')],
  ['⑧ 卡住', { stuck: true }, held('target-stuck')],
  ['⑨ 忙', { busy: true }, { status: 'queued' }],
];
for (const [label, over, want] of rows) eq(route(over), want, label);
// 先后:每一行与它后面所有行同时成立时,仍是这一行的结果
for (let i = 0; i < rows.length; i++) {
  const all = Object.assign({}, ...rows.slice(i).map(([, o]) => o));
  eq(route(all), rows[i][2], `先后:${rows[i][0]} 先于后面各行`);
}
eq(route({ inbound: undefined }), held('target-card'), '接收设置缺失按 card');
eq([route({ hop: 4 }), route({ hop: 0 }), route({ hop: 1.5 }), route({ hop: '2' })], [{ status: 'processing' }, held('chain-limit'), held('chain-limit'), held('chain-limit')], 'hop 4 可以;0、小数、字符串一律按超限');
eq(route({ targetMode: null }), held('class-mismatch'), '目标档位读不出 → 类别不同');
eq(route({ senderMode: undefined, targetMode: 'default' }), held('class-mismatch'), '发送方档位读不出 → 类别不同');
// 档位宽窄、工作目录、项目、provider 都不改变结果(只看类别)
const guarded = MODES.filter((m) => m !== 'bypassPermissions');
for (const s of guarded) for (const t of guarded) eq(route({ senderMode: s, targetMode: t, cwd: `/w/${s}`, project: t, provider: s + t }), { status: 'processing' }, `非放任内部 ${s} → ${t} 照样自动处理`);
for (const extra of [{ cwd: '/a' }, { cwd: '/b', project: 'p' }, { providerFp: 'x' }, { provider: 'openrouter' }]) eq(route(extra), { status: 'processing' }, `无关字段 ${JSON.stringify(extra)} 不影响`);
eq(route({ senderMode: 'plan', targetMode: 'bypassPermissions', cwd: '/same', project: 'same' }), held('class-mismatch'), '同目录同项目也按类别判');

// ③ 新回合的连锁标记
const auto = { auto: true, chainId: 'c-1', hop: 3 };
eq(chainForNewTurn({ redeemed: auto, liveTasks: 5, previous: { chainId: 'p', hop: 9 } }), { chainId: 'c-1', hop: 3 }, '自动兑换 → 该消息的标记');
eq(chainForNewTurn({ redeemed: { key: 'k' }, liveTasks: 2, previous: { chainId: 'p', hop: 2 } }), null, '点卡片兑换 → 空');
eq(chainForNewTurn({ liveTasks: 0, previous: { chainId: 'p', hop: 2 } }), null, '用户回合、没有在飞后台任务 → 空');
eq(chainForNewTurn({ liveTasks: 1, previous: { chainId: 'p', hop: 2 } }), { chainId: 'p', hop: 2 }, '用户回合、有上一回合留下的在飞后台任务 → 继承上一回合');
eq(chainForNewTurn({ liveTasks: 3, previous: null }), null, '有在飞任务但上一回合本来就是空标记 → 空');

// ④ 10 分钟 20 次(平移时间)
let clock = 1_000_000;
const bud = createAutoBudget({ limit: 20, windowMs: 600_000, now: () => clock });
for (let i = 1; i < 20; i++) { const n = bud.note(); ok(!n.reached && n.used === i, `第 ${i} 次未触顶`); clock += 1000; }
const twentieth = bud.note();
eq([twentieth.used, twentieth.reached], [20, true], '第 20 次触顶');
bud.refund(twentieth.stamp);
eq(bud.used(), 19, '退回一次');
clock += 600_000 - 19_000; // 最早一次刚好满 10 分钟
eq(bud.used(), 18, '窗口按 now() 滑动:满 10 分钟的不算');
clock += 3_600_000;
eq(bud.used(), 0, '平移一小时后计数归零');
bud.note(); bud.clear();
eq(bud.used(), 0, 'clear 清空');

// ⑤ 调度机关(假时钟、假定时器)
const timers = new Map(); let tid = 0;
const setTimer = (fn, ms) => { const id = ++tid; timers.set(id, { fn, at: clock + ms }); return id; };
const clearTimer = (id) => { timers.delete(id); };
const fire = async (upTo) => { // 依次触发到点的定时器
  clock = upTo;
  for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= clock && timers.has(id)) { timers.delete(id); t.fn(); }
  await new Promise((r) => setTimeout(r, 5));
};
const calls = [];
let reply = { queuedLeft: true, busy: true };
let running = 0; let overlap = false;
const sch = createXsScheduler({
  evaluate: async (id) => { running++; if (running > 1) overlap = true; calls.push([id, clock]); await new Promise((r) => setTimeout(r, 2)); running--; if (reply instanceof Error) throw reply; return reply; },
  hasQueued: (id) => id !== 'nobody', now: () => clock, setTimer, clearTimer,
});
clock = 0;
await sch.kick('S1');
eq(calls.map((c) => c[0]), ['S1'], 'kick → 评估一次');
eq(sch.timerOf('s1'), 'recheck', '有排队且目标忙 → 挂 30 秒复查(会话 id 不分大小写)');
await fire(29_999);
eq(calls.length, 1, '没到 30 秒不复查');
await fire(30_000);
eq(calls.length, 2, '30 秒到点复查一次');
eq(sch.timerOf('S1'), 'recheck', '仍忙 → 再挂一次');
reply = { queuedLeft: false, busy: false };
await fire(60_000);
eq(sch.timerOf('S1'), null, '没有排队了 → 不再挂定时器');
// 回合结束 → 满 1.5 秒才评估
calls.length = 0;
reply = { queuedLeft: true, busy: false };
clock = 100_000;
sch.noteTurnEnd('S2');
ok(sch.settling('S2') && sch.timerOf('S2') === 'idle', '刚转空闲:settling,挂 1.5 秒的定时器');
await sch.kick('S2'); // 这期间来的事件:评估照做(落卡片的立即落),投递的部分等满 1.5 秒
eq(sch.timerOf('S2'), 'idle', '评估后仍有排队、没满 1.5 秒 → 按剩余时间挂');
await fire(101_499);
eq(calls.filter((c) => c[0] === 'S2').length, 1, '1.5 秒内只有那次事件评估');
await fire(101_500);
eq(calls.filter((c) => c[0] === 'S2').map((c) => c[1]), [100_000, 101_500], '满 1.5 秒再评估');
ok(!sch.settling('S2'), '满 1.5 秒后不再 settling');
sch.noteTurnEnd('nobody');
eq(sch.timerOf('nobody'), null, '没有排队的会话回合结束不排评估');
// 平移时间:回合结束后墙上时间被往后拨,按 now() 判已满 1.5 秒
sch.noteTurnEnd('S3'); clock += 10 * 60_000;
ok(!sch.settling('S3'), '时间平移后按 now() 判定已过 1.5 秒(不只靠定时器)');
// 每会话串行
calls.length = 0; reply = { queuedLeft: false, busy: false }; overlap = false;
await Promise.all([sch.kick('S4'), sch.kick('S4'), sch.kick('S4')]);
ok(calls.length === 3 && !overlap, '同一会话的评估串行,不重叠');
// 评估出错 → 按"还在排、目标忙"处理
reply = new Error('boom');
await sch.kick('S5');
eq(sch.timerOf('S5'), 'recheck', '评估出错 → 挂复查,不丢消息');
sch.forget('S5');
eq(sch.timerOf('S5'), null, 'forget 撤掉定时器');

console.log(`PASS check-r151c-xs-policy(${checks} 项)`);
