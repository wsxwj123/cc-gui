#!/usr/bin/env node
// r194 守卫:同一个会话在完成浮条、会话标题、顶栏、侧栏显示同一个名字。
//
// 会话名两个来源:会话记录里的 custom-title(列表项的 customTitle)与偏好 customTitles,列表项上的优先。
// 浮条 / 会话标题 / 顶栏手里常常是只有编号的对象或打开那一刻的旧快照,所以要先按编号到已加载的
// 会话列表里找最新的那一项再解析。本文件锁住:
//   ① findLoadedSession 的查找顺序:所在工作区那一组 → 旧槽 sessions → 其余各组;草稿 / 找不到返回 null;
//      返回列表里的原对象(不新建);
//   ② resolveLatestSessionTitle:最新列表项压过手里的旧对象;找不到才用手里的对象 + 偏好;
//      返回字符串(给 zustand 选择器用);假 st 缺字段不抛;
//   ③ writeJsonlTitle 没写成(会话不存在)返回 null —— 改名接口据此不广播 file-change。
import assert from 'node:assert/strict';
import { findLoadedSession, resolveLatestSessionTitle, resolveSessionTitle } from '../../client/src/utils/sessionTitle.js';
import { resolveSessionTitle as serverResolve } from '../../server/utils/session-title.js';

const SID = 'aaaaaaaa-1111-4222-8333-444444444444';
const OTHER = 'bbbbbbbb-1111-4222-8333-444444444444';

// 转出的仍是服务端那一份(前后端同口径)
assert.equal(resolveSessionTitle, serverResolve, 'sessionTitle.js 必须原样转出 server/utils/session-title.js 的 resolveSessionTitle');

// ── ① 查找顺序 ─────────────────────────────────────────────────────────────
{
  const inOwn = { sessionId: SID, projectHash: 'A', customTitle: '所在组' };
  const inSlot = { sessionId: SID, projectHash: 'A', customTitle: '旧槽' };
  const inOther = { sessionId: SID, projectHash: 'C', customTitle: '其它组' };
  const st = {
    sessionsByProject: { C: [inOther], A: [{ sessionId: OTHER }, inOwn] },
    sessions: [inSlot],
  };
  assert.equal(findLoadedSession(st, SID, 'A'), inOwn, '所在工作区那一组优先,返回列表里的原对象');
  assert.equal(findLoadedSession({ ...st, sessionsByProject: { C: [inOther], A: [] } }, SID, 'A'), inSlot,
    '所在组没有时找旧槽 sessions');
  assert.equal(findLoadedSession({ sessionsByProject: { C: [inOther], A: [] }, sessions: [] }, SID, 'A'), inOther,
    '旧槽也没有时找其余各组(会话可能挂在别的工作区组里)');
  assert.equal(findLoadedSession({ sessionsByProject: { A: [] }, sessions: [] }, SID, 'A'), null, '都没有返回 null');
  assert.equal(findLoadedSession({ sessionsByProject: { C: [inOther] }, sessions: [inSlot] }, SID, null), inSlot,
    '不知道所在工作区时:先旧槽,再各组');
  assert.equal(findLoadedSession(st, null, 'A'), null, '草稿(没有会话编号)返回 null');
  assert.equal(findLoadedSession(st, '', 'A'), null, '空编号返回 null');
  assert.equal(findLoadedSession(null, SID, 'A'), null, '没有 st 不抛,返回 null');
  assert.equal(findLoadedSession({}, SID, 'A'), null, 'st 缺 sessionsByProject / sessions 字段不抛');
  assert.equal(findLoadedSession({ sessionsByProject: { A: null }, sessions: 'x' }, SID, 'A'), null, '组不是数组时跳过,不抛');
  assert.equal(findLoadedSession({ sessionsByProject: { A: [null, undefined, inOwn] } }, SID, 'A'), inOwn, '列表里的空项跳过');
}

