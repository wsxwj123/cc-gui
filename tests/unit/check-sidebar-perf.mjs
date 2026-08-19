// r13-p2:侧栏卡顿根治(列表身份保持 + SessionItem memo + 稳定回调)与 ⋯ 菜单顶对齐、
// 主题展示名去商标 的守卫。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeSessionList, sameSessionRow } from '../../client/src/utils/projectPanel.js';

const S = (over = {}) => ({ sessionId: 's1', firstPrompt: 'hi', archived: false, messageCount: 3, model: 'm', lastActivity: 't1', ...over });

// t1 身份保持矩阵
{
  const prev = [S(), S({ sessionId: 's2' })];
  // 内容全同(不同对象身份)→ 返回 prev 本身(调用方据此跳过 set)
  const next = [S(), S({ sessionId: 's2' })];
  assert.equal(mergeSessionList(prev, next), prev, 't1: 零变化返回旧数组身份');
  // 一条变(messageCount)→ 新数组,未变条目复用旧身份,变的用新对象
  const bumped = [S({ messageCount: 4 }), S({ sessionId: 's2' })];
  const merged = mergeSessionList(prev, bumped);
  assert.notEqual(merged, prev, 't1: 有变化必须换数组身份');
  assert.notEqual(merged[0], prev[0], 't1: 变化条目用新对象');
  assert.equal(merged[1], prev[1], 't1: 未变条目复用旧身份(memo 跳过重渲的前提)');
  // 新增/删除
  assert.equal(mergeSessionList(prev, [S()]).length, 1, 't1: 删除生效');
  assert.equal(mergeSessionList(undefined, next), next, 't1: 无旧值直接用新值');
  assert.deepEqual(mergeSessionList(prev, null), [], 't1: 非数组回落空');
  // 归档/标题/时间任一变都算变
  for (const k of ['archived', 'firstPrompt', 'lastActivity', 'model']) {
    assert.equal(sameSessionRow(S(), S({ [k]: 'X' })), false, `t1: ${k} 变化必须判不同`);
  }
  assert.equal(sameSessionRow(S({ subagents: [1] }), S({ subagents: [] })), false, 't1: 子代理数变化判不同');
}

// t2 接线守卫
{
  const store = readFileSync(new URL('../../client/src/stores/sessionStore.js', import.meta.url), 'utf8');
  assert.match(store, /mergeSessionList\(prev, list\)/, 't2: store 用合并函数');
  assert.match(store, /if \(merged === prev\) return s;/, 't2: 零变化跳过 set(哨兵锚)');
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /export const SessionItem = React\.memo\(function SessionItem/, 't2: SessionItem memo 化');
  const sb = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  assert.match(sb, /const bindRow = useCallback/, 't2: 稳定回调工厂');
  assert.match(sb, /\{\.\.\.bindRow\(proj\)\}/, 't2: 单列表用稳定回调');
  assert.match(sb, /\{\.\.\.bindRow\(project\)\}/, 't2: 折叠树用稳定回调');
  // 内联箭头回调会让 memo 恒失效 —— JSX 属性行不许再出现(注释里的说明文字不算)
  const jsxLines = sb.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(jsxLines, /onSelect=\{\(s\) => handleSelect/, 't2: 无内联 onSelect(memo 失效源)');
  assert.doesNotMatch(jsxLines, /onFork=\{\(s\) => handleFork/, 't2: 无内联 onFork');
}

// t3 ⋯ 菜单顶对齐
{
  const sel = readFileSync(new URL('../../client/src/components/SessionSelectors.jsx', import.meta.url), 'utf8');
  assert.match(sel, /topAlignRef = null/, 't3: 扩参默认 null(向后兼容)');
  assert.match(sel, /if \(rowEl\) top = rowEl\.getBoundingClientRect\(\)\.top;/, 't3: 顶缘与行顶缘齐平(哨兵锚)');
  assert.match(sel, /\[open, drop, align, gapProp, clampSelector, topAlignRef, bump\]/, 't3: deps 含新参');
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /topAlignRef=\{rowRef\}/, 't3: 会话行菜单接线');
  const sb = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  assert.match(sb, /rowRef=\{projectRowRef\(hash\)\}/, 't3: 项目行菜单接线');
  assert.match(sb, /topAlignRef=\{rowRef\}/, 't3: ProjectRowMenu 透传');
  // 既有消费点零新参(HomeState 等):topAlignRef 只出现在两处行菜单
  const hits = (sb.match(/topAlignRef=/g) || []).length;
  assert.equal(hits, 1, 't3: 侧栏内只有 ProjectRowMenu 透传一处');
  // r13-p2-2 修:rect→style 换算必须用实测标定,不许按 --ui-zoom 硬除
  // (WebKit/Chromium 对 zoom 下两者的口径不一致 —— p5-1 同族坑,真机偏上)。
  assert.match(sel, /export function fixedCalibration/, 't3: 标定函数存在');
  assert.match(sel, /const cal = fixedCalibration\(\);/, 't3: 定位走标定(哨兵锚)');
  assert.match(sel, /top: \(top - cal\.oy\) \/ cal\.sy/, 't3: 纵向按实测换算');
  assert.doesNotMatch(sel, /setPos\(\{ left: left \/ z, top: top \/ z/, 't3: 旧的按 zoom 硬除口径已退役');
}

// t4 主题展示名去商标(id 必须保留,否则用户已选主题与皮肤 base 失配)
{
  const store = readFileSync(new URL('../../client/src/stores/sessionStore.js', import.meta.url), 'utf8');
  const fam = store.slice(store.indexOf('export const THEME_FAMILIES = ['), store.indexOf('export function allThemeFamilies'));
  for (const brand of ["name: 'Claude'", "name: 'OpenCode'", "name: 'GitHub'", "name: '微信'"]) {
    assert.ok(!fam.includes(brand), `t4: 展示名不得用商标 ${brand}`);
  }
  for (const id of ["id: 'claude'", "id: 'opencode'", "id: 'github'", "id: 'wechat'"]) {
    assert.ok(fam.includes(id), `t4: id 必须保留 ${id}(持久化与皮肤 base 依赖)`);
  }
}

console.log('check-sidebar-perf: all passed (r13-p2)');
