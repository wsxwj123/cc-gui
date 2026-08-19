#!/usr/bin/env node
// 批L L1-c:app 级"在等你"角标。
// 回归对象:后台代理卡在授权时,GUI 前台没有任何提示 —— 用户不打开监控面板就不知道
// 有东西在等他。计数口径是这条链的关键:**只数在等你的,不数在跑的**,否则角标常亮
// 等于没有。计数与防抖是纯函数,这里真 import。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { waitingSessionKeys, countAttention, nextBadgeState, resetBadgeState } from '../../client/src/utils/attention.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── 1. 计数口径:只数在等你的 ────────────────────────────────────────────
{
  const agents = [
    { kind: 'chat-process', status: 'streaming', sessionId: 'a' },                       // 在跑,不数
    { kind: 'chat-process', status: 'idle', sessionId: 'b' },                            // 保活,不数
    { kind: 'cli-session', cliKind: 'interactive', status: 'alive', sessionId: 'c' },    // 只知道活着,不数
    { kind: 'cli-session', cliKind: 'interactive', status: 'waiting', sessionId: 'd' },  // 停下等人,数
    { kind: 'cli-session', cliKind: 'bg', status: 'waiting', state: 'blocked', sessionId: 'e' },
    { kind: 'cli-session', cliKind: 'bg', status: 'alive', state: 'blocked', sessionId: 'f' }, // 落盘 blocked,数
    { kind: 'cli-session', cliKind: 'bg', status: 'alive', state: 'working', sessionId: 'g' }, // 在跑,不数
  ];
  assert.equal(waitingSessionKeys(agents), 'd,e,f', '只挑 waiting / blocked,同一条不重复');
  assert.equal(waitingSessionKeys([]), '');
  assert.equal(waitingSessionKeys(null), '', '拿不到数据算空,不是 NaN(NaN 会让角标乱跳)');
  assert.equal(waitingSessionKeys([null, undefined]), '', '脏数据不炸');
  assert.equal(countAttention('d,e,f', ''), 3, '没有卡片时就是等待条目数');
  assert.equal(countAttention('', ''), 0, '什么都没有 = 0');
}

// ── 2. 去重:同一件事不数两遍 ────────────────────────────────────────────
// 后台代理卡在授权时,它【既】是一张待处理卡【又】是一个 waiting 条目 —— 那是同一件事。
{
  assert.equal(countAttention('e', 'e'), 1, '同一会话:卡片 + waiting 条目 = 一件事');
  assert.equal(countAttention('d,e', 'e'), 2, '另一个没有卡片的等待条目仍要数');
  assert.equal(countAttention('', 'x,y'), 2, '纯卡片按张数(同一会话可以有多张)');
  assert.equal(countAttention('e', 'e,e'), 2, '同一会话两张卡 = 两件事,但 waiting 条目不再加');
  assert.equal(countAttention('?', ''), 1, '没有 sessionId 的等待条目照数');
  assert.equal(countAttention('?', ''), countAttention('?', ''), '纯函数,可重复调用');
}

// ── 3. 防抖:计数没变就不下发 ────────────────────────────────────────────
{
  resetBadgeState();
  const first = nextBadgeState(0);
  assert.deepEqual(first, { count: undefined, title: 'CC-GUI' }, '首次(0)要下发一次,把可能的残留角标清掉');
  assert.equal(nextBadgeState(0), null, '同一计数不重复下发(1.5s 轮询下多数轮次都不变)');
  assert.deepEqual(nextBadgeState(2), { count: 2, title: 'CC-GUI (2)' }, '变了才下发');
  assert.equal(nextBadgeState(2), null);
  assert.deepEqual(nextBadgeState(0), { count: undefined, title: 'CC-GUI' },
    '归零要清角标:count 必须是 undefined —— 传 0 在 macOS 上会显示一个 "0"');
  resetBadgeState();
}

// ── 4. 接线守卫 ──────────────────────────────────────────────────────────
{
  const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
  assert.equal((app.match(/setWaitingKeys\(/g) || []).length, 1, '等待集合只有一个写入点');
  // 就挂在已有的全局轮询里(那条 effect 的标志是 setRunningStatus),不另起一条
  const globalPoll = app.slice(app.indexOf('useStore.getState().setRunningStatus('), app.indexOf('const id = setInterval(poll, 1500);', app.indexOf('setRunningStatus(')));
  assert.ok(/setWaitingKeys\(waitingSessionKeys\(d\.agents\)\)/.test(globalPoll),
    '必须复用已有的 /agents/active 全局轮询,不为角标另起一条');
  assert.ok(/const attentionCount = countAttention\(waitingKeys, pendingKeys\);/.test(app), '角标走去重后的计数');
  assert.ok(/useEffect\(\(\) => \{ applyAttentionBadge\(attentionCount\); \}, \[attentionCount\]\)/.test(app),
    '只在计数变化时下发(effect 依赖就是计数本身)');
  // 选择器只返回字符串(基元):返回数组会因新引用触发 React #185 整页白屏;
  // React state 存数组同理会让 App 根组件每 1.5s 白重渲一次。
  assert.ok(/useStore\(\(s\) => s\.pendingPermissions\.map\(\(p\) => p\.sessionId \|\| ''\)\.join\(','\)\)/.test(app),
    'pendingPermissions 选择器必须返回字符串');
  assert.ok(/useState\(''\);/.test(app.slice(app.indexOf('const [waitingKeys'), app.indexOf('const [waitingKeys') + 200)),
    '等待集合存字符串,不存数组');
  assert.ok(/attentionCount=\{attentionCount\}/.test(app), '坞图标要拿到计数才能画小红点');
  assert.ok(/\{attentionCount > 0 && \(/.test(app), '前台可见的小红点');

  const util = readFileSync(join(root, 'client/src/utils/attention.js'), 'utf8');
  // Tauri API 必须动态 import + 静默降级:浏览器/手机端没有 Tauri,顶层 import 会整页崩
  assert.ok(/import\('@tauri-apps\/api\/window'\)/.test(util), 'Tauri window API 走动态 import');
  assert.ok(/\.catch\(\(\) => \{\}\)/.test(util), '非 Tauri 环境静默降级');
  assert.ok(/w\.setTitle\(next\.title\)/.test(util), 'setTitle 是跨平台兜底(Windows 上角标是 no-op)');
}

// ── 5. Tauri capability:两条权限都不在 core:window:default 里 ────────────
{
  const cap = JSON.parse(readFileSync(join(root, 'src-tauri/capabilities/window-badge.json'), 'utf8'));
  assert.ok(cap.permissions.includes('core:window:allow-set-badge-count'), '缺角标权限 = 运行时被 ACL 拒');
  assert.ok(cap.permissions.includes('core:window:allow-set-title'), '缺标题权限 = 运行时被 ACL 拒');
  assert.deepEqual(cap.windows, ['main']);
  // 生产 webview 加载 http://127.0.0.1:<port>,属 remote 上下文:不列 remote.urls 权限不生效
  const urls = cap.remote?.urls || [];
  const dialog = JSON.parse(readFileSync(join(root, 'src-tauri/capabilities/dialog.json'), 'utf8'));
  assert.deepEqual(urls, dialog.remote.urls, 'remote.urls 必须与 dialog.json 的端口列表一致(6677..6687)');
}

console.log('✓ check-badge-count: 计数口径 + 防抖 + 接线 + capability 全过');
