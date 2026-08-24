#!/usr/bin/env node
// 单测:r39 ①「试穿 XP 皮肤后界面卡死」——根因不是样式,是观察器成本。
// xp/client.js 把 rootObserver 挂在 body 上(childList+subtree),页面**任何** DOM 变化
// 都跑一次 installTaskbar:每次 document.querySelector 侧栏 + syncCurrentRow 全文档
// querySelectorAll 会话行 + 逐行改 class。首页 DOM 小无感;真实会话上万节点、流式输出
// 每批变化都全扫 → 主线程吃满 → WKWebView 点不动。
//
// DOM 行为在 node 里测不了,故钉"形态"四条(静态断言):
//   t1 installTaskbar 首句廉价早退:侧栏仍 isConnected 且其内已有 .cgui-xp-taskbar
//      → 直接 return,什么都不查(早退必须排在任何 DOM 查询之前);
//   t2 syncCurrentRow 查询范围收窄到 observedSidebar(会话行都在侧栏内),
//      不得再出现 document.querySelectorAll;
//   t3 rootObserver 回调 rAF 合帧,不再直接 new MutationObserver(installTaskbar),
//      且一帧内多批变化只跑一次(回调先判 rAF 句柄再申请);
//   t4 卸载器 cancelAnimationFrame(卸载后无残留 rAF)。
// 变异:删 t1 那行早退 → t1 红。
// Run: node tests/unit/check-r39-xp-observer-cost.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  fileURLToPath(new URL('../../client/src/builtin-skins/xp/client.js', import.meta.url)),
  'utf8',
);

// 取 IIFE 内 2 空格缩进的顶层函数体(其内层闭合括号缩进更深,故首个 '\n  }' 即函数尾)
function fnBody(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `缺函数 ${name}(哨兵锚)`);
  const end = src.indexOf('\n  }', start);
  assert.ok(end > start, `${name} 没找到函数尾(哨兵锚)`);
  return src.slice(start, end + 4);
}

// t1 廉价早退:稳态下 rootObserver 的每批变化什么都不查
{
  const install = fnBody('installTaskbar');
  const guard = install.split('\n').find((l) => /observedSidebar/.test(l) && /return/.test(l));
  assert.ok(guard, 't1: installTaskbar 缺稳态早退 → 每批 DOM 变化都重扫(卡死根因)');
  assert.match(guard, /isConnected/, 't1: 早退判据要含 observedSidebar.isConnected(侧栏被重建时必须走重路径)');
  assert.match(guard, /cgui-xp-taskbar/, 't1: 早退判据要含 .cgui-xp-taskbar(任务栏被 React 抹掉时必须重挂)');
  const firstQuery = install.indexOf('document.querySelector(');
  assert.ok(firstQuery < 0 || install.indexOf(guard) < firstQuery,
    't1: 早退必须排在任何 DOM 查询之前(排后面等于没早退)');
}

// t2 syncCurrentRow 收窄到侧栏内
{
  const sync = fnBody('syncCurrentRow');
  assert.ok(!/document\.querySelectorAll/.test(sync),
    't2: syncCurrentRow 仍全文档扫会话行(上万节点逐行改 class = 主线程杀手)');
  assert.match(sync, /observedSidebar\.querySelectorAll\('\[data-cgui="session-row"\]'\)/,
    't2: 查询范围要收窄到 observedSidebar(会话行都在侧栏内)');
}

// t3 rootObserver 回调 rAF 合帧
{
  assert.ok(!/new MutationObserver\(installTaskbar\)/.test(src),
    't3: rootObserver 仍直接绑 installTaskbar(每批变化同步跑,无合帧)');
  const cb = src.slice(src.indexOf('var rootObserver'), src.indexOf('rootObserver.observe('));
  assert.ok(cb.length > 0, 't3: 没找到 rootObserver 定义(哨兵锚)');
  assert.match(cb, /requestAnimationFrame\(/, 't3: rootObserver 回调缺 rAF 合帧');
  assert.match(cb, /if \(\w+\) return;/, 't3: 缺"一帧内只跑一次"的句柄守卫(否则合帧形同虚设)');
}

// t4 卸载器清 rAF
{
  const dispose = src.slice(src.indexOf('window.__cguiSkinDispose'));
  assert.ok(dispose.length > 0, 't4: 没找到卸载器(哨兵锚)');
  assert.match(dispose, /cancelAnimationFrame\(/, 't4: 卸载器没取消在飞的 rAF(卸载后仍跑一帧)');
}

// t5(r41): syncCurrentRow 的 add/remove 必须带 contains 守卫 —— 旧版系统 WebKit 对
// no-op classList 写入也重写 class 属性,观察器回调里无守卫的同步 = 微任务无限循环整页
// 冻死(用户机 sample 原生栈实锤:100% 时间在 MutationObserver→classList.remove→
// setAttribute→再通知的闭环里)。变异:守卫改回无条件 add/remove → 下面断言红。
assert.ok(/wantCurrent && !hasCurrent\) rows\[k\]\.classList\.add/.test(src),
  't5: add 必须带「不在才加」守卫');
assert.ok(/!wantCurrent && hasCurrent\) rows\[k\]\.classList\.remove/.test(src),
  't5: remove 必须带「在才删」守卫');
assert.ok(!/else rows\[k\]\.classList\.remove/.test(src),
  't5: 不得存在无守卫的 else remove(冻死根因形态)');

console.log('check-r39-xp-observer-cost: all passed');
