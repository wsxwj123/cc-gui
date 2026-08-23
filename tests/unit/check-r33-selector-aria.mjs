#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');

const projectBlock = app.slice(app.indexOf('data-testid="project-selector"'), app.indexOf('data-testid="home-send"'));
assert.match(projectBlock, /aria-haspopup="listbox"/);
assert.match(projectBlock, /aria-expanded=\{projOpen\}/);
assert.match(projectBlock, /<div role="listbox" aria-label="选择项目">[\s\S]*?<button[\s\S]*?role="option"[\s\S]*?aria-selected=/,
  '项目 option 由合法 listbox 持有并暴露选中态');

const permissionBlock = chat.slice(chat.indexOf('data-testid="permission-mode-selector"'), chat.indexOf('// 修正批#1b:composer'));
assert.match(permissionBlock, /aria-haspopup="listbox" aria-expanded=\{open\}/);
assert.match(permissionBlock, /<div role="listbox" aria-label="权限模式">[\s\S]*?<button key=\{m\}[\s\S]*?role="option"[\s\S]*?aria-selected=/,
  '权限 option 由合法 listbox 持有并保留原生 button 键盘激活');

console.log('✓ check-r33-selector-aria: 两个 selector 的 listbox/option/aria-selected/原生键盘语义全过');
