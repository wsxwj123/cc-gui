#!/usr/bin/env node
// r151c 实点:自动处理回合进行中,目标会话里同一条来源气泡显示两次(历史条目 data-via="gui" + 直播气泡 data-via="auto")。
// CLI 在回合开始时就把这条写进会话记录,所以在跑的回合里打开会话、上一回合收尾刷新历史、接管在跑进程期间按节流刷新历史,
// 历史里都会先于或晚于直播 xs_message 出现同一条。修法(utils/xsession.js mergeLivePeersIntoHistory + App.jsx 渲染接线):
// 两个来源只画一个 —— 历史那条留在原位、带直播的 via(回合进行中仍是"自动处理"),直播气泡不在末尾单独画;
// 回合落盘对账收走直播气泡后 / 刷新后,历史那条是 gui(行为清单第 21 条)。同一条的判定沿用 peerLanded / keepLivePeer。
//   ① 先有历史、后来直播事件 → 一条,via=auto,在历史原位(回复之前)
//   ② 先有直播气泡、后来历史刷新 → 一条;刷新前在末尾,刷新后回到历史原位
//   ③ 回合落盘对账(keepLivePeer)收走直播气泡 → 一条,via=gui
//   ④ 本回合历史被截断(正常发送 / 点卡片处理)时不认领:截断挡掉的是本回合那条,更早的同正文消息不被拿来顶替
//   ⑤ 边界:历史里还没有新这条、却有正文完全相同的更早一条 → 新这条先认领更早那条(取舍,见报告);历史刷新出新这条后改认新这条
//   ⑥ 其它:正文不同不认领;已有锚点的直播气泡不参与;没有直播气泡时原引用;原生 result 气泡同理
//   ⑦ 源码锚:App.jsx 的渲染接线(条件与 visibleMessages 的截断条件一致;插入点不看历史、仍按 uuid 去重)
// node tests/unit/check-r151c-xs-peer-dedup.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

{
  const mem = new Map();
  globalThis.localStorage = {
    get length() { return mem.size; }, key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); }, clear: () => mem.clear(),
  };
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.fetch = async (url) => { throw new Error(`check-r151c-xs-peer-dedup:不应发请求 ${url}`); };
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const xs = await import('../../client/src/utils/xsession.js');

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const M1 = '11111111-0000-4000-8000-000000000001';
const M2 = '22222222-0000-4000-8000-000000000002';
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();

// 历史条目(服务端 session-reader peerMessageOf 的形状:from 为 gui:<发送方>,没有 via → peerVia 推成 gui)
const hist = (uuid, body, ts, extra = {}) => ({ type: 'peer-message', uuid, timestamp: iso(ts), fromName: '甲', from: `gui:${A}`, body, hostInjected: false, ...extra });
const turn = (uuid, ts) => ({ type: 'turn', uuid, timestamp: iso(ts), blocks: [] });
const user = (uuid, ts, text) => ({ type: 'user', uuid, timestamp: iso(ts), text });
// 直播 xs_message(自动处理)→ 与 App.jsx 同一构造函数
const liveAuto = (id, body) => xs.peerFromXsEvent({ type: 'xs_message', id, from: { kind: 'session', sessionId: A, title: '甲', project: 'proj-a' }, body, via: 'auto', hop: 1 });
const liveCard = (id, body) => xs.peerFromXsEvent({ type: 'xs_message', id, from: { kind: 'session', sessionId: A, title: '甲', project: 'proj-a' }, body, via: 'card', hop: 1 });
// App.jsx 插入点:按 uuid 去重追加(不看历史)
const insert = (chat, p) => (chat.some((m) => m.uuid === p.uuid) ? chat : [...chat, p]);

// 与 App.jsx 同一渲染接线:peerMerge(本回合历史被截断时不认领)→ placeAnchoredPeers → 末尾画剩下的本地条目
function render({ list, chat, cut = false }) {
  const merge = cut ? { list, taken: null } : xs.mergeLivePeersIntoHistory(list, chat);
  const placement = xs.placeAnchoredPeers(merge.list, chat);
  const tail = chat.filter((m) => m.type !== 'btw' && !placement.placed.has(m.uuid) && !merge.taken?.has(m.uuid));
  return [...placement.list, ...tail];
}
const bubbles = (rows, body) => rows.map((m, i) => ({ m, i })).filter(({ m }) => m.type === 'peer-message' && m.body === body)
  .map(({ m, i }) => ({ uuid: m.uuid, via: xs.peerVia(m), at: i }));

const BODY = 'R151C 实点 正文';

