// 单测:r10-11 单层项目折叠面板纯函数矩阵(composePanelProjects / composePanelSessions /
// sessionQueryMatchHashes)。import 真函数。
// 变异哨兵(实际验证过红):
//   S1 删虚拟节点合成(panes 循环)→ t3 红
//   S2 删 lastActivity 降序(只留置顶排序)→ t2 红
// 变异哨兵(11-b 追加,实际验证过红):
//   S3 reducePinned 不过滤非字符串 → t7 红
import assert from 'node:assert/strict';
import {
  composePanelProjects, composePanelSessions, sessionQueryMatchHashes, WORKTREE_PATH_RE, reducePinned,
} from '../../client/src/utils/projectPanel.js';

const P = (hash, path, extra = {}) => ({ hash, path, sessionCount: 1, lastActivity: null, ...extra });

// t1 过滤:hidden 隐藏、worktree 默认隐藏(开关放行)、query 按路径过滤
{
  const projects = [
    P('a', '/x/alpha', { lastActivity: '2026-01-02T00:00:00Z' }),
    P('b', '/x/beta', { lastActivity: '2026-01-01T00:00:00Z' }),
    P('w', '/x/repo-worktrees/f1', { isWorktree: true, lastActivity: '2026-01-03T00:00:00Z' }),
  ];
  assert.deepEqual(
    composePanelProjects({ projects, hidden: ['b'] }).map((p) => p.hash),
    ['a'], 't1: hidden+worktree 默认全滤');
  assert.deepEqual(
    composePanelProjects({ projects, showWorktrees: true }).map((p) => p.hash),
    ['w', 'a', 'b'], 't1: 开关放行 worktree 且按时间降序');
  assert.deepEqual(
    composePanelProjects({ projects, query: 'beta' }).map((p) => p.hash),
    ['b'], 't1: query 路径过滤');
}

// t2 排序:置顶前置,组内 lastActivity 降序,无时间排最后
{
  const projects = [
    P('old', '/p/old', { lastActivity: '2025-01-01T00:00:00Z' }),
    P('new', '/p/new', { lastActivity: '2026-08-01T00:00:00Z' }),
    P('none', '/p/none'),
    P('pin', '/p/pin', { lastActivity: '2024-01-01T00:00:00Z' }),
  ];
  assert.deepEqual(
    composePanelProjects({ projects, pinned: ['pin'] }).map((p) => p.hash),
    ['pin', 'new', 'old', 'none'], 't2: 置顶最前,余下时间降序,无时间最后');
}

// t3 虚拟节点:pane 项目 projects.find 落空 → 构造虚拟行(worktree 判据);已有则不重复
{
  const projects = [P('a', '/x/alpha', { lastActivity: '2026-01-01T00:00:00Z' })];
  const rows = composePanelProjects({
    projects,
    panes: [
      { projectHash: 'wt', projectPath: '/x/repo-worktrees/r10' }, // 未落盘 worktree draft
      { projectHash: 'a', projectPath: '/x/alpha' },               // 已在列表,不重复
      { projectHash: null },                                        // 无 hash 跳过
    ],
  });
  assert.equal(rows.length, 2, 't3: 虚拟行只补缺失的');
  const vt = rows.find((p) => p.hash === 'wt');
  assert.ok(vt && vt.virtual === true, 't3: 虚拟行标记');
  assert.equal(vt.isWorktree, true, 't3: worktree 判据(路径正则)');
  assert.equal(vt.sessionCount, 0);
  assert.ok(WORKTREE_PATH_RE.test('/x/.claude/worktrees/agent-1'), 't3: agent 树判据');
}

// t4 pane 项目豁免 hidden/worktree 过滤(正在用必须可见),但仍受 query 过滤
{
  const projects = [
    P('h', '/x/hidden-proj', { lastActivity: '2026-01-01T00:00:00Z' }),
    P('w', '/x/repo-worktrees/f1', { isWorktree: true }),
  ];
  const rows = composePanelProjects({
    projects, hidden: ['h'],
    panes: [{ projectHash: 'h', projectPath: '/x/hidden-proj' }, { projectHash: 'w', projectPath: '/x/repo-worktrees/f1' }],
  });
  assert.deepEqual(rows.map((p) => p.hash).sort(), ['h', 'w'], 't4: pane 项目复活被过滤的真实条目');
  assert.ok(rows.every((p) => !p.virtual), 't4: 复活的是真实条目非虚拟行');
  const rows2 = composePanelProjects({
    projects, query: 'zzz',
    panes: [{ projectHash: 'w', projectPath: '/x/repo-worktrees/f1' }],
  });
  assert.equal(rows2.length, 0, 't4: query 过滤对 pane 项目同样生效');
}

// t5 组内会话:归档过滤+标题搜索+置顶前置(稳定,保持服务端时序)
{
  const sessions = [
    { sessionId: 's1', archived: false },
    { sessionId: 's2', archived: true },
    { sessionId: 's3', archived: false },
    { sessionId: 's4', archived: false },
  ];
  const titles = { s1: '修复登录', s3: '重构面板', s4: '登录样式' };
  const titleOf = (s) => titles[s.sessionId] || '';
  assert.deepEqual(
    composePanelSessions({ sessions, titleOf, pinned: ['s4'] }).map((s) => s.sessionId),
    ['s4', 's1', 's3'], 't5: 归档滤除+置顶前置+组内时序稳定');
  assert.deepEqual(
    composePanelSessions({ sessions, titleOf, showArchived: true }).map((s) => s.sessionId),
    ['s2'], 't5: 归档视图');
  assert.deepEqual(
    composePanelSessions({ sessions, titleOf, query: '登录' }).map((s) => s.sessionId),
    ['s1', 's4'], 't5: 标题搜索');
}

// t6 搜索带出所属项目:组内标题命中 → 项目 hash 进集合 → 项目行可见
{
  const sessionsByProject = {
    pa: [{ sessionId: 's1' }],
    pb: [{ sessionId: 's2' }],
  };
  const titles = { s1: '修复登录', s2: '别的' };
  const titleOf = (s) => titles[s.sessionId] || '';
  const hits = sessionQueryMatchHashes({ sessionsByProject, query: '登录', titleOf });
  assert.deepEqual([...hits], ['pa'], 't6: 命中集');
  const rows = composePanelProjects({
    projects: [P('pa', '/x/aaa'), P('pb', '/x/bbb')],
    query: '登录', queryMatchHashes: hits,
  });
  assert.deepEqual(rows.map((p) => p.hash), ['pa'], 't6: 会话命中带出项目行');
  assert.equal(sessionQueryMatchHashes({ sessionsByProject, query: '', titleOf }).size, 0, 't6: 空 query 空集');
}

// t7 置顶广播 reducer:合法载荷入位;非法载荷/脏元素回落干净数组(不炸 UI)
{
  assert.deepEqual(reducePinned({ projects: ['a'], sessions: ['s1'] }),
    { pinnedProjects: ['a'], pinnedSessions: ['s1'] }, 't7: 正常载荷');
  assert.deepEqual(reducePinned({ projects: 'junk', sessions: null }),
    { pinnedProjects: [], pinnedSessions: [] }, 't7: 非数组回落空');
  assert.deepEqual(reducePinned(null),
    { pinnedProjects: [], pinnedSessions: [] }, 't7: 空载荷');
  assert.deepEqual(reducePinned({ projects: ['a', 42, null], sessions: [{}] }),
    { pinnedProjects: ['a'], pinnedSessions: [] }, 't7: 脏元素滤除');
}

console.log('check-project-panel: all passed');
