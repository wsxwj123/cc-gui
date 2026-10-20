#!/usr/bin/env node
// r151l 历史消息分页 —— 纯函数单测。
// 服务端:sliceMessagesForPage(窗口/游标/hasMore/total)、parseHistoryPaging(query 校验)。
// 客户端:historyFetchLimit、mergeRefreshedMessages、prependOlderMessages、trimRecentMessages,
//        请求代号 nextHistoryRequestSeq / resetHistoryRequestSeq / isHistoryRequestCurrent
//        (窄复审①:按 (sessionId, tab, lane) 分账,refresh 与 older 互不作废),
//        以及分页账继承 resolveHistoryPagingFlags(窄复审②:loading/capped 只在同会话时保留)。
// Run: node tests/unit/check-r151l-history-page.mjs
// 变异哨兵:before 不按 total 钳 → t2 红;空窗口 beforeCursor 写成 0 → t3 红;不传 limit 切片 → t1 红。
import assert from 'node:assert/strict';
import { sliceMessagesForPage, parseHistoryPaging } from '../../server/utils/history-pagination.js';
import {
  HISTORY_LOADED_MAX,
  HISTORY_PAGE_SIZE,
  historyFetchLimit,
  historyMessageKey,
  isHistoryRequestCurrent,
  mergeRefreshedMessages,
  nextHistoryRequestSeq,
  prependOlderMessages,
  resetHistoryRequestSeq,
  resolveHistoryPagingFlags,
  trimRecentMessages,
} from '../../client/src/utils/historyPaging.js';

const seq = (n) => Array.from({ length: n }, (_, i) => ({ i }));
const idx = (list) => list.map((m) => m.i);

// ── t1 不传 limit = 全量(旧调用逐字兼容),新字段按全量语义 ─────────────────
{
  const all = seq(300);
  const page = sliceMessagesForPage(all);
  assert.equal(page.messages, all, '不传 limit 原样返回同一份列表');
  assert.deepEqual(idx(page.messages).slice(0, 3), [0, 1, 2]);
  assert.equal(page.hasMore, false, '全量语义 hasMore=false');
  assert.equal(page.beforeCursor, 0, '全量语义 beforeCursor=0');
  assert.equal(page.total, 300);
  assert.deepEqual(sliceMessagesForPage(all, {}), page, '空 options 与不传等价');
  assert.equal(sliceMessagesForPage(all, { before: 50 }).total, 300, '只给 before 不切(limit 缺省=全量)');
  assert.equal(sliceMessagesForPage(all, { before: 50 }).messages.length, 300);
}

// ── t2 limit 窗口:before 缺省=total,before 超界按 total 处理,limit>total 全量 ──
{
  const all = seq(300);
  const last = sliceMessagesForPage(all, { limit: 120 });
  assert.deepEqual(idx(last.messages), seq(120).map((x) => x.i + 180), 'limit=120 → 最后 120 条(180..299)');
  assert.equal(last.hasMore, true);
  assert.equal(last.beforeCursor, 180, '下一次 before=180');
  assert.equal(last.total, 300);

  const mid = sliceMessagesForPage(all, { limit: 120, before: 180 });
  assert.deepEqual(idx(mid.messages), seq(120).map((x) => x.i + 60), 'before=180 → 60..179');
  assert.equal(mid.beforeCursor, 60);
  assert.equal(mid.hasMore, true);

  const first = sliceMessagesForPage(all, { limit: 120, before: 60 });
  assert.deepEqual(idx(first.messages), seq(60).map((x) => x.i), 'before=60 → 0..59');
  assert.equal(first.hasMore, false);
  assert.equal(first.beforeCursor, 0);

  const over = sliceMessagesForPage(all, { limit: 120, before: 99_999 });
  assert.deepEqual(idx(over.messages), idx(last.messages), 'before>total 按 total(不报错)');
  assert.equal(over.beforeCursor, 180);
  assert.equal(over.total, 300);

  const wide = sliceMessagesForPage(all, { limit: 2000 });
  assert.equal(wide.messages.length, 300, 'limit>total → 全量');
  assert.equal(wide.hasMore, false);
  assert.equal(wide.beforeCursor, 0);

  const exact = sliceMessagesForPage(all, { limit: 300 });
  assert.equal(exact.messages.length, 300);
  assert.equal(exact.beforeCursor, 0);
  assert.equal(exact.hasMore, false);

  // before=0 → 空窗口,游标为 null(不能是 0,否则下次 before=0 无限循环)。
  const emptyWindow = sliceMessagesForPage(all, { limit: 120, before: 0 });
  assert.deepEqual(emptyWindow.messages, []);
  assert.equal(emptyWindow.hasMore, false);
  assert.equal(emptyWindow.beforeCursor, null);
  assert.equal(emptyWindow.total, 300);
}

