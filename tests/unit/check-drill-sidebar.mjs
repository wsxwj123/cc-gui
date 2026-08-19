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
  assert.match(sb, /for \(const h of st\.expandedProjects\) st\.fetchSessionsForPanel\(h\);/, 't3: 展开组保鲜(原单钻入组)');
  assert.doesNotMatch(sb, /彻底清理该项目的 Claude 本地状态/, 't3: p3-4 清理按钮移除态保持');
}

console.log('check-drill-sidebar: all passed (r13 折叠树)');
