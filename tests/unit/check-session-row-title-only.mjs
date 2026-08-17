#!/usr/bin/env node
// 单测:r11-⑪ 会话行只显标题 —— 单行化(状态点+标题+置顶角标),模型徽章/消息数/
// 子任务数/相对时间退出可见 DOM、收进原生 title tooltip(sessionRowTooltip 纯函数)。
// 变异哨兵(实际验证过红):在 SessionItem 行内恢复 <ModelBadge …/> 渲染 → t2 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sessionRowTooltip } from '../../client/src/utils/sessionTitle.js';

// t1 tooltip 组装矩阵:缺项跳过、[1m] 剥离、子任务数 0 不显、全空得空串
{
  assert.equal(
    sessionRowTooltip({ model: 'claude-sonnet-4-6', messageCount: 12, subagentCount: 2, timeText: '3 小时前' }),
    'claude-sonnet-4-6 · 12 条消息 · 2 个子任务 · 3 小时前',
    't1: 全字段组装',
  );
  assert.equal(
    sessionRowTooltip({ model: 'claude-opus-4-8[1m]', messageCount: 3, timeText: '刚刚' }),
    'claude-opus-4-8 · 3 条消息 · 刚刚',
    't1: [1m] 后缀剥离(与徽章同口径)',
  );
  assert.equal(sessionRowTooltip({ messageCount: 5 }), '5 条消息', 't1: 无模型跳过');
  assert.equal(sessionRowTooltip({ model: 'm', subagentCount: 0 }), 'm', 't1: 子任务 0 不显');
  assert.equal(sessionRowTooltip({ model: '  ' }), '', 't1: 空白模型不留孤立分隔符');
  assert.equal(sessionRowTooltip(), '', 't1: 无参安全空串');
  assert.equal(sessionRowTooltip({ messageCount: '12' }), '', 't1: 非数值消息数跳过');
}

