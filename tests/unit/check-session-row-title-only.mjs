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
  // p1-2:标题吃满行宽——桌面只留 pr-6 最小留位(常驻 pr-[112px] 挤没标题的形态禁止回潮),
  // 触屏常显保留收窄留位;操作组桌面 hover 覆盖必须带不透明底+左缘渐变过渡。
  assert.match(item, /pl-3 pr-\[108px\] md:pr-6 py-2 [^"]*flex items-center/, 't2: 桌面标题吃满行宽(md:pr-6)+触屏收窄留位(哨兵锚)');
  assert.doesNotMatch(item, /pr-\[112px\]/, 't2: 旧常驻宽留位清零');
  assert.match(item, /md:bg-canvas-warm md:rounded-md/, 't2: 操作组桌面覆盖自带不透明底(主题 token)');
  assert.match(item, /bg-gradient-to-l from-canvas-warm to-transparent/, 't2: 左缘细渐变过渡');
  assert.match(item, /gap-0 md:gap-0\.5/, 't2: 触屏常显按钮组收窄(gap-0)');
  // 子代理折叠三角与 hover 操作组照旧
  assert.match(item, /setExpanded\(!expanded\)/, 't2: 子代理折叠三角保留');
  assert.match(item, /ChevronRight/, 't2: 折叠三角图标保留');
  // p2-3 行首:💬 彻底移除。p3-2 顶格(dsh 式):恒宽占位槽废除(哨兵a锚:恢复即红),
  // 状态点存在才内联(6px 间距),无点零留位;三角双形态(触屏/展开内联常显,
  // 桌面静置 hover 覆盖行首左缘 absolute 不挤压标题)。
  assert.doesNotMatch(item, /<MessageSquare/, 't2-p3: 💬 占位图标彻底移除(哨兵锚)');
  assert.doesNotMatch(item, /w-\[17px\]|w-\[11px\]/, 't2-p3-2: 恒宽占位槽清零(标题顶格,哨兵a锚)');
  assert.match(item, /flex items-center gap-1\.5 min-w-0/, 't2-p3-2: 点-标题 6px 间距(gap-1.5)');
  assert.match(item, /\$\{expanded \? '' : 'md:hidden'\}/, 't2-p3-2: 内联三角=触屏常显/展开态常显');
  assert.match(item, /hidden md:flex absolute left-0\.5 top-1\/2 -translate-y-1\/2 z-10 p-0\.5 rounded bg-canvas-warm[^"]*group-hover:opacity-100/, 't2-p3-2: 桌面静置三角 hover 覆盖行首左缘(带底色)');
  assert.match(item, /<SessionRowStatus sessionId=\{session\.sessionId\} running=\{running\} isSelected=\{isSelected\} \/>/, 't2-p3: 状态点组件内联(签名不变)');
  const comp = src.slice(src.indexOf('export function SessionRowStatus'), src.indexOf('export function StatusDot'));
  assert.match(comp, /if \(!kind\) return null;/, 't2-p3-2: 无点行零留位(返回 null)');
  assert.doesNotMatch(comp, /w-\[11px\]/, 't2-p3-2: 恒宽状态槽废除');
  // 判官p1建议:操作组左缘渐变层纯装饰,不拦标题尾部点击
  assert.match(item, /from-canvas-warm to-transparent pointer-events-none/, 't2-p1判官: 渐变层 pointer-events-none');
  for (const t of ['onTogglePin', 'startRename', 'onFork(session)', 'onArchive(session)', 'DeleteButton']) {
    assert.ok(item.includes(t), `t2: hover 操作 ${t} 保留`);
  }
  // 置顶针角标仍在行内
  assert.match(item, /\{pinned && <Pin size=\{9\}/, 't2: 置顶针角标保留');
}

console.log('check-session-row-title-only: all passed');
