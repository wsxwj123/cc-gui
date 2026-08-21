#!/usr/bin/env node
// 单测:r13-① dsh 折叠树(r11-① 钻入两页退役,本测随架构整体重写)。
// 变异哨兵(实际验证过红):S1 initialExpandedProjects 删 drill 迁移分支 → t1 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialExpandedProjects, toggleExpanded } from '../../client/src/utils/projectPanel.js';

// t1 展开态迁移矩阵 + 折叠切换
{
  assert.deepEqual(initialExpandedProjects(undefined, 'h1'), { list: ['h1'], migrated: true }, 't1: 旧 drill 键有值→该项目初始展开(哨兵锚)');
  assert.deepEqual(initialExpandedProjects(['a', 'b'], 'h1'), { list: ['h1'], migrated: true }, 't1: drill 态优先于陈旧手风琴数组');
  assert.deepEqual(initialExpandedProjects(['a', 7, ''], undefined), { list: ['a'], migrated: false }, 't1: 新键数组过滤非法');
  assert.deepEqual(initialExpandedProjects(undefined, undefined), { list: [], migrated: false }, 't1: 都缺→全部折叠');
  assert.deepEqual(initialExpandedProjects('junk', null), { list: [], migrated: false }, 't1: 非法类型安全回落');
  assert.deepEqual(toggleExpanded(['a'], 'b'), ['a', 'b'], 't1: 展开追尾');
  assert.deepEqual(toggleExpanded(['a', 'b'], 'a'), ['b'], 't1: 收起移除');
  assert.deepEqual(toggleExpanded(['a'], ''), ['a'], 't1: 空 hash no-op');
}

