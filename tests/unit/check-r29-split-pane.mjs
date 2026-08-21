#!/usr/bin/env node
// 单测:r29 Bug3「分屏空白窗格点 + 不落会话」。
// 根因:e924a45 把新建入口从写 draft 改成写 null 后,SplitMain 门控
// (soloPane || hasSession) 让 null 会话窗格永远挂静态占位,Home 进不来。
// 修法(方案②):聚焦的空窗格也挂 SessionDetail(走 homeView 判定进 Home);
// 未聚焦的空窗格保留静态占位(「点左侧任一会话填入本分屏」语义不动)。
// 变异哨兵(实际验证过红):
//   S1 paneMountsSessionDetail 删掉 focused 析取项 → t1 红(聚焦空窗格回落占位)
//   S2 App.jsx 门控退回 (soloPane || hasSession) → t2 红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paneMountsSessionDetail, homeView } from '../../client/src/utils/home.js';

// t1 门控真值表
{
  assert.equal(paneMountsSessionDetail({ soloPane: true, hasSession: false, focused: false }), true, 't1: 单屏恒挂(原语义)');
  assert.equal(paneMountsSessionDetail({ soloPane: false, hasSession: true, focused: false }), true, 't1: 有会话恒挂(原语义)');
  assert.equal(paneMountsSessionDetail({ soloPane: false, hasSession: false, focused: true }), true, 't1: 聚焦空窗格 → 挂 SessionDetail 进 Home(本次修复)');
  assert.equal(paneMountsSessionDetail({ soloPane: false, hasSession: false, focused: false }), false, 't1: 未聚焦空窗格 → 静态占位保留(别把两个窗格都变成 Home)');
}

// t2 App.jsx 门控接线 + 占位语义保留
{
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /paneMountsSessionDetail\(\{ soloPane, hasSession, focused \}\) \? \(/, 't2: SplitMain 门控走纯函数(含 focused)');
  assert.doesNotMatch(app, /\{\(soloPane \|\| hasSession\) \? \(/, 't2: 旧门控不得回魂(它就是 bug 本体)');
  assert.match(app, /点左侧任一会话填入本分屏/, 't2: 未聚焦空窗格的占位文案保留');
  // 空窗格挂进 SessionDetail 后,走的是既有 Home 判定(有项目进 Home,零项目 EmptyState)
  assert.equal(homeView({ hasSession: false, projectCount: 2 }), 'home', 't2: 空窗格+有项目 → Home 锚点');
}

// t3 新建入口行为:三处都是「写 null + 清本 pane 消息」(e924a45 口径,门控修复后才生效)
{
  const sidebar = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  const handleNew = sidebar.slice(sidebar.indexOf('const handleNew = (project)'), sidebar.indexOf('const handleNew = (project)') + 700);
  assert.match(handleNew, /if \(splitMode\) \{\s*st\.setActiveTabSession\(null\);\s*st\.setPaneMessages\(activeTabIndex, \[\]\);/, 't3: 侧栏+ 分屏分支写 null 到聚焦窗格');
  assert.match(handleNew, /seedNewSessionDefaults\(project\.hash\)/, 't3: 侧栏+ 仍 seed 档位继承');

  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const cmdN = app.slice(app.indexOf("e.key === 'n' || e.key === 'N'"), app.indexOf("e.key === 'n' || e.key === 'N'") + 900);
  assert.match(cmdN, /st\.setPaneSession\(idx, null\);\s*st\.setPaneMessages\(idx, \[\]\);/, 't3: Cmd+N 写 null 到聚焦窗格');
}

// t4 Home 提交落点:draft 写进 Home 所在的那个 pane(分屏下不串到别的窗格)
{
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const submit = app.slice(app.indexOf('const submit = () => {'), app.indexOf('const submit = () => {') + 800);
  assert.match(submit, /st\.setPaneSession\(tabIndex, _homeDraft\)/, 't4: Home 提交把 draft 写进本 pane');
  assert.match(submit, /st\.setPaneMessages\(tabIndex, \[\]\)/, 't4: 同 pane 清消息');
}

console.log('✓ check-r29-split-pane: 聚焦空窗格进 Home + 未聚焦占位保留 + 新建入口写 null + Home 落本 pane');
