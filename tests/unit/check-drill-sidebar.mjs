#!/usr/bin/env node
// 单测:r11-① 钻入式项目视图 —— 两页态解析 + 持久化 key 迁移(import 真函数)
// + 侧栏/store/端点仪表化。
// 变异哨兵(实际验证过红):
//   S1 resolveDrillView 删「解析落空回落项目页」→ t2 红
//   S2 initialDrillProject 删旧 key 迁移 → t1 红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialDrillProject, resolveDrillView } from '../../client/src/utils/projectPanel.js';

// t1 初始值迁移矩阵:新 key 优先;缺失时取旧手风琴数组的最后展开;都缺 → null
{
  assert.equal(initialDrillProject('h1', ['a', 'b']), 'h1', 't1: 新 key 有值直接用');
  assert.equal(initialDrillProject(null, ['a', 'b']), null, 't1: 新 key 显式 null(项目页)不迁移');
  assert.equal(initialDrillProject('', ['a']), null, 't1: 空串回落 null');
  assert.equal(initialDrillProject(42, ['a']), null, 't1: 非法类型回落 null');
  assert.equal(initialDrillProject(undefined, ['a', 'b']), 'b', 't1: 旧 key 迁移取最后展开');
  assert.equal(initialDrillProject(undefined, ['a', 7, '']), 'a', 't1: 旧数组滤非法项后取最后');
  assert.equal(initialDrillProject(undefined, []), null, 't1: 旧 key 空数组 → null');
  assert.equal(initialDrillProject(undefined, 'junk'), null, 't1: 旧 key 非数组 → null');
}

// t2 两页态解析:null=项目页;命中=会话页;落空回落项目页(不许伪装成会话页)
{
  const rows = [{ hash: 'a', path: '/x/a' }, { hash: 'w', path: '/x/w', virtual: true }];
  assert.deepEqual(resolveDrillView(null, rows), { view: 'projects', project: null }, 't2: 未钻入=项目页');
  assert.equal(resolveDrillView('a', rows).view, 'sessions', 't2: 命中=会话页');
  assert.equal(resolveDrillView('a', rows).project.path, '/x/a', 't2: 透传项目对象');
  assert.equal(resolveDrillView('w', rows).view, 'sessions', 't2: 虚拟行(未落盘 worktree draft)也可钻入');
  const miss = resolveDrillView('gone', rows);
  assert.equal(miss.view, 'projects', 't2: 解析落空必须回落项目页');
  assert.equal(miss.project, null, 't2: 落空不返回幽灵项目');
  assert.equal(resolveDrillView('a', []).view, 'projects', 't2: 行集为空(fetch 未到)回落项目页');
}

