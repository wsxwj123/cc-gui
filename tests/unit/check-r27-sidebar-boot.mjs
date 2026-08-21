#!/usr/bin/env node
// 单测:r27 侧栏启动补拉 + isSelected 恒真加固。
// 症状(用户实证):冷启动后只有上次聚焦项目的会话组被拉取,其他已展开组永远转圈,
// 只能手动折叠再展开(toggleProject 里有补拉,启动路径没有)。
// 根因:水合的 expandedProjects 在启动路径没有任何一脚 fetchSessionsForPanel;
// watcher 只在 cgui:sessions-changed / cgui:ws-reconnected 后跑,而首连不发 reconnected。
// 哨兵(验证过红):删掉启动补拉 effect → t1 红;isSelected 退回裸等式 → t2 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');

// t1 启动补拉接线:projects 就绪后对所有已展开未拉取的可见组补一脚(与 toggleProject 同一动作)
{
  assert.match(src, /启动补拉/, 't1: 启动补拉 effect 存在(注释锚)');
  assert.match(src, /if \(!projects\.length\) return;\s*\n\s*const st = useStore\.getState\(\);\s*\n\s*for \(const h of watcherRefreshTargets\(st\.expandedProjects/, 't1: 遍历 expandedProjects 经 watcherRefreshTargets(与 watcher 同口径跳过 hidden)');
  assert.match(src, /if \(!st\.sessionsByProject\[h\]\) st\.fetchSessionsForPanel\(h\);\s*\n\s*}\s*\n\s*}, \[projects\]\)/, 't1: 幂等补拉且 deps=[projects]');
  // 与 toggleProject 同动作对照(既有行没被动过)
  assert.match(src, /if \(!isOpen && !st\.sessionsByProject\[hash\]\) st\.fetchSessionsForPanel\(hash\);/, 't1: toggleProject 补拉原样保留');
}

// t2 isSelected 恒真加固:先判 sessionId 非空再比对(封死 undefined===undefined 路径)
{
  const n = (src.match(/isSelected=\{!!session\.sessionId && focusSession\?\.sessionId === session\.sessionId\}/g) || []).length;
  assert.equal(n, 2, 't2: 两处 isSelected 都带非空守卫(分组+平铺)');
  assert.doesNotMatch(src, /isSelected=\{focusSession\?\.sessionId/, 't2: 裸等式清零');
}

console.log('check-r27-sidebar-boot: all passed');