// ── ② 解析会话名 ───────────────────────────────────────────────────────────
{
  const listItem = { sessionId: SID, projectHash: 'A', customTitle: '甲', firstPrompt: '首条' };
  const st = {
    sessionsByProject: { A: [listItem] },
    sessions: [],
    customTitles: { [SID]: '乙' },
    autoTitles: {},
  };
  // 从完成浮条 / 后台代理面板打开:手里只有编号
  assert.equal(resolveLatestSessionTitle(st, { sessionId: SID }), '甲',
    '手里只有编号时用列表项(会话记录里的名字),不能退回偏好里的「乙」');
  assert.equal(resolveLatestSessionTitle(st, { sessionId: SID, projectHash: 'A', draft: false }), '甲');
  // 从侧栏打开后改了名:手里的快照是旧名,列表已刷新
  const renamed = { ...st, sessionsByProject: { A: [{ ...listItem, customTitle: '丙' }] }, customTitles: { [SID]: '丙' } };
  assert.equal(resolveLatestSessionTitle(renamed, listItem), '丙', '旧快照里的 customTitle 不能压过最新列表项');
  // 列表里没有这个会话:用手里的对象 + 偏好
  const noList = { ...st, sessionsByProject: {}, sessions: [] };
  assert.equal(resolveLatestSessionTitle(noList, { sessionId: SID }), '乙', '列表里找不到时退回偏好里的名字');
  assert.equal(resolveLatestSessionTitle(noList, { sessionId: SID, customTitle: '快照名' }), '快照名',
    '列表里找不到时用手里的对象(其 customTitle 照旧优先)');
  // 偏好与自动标题照旧参与(列表项没有 customTitle 时)
  const auto = { sessionsByProject: { A: [{ sessionId: SID, aiTitle: 'AI名' }] }, customTitles: {}, autoTitles: { [SID]: 'GUI自动' } };
  assert.equal(resolveLatestSessionTitle(auto, { sessionId: SID, projectHash: 'A' }), 'AI名');
  assert.equal(resolveLatestSessionTitle({ ...auto, sessionsByProject: {} }, { sessionId: SID }), 'GUI自动');
  // 草稿 / 空
  assert.equal(resolveLatestSessionTitle(st, { sessionId: null, draft: true, firstPrompt: '新会话' }), '新会话', '草稿按手里的对象解析');
  assert.equal(resolveLatestSessionTitle(st, null), '', '没有会话返回空串,不抛');
  assert.equal(resolveLatestSessionTitle(null, { sessionId: SID, firstPrompt: '首条' }), '首条', '没有 st 不抛');
  // adoptFork 的调用方可能传只带 customTitles 的 st
  assert.equal(resolveLatestSessionTitle({ customTitles: { [SID]: '乙' } }, { sessionId: SID }), '乙', 'st 缺列表与 autoTitles 字段不抛');
  // 给选择器用:返回基元字符串,同一状态两次结果相等
  const a = resolveLatestSessionTitle(st, { sessionId: SID });
  const b = resolveLatestSessionTitle(st, { sessionId: SID });
  assert.equal(typeof a, 'string', '返回字符串(基元),不能是对象');
  assert.ok(Object.is(a, b), '同一状态两次结果相等(选择器不会因新引用反复重渲染)');
}

// ── ③ writeJsonlTitle 没写成返回 null ─────────────────────────────────────
{
  const { writeJsonlTitle } = await import('../../server/routes/prefs.js');
  const missing = '99999999-9999-4999-8999-999999999998';
  const orig = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(String(m));
  try {
    assert.equal(await writeJsonlTitle(missing, '标题'), null, '会话不存在:返回 null(改名接口据此不广播 file-change)');
    assert.equal(await writeJsonlTitle(missing, ''), null, '清空路径会话不存在:同样返回 null');
  } finally { console.warn = orig; }
  assert.equal(warned.length, 2, '两条失败路径照旧各记一条日志');
}

console.log('check-r194-title-latest: OK');
