#!/usr/bin/env node
// r34:任务清单的"隐藏"必须是真隐藏 —— 用户点隐藏后,清单再更新(内容/勾选变化)都不许把卡片
// 弹回来。旧实现落盘的是"隐藏那一刻的清单签名",活跃回合里清单只要动一下签名就变,卡片自己
// 冒出来(用户实报)。
//
// 三层验证:
//   ① 纯逻辑:todoCollapse.js 的隐藏开关读写/旧键兼容/自动折叠判据 + plan.js 的 draft→real 迁移。
//   ② 真组件渲染:esbuild 打包 TodoPanel.jsx(带 katex 等真依赖)后用 react-dom/server 渲染,
//      断言"隐藏态只出'显示任务清单'小条""清单更新后依然只出小条"——旧实现这条必红。
//      (JSX 进不了 node 的 loader,故走 esbuild;无 client/node_modules 时明确跳过并打印。)
//   ③ 源码哨兵:组件接线(隐藏判定不得再读任何清单签名)。
// Run: node tests/unit/check-r34-todo-hide.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  TODO_HIDDEN_PREFIX,
  TODO_HIDDEN_SIG_LEGACY_KEY,
  readTodoHidden,
  shouldAutoCollapse,
  todoHiddenKey,
  writeTodoHidden,
} from '../../client/src/utils/todoCollapse.js';
import { migrateSessionVisibilityOwner } from '../../client/src/utils/plan.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const requireCjs = createRequire(import.meta.url);
const todoPanel = readFileSync(join(root, 'client/src/components/TodoPanel.jsx'), 'utf8');

// localStorage 桩:每个用例换一份干净内存,桩本身与 TodoPanel/工具函数用的是同一套 API。
function freshStorage() {
  const mem = new Map();
  const stub = {
    get length() { return mem.size; },
    key: (index) => [...mem.keys()][index] ?? null,
    getItem: (key) => (mem.has(key) ? mem.get(key) : null),
    setItem: (key, value) => { mem.set(key, String(value)); },
    removeItem: (key) => { mem.delete(key); },
  };
  globalThis.localStorage = stub;
  return mem;
}

// ── ① 隐藏开关 = 按会话的布尔,与清单内容无关 ──────────────────────────────
{
  assert.equal(TODO_HIDDEN_PREFIX, 'cgui-todo-hidden:', '新键前缀固定(带冒号,旧键 cgui-todo-hidden-sig 不会撞前缀)');
  assert.equal(todoHiddenKey('sess-1'), 'cgui-todo-hidden:sess-1', '按会话键构造');
  assert.equal(todoHiddenKey(''), 'cgui-todo-hidden:global', '空 owner 落 global');
  assert.equal('cgui-todo-hidden-sig'.startsWith(TODO_HIDDEN_PREFIX), false,
    '旧签名键不落在新前缀里(否则会被误当成隐藏开关)');

  const mem = freshStorage();
  assert.equal(readTodoHidden('sess-1'), false, '无记录 → 不隐藏(默认显示)');
  writeTodoHidden('sess-1', true);
  assert.equal(mem.get('cgui-todo-hidden:sess-1'), '1', '隐藏只落一个与清单无关的布尔');

  // 核心:隐藏之后,清单怎么更新都不影响隐藏态 —— 隐藏判据里根本没有清单的任何一段。
  const v1 = [{ content: '甲', status: 'completed' }, { content: '乙', status: 'in_progress' }];
  const v2 = [{ content: '甲', status: 'completed' }, { content: '乙', status: 'completed' }, { content: '丙', status: 'pending' }];
  const sigOf = (todos) => todos.map((t) => `${t.content || ''}\x01${t.status || ''}`).join('\x02');
  for (const todos of [v1, v2, v1, []]) {
    assert.equal(sigOf(todos) === sigOf(v1), todos === v1, '哨兵:两份清单签名确实不同(否则本用例测不出东西)');
    assert.equal(readTodoHidden('sess-1'), true,
      `隐藏后清单更新到 ${JSON.stringify(todos.map((t) => t.status))} 仍必须保持隐藏`);
  }

  // 按会话隔离:A 会话隐藏,别的会话照常显示。
  assert.equal(readTodoHidden('sess-2'), false, '别的会话不受本会话隐藏影响');
  assert.equal(mem.has('cgui-todo-hidden:sess-2'), false, '读别的会话不得顺手建键');

  // 点"显示任务清单":恢复显示 = 删键(不留 'false' 残值)。
  writeTodoHidden('sess-1', false);
  assert.equal(readTodoHidden('sess-1'), false, '点显示后恢复显示');
  assert.equal(mem.has('cgui-todo-hidden:sess-1'), false, '恢复显示删键,不留残值');
  assert.equal(readTodoHidden('sess-2'), false, '删一个会话的键不动别处');
}