// t3 store 仪表化:drillProject 持久化新 key + 旧 key 只读迁移;ensureProjectExpanded
//    改为钻入语义且 4 个旧调用点(跟随/添加项目/搜索命中/进 worktree)不减
{
  const store = readFileSync(new URL('../../client/src/stores/sessionStore.js', import.meta.url), 'utf8');
  assert.match(store, /writeLs\('cgui-drill-project'/, 't3: 持久化写新 key');
  assert.match(store, /initialDrillProject\(readLs\('cgui-drill-project', undefined\), readLs\('cgui-expanded-projects', \[\]\)\)/, 't3: 迁移读取接线');
  assert.doesNotMatch(store, /writeLs\('cgui-expanded-projects'/, 't3: 不再写旧 key');
  assert.doesNotMatch(store, /toggleProjectExpanded/, 't3: 手风琴 toggle 退役');
  const sidebar = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  assert.equal((sidebar.match(/ensureProjectExpanded\(/g) || []).length, 4, 't3: 钻入语义调用点(跟随/添加/命中/worktree)不减');
}

// t4 侧栏两页态仪表化:项目行只显名称(路径进 title)+钻入;返回行;离开会话页 flush 待删;
//    hover 组含「在文件夹中显示」;清理入口保留(移入会话页);会话操作全保留
{
  const sidebar = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  assert.match(sidebar, /resolveDrillView\(drillProject, rowsNoQuery\)/, 't4: 两页态走纯函数解析(且不受 query 踢出)');
  assert.match(sidebar, /view === 'projects' && rows\.map/, 't4: 项目页渲染');
  assert.match(sidebar, /view === 'sessions' && drilled/, 't4: 会话页渲染');
  assert.match(sidebar, /返回项目列表/, 't4: 返回行在');
  const drillIntoBody = /const drillInto = [\s\S]*?\n  \};/.exec(sidebar)?.[0] || '';
  assert.match(drillIntoBody, /flushPendingForProject/, 't4: 切换钻入项目落实待删');
  const drillBackBody = /const drillBack = [\s\S]*?\n  \};/.exec(sidebar)?.[0] || '';
  assert.match(drillBackBody, /flushPendingForProject/, 't4: 返回项目页落实待删');
  assert.match(sidebar, /在文件夹中显示/, 't4: reveal 按钮在');
  assert.match(sidebar, /\/api\/reveal-path/, 't4: reveal 走已知项目校验端点');
  assert.match(sidebar, /project\.virtual/, 't4: 虚拟行不显示 reveal');
  // r11-p3-4 语义变更(用户拍板):项目头🗑「彻底清理」按钮整体移除,前端不再有清理入口
  // (POST /api/project/purge 端点保留待将来接回)。原"清理入口保留"断言反向。
  assert.doesNotMatch(sidebar, /彻底清理该项目的 Claude 本地状态/, 't4: 清理按钮已移除(p3-4)');
  assert.doesNotMatch(sidebar, /purgeProject\(project\)/, 't4: 清理调用点清零');
  // p3-4 项目头图标化:文字按钮撤销(纯图标+title),名称 truncate 让位、按钮组 shrink-0
  assert.doesNotMatch(sidebar, /－?<Plus size=\{1[12]\} \/>新建/, 't4-p3-4: 「新建」文字标签撤销(哨兵锚)');
  assert.doesNotMatch(sidebar, />worktree<\/button>|<GitBranch size=\{1[12]\} \/>worktree/, 't4-p3-4: 「worktree」文字标签撤销');
  assert.doesNotMatch(sidebar, /\{showArchived \? `已归档 \$\{archivedCount\}` : `归档 \$\{archivedCount\}`\}/, 't4-p3-4: 归档可见文字标签撤销(tooltip/角标呈现不受限)');
  assert.match(sidebar, /flex-1 min-w-0"\n\s*title=\{`\$\{formatPath\(project\.path\)\}/, 't4-p3-4: 名称 truncate 优先让位(flex-1 min-w-0)+会话数并入 tooltip');
  assert.match(sidebar, /flex items-center gap-0\.5 shrink-0/, 't4-p3-4: 按钮组 shrink-0 不换行不溢出');
  assert.match(sidebar, /min-w-\[12px\] h-\[12px\][^"]*font-mono/, 't4-p3-4: 归档数角标');
  // 项目行只显名称:不再渲染 formatDate/独立路径行;完整路径进 title
  assert.match(sidebar, /title=\{formatPath\(project\.path\)\}/, 't4: 完整路径进 title');
  for (const fn of ['handleFork', 'handleArchive', 'handleDelete', 'togglePinSession', 'handleNew', 'openWorktreePicker']) {
    assert.ok(sidebar.includes(fn), `t4: 会话/组操作 ${fn} 保留`);
  }
  assert.match(sidebar, /data-tour="new-session"/, 't4: GuideTour 新建锚点在(单实例,无条件)');
  assert.match(sidebar, /data-tour="new-worktree"/, 't4: GuideTour worktree 锚点在');
}

// t5 服务端 reveal-path:已知项目集校验 + darwin open -R / win explorer /select 分支
{
  const sessions = readFileSync(new URL('../../server/routes/sessions.js', import.meta.url), 'utf8');
  const route = /router\.post\('\/reveal-path'[\s\S]*?\n\}\);/.exec(sessions)?.[0];
  assert.ok(route, 't5: 端点存在');
  assert.match(route, /listProjects\(\)/, 't5: 校验来源=已知项目集');
  assert.match(route, /path is not a known project/, 't5: 未知路径拒绝');
  assert.match(route, /\['-R', p\]/, 't5: mac open -R 高亮');
  assert.match(route, /\/select,\$\{p\}/, 't5: win explorer /select');
  assert.match(route, /win32'\) throw err/, 't5: explorer 非零退出不当失败(仅 win 豁免)');
}

console.log('check-drill-sidebar: all passed');