// ── t3 边界:空数组、单条、纯度 ────────────────────────────────────────────
{
  const none = sliceMessagesForPage([], { limit: 120 });
  assert.deepEqual(none.messages, []);
  assert.equal(none.hasMore, false);
  assert.equal(none.beforeCursor, null, '空窗口 → beforeCursor=null');
  assert.equal(none.total, 0);

  const noneFull = sliceMessagesForPage([]);
  assert.deepEqual(noneFull.messages, []);
  assert.equal(noneFull.hasMore, false);
  assert.equal(noneFull.beforeCursor, 0, '全量语义即便空列表也是 0');
  assert.equal(noneFull.total, 0);

  const one = [{ i: 0 }];
  const onePage = sliceMessagesForPage(one, { limit: 120 });
  assert.deepEqual(idx(onePage.messages), [0]);
  assert.equal(onePage.beforeCursor, 0);
  assert.equal(onePage.hasMore, false);
  assert.equal(onePage.total, 1);

  const all = seq(300);
  const snapshot = JSON.stringify(all);
  sliceMessagesForPage(all, { limit: 120, before: 180 });
  assert.equal(JSON.stringify(all), snapshot, '不得修改入参');

  const notArray = sliceMessagesForPage(null, { limit: 10 });
  assert.deepEqual(notArray.messages, []);
  assert.equal(notArray.total, 0);
}

// ── t4 query 解析:合法值 + 非法集合(接口文件 §1) ─────────────────────────
{
  assert.deepEqual(parseHistoryPaging({}), { ok: true, limit: undefined, before: undefined });
  assert.deepEqual(parseHistoryPaging({ limit: '120' }), { ok: true, limit: 120, before: undefined });
  assert.deepEqual(parseHistoryPaging({ limit: '1' }).limit, 1);
  assert.deepEqual(parseHistoryPaging({ limit: '2000' }).limit, 2000, '上界 2000 合法');
  assert.deepEqual(parseHistoryPaging({ before: '0' }).before, 0, 'before=0 合法');
  assert.deepEqual(parseHistoryPaging({ before: '999999' }).before, 999999, 'before 超界不在这里报错');
  assert.deepEqual(parseHistoryPaging({ limit: '120', before: '180' }), { ok: true, limit: 120, before: 180 });
  assert.deepEqual(parseHistoryPaging({ limit: 120, before: 180 }), { ok: true, limit: 120, before: 180 }, '数字形态同样接受');
  assert.deepEqual(parseHistoryPaging({ limit: '0120' }).limit, 120, '前导零按数值处理');

  for (const bad of ['0', '-1', '1.5', '3000', '2001', 'abc', '', ' 1', '1e2', '+1']) {
    const r = parseHistoryPaging({ limit: bad });
    assert.equal(r.ok, false, `非法 limit=${JSON.stringify(bad)} 应拒绝`);
    assert.match(r.error, /limit/, '错误信息要指明 limit');
  }
  for (const bad of ['-1', '2.5', 'abc', '', '1e2', '-0', ' 0']) {
    const r = parseHistoryPaging({ before: bad });
    assert.equal(r.ok, false, `非法 before=${JSON.stringify(bad)} 应拒绝`);
    assert.match(r.error, /before/, '错误信息要指明 before');
  }
  assert.equal(parseHistoryPaging({ limit: ['120'] }).ok, false, '数组(重复 query)视为非法');
  assert.equal(parseHistoryPaging({ before: {} }).ok, false, '对象视为非法');
  // limit 合法 + before 非法 → 整体拒绝(不能只放行一半)。
  assert.equal(parseHistoryPaging({ limit: '120', before: 'x' }).ok, false);
}

