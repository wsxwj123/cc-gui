#!/usr/bin/env node
// r30:任务清单栏默认折叠 + 用户手动展开/折叠选择记本设备 localStorage(cgui-todo-collapsed)。
// 纯逻辑(todoCollapse.js)行为测;组件接线用源码哨兵(TodoPanel.jsx)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TODO_COLLAPSED_KEY, readTodoCollapsed, writeTodoCollapsed } from '../../client/src/utils/todoCollapse.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const todoPanel = readFileSync(join(root, 'client/src/components/TodoPanel.jsx'), 'utf8');

// ── 1. 行为测:默认折叠 + localStorage 记忆 ───────────────────────────
assert.equal(TODO_COLLAPSED_KEY, 'cgui-todo-collapsed', 'localStorage 键固定为 cgui-todo-collapsed');

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};
assert.equal(readTodoCollapsed(), true, '无记录 → 默认折叠');
writeTodoCollapsed(false);
assert.equal(readTodoCollapsed(), false, '用户展开 → 记 false');
writeTodoCollapsed(true);
assert.equal(readTodoCollapsed(), true, '用户折叠 → 记 true');
assert.equal(mem.get(TODO_COLLAPSED_KEY), 'true', '写入的是字符串布尔');

// 非法/脏值:非 'true' 一律按非折叠处理(幂等,不抛错)
mem.set(TODO_COLLAPSED_KEY, 'no');
assert.equal(readTodoCollapsed(), false, '脏值按非折叠处理');
mem.set(TODO_COLLAPSED_KEY, 'true');
assert.equal(readTodoCollapsed(), true, 'true 字符串 → 折叠');

// 缺失 localStorage 的异常环境(隐私模式等)回退默认折叠,不抛
globalThis.localStorage = undefined;
assert.equal(readTodoCollapsed(), true, '缺 localStorage → 回退默认折叠');
writeTodoCollapsed(false); // 不得抛

// ── 2. 源码哨兵:TodoPanel 接线 ──────────────────────────────────────
assert.ok(todoPanel.includes('readTodoCollapsed'), 'TodoChecklist 用 readTodoCollapsed 初始化折叠态');
assert.ok(todoPanel.includes('writeTodoCollapsed'), '手动切换时写入 localStorage');
assert.ok(/const \[collapsed, setCollapsed\] = useState\(\(\) => readTodoCollapsed\(\)\)/.test(todoPanel),
  '折叠态初值来自 readTodoCollapsed(默认折叠)');
assert.ok(/writeTodoCollapsed\(n\)/.test(todoPanel), '手动切换的展开/折叠写 localStorage');

console.log('✓ check-r30-todo-collapse: 默认折叠 + localStorage 记忆全过');
