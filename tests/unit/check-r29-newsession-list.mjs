#!/usr/bin/env node
// 单测:r29 Bug1「新建会话不进项目会话列表」。
// 根因:打包版无文件 watcher,draft 转正后/回合结束的三连重试只刷旧单值槽
// sessions(fetchSessions),而侧栏渲染源是 sessionsByProject(fetchSessionsForPanel)。
// 旧槽仍有消费者(权限卡门禁/@面板/监控反查),所以正确修法是【两处都刷】。
// 变异哨兵(实际验证过红):
//   S1 App.jsx 两处三连重试删 fetchSessionsForPanel 行 → t1/t2 红
//   S2 toggleProject 退回 `!st.sessionsByProject[hash]` 门控 → t3 红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');

// t1 draft 转正(init 拿真 sid)的三连重试:面板槽 + 旧槽都刷
{
  assert.ok(app.includes('[400, 1200, 3000]'), 't1: draft 转正重试块存在');
  const block = app.slice(app.indexOf('[400, 1200, 3000]'), app.indexOf('[400, 1200, 3000]') + 600);
  assert.match(block, /fetchSessionsForPanel\(hash\)/, 't1: 重试必须刷面板槽 sessionsByProject(侧栏渲染源)');
  assert.match(block, /fetchSessions\(hash, \{ silent: true \}\)/, 't1: 旧单值槽保留(权限卡门禁/@面板/监控反查仍在消费)');
}

// t2 回合结束 finally 的三连重试:同款两处都刷
{
  const block = app.slice(app.indexOf('[500, 1500, 3500]'), app.indexOf('[500, 1500, 3500]') + 600);
  assert.match(block, /fetchSessionsForPanel\(hash\)/, 't2: 回合结束重试必须刷面板槽');
  assert.match(block, /fetchSessions\(hash, \{ silent: true \}\)/, 't2: 旧单值槽保留');
}

// t3 侧栏展开已缓存组:stale 刷新(不只 !sessionsByProject[hash] 才拉)
{
  const m = sidebar.match(/const toggleProject = \(hash\) => \{[\s\S]*?\n  \};/);
  assert.ok(m, 't3: toggleProject 存在');
  assert.match(m[0], /if \(!isOpen\) st\.fetchSessionsForPanel\(hash\);/, 't3: 展开即重新拉取该组(stale 刷新)');
  assert.doesNotMatch(m[0], /!st\.sessionsByProject\[hash\]/, 't3: 不得再用「未缓存才拉」门控(缓存可能是旧列表)');
}

// t4 旧槽消费端仍在(防止「旧槽没用了」误判而把 fetchSessions 调用删干净)
{
  const chatInput = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');
  const permPrompt = readFileSync(new URL('../../client/src/components/PermissionPrompt.jsx', import.meta.url), 'utf8');
  assert.match(chatInput, /useStore\(\(s\) => s\.sessions\)/, 't4: ChatInput @面板仍消费旧槽');
  assert.match(permPrompt, /useStore\(\(s\) => s\.sessions\)/, 't4: PermissionPrompt 权限卡门禁仍消费旧槽');
}

console.log('✓ check-r29-newsession-list: 三连重试双槽同刷 + 展开 stale 刷新 + 旧槽消费端存续');