// ── ① 先有历史(打开在跑的会话 / 上一回合收尾刷新时 CLI 已写入)、后来直播事件 ─────────────────────────────
{
  const h = hist('h-new', BODY, NOW - 5_000);
  const list = [user('u0', NOW - 60_000, '早先的话'), turn('t0', NOW - 59_000), h, turn('t1', NOW - 4_000)];
  assert.deepEqual(bubbles(render({ list, chat: [] }), BODY), [{ uuid: 'h-new', via: 'gui', at: 2 }], '直播事件到来前:历史那条 gui');
  const chat = insert([], liveAuto(M1, BODY));
  const rows = render({ list, chat });
  assert.deepEqual(bubbles(rows, BODY), [{ uuid: 'h-new', via: 'auto', at: 2 }], '①:只画一条,留在历史原位(回复之前),带直播的 via=auto');
  assert.equal(rows.length, list.length, '①:直播气泡不在末尾单独画');
  const again = insert(chat, liveAuto(M1, BODY)); // 重放 / reattach 再收到同一条 xs_message
  assert.equal(again, chat, '插入点仍按 uuid 去重');
  assert.deepEqual(bubbles(render({ list, chat: again }), BODY), [{ uuid: 'h-new', via: 'auto', at: 2 }], '重放后仍是一条');
  assert.equal(list[2].via, undefined, '不改历史条目本身(渲染层出新对象)');
}

// ── ② 先有直播气泡、后来历史刷新(接管在跑进程期间节流刷新 / 回合中途刷新)──────────────────────────────────
{
  const before = [user('u0', NOW - 60_000, '早先的话'), turn('t0', NOW - 59_000)];
  const chat = insert([], liveAuto(M1, BODY));
  const r1 = render({ list: before, chat });
  assert.deepEqual(bubbles(r1, BODY), [{ uuid: `xs-peer-${M1}`, via: 'auto', at: before.length }], '②刷新前:历史里还没有 → 直播气泡在末尾,via=auto');
  const after = [...before, hist('h-new', BODY, NOW - 5_000), turn('t1', NOW - 4_000)];
  const r2 = render({ list: after, chat });
  assert.deepEqual(bubbles(r2, BODY), [{ uuid: 'h-new', via: 'auto', at: 2 }], '②刷新后:只画一条,回到历史原位,仍是 via=auto');
  assert.equal(r2.length, after.length, '②:直播气泡不再单独画');

  // ③ 回合落盘对账(App.jsx 回合收尾 / 兜底 effect 的 keepLivePeer)收走直播气泡 → 历史那条恢复 gui
  const reconciled = chat.filter((m) => xs.keepLivePeer(m, after));
  assert.deepEqual(reconciled, [], '③:历史里有同一条 → 对账收走直播气泡');
  assert.deepEqual(bubbles(render({ list: after, chat: reconciled }), BODY), [{ uuid: 'h-new', via: 'gui', at: 2 }], '③:回合结束后只剩历史那一个,via=gui');
}

// ── ④ 本回合历史被截断(正常发送 / 点卡片处理:本回合那条被截掉,不在可见历史里)→ 不认领 ─────────────────────
{
  const visible = [hist('h-old', BODY, NOW - 3_600_000), turn('t-old', NOW - 3_590_000), user('u1', NOW - 60_000, '别的话'), turn('t1', NOW - 59_000)];
  const chat = insert([], liveCard(M2, BODY));
  const cutRows = render({ list: visible, chat, cut: true });
  assert.deepEqual(bubbles(cutRows, BODY), [{ uuid: 'h-old', via: 'gui', at: 0 }, { uuid: `xs-peer-${M2}`, via: 'card', at: visible.length }],
    '④:截断时更早的同正文消息不被拿来顶替,新这条照常在末尾画(两条不同的消息各画各的)');
}

// ── ⑤ 边界:历史里还没有新这条,却有正文完全相同的更早一条(不截断时)────────────────────────────────────────
{
  const old = [hist('h-old', BODY, NOW - 3_600_000), turn('t-old', NOW - 3_590_000), user('u1', NOW - 60_000, '别的话'), turn('t1', NOW - 59_000)];
  const chat = insert([], liveAuto(M1, BODY));
  const r1 = render({ list: old, chat });
  assert.deepEqual(bubbles(r1, BODY), [{ uuid: 'h-old', via: 'auto', at: 0 }],
    '⑤取舍:按正文认不看时间 —— 新这条先认领更早的同正文条目(那条在原位显示成 auto,新这条不单独画)');
  const refreshed = [...old, hist('h-new', BODY, NOW - 5_000), turn('t2', NOW - 4_000)];
  const r2 = render({ list: refreshed, chat });
  assert.deepEqual(bubbles(r2, BODY), [{ uuid: 'h-old', via: 'gui', at: 0 }, { uuid: 'h-new', via: 'auto', at: 4 }],
    '⑤:历史刷新出新这条后改认新这条(新的配新的),更早那条恢复 gui');
}

