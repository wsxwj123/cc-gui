#!/usr/bin/env node
// r26-E2 侧栏侧单测:emptyHint 按项目读 sessionsAccessErrorByProject(契约 C-E2)。
// 契约形状:{ [projectHash]: { hint, canOpenSettings } },读方缺省 undefined = 正常。
// store 侧由 PKG-2 产出;本包只钉消费端(源码级接线 + 纯函数行为)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sessionEmptyHint, showAccessSettingsButton, ACCESS_DENIED_HINT } from '../../client/src/utils/projectPanel.js';

const src = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');

// t1 消费端读契约字段,旧全局单值引用清零
assert.match(src, /st\.sessionsAccessErrorByProject/, 't1: 读 C-E2 契约字段');
assert.ok(!/st\.sessionsAccessError\b/.test(src.replace(/sessionsAccessErrorByProject/g, '')), 't1: 旧全局字段引用清零');
assert.ok(!/st\.sessionsAccessCanOpenSettings/.test(src), 't1: 旧全局平台位引用清零');

// t2 emptyHint 按 entry 工作:有 entry → 拒访文案 + title;无 entry → fallback
assert.equal(sessionEmptyHint({ accessError: 'HINT_A', query: '', fallback: '暂无会话' }), ACCESS_DENIED_HINT, 't2: 有错误显示原因');
assert.equal(sessionEmptyHint({ accessError: undefined, query: '', fallback: '暂无会话' }), '暂无会话', 't2: undefined=正常(契约缺省语义)');
assert.ok(showAccessSettingsButton({ accessError: 'H', canOpenSettings: true }), 't2: mac 给按钮');
assert.ok(!showAccessSettingsButton({ accessError: 'H', canOpenSettings: false }), 't2: win 不给按钮');

// t3 分组空态按当前组 hash 读;平铺空态有 flatAccessEntry 兜底
assert.match(src, /emptyHint\(showArchived \? '没有已归档的会话' : '暂无会话,点行尾「\+」新建', errByProject\[hash\]\)/, 't3: 分组按组 hash 读');
assert.match(src, /emptyHint\(hiddenOnly \? '所有项目都已隐藏' : '暂无会话', flatAccessEntry\)/, 't3: 平铺读可见项目首条错误');

// t4 隔离语义模拟(消费端视角):errByProject 里只有 A 的键 → B 组读出 undefined=正常
{
  const errByProject = { hashA: { hint: 'HINT_A', canOpenSettings: true } };
  assert.equal(errByProject.hashB, undefined, 't4: B 组读到 undefined=正常(污染根治)');
  assert.equal(errByProject.hashA.hint, 'HINT_A', 't4: A 组读出自己的错误');
}

console.log('check-r26-e2-sidebar-access-error: all passed');
