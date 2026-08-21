#!/usr/bin/env node
// r26-E3 单测:项目空态渲染点读 store.projectsAccessError(契约 C-E3 延伸)。
// 契约:PKG-3 服务端 /projects 403 回 {code:'no-disk-access', hint, canOpenSettings}
// → PKG-2 fetchProjects 置 projectsAccessError 单值({hint, canOpenSettings})
// → PKG-11 项目空态渲染点只读它渲染提示,不自拉;undefined = 正常。
// 渲染点无 JSX 环境,按仓库惯例做源码级接线断言 + 纯函数行为断言。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { showAccessSettingsButton } from '../../client/src/utils/projectPanel.js';

const src = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');

// t1 读契约字段(单值,projects 是顶层单列表,按 hash 存无意义)
assert.match(src, /const projectsAccessError = useStore\(\(st\) => st\.projectsAccessError\);/, 't1: 读 store.projectsAccessError 单值');

// t2 项目空态块:拒访时显示真实原因而不是「没有找到项目」
const block = src.match(/view\.groupMode !== 'single' && rows\.length === 0 && \([\s\S]*?\n        \)\}/);
assert.ok(block, 't2: 项目空态块应存在');
assert.match(block[0], /!q && !hiddenOnly && projectsAccessError/, 't2: 拒访分支门控(搜索中/全隐藏不抢戏)');
assert.match(block[0], /text-amber-700/, 't2: 拒访提示用琥珀色(与会话空态同一套)');
assert.match(block[0], /没有找到项目/, 't2: 正常空态文案保留(未拒访时)');
const errIdx = block[0].indexOf('projectsAccessError.hint');
const okIdx = block[0].indexOf("'没有找到项目'");
assert.ok(errIdx > -1 && okIdx > -1 && errIdx < okIdx, 't2: 拒访分支优先于「没有找到项目」(不许再伪装)');

// t3 「打开系统设置」按钮按 canOpenSettings 门控(与 E2 同端点同口径)
assert.match(block[0], /projectsAccessError\.canOpenSettings && \(/, 't3: 按钮按平台位门控');
assert.match(block[0], /\/api\/system\/open-fda-settings/, 't3: 按钮调既有的一键打开端点');
assert.ok(showAccessSettingsButton({ accessError: 'H', canOpenSettings: true }), 't3: 门控纯函数 mac=true');
assert.ok(!showAccessSettingsButton({ accessError: 'H', canOpenSettings: false }), 't3: 门控纯函数 win=false');

// t4 hint 缺失时回落共用文案(会话文件没有丢失 —— 安抚口径一致)
assert.match(block[0], /projectsAccessError\.hint \|\| ACCESS_DENIED_HINT/, 't4: hint 兜底共用文案');

console.log('check-r26-e3-projects-access-error: all passed');