// ── ⑥ 其它 ───────────────────────────────────────────────────────────────────────────────────────────────
{
  const list = [hist('h-x', '别的正文', NOW - 5_000), turn('t1', NOW - 4_000)];
  const chat = [liveAuto(M1, BODY)];
  const m = xs.mergeLivePeersIntoHistory(list, chat);
  assert.equal(m.list, list, '正文不同:不认领,原引用');
  assert.equal(m.taken.size, 0);
  assert.equal(bubbles(render({ list, chat }), BODY).length, 1, '正文不同:直播气泡照常画');

  const none = [hist('h-new', BODY, NOW - 5_000)];
  const empty = xs.mergeLivePeersIntoHistory(none, [user('u9', NOW, 'x')]);
  assert.equal(empty.list, none, '没有直播来源气泡:原引用(不打穿 MessageList 的 memo)');
  assert.equal(empty.taken.size, 0);

  const anchored = { ...liveAuto(M1, BODY), anchorUuid: 't1' };
  const withAnchor = [hist('h-new', BODY, NOW - 5_000), turn('t1', NOW - 4_000)];
  assert.equal(xs.mergeLivePeersIntoHistory(withAnchor, [anchored]).taken.size, 0, '已有锚点的直播气泡不参与(由 placeAnchoredPeers 负责)');

  // 两条不同正文的直播气泡各认各的;一条历史只被一个直播气泡认领
  const two = [hist('h-1', '正文一', NOW - 9_000), turn('t1', NOW - 8_000), hist('h-2', '正文二', NOW - 5_000), turn('t2', NOW - 4_000)];
  const chat2 = [liveAuto(M1, '正文一'), liveAuto(M2, '正文二')];
  const r = render({ list: two, chat: chat2 });
  assert.deepEqual(r.filter((x) => x.type === 'peer-message').map((x) => [x.uuid, xs.peerVia(x)]), [['h-1', 'auto'], ['h-2', 'auto']], '两条各认各的');
  const dup = [hist('h-1', BODY, NOW - 9_000), turn('t1', NOW - 8_000)];
  const chatDup = [liveAuto(M1, BODY), liveAuto(M2, BODY)];
  const rd = render({ list: dup, chat: chatDup });
  assert.equal(rd.filter((x) => x.type === 'peer-message').length, 2, '同正文两个直播气泡、历史只有一条:只认领一个,另一个照常画(不会少画)');

  // 原生 result 气泡:via 本就是 native → 历史那条不用换对象,直播气泡不单独画
  const nat = xs.peerFromResultEvent({ type: 'result', uuid: 'r-1', origin: { kind: 'peer', from: 'uds:/tmp/x.sock', name: '丙', body: BODY } }, NOW - 10_000);
  const natHist = [hist('h-nat', BODY, NOW - 5_000, { from: 'uds:/tmp/x.sock', fromName: '丙' }), turn('t1', NOW - 4_000)];
  const mn = xs.mergeLivePeersIntoHistory(natHist, [nat]);
  assert.equal(mn.list, natHist, '原生:via 相同,历史列表原引用');
  assert.ok(mn.taken.has(nat.uuid), '原生:直播气泡被认领,不单独画');
  assert.deepEqual(bubbles(render({ list: natHist, chat: [nat] }), BODY), [{ uuid: 'h-nat', via: 'native', at: 0 }], '原生:一条');
}

// ── ⑦ 源码锚:App.jsx 的渲染接线 ─────────────────────────────────────────────────────────────────────────
{
  const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
  const merge = app.match(/const peerMerge = useMemo\(\s*\(\) => \(streamHistCutoff && streamOwnerKey === sessionQueueKey\s*\? \{ list: mountedMessages, taken: null \}\s*: mergeLivePeersIntoHistory\(mountedMessages, visibleChat\)\),\s*\[mountedMessages, visibleChat, streamHistCutoff, streamOwnerKey, sessionQueueKey\],\s*\);/);
  assert.ok(merge, 'peerMerge:本回合历史被截断时不认领,否则按 mountedMessages 与 visibleChat 合并;依赖齐全');
  assert.ok(/if \(!cut \|\| streamOwnerKey !== sessionQueueKey\) return messages;/.test(app), 'visibleMessages 的截断条件仍是同一口径(peerMerge 与它互为反面)');
  assert.ok(app.indexOf('const peerMerge = useMemo(') > app.indexOf('const mountedMessages = useMemo('), 'peerMerge 定义在 mountedMessages 之后');
  assert.ok(/const peerPlacement = useMemo\(\(\) => placeAnchoredPeers\(peerMerge\.list, visibleChat\), \[peerMerge, visibleChat\]\);/.test(app), '锚点插回基于合并后的历史');
  assert.ok(/<MessageList\s+messages=\{peerPlacement\.list\}/.test(app), '历史列表画的是合并后的那份');
  assert.ok(app.includes("renderChat.filter((msg) => msg.type !== 'btw' && !peerPlacement.placed.has(msg.uuid) && !peerMerge.taken?.has(msg.uuid))"), '末尾不再单独画被认领的直播气泡');
  assert.ok(app.includes('if (peer) setChatMessages((prev) => (prev.some((m) => m.uuid === peer.uuid) ? prev : [...prev, { ...peer, ownerKey: streamOwnerSid() }]));'),
    '直播插入点不变:不看历史、按 uuid 去重(直播气泡要留着提供 via,也供回合落盘对账)');
}

console.log('check-r151c-xs-peer-dedup: OK');
