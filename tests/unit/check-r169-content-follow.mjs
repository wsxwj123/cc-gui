#!/usr/bin/env node
// r169 修法 2:按内容高度变化跟随。消息列表的内容盒 / 容器高度一变:不在看历史就吸底;
// 「回到底部」按钮按真实离底距离显隐(在看历史且离底 ≥ 120 → 显示)。
// 运行:node tests/unit/check-r169-content-follow.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETURN_TO_BOTTOM_MIN_PX, setIfChanged, shouldShowReturnToBottom } from '../../client/src/utils/scroll.js';

// ── 按钮显隐规则 ─────────────────────────────────────────────────────────────
assert.equal(RETURN_TO_BOTTOM_MIN_PX, 120);
assert.equal(shouldShowReturnToBottom({ reading: true, distFromBottom: 120 }), true, '在看历史、离底 120 → 显示');
assert.equal(shouldShowReturnToBottom({ reading: true, distFromBottom: 1498 }), true);
assert.equal(shouldShowReturnToBottom({ reading: true, distFromBottom: 80 }), false,
  '只翻上去一点点(离底 < 120)先不显示,等回复把距离拉大再显示');
assert.equal(shouldShowReturnToBottom({ reading: false, distFromBottom: 645 }), false,
  '跟随中(内容刚追加、还没吸底的一瞬)不显示');
assert.equal(shouldShowReturnToBottom({ reading: true, distFromBottom: NaN }), false, '量不到距离不显示');

// ── 源码守卫 ─────────────────────────────────────────────────────────────────
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');

// followLayoutChange:不在看历史才吸底(程序滚动 transaction,kind=follow),并按真实距离重算按钮
const fStart = app.indexOf('const followLayoutChange = useCallback((node) => {');
assert.ok(fStart > 0, '必须有按真实几何重算跟随 / 按钮的 followLayoutChange');
const follow = app.slice(fStart, app.indexOf('}, [writeProgrammaticScroll]);', fStart));
assert.ok(/if \(!node\?\.isConnected \|\| !\(node\.clientHeight > 0\)\) return;/.test(follow),
  '脱离文档 / 隐藏窗格(高度 0)量不到几何,必须跳过');