// ── ①b 旧键兼容:老的"签名隐藏"值不得造成意外隐藏,也不许报错 ──────────────
{
  const mem = freshStorage();
  mem.set(TODO_HIDDEN_SIG_LEGACY_KEY, '甲completed乙in_progress'); // 旧实现存的签名串
  assert.equal(readTodoHidden('sess-1'), false, '旧签名键读到也绝不当作隐藏开关(否则升级即"意外隐藏")');
  assert.equal(mem.has(TODO_HIDDEN_SIG_LEGACY_KEY), false, '旧键读到时顺手清掉,不留死键');
  // 清完不影响后续正常隐藏/恢复。
  writeTodoHidden('sess-1', true);
  assert.equal(readTodoHidden('sess-1'), true, '清理旧键不影响新开关');
}

// ── ①c 无 localStorage(隐私模式)兜底:不隐藏、不抛 ─────────────────────────
{
  globalThis.localStorage = undefined;
  assert.equal(readTodoHidden('sess-1'), false, '缺 localStorage → 回退不隐藏(宁可显示,不可无入口)');
  writeTodoHidden('sess-1', true); // 不得抛
  writeTodoHidden('sess-1', false);
  freshStorage();
}

// ── ①d 全完成自动折叠:同一份全完成快照只折一次(不是"不再折叠") ─────────────
{
  assert.equal(shouldAutoCollapse(true, 'sigA', null), true, '首次看到全完成 → 折一次');
  assert.equal(shouldAutoCollapse(true, 'sigA', 'sigA'), false, '同一份全完成快照不二次强制折叠(用户手动展开后不被再按下去)');
  assert.equal(shouldAutoCollapse(true, 'sigB', 'sigA'), true, '换成内容不同的新清单完成 → 再折一次');
  assert.equal(shouldAutoCollapse(false, 'sigB', 'sigA'), false, '没全完成不折');
  assert.equal(shouldAutoCollapse(false, '', null), false, '空清单不折');
}

// ── ①e draft→real 换绑:隐藏开关要跟着会话键搬走 ────────────────────────────
{
  const mem = freshStorage();
  mem.set('cgui-todo-hidden:draft-a', '1');
  mem.set('cgui-goal-hidden:draft-a', 'goal-fp');
  mem.set('cgui-plan-hidden:draft-a:hash1', '# 计划');
  mem.set('cgui-todo-hidden:sess-b', '1');
  assert.equal(migrateSessionVisibilityOwner(globalThis.localStorage, 'draft-a', 'session-a'), true,
    'draft→real 迁移按会话键存的可见性');
  assert.equal(mem.get('cgui-todo-hidden:session-a'), '1', '任务清单隐藏开关随会话键搬到真 sid');
  assert.equal(mem.has('cgui-todo-hidden:draft-a'), false, 'draft 旧键已移除');
  assert.equal(mem.get('cgui-goal-hidden:session-a'), 'goal-fp', 'goal 可见性照旧迁移(回归哨兵)');
  assert.equal(mem.get('cgui-plan-hidden:session-a:hash1'), '# 计划', '计划可见性照旧迁移(回归哨兵)');
  assert.equal(mem.get('cgui-todo-hidden:sess-b'), '1', '别的会话不受牵连');
}

// ── ② 真组件渲染:隐藏态只出"显示"小条,清单更新后依然只出小条 ──────────────
const todosV1 = [
  { content: '甲', status: 'completed' },
  { content: '乙', status: 'in_progress' },
  { content: '丙', status: 'pending' },
];
const todosV2 = [
  { content: '甲', status: 'completed' },
  { content: '乙', status: 'completed' },
  { content: '丙', status: 'in_progress' },
];

