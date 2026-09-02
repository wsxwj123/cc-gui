#!/usr/bin/env node
// r92:六张待应答卡的正文可折叠 —— 折叠只藏【可滚动正文】,标题行与操作按钮行保留。
//
// 为什么要锁:
//   ① 折叠若连按钮行一起藏 → 折叠态没法一键允许/拒绝,而 Enter/Esc 仍绑在
//      position===0 的卡上(键盘让行 escAction 也看不见折叠态)→ 用户按个回车
//      就静默批准了一个看不见的请求。按钮行必须留在门控之外。
//   ② 折叠若靠"不渲染卡片、改渲染一条 bar"实现 → 卡片 unmount,用户填到一半的
//      计划修改意见 / 多题答案 / remember 选择 / 目录永久授权勾选一并丢失
//      (与 check-r55-perm-sticky 锁的 key={mine[0].id} 是同一条不变量)。
//      正文必须【保持挂载】,只把高度收到 0。
//   ③ 默认必须【展开】:这类卡是阻塞回合的闸门,默认折叠 = 默认藏起一件必须做的事。
//   ④ 折叠是纯渲染层的事,禁止新增 window 级监听、禁止碰应答链路三禁区
//      (respondPermission / escAction / App.jsx 的 Esc 让行)。
// JSX 进不了 node,故按组件切片做结构断言 + 纯函数真跑,不是散装 grep。
// Run: node tests/unit/check-r92-card-collapse.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PERM_COLLAPSED_KEY, readPermCollapsed, writePermCollapsed } from '../../client/src/utils/permCollapse.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const P = join(root, 'client/src/components/PermissionPrompt.jsx');
const src = readFileSync(P, 'utf8');

const CARDS = ['ElicitCard', 'RefusalDialogCard', 'PlanReviewCard', 'AskQuestionCard', 'BoundaryCard', 'PermissionCard'];
const HEAD_ROW = 'px-4 py-2.5 flex items-center gap-2 border-b border-canvas-deep'; // 标题行
const FOOT_ROW = 'bg-canvas-warm/60 border-t border-canvas-deep';                    // 操作按钮行

// 取一个组件定义的源码切片(到下一个顶层 function 为止)。
function sliceCard(name) {
  const start = src.indexOf(`function ${name}({`);
  assert.ok(start > 0, `r92: 找不到组件 ${name}`);
  const next = src.indexOf('\nfunction ', start + 1);
  const nextExport = src.indexOf('\nexport function ', start + 1);
  const end = Math.min(next < 0 ? Infinity : next, nextExport < 0 ? Infinity : nextExport);
  return src.slice(start, end === Infinity ? undefined : end);
}

// ── ① 六张卡逐张:正文受折叠门控,标题行与按钮行不受 ────────────────
for (const name of CARDS) {
  const card = sliceCard(name);

  // 1a 正文走 CardBody(唯一的折叠门控点),且每张卡只有一处
  assert.equal(card.split('<CardBody collapsed={collapsed}').length - 1, 1,
    `r92-①: ${name} 的可滚动正文必须整段交给 <CardBody collapsed={collapsed}>(唯一折叠门控点)`);
  const bodyStart = card.indexOf('<CardBody');
  const bodyEnd = card.indexOf('</CardBody>');
  assert.ok(bodyEnd > bodyStart, `r92-①: ${name} 的 CardBody 没有正确闭合`);
  const body = card.slice(bodyStart, bodyEnd);

  // 1b 标题行与按钮行【不在】折叠门控范围内 —— 挪进 CardBody = 折叠态没法决策
  assert.ok(!body.includes(FOOT_ROW),
    `r92-①: ${name} 的操作按钮行被挪进了 CardBody(折叠后就点不到允许/拒绝,而 Enter 仍会静默批准)`);
  assert.ok(!body.includes(HEAD_ROW),
    `r92-①: ${name} 的标题行被挪进了 CardBody(折叠后连折叠开关都没了)`);

  // 1c 两行确实存在,且外面没有 collapsed 条件把它们整段藏掉
  assert.ok(card.includes(HEAD_ROW), `r92-①: ${name} 标题行不见了`);
  assert.ok(card.includes(FOOT_ROW), `r92-①: ${name} 操作按钮行不见了`);
  for (const [row, label] of [[FOOT_ROW, '操作按钮行'], [HEAD_ROW, '标题行']]) {
    const gated = new RegExp(`collapsed[^\\n]{0,40}(&&|\\?)[\\s\\S]{0,160}?${row.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}`);
    assert.ok(!gated.test(card),
      `r92-①: ${name} 的${label}被 collapsed 条件门控了 —— 折叠只许藏可滚动正文`);
  }

  // 1d 折叠开关挂在标题行里(在正文之前)
  const tailAt = card.indexOf('<CardHeadTail collapsed={collapsed} onToggle={onToggleCollapsed}');
  assert.ok(tailAt > 0 && tailAt < bodyStart,
    `r92-①: ${name} 的标题行必须带 <CardHeadTail>(折叠开关 + 折叠态摘要),且在正文之前`);

  // 1e 组件签名收下折叠两参
  assert.match(card, new RegExp(`^function ${name}\\(\\{[^}]*collapsed, onToggleCollapsed \\}\\)`),
    `r92-①: ${name} 必须接收 collapsed / onToggleCollapsed`);
}

