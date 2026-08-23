#!/usr/bin/env node
// 单测:r11-② Home(首页新建会话形态)—— 显隐判定矩阵 + 项目选择/cwd 绑定 +
// draft 创建参数 + 启动恢复门控仪表化(import 真函数)。
// 变异哨兵(实际验证过红):
//   S1 buildHomeDraft 删项目选择的 cwd 绑定(projectHash/projectPath 不取所选项目)→ t3 红
//   S2 homeView 删零项目分支(恒 home)→ t1 红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homeView, pickHomeProject, buildHomeDraft, enqueueHomeDraft, homeGreeting } from '../../client/src/utils/home.js';

// t1 显隐判定矩阵:选中会话=会话页;无会话+有项目=Home;无会话+零项目=EmptyState
{
  assert.equal(homeView({ hasSession: true, projectCount: 3 }), 'session', 't1: 有会话恒会话页');
  assert.equal(homeView({ hasSession: true, projectCount: 0 }), 'session', 't1: 有会话(即使零项目)仍会话页');
  assert.equal(homeView({ hasSession: false, projectCount: 2 }), 'home', 't1: 无会话+有项目 → Home');
  assert.equal(homeView({ hasSession: false, projectCount: 0 }), 'empty', 't1: 无会话+零项目 → EmptyState 保留');
  assert.equal(homeView({ hasSession: false, projectCount: undefined }), 'empty', 't1: 项目数未知按零处理');
}

// t2 项目选择:显式选择 > 聚焦窗格项目 > 侧栏选中项目 > 最近活动 > 空
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

