#!/usr/bin/env node
// 监控面板折叠态持久化(#8)。修前三个折叠壳全是裸 useState(defaultOpen),关面板
// (App.jsx setRightPanel(null))就卸载整棵子树 → 重开全部回默认展开。
// 纯 JSX 不能真 import,用源码守卫 + 复刻取值语义。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'client/src/components/AgentMonitorPanel.jsx'), 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

// ── 1. 三个折叠壳都收 id 且都从 localStorage 取初值 ────────────────
for (const fn of ['FoldableSection', 'AgentBucket', 'RemoteBucket']) {
  const sig = new RegExp(`function ${fn}\\(\\{ id[,}]`);
  assert.ok(sig.test(src), `${fn} 必须接收 id prop(折叠态按 id 存)`);
}
assert.equal(count(src, 'useState(() => readFold()[id] ?? defaultOpen)'), 3,
  '三个折叠壳都要用 readFold()[id] ?? defaultOpen 取初值(?? 不能写成 ||,否则存下的 false 会被吞)');
assert.equal(count(src, 'writeFold(id, !v)'), 3, '三个折叠壳的 toggle 都要写回');

// ── 2. 每个使用点都带 id(数量必须对上)──────────────────────────
for (const tag of ['<FoldableSection', '<AgentBucket', '<RemoteBucket']) {
  let sites = 0, withId = 0;
  for (let i = src.indexOf(tag); i >= 0; i = src.indexOf(tag, i + 1)) {
    sites++;
    if (/\bid=/.test(src.slice(i, i + 260))) withId++;
  }
  assert.ok(sites > 0, `${tag} 使用点不该为 0`);
  assert.equal(withId, sites, `${tag} 有 ${sites - withId} 个使用点没带 id`);
}

// ── 3. id 必须稳定:不能拿带计数的 title 当 id ─────────────────────
// `当前对话内 Task (3)` 每来一个子代理数字就变,当 id 等于折叠态每次都丢。
assert.ok(!/id=\{[^}]*title/.test(src), 'id 不得由 title 派生(title 里带实时计数)');
assert.ok(!/id=\{`[^`]*\$\{[^}]*(length|Count)/.test(src), 'id 不得包含实时计数');

// ── 4. 复刻取值语义:存下的 false 必须能覆盖 defaultOpen=true ────────
{
  const fold = { 'local-tasks': false };
  const initial = (id, defaultOpen) => fold[id] ?? defaultOpen;
  assert.equal(initial('local-tasks', true), false, '存过的折叠态优先于默认展开');
  assert.equal(initial('bg-tasks', true), true, '没存过的用默认值');
  assert.equal(initial('done-bucket', false), false, '没存过的默认折叠仍折叠');
}

console.log('✓ check-monitor-fold: 折叠态持久化守卫全过');
