#!/usr/bin/env node
// 单测:r11-② Home(首页新建会话形态)—— 显隐判定矩阵 + 项目选择/cwd 绑定 +
// draft 创建参数 + 启动恢复门控仪表化(import 真函数)。
// 变异哨兵(实际验证过红):
//   S1 buildHomeDraft 删项目选择的 cwd 绑定(projectHash/projectPath 不取所选项目)→ t3 红
//   S2 homeView 删零项目分支(恒 home)→ t1 红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homeView, pickHomeProject, buildHomeDraft, homeGreeting } from '../../client/src/utils/home.js';

// t1 显隐判定矩阵:选中会话=会话页;无会话+有项目=Home;无会话+零项目=EmptyState
{
  assert.equal(homeView({ hasSession: true, projectCount: 3 }), 'session', 't1: 有会话恒会话页');
  assert.equal(homeView({ hasSession: true, projectCount: 0 }), 'session', 't1: 有会话(即使零项目)仍会话页');
  assert.equal(homeView({ hasSession: false, projectCount: 2 }), 'home', 't1: 无会话+有项目 → Home');
  assert.equal(homeView({ hasSession: false, projectCount: 0 }), 'empty', 't1: 无会话+零项目 → EmptyState 保留');
  assert.equal(homeView({ hasSession: false, projectCount: undefined }), 'empty', 't1: 项目数未知按零处理');
}

// t2 项目选择:显式选择 > 当前选中项目 > 最近活动 > 空
{
  const projects = [
    { hash: 'old', path: '/p/old', lastActivity: '2025-01-01T00:00:00Z' },
    { hash: 'new', path: '/p/new', lastActivity: '2026-08-01T00:00:00Z' },
    { hash: 'none', path: '/p/none', lastActivity: null },
  ];
  assert.equal(pickHomeProject({ chosenHash: 'old', projects }).hash, 'old', 't2: 显式选择优先');
  assert.equal(pickHomeProject({ chosenHash: 'gone', projects, selectedProject: { hash: 'none', path: '/p/none' } }).hash, 'none', 't2: 选择失效回落选中项目');
  assert.equal(pickHomeProject({ projects }).hash, 'new', 't2: 无选择取最近活动');
  assert.equal(pickHomeProject({ projects: [] }), null, 't2: 零项目 → null(Home 禁发)');
  assert.equal(
    pickHomeProject({ projects: [], selectedProject: { hash: 'x', path: '/p/x' } }).hash,
    'x', 't2: 列表暂缺但选中带 path 也可用(fetch 未到窗口)');
}

// t3 draft 创建参数:cwd 绑定 = 所选项目(projectHash+projectPath 逐字取自它)
{
  const project = { hash: 'h-abc', path: '/work/abc', lastActivity: null };
  const d = buildHomeDraft(project, 'd123');
  assert.equal(d.projectHash, 'h-abc', 't3: projectHash 绑定所选项目');
  assert.equal(d.projectPath, '/work/abc', 't3: projectPath(cwd)绑定所选项目');
  assert.equal(d.draft, true, 't3: draft 标记');
  assert.equal(d.draftId, 'd123', 't3: draftId 透传(nonce 语义单一来源)');
  assert.equal(d.sessionId, null, 't3: 未落盘无 sessionId');
  assert.equal(buildHomeDraft(null, 'd1'), null, 't3: 无项目不造 draft');
  assert.equal(buildHomeDraft({ hash: 'h' }, 'd1'), null, 't3: 缺 path(cwd)不造 draft');
}

// t4 称呼:皮肤自定义优先(≤60 截断),无自定义按时段
{
  assert.equal(homeGreeting(9, 'x'.repeat(80)).length, 60, 't4: 自定义截断 60');
  assert.equal(homeGreeting(9, '  你好  '), '你好', 't4: 自定义去空白');
  assert.match(homeGreeting(9, null), /^早上好/, 't4: 上午');
  assert.match(homeGreeting(14, ''), /^下午好/, 't4: 下午');
  assert.match(homeGreeting(23, undefined), /^晚上好/, 't4: 夜间');
  assert.match(homeGreeting(2, null), /^晚上好/, 't4: 凌晨归夜间');
}

// t5 仪表化:启动恢复门控 + Home 接线 + 发送走既有队列排空链路
{
  const store = readFileSync(new URL('../../client/src/stores/sessionStore.js', import.meta.url), 'utf8');
  assert.match(store, /cgui-restore-last-session/, 't5: 启动恢复开关 key');
  assert.match(store, /RESTORE_LAST_ON_BOOT \? readLs\('cgui-selected-session', null\) : null/, 't5: selectedSession 启动门控');
  assert.match(store, /if \(!RESTORE_LAST_ON_BOOT\) return \[null, null, null, null, null, null\]/, 't5: paneSessions 全窗格同一门控');
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /homeView\(\{ hasSession: false, projectCount \}\) === 'home'/, 't5: 显隐走纯函数');
  assert.match(app, /<HomeState tabIndex=\{tabIndex\} \/>/, 't5: Home 挂在无会话分支');
  assert.match(app, /<EmptyState tabIndex=\{tabIndex\} \/>/, 't5: 零项目 EmptyState 保留');
  assert.match(app, /seedNewSessionDefaults\(project\.hash\)/, 't5: 与侧栏创建点同一 seed 链路');
  assert.match(app, /enqueueMessage\(`draft-\$\{project\.hash\}`/, 't5: 发送经 draft 队列(既有排空链路,零旁路)');
  assert.match(app, /buildHomeDraft\(project, newDraftId\(\)\)/, 't5: draft 经纯函数(cwd 绑定)创建');
  assert.match(app, /cgui:add-project/, 't5: 「浏览新文件夹」走既有 _addProject 流');
  const settings = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
  assert.match(settings, /RestoreLastSessionToggle/, 't5: 设置项「启动时恢复上次会话」在');
  assert.match(settings, /set-restore-last/, 't5: 设置项已注册进 session tab 索引');
  const sidebar = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  assert.match(sidebar, /export const seedNewSessionDefaults/, 't5: seed 提为模块级导出(单一实现)');
}

console.log('check-home-state: all passed');