function loadTodoPanelRenderer() {
  const clientDir = join(root, 'client');
  let esbuild;
  try {
    esbuild = requireCjs(join(clientDir, 'node_modules/esbuild'));
    requireCjs(join(clientDir, 'node_modules/react-dom/server'));
  } catch {
    return null; // 没装 client 依赖(裸检出):下面明确打印跳过,不静默转绿
  }
  const work = mkdtempSync(join(tmpdir(), 'r34-todo-render-'));
  const entry = join(work, 'entry.jsx');
  writeFileSync(entry, [
    "import React from 'react';",
    "import { renderToStaticMarkup } from 'react-dom/server';",
    `import { TodoPanel } from ${JSON.stringify(join(clientDir, 'src/components/TodoPanel.jsx'))};`,
    'export function render(props) { return renderToStaticMarkup(React.createElement(TodoPanel, props)); }',
  ].join('\n'));
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(work, 'bundle.cjs'),
    jsx: 'automatic',
    nodePaths: [join(clientDir, 'node_modules')],
    loader: { '.js': 'jsx', '.css': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
  });
  const { render } = requireCjs(join(work, 'bundle.cjs'));
  return { render, cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

const renderer = loadTodoPanelRenderer();
if (!renderer) {
  console.log('! 跳过 ② 真组件渲染:未找到 client/node_modules/esbuild 或 react-dom(裸检出环境)');
} else {
  const { render, cleanup } = renderer;
  const CARD = 'data-cgui="todo-panel"';
  // 小条的精确标记:它渲染成 <span>显示任务清单</span>;隐藏按钮的 title 里也含这几个字,
  // 所以不能拿裸文案当判据(标题里那句是"点「显示任务清单」恢复")。
  const SHOW_BAR = '<span>显示任务清单</span>';
  try {
    freshStorage();
    // 未隐藏:整卡在,且没有"显示"小条。
    const plain = render({ todos: todosV1, planKey: 'sess-1' });
    assert.ok(plain.includes(CARD), '未隐藏时渲染完整任务清单卡');
    assert.ok(!plain.includes(SHOW_BAR), '未隐藏时不渲染"显示任务清单"小条');

    // 点隐藏后的落盘形态 + 首帧:只剩"显示"小条,卡片不在。
    writeTodoHidden('sess-1', true);
    const hiddenV1 = render({ todos: todosV1, planKey: 'sess-1' });
    assert.ok(!hiddenV1.includes(CARD), '隐藏后不渲染任务清单卡');
    assert.ok(hiddenV1.includes(SHOW_BAR), '隐藏后留下可点的"显示任务清单"小条');

    // 核心用例:清单更新(内容/勾选都变 = 旧实现的签名必变)后,卡片仍然不许出现。
    const hiddenV2 = render({ todos: todosV2, planKey: 'sess-1' });
    assert.ok(!hiddenV2.includes(CARD), '清单更新后不得把卡片弹回来(r34 用户实报)');
    assert.ok(hiddenV2.includes(SHOW_BAR), '清单更新后"显示任务清单"入口仍在');

    // 按会话:同一份清单在别的会话里照常显示完整卡。
    const otherSession = render({ todos: todosV1, planKey: 'sess-2' });
    assert.ok(otherSession.includes(CARD), '别的会话不受本会话隐藏影响(隐藏按会话记)');

    // 点"显示任务清单"的落盘后果(组件回调写的就是这个)+ 恢复后的首帧。
    writeTodoHidden('sess-1', false);
    const shown = render({ todos: todosV2, planKey: 'sess-1' });
    assert.ok(shown.includes(CARD), '点显示后恢复完整卡');
    assert.ok(!shown.includes(SHOW_BAR), '恢复后不再留"显示"小条');

    // 旧签名键:升级用户机器上留着老值,渲染必须照常出整卡(不得意外隐藏),并把老键清掉。
    const mem = freshStorage();
    mem.set(TODO_HIDDEN_SIG_LEGACY_KEY, '甲completed乙in_progress');
    const legacy = render({ todos: todosV1, planKey: 'sess-1' });
    assert.ok(legacy.includes(CARD), '旧签名键的值不得造成意外隐藏');
    assert.equal(mem.has(TODO_HIDDEN_SIG_LEGACY_KEY), false, '渲染一次即清掉旧签名键');

    // 无 localStorage:照常出卡,不白屏。
    globalThis.localStorage = undefined;
    const noStorage = render({ todos: todosV1, planKey: 'sess-1' });
    assert.ok(noStorage.includes(CARD), '无 localStorage 时按不隐藏渲染(不抛、不白屏)');
    freshStorage();
  } finally {
    cleanup();
  }
}

// ── ③ 源码哨兵:组件接线 ───────────────────────────────────────────────────
{
  assert.ok(!todoPanel.includes('hiddenSig'), '隐藏态不得再是"签名比较"(旧实现的根因)');
  assert.ok(!todoPanel.includes(TODO_HIDDEN_SIG_LEGACY_KEY), '旧签名键只在 utils 里做兼容清理,组件不再碰它');
  assert.match(todoPanel, /const \[hidden, setHidden\] = useState\(\(\) => readTodoHidden\(planKey\)\)/,
    '隐藏态初值来自按会话的 readTodoHidden(planKey)');
  assert.match(todoPanel, /useEffect\(\(\) => \{ setHidden\(readTodoHidden\(planKey\)\); \}, \[planKey\]\)/,
    '切会话重新读该会话的隐藏开关');
  assert.match(todoPanel, /if \(hidden\) return \(\s*<ShowBar/, '隐藏渲染分支只看 hidden 布尔,不看清单签名');
  // 旧实现就是 `hiddenSig === sig` 这一句把卡片弹回来的。限定 sig\b(不误伤 PlanBlock 里
  // 合法按签名的 hiddenPlan === signature)。
  assert.doesNotMatch(todoPanel, /hidden\w*\s*(===|!==)\s*sig\b/, '隐藏判定里不得再出现清单签名比较(旧实现的根因)');
  assert.doesNotMatch(todoPanel, /\bsig\b\s*(===|!==)\s*hidden\w*/, '清单签名也不得反向与隐藏态比较');
  // 隐藏态只能被"布尔常量 / 该会话键的读取"驱动,拿清单里的任何东西当参数即回退成签名语义。
  const hiddenArgs = [...todoPanel.matchAll(/setHidden\(([^;]*?)\);/g)].map((m) => m[1].trim());
  assert.ok(hiddenArgs.length >= 3, `隐藏态必须由 setHidden 驱动(实得 ${hiddenArgs.length} 处)`);
  for (const arg of hiddenArgs) {
    assert.ok(['true', 'false', 'readTodoHidden(planKey)'].includes(arg),
      `setHidden 只接受布尔/按会话键读取,实得 setHidden(${arg})`);
  }
  // 隐藏/显示两个动作必须落盘(否则刷新/换会话即失效)。
  assert.match(todoPanel, /setHidden\(true\); writeTodoHidden\(planKey, true\)/, '点隐藏:置本地态 + 写入该会话的隐藏键');
  assert.match(todoPanel, /setHidden\(false\); writeTodoHidden\(planKey, false\)/, '点显示:清本地态 + 删该会话的隐藏键');
  // 自动折叠口径不变:仍由 shouldAutoCollapse 去重,不因本次改动被顺手改掉。
  assert.match(todoPanel, /shouldAutoCollapse\(allComplete, sig, collapsedForSigRef\.current\)/,
    '"全部完成自动折叠一次"仍按签名去重(本次只动隐藏,不动折叠)');
  // 会话键必须传进来才可能按会话隔离。
  assert.match(todoPanel, /<TodoChecklist todos=\{todos\} isStreaming=\{isStreaming\} planKey=\{planKey\} \/>/,
    'TodoPanel 必须把 planKey 交给 TodoChecklist');
  assert.match(todoPanel, /function TodoChecklist\(\{ todos, isStreaming = false, planKey = 'global' \}\)/,
    'TodoChecklist 必须绑定 planKey 形参(只写类型注解不绑定 = 引用即崩)');
  // 恢复入口仍在,文案不变。
  assert.match(todoPanel, /label="显示任务清单"/, '恢复入口文案保持"显示任务清单"');
  // GUI 文案禁 emoji(项目规范)。
  assert.doesNotMatch(todoPanel, /[✀-➿\u{1f300}-\u{1faff}✅⭐⚡]/u, 'TodoPanel 文案不得含 emoji');
}

console.log('✓ check-r34-todo-hide: 隐藏=按会话真隐藏(清单更新不弹回)、点显示恢复、旧键兼容、全完成自动折叠只折一次 全过');