// ── t5 前端请求窗口:首屏 120,刷新至少等于已加载条数,上限 2000 ─────────────
{
  assert.equal(HISTORY_PAGE_SIZE, 120);
  assert.equal(HISTORY_LOADED_MAX, 2000);
  assert.equal(historyFetchLimit(0), 120, '首屏');
  assert.equal(historyFetchLimit(1), 120, '远小于一页仍取 120');
  assert.equal(historyFetchLimit(120), 120);
  assert.equal(historyFetchLimit(121), 121, '已加载更多时刷新不得退回 120');
  assert.equal(historyFetchLimit(240), 240);
  assert.equal(historyFetchLimit(2000), 2000);
  assert.equal(historyFetchLimit(2001), 2000, '上限 2000');
  assert.equal(historyFetchLimit(50_000), 2000);
  assert.equal(historyFetchLimit(undefined), 120);
  assert.equal(historyFetchLimit(NaN), 120);
  assert.equal(historyFetchLimit(-5), 120);
}

// ── t6 静默刷新:服务端后缀窗口 + 已加载旧前缀合并,不丢旧消息 ───────────────
{
  const msg = (i) => ({ i, uuid: `u${i}` });
  const existing = Array.from({ length: 120 }, (_, k) => msg(180 + k)); // 180..299
  const appended = [...Array.from({ length: 119 }, (_, k) => msg(181 + k)), msg(300)]; // 181..300
  const merged = mergeRefreshedMessages(existing, appended);
  assert.equal(merged.preservedPrefix, 1, '保留旧列表最旧的一条');
  assert.deepEqual(idx(merged.messages), Array.from({ length: 121 }, (_, k) => 180 + k), '180..300 一条不少');

  const same = mergeRefreshedMessages(existing, existing);
  assert.equal(same.preservedPrefix, 0, '无追加 → 以服务端窗口为准');
  assert.equal(same.messages.length, 120);

  const noOverlap = mergeRefreshedMessages(existing, Array.from({ length: 120 }, (_, k) => msg(400 + k)));
  assert.equal(noOverlap.preservedPrefix, 0, '无交集(文件被重写)→ 不复活旧内容');
  assert.equal(noOverlap.messages[0].i, 400);

  assert.deepEqual(mergeRefreshedMessages([], [msg(1)]).messages.map((m) => m.i), [1]);
  assert.deepEqual(mergeRefreshedMessages(existing, []).messages, [], '服务端为空 → 清空(不复活)');
  assert.deepEqual(mergeRefreshedMessages(null, null).messages, []);

  // 没有 uuid 的合成条目走 type+时间戳+正文兜底键,不能全部撞成同一个键。
  assert.notEqual(
    historyMessageKey({ type: 'goal', timestamp: 't1', text: 'a' }),
    historyMessageKey({ type: 'goal', timestamp: 't2', text: 'a' }),
  );
  assert.equal(historyMessageKey(null), '');
}

// ── t7 加载更早:前插去重(与已加载/流式重复的条目不重复插) ──────────────────
{
  const msg = (i) => ({ i, uuid: `u${i}` });
  const existing = Array.from({ length: 120 }, (_, k) => msg(180 + k));
  const older = Array.from({ length: 120 }, (_, k) => msg(60 + k));
  const first = prependOlderMessages(existing, older);
  assert.equal(first.addedCount, 120);
  assert.deepEqual(idx(first.messages).slice(0, 3), [60, 61, 62]);
  assert.deepEqual(idx(first.messages).slice(-2), [298, 299]);
  assert.equal(first.messages.length, 240);

  // 与已加载部分重叠时只插缺的那一段(按 uuid 去重)。
  const overlapPage = Array.from({ length: 120 }, (_, k) => msg(120 + k)); // 120..239
  const second = prependOlderMessages(existing, overlapPage);
  assert.equal(second.addedCount, 60, '180..239 已在列表里 → 只前插 120..179');
  assert.equal(second.messages.length, 180);
  assert.deepEqual(idx(second.messages).slice(0, 2), [120, 121]);

  const none = prependOlderMessages(existing, []);
  assert.equal(none.addedCount, 0);
  assert.equal(none.messages, existing, '空页原样返回');
  assert.equal(prependOlderMessages([], older).messages.length, 120);
  // 页内自身重复也去重。
  const dupPage = [msg(1), msg(1), msg(2)];
  const dup = prependOlderMessages([], dupPage);
  assert.equal(dup.addedCount, 2);
  assert.deepEqual(idx(dup.messages), [1, 2]);
}

