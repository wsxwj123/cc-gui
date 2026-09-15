#!/usr/bin/env node
// 挂载窗口"锚定补偿"的**基准**必须是变化前的快照 —— 钉住 0.2.383 的必修-1(叠加)那个错法。
//
// 错法长什么样:基准取**提交后**的 el.scrollTop(相对口径)。
// Chromium/WebView2(以及 Playwright 的 WebKit)默认开着原生 scroll anchoring —— 浏览器已经在
// 这次布局里按被卸高度把 scrollTop 改好了,再拿它当基准加一遍位移量 = 叠加,朝反方向多滚
// **一整个被卸行高**(双引擎实测 300px)。现场见 tests/unit/sf-mount-anchor-two-configs.spec.mjs
// 的"默认配置"那条用例:修复前红(视口最上一行换成下一行),`overflow-anchor:none` 那条一直绿
// —— 因为那条配置下原生锚定被关掉,叠加不会发生,只跑它就等于没验。
//
// 允许的写法:prev.top + shift(变化前快照),与同一个 effect 里那条 scrollHeight 差值口径同约定。
// 与本目录 check-mount-growth-anchor.mjs 互补:那条钉"路径在 + 位置用 offsetTop 不用 rect",
// 这条钉"基准不许是变化后的 scrollTop"。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../client/src/App.jsx'), 'utf8');

const start = src.indexOf('const mountLenRef');
const end = src.indexOf('}, [mountFromResolved, writeProgrammaticScroll]);', start);
assert.ok(start > 0 && end > start, '补偿 effect 的结构变了(mountLenRef / 收尾没找到)');
const block = src.slice(start, end);

const anchorBranch = block.slice(block.indexOf('if (prev.node)'), block.indexOf('const delta = el.scrollHeight'));
assert.ok(anchorBranch.length > 0, '锚定补偿分支(prev.node)不见了');

assert.ok(anchorBranch.includes('prev.top + shift'),
  '锚定补偿的基准必须是**变化前**快照 prev.top + shift —— 提交后的 scrollTop 已经被原生 scroll anchoring 改过,再加一遍位移量就是叠加');
assert.ok(!/scrollTop:\s*el\.scrollTop\s*\+/.test(anchorBranch),
  '锚定补偿的基准不许取提交后的 el.scrollTop(与原生 scroll anchoring 叠加,朝反方向多滚一整个被卸行高)');

const cap = src.match(/mountCompRef\.current = \{[^}]*nodeTop: anchor\.offsetTop[^}]*\};/);
assert.ok(cap, '锚点分支的几何快照不见了(mountCompRef 记 node/nodeTop 那处)');
assert.ok(/top: el\.scrollTop/.test(cap[0]), '快照必须带上变化前的 scrollTop —— prev.top 就是上面那条基准');

console.log('check-mount-anchor-absolute-base: all passed');