// t2b r24 优先级真值表:新建会话的默认 cwd 跟【聚焦窗格里那个会话】的项目走。
//   用户报的场景:分屏 B 窗格开着项目 P 的会话、侧栏还停在 Q → 新建开到了 Q。
// ⚠️ 夹具必须有区分度:聚焦项目 'foc' 的 lastActivity **最旧**,而 'fresh' 最新 ——
//    这样一旦 focusedProjectHash 分支失效(被删/被排到 selectedProject 之后),
//    落点会变成 'sel' 或 'fresh',断言当场变红,不会"恰好还是对的"而假绿。
{
  const projects = [
    { hash: 'foc', path: '/p/foc', lastActivity: '2024-01-01T00:00:00Z' },  // 聚焦窗格的项目(最旧)
    { hash: 'sel', path: '/p/sel', lastActivity: '2025-01-01T00:00:00Z' },  // 侧栏选中
    { hash: 'fresh', path: '/p/fresh', lastActivity: '2026-08-20T00:00:00Z' }, // 最近活动(最新)
  ];
  const sel = { hash: 'sel', path: '/p/sel' };
  // 夹具自检:去掉聚焦来源后,这两条各自会落到谁 —— 证明下面三条断言真的在区分优先级。
  assert.equal(pickHomeProject({ projects }).hash, 'fresh', 't2b: 夹具自检 —— 无来源时落最近活动 fresh');
  assert.equal(pickHomeProject({ projects, selectedProject: sel }).hash, 'sel', 't2b: 夹具自检 —— 只有侧栏时落 sel');

  assert.equal(pickHomeProject({ chosenHash: 'fresh', focusedProjectHash: 'foc', projects, selectedProject: sel }).hash,
    'fresh', 't2b: 用户在 Home 下拉里显式选的仍然最高(聚焦压不过它)');
  assert.equal(pickHomeProject({ focusedProjectHash: 'foc', projects, selectedProject: sel }).hash,
    'foc', 't2b: 聚焦窗格的项目压过侧栏选中(分屏时侧栏常停在另一个项目)');
  assert.equal(pickHomeProject({ focusedProjectHash: 'foc', projects }).hash,
    'foc', 't2b: 聚焦窗格的项目压过"最近活动最新"');

  // 聚焦窗格的项目不在列表里(被隐藏 / projects 还没拉到):只有 hash 没有 path,
  // 凑不出 buildHomeDraft 需要的 cwd → 不许凭空造项目,老实往下一优先级走。
  assert.equal(pickHomeProject({ focusedProjectHash: 'ghost', projects, selectedProject: sel }).hash,
    'sel', 't2b: 聚焦项目不在列表 → 回落侧栏选中');
  assert.equal(pickHomeProject({ focusedProjectHash: 'ghost', projects }).hash,
    'fresh', 't2b: 聚焦项目不在列表且无侧栏选中 → 回落最近活动');
  assert.equal(pickHomeProject({ focusedProjectHash: 'ghost', projects: [] }), null,
    't2b: 聚焦项目不在列表且列表为空 → null(绝不返回一个没有 path 的假项目)');
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
  assert.match(app, /seedNewSessionDefaults\(project\.hash, _did\)/, 't5: 与侧栏创建点同一 seed 链路;r31 起 seed 带 draftId(键落 draft-<hash>-<draftId>)');
  assert.match(app, /enqueueHomeDraft\(homeDraftArgs\)/, 't5: 普通 Home 发送经可白盒验证的队列编排入口');
  assert.match(app, /enqueueRestoredHomeDraft\(\{/, 't5: 恢复孤儿经先入新队列再删旧副本的编排入口');
  assert.match(app, /buildHomeDraft\(project, _did\)/, 't5: draft 经纯函数(cwd 绑定)创建;r31 与 seed 共用同一 draftId(三键对齐)');
  // r24 接线:t2b 的优先级只在【真把聚焦窗格的项目喂进去】时才有意义 —— 这一句没了,
  // focusedProjectHash 恒 undefined,纯函数测试照样全绿而功能是死的。
  assert.match(app, /const focusedProjectHash = useStore\(\(s\) => s\.paneSessions\?\.\[s\.activeTabIndex\]\?\.projectHash\)/,
    't5: 聚焦窗格项目 = paneSessions[activeTabIndex].projectHash(单屏 pane0 恒镜像 selectedSession)');
  assert.match(app, /pickHomeProject\(\{ chosenHash, focusedProjectHash,/, 't5: 聚焦来源真的传进了 pickHomeProject');
  assert.match(app, /cgui:add-project/, 't5: 「浏览新文件夹」走既有 _addProject 流');
  const settings = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
  assert.match(settings, /RestoreLastSessionToggle/, 't5: 设置项「启动时恢复上次会话」在');
  assert.match(settings, /set-restore-last/, 't5: 设置项已注册进 session tab 索引');
  const sidebar = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  assert.match(sidebar, /export const seedNewSessionDefaults/, 't5: seed 提为模块级导出(单一实现)');
}

// t6 Home 首发原子顺序:队列持久化成功后才挂 pane;失败时 UI 会话保持原位。
{
  const calls = [];
  const draft = buildHomeDraft({ hash: 'h', path: '/p' }, 'd1');
  const envelope = { text: 'hello', queuedAt: 1, opts: { meta: { attachments: [] } } };
  const store = {
    enqueueMessage: (key, value) => { calls.push(['enqueue', key, value]); return { ...value, queueId: 'q1' }; },
    setPaneSession: (tab, value) => calls.push(['pane', tab, value]),
    setPaneMessages: (tab, value) => calls.push(['messages', tab, value]),
  };
  assert.equal(enqueueHomeDraft({ store, sessionKey: 'draft-h-d1', envelope, tabIndex: 0, draft })?.queueId, 'q1');
  assert.deepEqual(calls.map(([name]) => name), ['enqueue', 'pane', 'messages'], 't6: enqueue 必须先于 pane');

  calls.length = 0;
  store.enqueueMessage = () => null;
  assert.equal(enqueueHomeDraft({ store, sessionKey: 'draft-h-d1', envelope, tabIndex: 0, draft }), null);
  assert.deepEqual(calls, [], 't6: quota/持久化失败不挂 pane');
}

console.log('check-home-state: all passed');