// ── t8 2000 条上限:超出只留最近 2000,返回丢弃条数 ─────────────────────────
{
  const msgs = seq(300);
  assert.deepEqual(trimRecentMessages(msgs, 2000), { messages: msgs, dropped: 0 });
  const over = trimRecentMessages(seq(2001), 2000);
  assert.equal(over.messages.length, 2000);
  assert.equal(over.dropped, 1);
  assert.equal(over.messages[0].i, 1, '丢最旧的,留最近 2000');
  assert.equal(over.messages[1999].i, 2000);
  assert.equal(trimRecentMessages(null).messages.length, 0, '非数组不抛');
  const custom = trimRecentMessages(seq(10), 4);
  assert.deepEqual(custom.messages.map((m) => m.i), [6, 7, 8, 9]);
  assert.equal(custom.dropped, 6);
}

// ── t9 请求代号:按 (sessionId, tab, lane) 分账,refresh/older 互不作废(窄复审①)──
{
  const fresh = nextHistoryRequestSeq(undefined, 0, 's1');
  assert.deepEqual(fresh.seqs[0], { sessionId: 's1', refresh: 1, older: 0 }, '缺 state 时从 0 起');
  assert.equal(fresh.seq, 1);

  const a = nextHistoryRequestSeq([], 2, 's1', 'refresh');
  assert.deepEqual(a.seqs[2], { sessionId: 's1', refresh: 1, older: 0 });
  const b = nextHistoryRequestSeq(a.seqs, 2, 's1', 'refresh');
  assert.deepEqual(b.seqs[2], { sessionId: 's1', refresh: 2, older: 0 });
  assert.deepEqual(a.seqs[2], { sessionId: 's1', refresh: 1, older: 0 }, '不原地修改入参');
  assert.equal(isHistoryRequestCurrent(b.seqs, 2, 's1', 'refresh', 2), true);
  assert.equal(isHistoryRequestCurrent(b.seqs, 2, 's1', 'refresh', 1), false, '旧代号必须作废');

  // refresh 与 older 是两条独立递增线:互不作废(原实现共用一条号 → 静默刷新会丢 loadOlder)。
  const o1 = nextHistoryRequestSeq(b.seqs, 2, 's1', 'older');
  assert.equal(o1.seq, 1, 'older 自己从 1 起');
  assert.equal(isHistoryRequestCurrent(o1.seqs, 2, 's1', 'refresh', 2), true, '加载更早不得作废刷新');
  assert.equal(isHistoryRequestCurrent(o1.seqs, 2, 's1', 'older', 1), true);
  const r3 = nextHistoryRequestSeq(o1.seqs, 2, 's1', 'refresh');
  assert.equal(isHistoryRequestCurrent(r3.seqs, 2, 's1', 'older', 1), true, '刷新不得作废加载更早');
  assert.equal(isHistoryRequestCurrent(r3.seqs, 2, 's1', 'refresh', 2), false);

  // 别的 tab / 别的会话不共用代号。
  const otherTab = nextHistoryRequestSeq(r3.seqs, 3, 's1', 'refresh');
  assert.equal(otherTab.seq, 1, '别的 tab 从 0 起');
  assert.equal(isHistoryRequestCurrent(otherTab.seqs, 2, 's1', 'refresh', 3), true, '别的 tab 不影响本 tab');
  assert.equal(isHistoryRequestCurrent(otherTab.seqs, 3, 's1', 'refresh', 1), true);
  const otherSess = nextHistoryRequestSeq(otherTab.seqs, 2, 's2', 'refresh');
  assert.equal(isHistoryRequestCurrent(otherSess.seqs, 2, 's1', 'refresh', 3), false, '换会话后旧号作废');
  assert.equal(otherSess.seq, 4, '计数器只增不减:切回同一会话的新号必然大于旧号(不撞号)');

  // reset(切会话/清窗格):sessionId 置空 → 在飞响应立即过期;两条计数器都 +1
  // (窄复审②:切回同一会话时 refresh 会把 sessionId 写回来,旧 older 号若不变会"复活")。
  const reset = resetHistoryRequestSeq(otherSess.seqs, 2);
  assert.equal(reset[2].sessionId, null);
  assert.equal(reset[2].refresh, 5, 'reset 递增 refresh 计数器(不归零)');
  assert.equal(reset[2].older, 2, 'reset 递增 older 计数器');
  assert.equal(isHistoryRequestCurrent(reset, 2, 's1', 'refresh', 4), false, '切走后旧响应立即判过期');
  assert.deepEqual(reset[1], otherSess.seqs[1], '别的 tab 不受影响');
  const back = nextHistoryRequestSeq(reset, 2, 's2', 'refresh');
  assert.equal(back.seq, 6, '切回原会话:新号 > 旧号,旧响应仍过期');
  assert.equal(isHistoryRequestCurrent(back.seqs, 2, 's2', 'refresh', 4), false);
  // 窄复审②回归哨兵:切走再切回**同一会话**,旧 older 响应不能因 refresh 写回 sessionId
  // 而重新被认作最新(旧实现 reset 保留 older 号 → 这里会误判 current,旧页拼回 = 分页空洞)。
  const inFlightOlder = nextHistoryRequestSeq(back.seqs, 4, 'sA', 'older');
  assert.equal(inFlightOlder.seq, 1);
  const away = resetHistoryRequestSeq(inFlightOlder.seqs, 4);
  const backRefresh = nextHistoryRequestSeq(away, 4, 'sA', 'refresh');
  assert.equal(backRefresh.seqs[4].sessionId, 'sA', '切回后 refresh 重新写回 sessionId');
  assert.equal(isHistoryRequestCurrent(backRefresh.seqs, 4, 'sA', 'older', inFlightOlder.seq), false,
    '切换前在飞的旧 older 响应必须仍判过期(不能靠 sessionId 撞回而复活)');
  // 新请求领号也不会与旧响应撞号。
  assert.equal(backRefresh.seqs[4].older, inFlightOlder.seq + 1, '切回后存储的 older 号 = 旧号 + 1');
  // tab 越界按 0 处理。
  assert.deepEqual(nextHistoryRequestSeq(undefined, 9, 's3', 'older').seqs[0],
    { sessionId: 's3', refresh: 0, older: 1 });
  assert.equal(isHistoryRequestCurrent(undefined, 0, 's1', 'refresh', 1), false, '缺 state 时保守判过期');
}