// ── ② 折叠正文是"高度归零",不是卸载 ───────────────────────────────
const cardBody = src.slice(src.indexOf('function CardBody('), src.indexOf('function CardHeadTail('));
assert.ok(!/\{\s*!?collapsed\s*&&/.test(cardBody) && !/collapsed\s*\?[^}]*:\s*null/.test(cardBody),
  'r92-②: CardBody 不许用条件渲染卸载 children —— 卸载会丢用户填到一半的意见/答案/remember 选择');
assert.match(cardBody, /grid-rows-\[0fr\]/, 'r92-②: 折叠态用 grid-template-rows:0fr 把正文高度收到 0(children 保持挂载)');
assert.match(cardBody, /grid-rows-\[1fr\]/, 'r92-②: 展开态 1fr');
assert.match(cardBody, /transition-\[grid-template-rows\][^`]*motion-reduce:transition-none/,
  'r92-②: 过渡必须带 motion-reduce 分支(prefers-reduced-motion 下不动画)');
assert.match(cardBody, /\{children\}/, 'r92-②: children 无条件渲染');

// 渲染点六张卡不许被折叠态门控(那就是"折叠=卸载卡片")
const renderAt = src.indexOf('<div className="px-6 pb-2 space-y-2');
assert.ok(renderAt > 0, 'r92-②: 找不到渲染点');
const render = src.slice(renderAt)
  .split('collapsed={collapsed}').join('')
  .split('onToggleCollapsed={toggleCollapsed}').join('');
assert.ok(!render.includes('collapsed'),
  'r92-②: 渲染点不许出现 collapsed 条件 —— 折叠必须是卡片内部的正文高度变化,卡片本身始终挂载');
// 与 r55 同源:key 一张不落(折叠改造最容易顺手动到这里)
for (const name of CARDS) {
  assert.match(src, new RegExp(`<${name}\\s+key=\\{mine\\[0\\]\\.id\\}`), `r92-②: ${name} 渲染点的 key={mine[0].id} 不许动`);
}

// ── ③ 折叠开关:可 Tab 到达的 button + aria-expanded ────────────────
const headTail = src.slice(src.indexOf('function CardHeadTail('), src.indexOf('// Plan-mode review card.'));
assert.match(headTail, /<button/, 'r92-③: 折叠开关必须是真 button(可 Tab 到达、可回车触发)');
assert.match(headTail, /aria-expanded=\{!collapsed\}/, 'r92-③: 折叠开关必须带 aria-expanded');
assert.match(headTail, /onClick=\{onToggle\}/, 'r92-③: 折叠开关点了要切换');
assert.match(headTail, /title=\{collapsed \? '展开正文' : '折叠正文'\}/, 'r92-③: 两态各有客观陈述的提示文案');

// ── ④ 偏好:localStorage 键名 + 默认展开 ───────────────────────────
assert.equal(PERM_COLLAPSED_KEY, 'cgui-perm-collapsed', 'r92-④: localStorage 键固定为 cgui-perm-collapsed');
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};
assert.equal(readPermCollapsed(), false,
  'r92-④: 无记录 → 默认【展开】。权限卡是阻塞回合的闸门,默认折叠 = 默认藏起一件必须做的事');
writePermCollapsed(true);
assert.equal(readPermCollapsed(), true, 'r92-④: 用户折起 → 记 true');
assert.equal(mem.get(PERM_COLLAPSED_KEY), 'true', 'r92-④: 写入字符串布尔');
writePermCollapsed(false);
assert.equal(readPermCollapsed(), false, 'r92-④: 用户展开 → 记 false');
mem.set(PERM_COLLAPSED_KEY, 'yes');
assert.equal(readPermCollapsed(), false, 'r92-④: 脏值按展开处理');
globalThis.localStorage = undefined;
assert.equal(readPermCollapsed(), false, 'r92-④: 缺 localStorage(隐私模式)→ 回退默认展开,不抛');
writePermCollapsed(true); // 不得抛

// state 在 PermissionPrompt 顶层(一个窗格一个实例 = 分屏天然隔离)
assert.match(src, /const \[collapsed, setCollapsed\] = useState\(\(\) => readPermCollapsed\(\)\)/,
  'r92-④: 折叠态初值取自 readPermCollapsed');
assert.match(src, /writePermCollapsed\(n\)/, 'r92-④: 手动切换写 localStorage');

// ── ⑤ 不新增 window 级监听 ────────────────────────────────────────
assert.equal(src.split('window.addEventListener').length - 1, 6,
  'r92-⑤: 本文件的 window 监听只该有六张卡各自的 keydown(6 处);折叠是渲染层的事,不许新增 window 级 effect');

// ── ⑥ 禁区:应答链路一行不碰 ──────────────────────────────────────
assert.ok(!/fetch\(\s*['"`]\/api\/permissions\/respond/.test(src),
  'r92-⑥: 应答一律经 respondPermission(送达为止重试 + in-flight 去重),禁止裸 fetch');