// t2 store 接线:持久化回 cgui-expanded-projects;旧键仅迁移读点+删除
{
  const store = readFileSync(new URL('../../client/src/stores/sessionStore.js', import.meta.url), 'utf8');
  assert.match(store, /initialExpandedProjects\(readLs\('cgui-expanded-projects', undefined\), readLs\('cgui-drill-project', undefined\)\)/, 't2: 迁移读点');
  assert.match(store, /localStorage\.removeItem\('cgui-drill-project'\)/, 't2: 迁移后删旧键');
  assert.equal((store.match(/readLs\('cgui-drill-project'/g) || []).length, 1, 't2: 旧键仅一处迁移读点');
  assert.doesNotMatch(store, /writeLs\('cgui-drill-project'/, 't2: 旧键不再写');
  assert.match(store, /toggleProjectExpanded/, 't2: 折叠切换 action');
  assert.match(store, /ensureProjectExpanded: \(hash\) => set\(\(s\) => \{\s*if \(!hash \|\| s\.expandedProjects\.includes\(hash\)\)/, 't2: ensureProjectExpanded 回归「确保展开」语义(调用点零改)');
  assert.doesNotMatch(store, /setDrillProject|drillProject:/, 't2: 钻入单值槽退役');
}

// t3 侧栏接线:返回行退役/折叠树/项目行两枚操作/能力一个不丢/会话行零回退
{
  const sb = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(sb, />返回项目列表/, 't3: 「返回项目列表」不再渲染(注释提及不计)');
  assert.doesNotMatch(sb, /drillInto|drillBack|resolveDrillView/, 't3: drill 残留清零');
  assert.match(sb, /aria-expanded=\{isOpen\}/, 't3: 项目行折叠语义(a11y)');
  assert.match(sb, /ChevronRight size=\{12\} className=\{`text-ink-faint shrink-0 transition-transform \$\{isOpen \? 'rotate-90' : ''\}`\}/, 't3: 折叠 chevron');
  assert.match(sb, /const toggleProject = \(hash\) => \{/, 't3: 折叠切换');
  assert.match(sb, /if \(isOpen\) flushPendingForProject\(hash\);/, 't3: 收起组落实待删(时机等价迁移)');
  // 项目行 hover 两枚:「+」新建 + 「⋯」菜单;菜单收纳全部既有能力
  assert.match(sb, /data-cgui="new-session-btn"\s*\n\s*data-tour="new-session"/, 't3: 「+」新建(锚点/GuideTour 保留)');
  assert.match(sb, /<ProjectRowMenu/, 't3: 「⋯」菜单挂载');
  for (const cap of ['在文件夹中显示', '置顶到列表最前', '新建 worktree 会话', '已归档会话', '从侧栏隐藏']) {
    assert.ok(sb.includes(cap), `t3: 能力不丢——${cap}`);
  }
  assert.match(sb, /gap=\{4\} clampSelector="\.sidebar-flank"/, 't3: 菜单弹层沿 p5-2 口径');
  assert.match(sb, /!project\.virtual && \(/, 't3: 虚拟行不显示 reveal(双关保留)');
  assert.match(sb, /\/api\/reveal-path/, 't3: reveal 走已知项目校验端点');
  assert.match(sb, /data-cgui="new-worktree-btn"/, 't3: worktree 锚点随菜单保留');
  assert.match(sb, /<SessionItem/, 't3: 会话行组件原样复用(零回退)');
  // r26-I7② 换锚:展开组保鲜过 watcherRefreshTargets(跳过 hidden 展开组)。
  assert.match(sb, /for \(const h of watcherRefreshTargets\(st\.expandedProjects, st\.hiddenProjects \|\| hiddenRef\.current\)\) st\.fetchSessionsForPanel\(h\);/, 't3: 展开组保鲜(r26-I7②:跳过 hidden 组)');
  assert.doesNotMatch(sb, /彻底清理该项目的 Claude 本地状态/, 't3: p3-4 清理按钮移除态保持');
}

// t4 r13-② 分组/排序纯函数(哨兵:删置顶恒前 → 本节红)
{
  const { sortProjectRows, flattenSessionRows, reorderManual } = await import('../../client/src/utils/projectPanel.js');
  const rows = [
    { hash: 'a', lastActivity: '2026-01-01T00:00:00Z' },
    { hash: 'b', lastActivity: '2026-03-01T00:00:00Z' },
    { hash: 'c', lastActivity: '2026-02-01T00:00:00Z' },
    { hash: 'p', lastActivity: '2025-01-01T00:00:00Z' },
  ];
  const pinned = new Set(['p']);
  assert.deepEqual(sortProjectRows(rows, { sortMode: 'recent', pinned }).map((r) => r.hash), ['p', 'b', 'c', 'a'], 't4: recent=置顶恒前+活动降序(哨兵锚)');
  assert.deepEqual(sortProjectRows(rows, { sortMode: 'manual', order: ['c', 'a'], pinned }).map((r) => r.hash), ['p', 'c', 'a', 'b'], 't4: manual=order 对账,新项目(b)追尾');
  assert.deepEqual(sortProjectRows(rows, { sortMode: 'manual', order: ['gone', 'a'], pinned }).map((r) => r.hash), ['p', 'a', 'b', 'c'], 't4: order 未知项忽略(删除项目自动出列)');
  const flat = flattenSessionRows({
    h1: [{ sessionId: 's1', lastActivity: '2026-01-02T00:00:00Z' }, { sessionId: 's2', archived: true, lastActivity: '2026-05-01T00:00:00Z' }],
    h2: [{ sessionId: 's3', lastActivity: '2026-01-03T00:00:00Z' }],
  });
  assert.deepEqual(flat.map((s) => s.sessionId), ['s3', 's1'], 't4: 单列表跨项目按时间降序,归档不进平铺');
  assert.equal(flat[0].projectHash, 'h2', 't4: 平铺行带 projectHash 反查');
  assert.deepEqual(reorderManual(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b'], 't4: 拖拽落位');
}

// t5 r13-② 接线:prefs 统一端点/WS/store/侧栏 UI
{
  const prefs = readFileSync(new URL('../../server/routes/prefs.js', import.meta.url), 'utf8');
  assert.match(prefs, /router\.(get|put)\('\/prefs\/sidebar-view'/, 't5: prefs 端点');
  assert.match(prefs, /broadcast\(\{ type: 'sidebar-view'/, 't5: WS 广播');
  const sb = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  assert.match(sb, /<SidebarViewMenu \/>/, 't5: 侧栏头按钮');
  assert.match(sb, /分组方式[\s\S]*?排序方式/, 't5: 弹层两段');
  assert.match(sb, /桌面端拖拽/, 't5: 手机置灰注文案');
  assert.match(sb, /view\.groupMode === 'single' && flatSessions\.map/, 't5: 单列表平铺分支');
  assert.match(sb, /sortProjectRows\(rows, \{\s*sortMode: view\.sortMode, order: drag \? drag\.preview : view\.projectOrder, pinned: pinnedProjSet,/, 't5: 排序接线(拖拽预览优先)');
  // r26-I1 二次换锚:并回下沉到 store 层(putSidebarView 唯一真相源),组件直传 preview。
  assert.match(sb, /putSidebarView\(\{ projectOrder: drag\.preview \}\)/, 't5: 松手才落 prefs(r26-I1:并回在 store 层)');
  assert.doesNotMatch(sb, /from 'lucide-react'/, 't5: 零裸 lucide(守卫)');
  const store = readFileSync(new URL('../../client/src/stores/sessionStore.js', import.meta.url), 'utf8');
  assert.match(store, /hydrateSidebarView|putSidebarView|applyRemoteSidebarView/, 't5: store 三件');

  // t6(0.2.296 全端崩溃回归钉):useMemo 回调与 deps 数组在渲染时同步求值,
  // flatSessions 引用 pendingIds → 声明必须在 pendingIds 之后,否则 TDZ
  // (WebKit "Cannot access uninitialized variable")。钉源码声明顺序。
  const declPending = sb.indexOf('const pendingIds = useMemo(');
  const declFlat = sb.indexOf('const flatSessions = useMemo(');
  assert.ok(declPending > 0 && declFlat > 0, 't6: 两声明都存在');
  assert.ok(declFlat > declPending, 't6: flatSessions 声明必须在 pendingIds 之后(TDZ 回归钉)');
}

console.log('check-drill-sidebar: all passed (r13 折叠树)');