// ── t10 分页账继承:loading/capped 只在同会话时保留(窄复审②)───────────────
{
  const aPaging = { sessionId: 'sA', loading: true, capped: true };
  assert.deepEqual(resolveHistoryPagingFlags(aPaging, 'sA'), { loading: true, capped: true },
    '同会话:在飞的 loading / capped 原样保留');
  assert.deepEqual(resolveHistoryPagingFlags(aPaging, 'sA', { capped: true }), { loading: true, capped: true });
  assert.deepEqual(resolveHistoryPagingFlags(aPaging, 'sB'), { loading: false, capped: false },
    '换会话:绝不能把 A 的 loading/capped 抄进 B 的新账');
  assert.equal(resolveHistoryPagingFlags(aPaging, 'sB', { capped: true }).capped, true,
    'capped 由本次响应自己算出(修剪/触顶)时照旧生效');
  assert.deepEqual(resolveHistoryPagingFlags(null, 'sA'), { loading: false, capped: false });
  assert.deepEqual(resolveHistoryPagingFlags(undefined, 'sA', { capped: false }), { loading: false, capped: false });
  assert.deepEqual(resolveHistoryPagingFlags({ sessionId: 'sA', loading: false, capped: false }, 'sA'),
    { loading: false, capped: false }, '同会话但没在飞 → 不凭空造 loading');
  assert.deepEqual(resolveHistoryPagingFlags({ sessionId: 'sB', loading: true }, 'sA', { capped: true }),
    { loading: false, capped: true }, '别会话的 loading 不继承,但本次 capped 保留');
}

console.log('check-r151l-history-page: all passed');
