#!/usr/bin/env node
// 批B B2:SSE attach 由「拒绝 409」改为「新连接接管旧监听」。
// 回归对象:老监听多半是关窗格/崩溃留下的僵尸(客户端曾从不 abort),却把新窗格永久挡在
// 门外 → 该会话没有任何追加通道,只剩一条承诺"自动追加"的后台横幅。
//
// token 是这条协议的唯一防线:被接管的老连接,它的 req.on('close') 必然晚于新 attach 到达。
// 若 close 回调无条件把 slot.attached 置 false,下一个 attach 就又走接管分支踢掉刚接上的
// 正常连接 —— attach 抖动。故让位只在【自己仍是当前持有者】时生效。
// 直接 import chat.js 的真函数(非复刻):去掉 token 守卫时下面的断言必须失败。
// 修前失败形态:HEAD 版 chat.js 根本没有 claimAttach / releaseAttach 导出,import 即报错。
//
// 批J J2 追加:接管必须由服务端【明说】。客户端原来只能从"reader 无 done 却正常结束"去猜,
// 而 WebView 空闲掐断 / 断网是同一形态 —— 猜错一次就焊死 reattach 闩锁(本回合内永不重连)。
// 故 end 之前先给每个旧响应写一行 detached 事件,且必须【先写后 end】(end 之后写不进去)。
import assert from 'node:assert/strict';
import { claimAttach, releaseAttach, DETACHED_TAKEOVER_LINE } from '../../server/routes/chat.js';

// 最小 slot 替身:只含本协议碰到的字段(与 chat.js slot 字面量同名同类型)。
const mkSlot = () => ({ listeners: new Set(), attachments: new Set(), attached: false, attachToken: 0 });
// 一次 attach 的替身:onLine 是写函数,end 是主动关响应。ended 计数供断言。
// 真实 safeWrite 在 end 之后写不进去 —— 这里如实模拟(ended 后写入记为 afterEnd),
// 好让"先写后 end"的顺序有断言可依。
const mkConn = (name, log) => {
  const conn = {
    onLine: (l) => { if (conn.ended) conn.afterEnd++; else log.push(`${name}:${l}`); },
    ended: 0, afterEnd: 0, end: () => { conn.ended++; },
  };
  return conn;
};

// ── ① 无人 attach:直接占用 ────────────────────────────────────────
{
  const slot = mkSlot();
  const log = [];
  const a = mkConn('a', log);
  claimAttach(slot, 1);
  slot.listeners.add(a.onLine);
  slot.attachments.add({ onLine: a.onLine, end: a.end });
  assert.equal(slot.attached, true);
  assert.equal(slot.attachToken, 1);
  assert.equal(a.ended, 0, '没有老连接时不该 end 任何东西');
}

// ── ② 已 attach:接管 —— 老响应被 end、监听清空、attached 仍真、token 更新 ──
{
  const slot = mkSlot();
  const log = [];
  const old = mkConn('old', log);
  claimAttach(slot, 1);
  slot.listeners.add(old.onLine);
  slot.attachments.add({ onLine: old.onLine, end: old.end });

  const fresh = mkConn('new', log);
  claimAttach(slot, 2);
  assert.equal(old.ended, 1, '接管必须主动 end 掉老响应(否则老 fetch 永远挂着)');
  assert.equal(slot.listeners.size, 0, '接管后老监听必须清空,防两个连接双读同一条流');
  assert.equal(slot.attachments.size, 0);
  assert.equal(slot.attached, true, '接管后仍是 attached(换了持有者,不是断开)');
  assert.equal(slot.attachToken, 2, 'token 必须换成新持有者的');

  slot.listeners.add(fresh.onLine);
  slot.attachments.add({ onLine: fresh.onLine, end: fresh.end });
  // 接管后 deliverLine 只推给新连接
  for (const fn of slot.listeners) fn('hello');
  assert.deepEqual(log, [`old:${DETACHED_TAKEOVER_LINE}`, 'new:hello'],
    '老连接必须先收到 detached 告知,之后只有新连接收到行');
}

// ── ②b 接管告知:先写 detached 再 end,且事件形态是约定的那一条 ────────────
// 顺序反了(先 end 后写)= 客户端一个字节都收不到,又退回"靠猜"的老形态。
{
  const slot = mkSlot();
  const log = [];
  const old = mkConn('old', log);
  claimAttach(slot, 1);
  slot.listeners.add(old.onLine);
  slot.attachments.add({ onLine: old.onLine, end: old.end });

  claimAttach(slot, 2);
  assert.deepEqual(log, [`old:${DETACHED_TAKEOVER_LINE}`], '被接管的连接必须收到 detached 事件');
  assert.equal(old.afterEnd, 0, 'detached 必须写在 end 之【前】,否则根本发不出去');
  assert.equal(old.ended, 1, '告知之后仍要照常 end');

  const ev = JSON.parse(DETACHED_TAKEOVER_LINE);
  assert.equal(ev.type, 'detached', '事件 type 必须是 detached(客户端按它设闩锁)');
  assert.equal(ev.reason, 'takeover');
  assert.ok(!DETACHED_TAKEOVER_LINE.startsWith('{"type":"done"'),
    'detached 不得撞上 done 的行首前缀,否则 SSE 侧会把它当收尾控制行');
}

// ── ②c 多条旧连接:每条都收到告知、都被 end(不许只处理第一条)────────────
{
  const slot = mkSlot();
  const log = [];
  const a = mkConn('a', log); const b = mkConn('b', log);
  claimAttach(slot, 1);
  for (const c of [a, b]) { slot.listeners.add(c.onLine); slot.attachments.add({ onLine: c.onLine, end: c.end }); }

  claimAttach(slot, 2);
  assert.equal(a.ended, 1); assert.equal(b.ended, 1);
  assert.deepEqual(log.sort(), [`a:${DETACHED_TAKEOVER_LINE}`, `b:${DETACHED_TAKEOVER_LINE}`].sort(),
    '每条旧连接都要收到告知');
}

