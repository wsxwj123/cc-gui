#!/usr/bin/env node
// r152w 折叠行两处行为(源码级,与 r151b/r151w 的渲染/派生测试互补):
//  1. 收件箱卡片的动作行(处理 / 撤回 / 忽略)点下即收起:XsNoticeRow 的动作容器带 onClickCapture 折叠;
//     同时状态一变(pending → claimed → …)由 resetKey 再次收起,避免点完还停在展开态。
//  2. 发送折叠行只显示「已发送给 xxx + 展开」:服务端 note 不再占状态行(由 check-r151w-xs-send-notice 覆盖派生值)。
// 无 client/node_modules 时这些文件仍在,直接读源码;缺文件则明确失败。
// node tests/unit/check-r152w-collapse-after-action.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p) => readFileSync(join(root, 'client/src', p), 'utf8');
const row = src('components/XsNoticeRow.jsx');
const inbox = src('components/XsInbox.jsx');
const xs = src('utils/xsession.js');

// 1) 动作行点击即折叠
assert.match(row, /onClickCapture=\{\(\) => setExpanded\(false\)\}/,
  '动作行(处理/撤回/忽略)点击后应收起卡片:XsNoticeRow 的动作容器缺少 onClickCapture 折叠');
assert.match(row, /resetKey = null/, 'XsNoticeRow 应接受 resetKey');
assert.match(row, /useEffect\(\(\) => \{ setExpanded\(false\); \}, \[resetKey\]\)/,
  'resetKey 变化时应自动收起(处理/撤回导致状态变化后不留在展开态)');
assert.match(inbox, /resetKey=\{status\}/, '收件箱卡片应把 message.status 作为 resetKey 传入');

// 2) 发送折叠行不再把服务端 note 写进状态行
assert.match(xs, /const singleNote = targets\.length === 1 \? \(targets\[0\]\.note \|\| ''\) : '';/,
  'guiSendNotice 应把单目标 note 单独取出(进元信息,不进状态行)');
assert.doesNotMatch(xs, /const base = targets\.length === 1 \? \(targets\[0\]\.note \|\| ''\)/,
  'guiSendNotice 的状态行不应再直接使用服务端 note');
console.log('✓ r152w:动作行点击收起 + 状态变化收起 + 发送行状态行不再带 note');