assert.ok(/if \(!userScrolledAwayRef\.current\) \{[\s\S]{0,200}writeProgrammaticScroll\(node, target, 'follow'\)/.test(follow),
  '只在不看历史时吸底,且必须走程序滚动 transaction(否则被 handleScroll 当成用户手势)');
assert.ok(/Math\.abs\(target - node\.scrollTop\) >= 1/.test(follow), '已在底部就不写,免得无谓的滚动事件');
assert.ok(/setAutoScroll\(!shouldShowReturnToBottom\(\{[\s\S]{0,80}reading: userScrolledAwayRef\.current/.test(follow),
  '按钮显隐必须按「在看历史且离底 ≥ 120」重算');
assert.ok(!/el\.scrollTop\s*=/.test(follow) && !/node\.scrollTop\s*=[^=]/.test(follow), '不得绕过 transaction 直接写 scrollTop');

// setContainerRef:容器 RO 也走同一重算;内容盒 = 直接子元素逐个观察 + MutationObserver 跟上增删
const sStart = app.indexOf('const setContainerRef = useCallback((node) => {');
const setRef = app.slice(sStart, app.indexOf('}, [writeProgrammaticScroll, followLayoutChange]);', sStart));
assert.ok(setRef.length > 0 && sStart > fStart, 'setContainerRef 依赖 followLayoutChange,必须在它之后定义');
const cleanupIdx = setRef.indexOf('scrollContentObsRef.current(); scrollContentObsRef.current = null;');
assert.ok(cleanupIdx > 0 && cleanupIdx < setRef.indexOf("if (!node || typeof ResizeObserver === 'undefined') return;"),
  '容器重挂载 / 卸载时必须先拆掉旧的内容观察(在早退之前)');
assert.ok(/scrollMaxRef\.current = Math\.max\(0, node\.scrollHeight - node\.clientHeight\);\s*\n\s*followLayoutChange\(node\);/.test(setRef),
  '容器高度变化(视口拉高、输入框伸缩)也要按真实几何重算');
assert.ok(/const contentRo = new ResizeObserver\(\(\) => followLayoutChange\(node\)\);/.test(setRef), '内容盒高度观察');
assert.ok(/for \(const child of node\.children\) contentRo\.observe\(child\);/.test(setRef), '逐个观察直接子元素');
assert.ok(/new MutationObserver/.test(setRef) && /childMo\?\.observe\(node, \{ childList: true \}\)/.test(setRef),
  '子元素增删要跟上(只看直接子元素,不看子树)');
assert.ok(/contentRo\.observe\(added\)/.test(setRef) && /contentRo\.unobserve\(removed\)/.test(setRef));
assert.ok(/scrollContentObsRef\.current = \(\) => \{ contentRo\.disconnect\(\); childMo\?\.disconnect\(\); \};/.test(setRef),
  '拆除函数必须同时断开两个观察器');

// handleScroll 与观察器同一按钮规则;按状态触发的吸底 effect 保留(同一目标,不互相拉扯)
const hs = app.slice(app.indexOf('const handleScroll = () => {'), app.indexOf('// Restore the saved scroll position'));
assert.ok(/setAutoScroll\(!shouldShowReturnToBottom\(\{ reading: userScrolledAwayRef\.current, distFromBottom \}\)\)/.test(hs),
  'handleScroll 的按钮规则必须与观察器一致');
assert.ok(!/setAutoScroll\(distFromBottom < 120\)/.test(app), '旧的纯距离按钮规则必须已替换');
assert.ok(/if \(userScrolledAwayRef\.current\) return;  \/\/ AZ3:用户在看历史时不抢滚/.test(app), '按状态触发的吸底 effect 保留');

// ── 发版前补丁 1:按钮显隐只在值变了才设(观察器几乎每帧回调,同值设置会让大组件白白多渲染) ──────
{
  const calls = [];
  const lastRef = { current: true };            // 与 useState(true) 的初值一致
  const setter = (v) => calls.push(v);
  // 跟随中:观察器每帧都算出"不显示"(true)→ 一次都不设
  for (let i = 0; i < 60; i++) assert.equal(setIfChanged(lastRef, setter, true), false);
  assert.deepEqual(calls, [], '跟随期间同值不得反复设置');
  // 用户上翻、离底拉大 → 设一次"显示";之后每帧同值不再设
  assert.equal(setIfChanged(lastRef, setter, false), true);
  for (let i = 0; i < 30; i++) setIfChanged(lastRef, setter, false);
  assert.deepEqual(calls, [false], '值变了才设,且只设一次');
  // 点「回到底部」→ 设回"不显示"
  assert.equal(setIfChanged(lastRef, setter, true), true);
  assert.deepEqual(calls, [false, true]);
  assert.equal(lastRef.current, true, 'ref 记的是最后一次设的值');
}
assert.ok(/const \[autoScroll, setAutoScrollState\] = useState\(true\);/.test(app), 'React 原始 setter 改名,只留给守卫用');
assert.ok(/const autoScrollSetRef = useRef\(true\);/.test(app), 'ref 初值与 useState 初值一致');
assert.ok(/const setAutoScroll = useCallback\(\(next\) => \{ setIfChanged\(autoScrollSetRef, setAutoScrollState, next\); \}, \[\]\);/.test(app),
  '所有 setAutoScroll 调用(handleScroll、观察器、按钮、恢复、发送)都经过同一个守卫');
assert.equal((app.match(/setAutoScrollState\(/g) || []).length, 0, '不得绕过守卫直接调 React 原始 setter(否则 ref 与真实状态脱节)');
assert.equal((app.match(/setAutoScrollState\b/g) || []).length, 2, '原始 setter 只出现在声明与守卫两处');

console.log('✓ check-r169-content-follow: 内容 / 容器高度变化按真实几何跟随,按钮按真实离底显隐');