const ws = readFileSync(join(root, 'client/src/hooks/useWebSocket.js'), 'utf8');
assert.match(ws, /export async function respondPermission\(id, body\)/, 'r92-⑥: respondPermission 签名不许动');
assert.match(ws, /inFlightResponds/, 'r92-⑥: in-flight 去重不许动');
const esc = readFileSync(join(root, 'client/src/utils/escAction.js'), 'utf8');
assert.match(esc, /export function escYieldCardId\(\{ targetTag = null, pendingList = \[\], psid = null, yieldedForId = null \}\)/,
  'r92-⑥: escYieldCardId 签名不许动(折叠态不许把渲染层状态漏进这只纯函数)');

// diff 文件列表锁:本轮只许动前端卡片相关文件。git 不可用时跳过(上面的内容哨兵仍然生效)。
const FORBIDDEN = ['client/src/hooks/useWebSocket.js', 'client/src/utils/escAction.js', 'client/src/App.jsx',
  'server/routes/permissions.js', 'server/routes/chat.js', 'client/src/stores/sessionStore.js'];
try {
  const base = execFileSync('git', ['merge-base', 'HEAD', 'master'], { cwd: root, encoding: 'utf8' }).trim();
  const changed = execFileSync('git', ['diff', '--name-only', base, '--', ...FORBIDDEN], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(changed, '', `r92-⑥: 这些文件本轮一行都不该改:\n${changed}`);
} catch (e) {
  if (e instanceof assert.AssertionError) throw e;
  console.log('  (跳过 git diff 文件列表锁:', String(e.message).split('\n')[0], ')');
}

console.log('✓ check-r92-card-collapse: 六张卡正文受折叠门控 / 标题行+按钮行保留 / 保持挂载 / 默认展开 / 禁区未动');