// t2 源码守卫:SessionItem 行内三行附属已退场,tooltip 接线,单行 truncate
{
  const src = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const start = src.indexOf('export function SessionItem');
  const end = src.indexOf('export const FORK_RUNNING_CONFIRM');
  assert.ok(start > 0 && end > start, 't2: SessionItem 区段可定位');
  const item = src.slice(start, end);
  // 哨兵锚:主行不再渲染模型徽章(恢复 <ModelBadge → 红)
  assert.doesNotMatch(item, /<ModelBadge/, 't2: 模型徽章退出会话行');
  // 消息数/子任务数徽标/相对时间退出可见 DOM(子代理折叠列表的 sub.messageCount 照旧,不在此禁)
  assert.doesNotMatch(item, /\{session\.messageCount\}/, 't2: 消息数不再直渲染');
  assert.doesNotMatch(item, /\+\{session\.subagents\.length\} 子任务/, 't2: +N 子任务徽标退场');
  assert.equal((item.match(/formatDate\(/g) || []).length, 1, 't2: formatDate 仅存 tooltip 一处');
  // tooltip 接线:模型/消息数/子任务数/时间四元组进原生 title
  assert.match(item, /title=\{sessionRowTooltip\(\{/, 't2: 行 title 走 sessionRowTooltip');
  assert.match(item, /model: pinModel \|\| session\.model/, 't2: tooltip 模型含 pin 优先');
  assert.match(item, /timeText: formatDate\(session\.lastActivity\)/, 't2: 时间进 tooltip');
  assert.match(item, /subagentCount: session\.subagents\?\.length/, 't2: 子任务数进 tooltip');
  // 单行化:标题 truncate,双行 clamp 退场;行高收窄(py-2)
  assert.doesNotMatch(item, /line-clamp-2/, 't2: 双行 clamp 退场');
  // p1-2→p3-3:标题吃满行宽(桌面 md:pr-6;触屏 pr-8 只留 ⋯ 常显位),
  // 旧常驻宽留位与 5 图标横排禁回潮。
  assert.match(item, /pl-3 pr-8 md:pr-6 py-2 [^"]*flex items-center/, 't2: 标题吃满行宽(桌面 pr-6/触屏 pr-8)');
  assert.doesNotMatch(item, /pr-\[112px\]|pr-\[108px\]/, 't2: 旧常驻宽留位清零');
  // 子代理折叠三角照旧;p3-3:5 图标横排撤销 → 行尾 ⋯ 触发钮 + AnchoredPopover 菜单
  assert.match(item, /setExpanded\(!expanded\)/, 't2: 子代理折叠三角保留');
  assert.match(item, /ChevronRight/, 't2: 折叠三角图标保留');
  assert.match(item, /<MoreHorizontal size=\{14\}/, 't2-p3-3: 行尾 ⋯ 触发钮(哨兵b锚)');
  assert.match(item, /\(menuOpen \|\| isSelected\) \? 'opacity-100' : 'opacity-100 md:opacity-0 md:group-hover:opacity-100'/, 't2-p3-3: hover/选中/菜单开可见,触屏常显');
  assert.match(item, /<AnchoredPopover anchorRef=\{menuBtnRef\} open=\{menuOpen\}/, 't2-p3-3: 菜单走既有 AnchoredPopover(glass-popover/portal 自管外点)');
  assert.match(item, /confirmDialog\('删除该会话的本地历史记录？操作不可恢复。', \{ danger: true/, 't2-p3-3: 删除走 confirmDialog(Tauri 红线)');
  assert.doesNotMatch(item, /<DeleteButton/, 't2-p3-3: 行内 morph 删除钮退役(菜单内确认)');
  assert.doesNotMatch(item, /bg-gradient-to-l from-canvas-warm/, 't2-p3-3: 旧横排渐变过渡层随横排退役');
  // 横排禁回潮:操作容器内除 ⋯ 触发钮外无直接图标按钮(全部在菜单里)
  const actions = item.slice(item.indexOf('data-cgui="session-actions"'), item.indexOf('<AnchoredPopover'));
  assert.doesNotMatch(actions, /<Pin |<Pencil |<GitBranch |<Archive |<Trash2 /, 't2-p3-3: 5 图标横排禁回潮(哨兵b锚)');
  // p2-3 行首:💬 彻底移除。p3-2b(dsh 实拍对齐):单一窄固定槽(10px+gap-1.5=16px 列)
  // 恒渲染,有无标记全部标题同一左缘;大恒宽双槽(17px+11px)禁回潮(哨兵a锚);
  // 子代理三角=absolute 覆盖槽位(触屏常显/桌面 hover 现身/展开常显,带底色)。
  assert.doesNotMatch(item, /<MessageSquare/, 't2-p3: 💬 占位图标彻底移除(哨兵锚)');
  assert.doesNotMatch(item, /w-\[17px\]|w-\[11px\]/, 't2-p3-2: 旧大恒宽双槽禁回潮(哨兵a锚)');
  assert.match(item, /flex items-center gap-1\.5 min-w-0/, 't2-p3-2b: 槽-标题 6px 间距(gap-1.5)');
  assert.match(item, /absolute left-2 top-1\/2 -translate-y-1\/2 z-10 p-0\.5 rounded bg-canvas-warm[^"]*\$\{expanded \? '' : 'md:opacity-0 md:group-hover:opacity-100'\}/, 't2-p3-2b: 三角覆盖槽位(触屏常显/桌面 hover/展开常显)');
  assert.match(item, /<SessionRowStatus sessionId=\{session\.sessionId\} running=\{running\} isSelected=\{isSelected\} \/>/, 't2-p3: 状态点组件内联(签名不变)');
  const comp = src.slice(src.indexOf('export function SessionRowStatus'), src.indexOf('export function StatusDot'));
  assert.match(comp, /w-\[10px\] shrink-0 flex items-center justify-center/, 't2-p3-2b: 单一窄固定槽恒渲染(全列标题同左缘)');
  assert.doesNotMatch(comp, /return null/, 't2-p3-2b: 槽不因无标记消失(对齐承诺)');
  for (const t of ['onTogglePin', 'startRename', 'onFork(session)', 'onArchive(session)', 'onDelete(session)']) {
    assert.ok(item.includes(t), `t2: 全部会话操作 ${t} 收进菜单保留`);
  }
  // 置顶针角标仍在行内
  assert.match(item, /\{pinned && <Pin size=\{9\}/, 't2: 置顶针角标保留');
}

console.log('check-session-row-title-only: all passed');