// ── ③ 老 token 让位:必须被守卫挡住(本用例即 token 守卫的存在性证明)──────
{
  const slot = mkSlot();
  const log = [];
  const old = mkConn('old', log);
  claimAttach(slot, 1);
  slot.listeners.add(old.onLine);
  slot.attachments.add({ onLine: old.onLine, end: old.end });

  const fresh = mkConn('new', log);
  claimAttach(slot, 2);
  slot.listeners.add(fresh.onLine);
  slot.attachments.add({ onLine: fresh.onLine, end: fresh.end });

  // 老连接的 req.on('close') 现在才到(被 end 触发,必然晚于新 attach)
  releaseAttach(slot, 1, old.onLine);
  assert.equal(slot.attached, true,
    '老 token 让位必须无效,否则下一个 attach 会误判"无人占用"并踢掉正常连接(attach 抖动)');
  assert.equal(slot.attachToken, 2, '老连接的 close 不得改 token');
  assert.equal(slot.listeners.size, 1, '老连接的 close 只删自己那条监听');
  assert.ok(slot.listeners.has(fresh.onLine), '新连接的监听不能被老 close 误删');
  assert.equal(slot.attachments.size, 1);
  assert.equal([...slot.attachments][0].onLine, fresh.onLine, '登记表里只该剩新连接');
}

// ── ④ 当前 token 让位:正常断开,attached 归假,后续行回落 earlyLines ────────
{
  const slot = mkSlot();
  const log = [];
  const a = mkConn('a', log);
  claimAttach(slot, 5);
  slot.listeners.add(a.onLine);
  slot.attachments.add({ onLine: a.onLine, end: a.end });

  releaseAttach(slot, 5, a.onLine);
  assert.equal(slot.attached, false, '当前持有者断开必须让位,否则下一个窗格永远 attach 不上');
  assert.equal(slot.listeners.size, 0);
  assert.equal(slot.attachments.size, 0);
}

// ── ⑤ 幂等:同一 close 回调重复触发不抛、不误伤 ────────────────────────
{
  const slot = mkSlot();
  const log = [];
  const a = mkConn('a', log);
  claimAttach(slot, 7);
  slot.listeners.add(a.onLine);
  slot.attachments.add({ onLine: a.onLine, end: a.end });
  releaseAttach(slot, 7, a.onLine);
  assert.doesNotThrow(() => releaseAttach(slot, 7, a.onLine));
  assert.equal(slot.attached, false);
}

// ── ⑥ 死连接不得中断接管:end() 抛错、onLine 抛错、两者同时抛,都要走完 ────
// 且一条死连接不许连累其余连接的告知与清理(逐个 try/catch 的存在性证明)。
{
  const slot = mkSlot();
  const log = [];
  slot.attached = true;
  slot.attachToken = 1;
  const boomEnd = { onLine: () => {}, end: () => { throw new Error('EPIPE'); } };
  const boomWrite = { onLine: () => { throw new Error('EPIPE'); }, ended: 0, end() { this.ended++; } };
  const alive = mkConn('alive', log);
  for (const c of [boomEnd, boomWrite, { onLine: alive.onLine, end: alive.end }]) {
    slot.listeners.add(c.onLine);
    slot.attachments.add(c);
  }
  assert.doesNotThrow(() => claimAttach(slot, 2));
  assert.equal(slot.attached, true);
  assert.equal(slot.attachToken, 2, '抛错也必须走完接管,否则新窗格接不上');
  assert.equal(slot.listeners.size, 0);
  assert.equal(slot.attachments.size, 0);
  assert.equal(boomWrite.ended, 1, '写失败(EPIPE)不得跳过这条连接自己的 end');
  assert.equal(alive.ended, 1, '死连接不得中断其余连接的清理');
  assert.deepEqual(log, [`alive:${DETACHED_TAKEOVER_LINE}`], '死连接不得中断其余连接的告知');
}

// ── ⑦ 路由段源码守卫:409 拒绝分支必须已经消失,close 走 releaseAttach ────
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const src = readFileSync(join(root, 'server/routes/chat.js'), 'utf8');
  assert.ok(!/Stream already attached/.test(src), '409 拒绝分支必须删除(改为接管)');
  const i = src.indexOf("router.get('/chat/:pid/stream'");
  assert.ok(i > 0, '找不到 SSE attach 路由');
  const seg = src.slice(i, i + 2600);
  assert.ok(/const myToken = \+\+attachSeq;/.test(seg), 'attach 必须自增取 token');
  assert.ok(/claimAttach\(slot, myToken\)/.test(seg), 'attach 必须走 claimAttach');
  assert.ok(/releaseAttach\(slot, myToken, onLine\)/.test(seg), 'close 必须走 releaseAttach');
  assert.ok(!/slot\.attached = false/.test(seg), 'close 里不得再裸写 slot.attached = false(绕过 token 守卫)');
  // earlyLines 回放/心跳/pumpEnded 补 done 三段不在本次改动范围,守住不被顺手动掉
  assert.ok(/for \(const l of slot\.earlyLines\)/.test(seg), 'earlyLines 回放逻辑不得改动');
  assert.ok(/if \(!closed && slot\.pumpEnded\)/.test(seg), 'pumpEnded 补 done 不得改动');
  assert.ok(/': keep-alive\\n\\n'/.test(seg), '心跳不得改动');
}

console.log('✓ check-stream-attach-takeover: 接管协议 + token 让位守卫全过');
