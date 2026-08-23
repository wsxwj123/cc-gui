#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listboxKeyAction, listboxOpenIndex } from '../../client/src/utils/listboxKeyboard.js';

assert.equal(listboxOpenIndex(2, 5), 2, '普通打开聚焦当前选项');
assert.equal(listboxOpenIndex(2, 5, 'ArrowDown'), 0, 'ArrowDown 从 trigger 打开聚焦首项');
assert.equal(listboxOpenIndex(2, 5, 'ArrowUp'), 4, 'ArrowUp 从 trigger 打开聚焦末项');
assert.deepEqual(listboxKeyAction('ArrowDown', 2, 5), { handled: true, nextIndex: 3 });
assert.deepEqual(listboxKeyAction('ArrowDown', 4, 5), { handled: true, nextIndex: 4 }, '末项不越界');
assert.deepEqual(listboxKeyAction('ArrowUp', 0, 5), { handled: true, nextIndex: 0 }, '首项不越界');
assert.deepEqual(listboxKeyAction('Home', 3, 5), { handled: true, nextIndex: 0 });
assert.deepEqual(listboxKeyAction('End', 1, 5), { handled: true, nextIndex: 4 });
assert.deepEqual(listboxKeyAction('Enter', 3, 5), { handled: true, select: true, nextIndex: 3 });
assert.deepEqual(listboxKeyAction(' ', 1, 5), { handled: true, select: true, nextIndex: 1 });
assert.deepEqual(listboxKeyAction('Escape', 2, 5), { handled: true, close: true, nextIndex: 2 });
assert.equal(listboxKeyAction('Tab', 2, 5).handled, false, 'Tab 保留原生离开 listbox 行为');

const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');

const projectBlock = app.slice(app.indexOf('data-testid="project-selector"'), app.indexOf('data-testid="home-send"'));
assert.match(projectBlock, /aria-haspopup="listbox"/);
assert.match(projectBlock, /aria-expanded=\{projOpen\}/);
assert.match(projectBlock, /<div role="listbox" aria-label="选择项目"[^>]*>[\s\S]*?<button[\s\S]*?role="option"[\s\S]*?aria-selected=[\s\S]*?tabIndex=/,
  '项目 option 由合法 listbox 持有并使用 roving tabindex');
assert.match(projectBlock, /onKeyDown=\{onProjectListboxKeyDown\}/);

const permissionBlock = chat.slice(chat.indexOf('data-testid="permission-mode-selector"'), chat.indexOf('// 修正批#1b:composer'));
assert.match(permissionBlock, /aria-haspopup="listbox" aria-expanded=\{open\}/);
assert.match(permissionBlock, /<div role="listbox" aria-label="权限模式"[^>]*>[\s\S]*?<button key=\{m\}[\s\S]*?role="option"[\s\S]*?aria-selected=[\s\S]*?tabIndex=/,
  '权限 option 由合法 listbox 持有并使用 roving tabindex');
assert.match(permissionBlock, /onKeyDown=\{onListboxKeyDown\}/);

console.log('✓ check-r33-selector-aria: 两个 selector 的合法ARIA与完整共享键盘状态迁移全过');
