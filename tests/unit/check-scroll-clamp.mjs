#!/usr/bin/env node
// 批B B4(#4):关右侧面板后会话区空白、上滑才找得回内容。
// 定位实测(vite dev :6702 + 长会话 249 条 + 开/关监控面板):
//   开面板 scrollTop 3248→3549、关回来 3549→3248,scrollHeight 6689↔7227。
//   即容器宽度一变,消息重新折行、全文总高变化几百像素;Chrome 靠 scroll anchoring
//   自己把 scrollTop 补偿回去(CSS.supports('overflow-anchor','auto') === true),
//   WKWebView(Tauri 的 webview)不实现该特性 → scrollTop 原地不动、内容整体位移,
//   视口就可能停在两条消息之间的空白段。故自己按比例补一次锚定。
// 纯函数,真 import。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { clampScrollTop, resizeScrollTop } from '../../client/src/utils/scroll.js';

// ── clampScrollTop ────────────────────────────────────────────────
assert.equal(clampScrollTop({ scrollTop: 9999, scrollHeight: 6689, clientHeight: 193 }), 6496,
  '超界必须钳到底(内容变矮后 scrollTop 还停在旧值 = 视口落在内容之外)');
assert.equal(clampScrollTop({ scrollTop: 3248, scrollHeight: 6689, clientHeight: 193 }), 3248,
  '未超界不得改动用户的阅读位置');
assert.equal(clampScrollTop({ scrollTop: 100, scrollHeight: 6689, clientHeight: 193, stickToBottom: true }), 6496,
  'stickToBottom 直接吸底');
assert.equal(clampScrollTop({ scrollTop: 50, scrollHeight: 120, clientHeight: 400 }), 0,
  '内容比视口短 → 上限 0');
assert.equal(clampScrollTop({ scrollTop: -20, scrollHeight: 6689, clientHeight: 193 }), 0, '负值钳到 0');

// ── resizeScrollTop:宽度变化后的等比还原 ──────────────────────────
{
  // 实测数值:关面板 sh 7227→6689(ch 193)。开面板时停在 3549(约 50.4%)。
  const next = resizeScrollTop({ prevTop: 3549, prevMax: 7034, scrollHeight: 6689, clientHeight: 193 });
  assert.ok(Math.abs(next - 3248) <= 40,
    `等比还原应落在 Chrome 的 anchoring 结果 3248 附近(实得 ${next});偏差 >40px 说明公式错了`);
  // 反向:开面板
  const back = resizeScrollTop({ prevTop: 3248, prevMax: 6496, scrollHeight: 7227, clientHeight: 193 });
  assert.ok(Math.abs(back - 3549) <= 40, `反向还原同样要贴近 3549(实得 ${back})`);
}
// 顶部/底部是不动点:不能因为"等比"把贴顶的人推下去、把贴底的人拉上来
assert.equal(resizeScrollTop({ prevTop: 0, prevMax: 6496, scrollHeight: 7227, clientHeight: 193 }), 0,
  '贴顶必须还是贴顶');
assert.equal(resizeScrollTop({ prevTop: 6496, prevMax: 6496, scrollHeight: 7227, clientHeight: 193 }), 7034,
  '贴底必须还是贴底');
// stickToBottom(用户没在看历史)压过一切 → 与吸底 effect 同一目标,两者不会互相拉扯
assert.equal(resizeScrollTop({ prevTop: 10, prevMax: 6496, scrollHeight: 7227, clientHeight: 193, stickToBottom: true }), 7034);
// 变化前不可滚动(短会话)→ 没有比例可言,退回纯钳位,绝不放大成 NaN/Infinity
{
  const v = resizeScrollTop({ prevTop: 0, prevMax: 0, scrollHeight: 7227, clientHeight: 193 });
  assert.equal(v, 0);
  assert.ok(Number.isFinite(v));
}
// 变化后不可滚动 → 0
assert.equal(resizeScrollTop({ prevTop: 3248, prevMax: 6496, scrollHeight: 120, clientHeight: 400 }), 0);
// 脏输入不得产出 NaN(NaN 写进 scrollTop 会被当 0 = 直接跳到顶)
for (const bad of [{}, { prevTop: NaN, prevMax: 100, scrollHeight: 500, clientHeight: 100 }]) {
  const v = resizeScrollTop(bad);
  assert.ok(Number.isFinite(v), `脏输入必须回落成有限值,实得 ${v}`);
}

// ── 源码守卫:effect 必须只认宽度、必须打程序滚动标记 ─────────────────
{
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const src = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
  const i = src.indexOf('const ro = new ResizeObserver(');
  assert.ok(i > 0, 'SessionDetail 必须给滚动容器挂 ResizeObserver');
  const seg = src.slice(i, i + 1600);
  assert.ok(/if \(width !== lastWidth\)/.test(seg),
    '只在宽度变化时动作 —— 高度变化是输入框长高,归既有吸底 effect,插手会打架');
  assert.ok(/stickToBottom: !userScrolledAwayRef\.current/.test(seg),
    '用户没在看历史时必须吸底,与吸底 effect 同一目标');
  assert.ok(/programmaticScrollRef\.current = true/.test(seg),
    '写 scrollTop 前必须打程序滚动标记,否则被 handleScroll 当成用户手势');
  assert.ok(/Math\.abs\(next - el\.scrollTop\) >= 1/.test(seg),
    '差值不足 1px 不写:否则标记被置真却等不到回弹事件,下一次真实滚动会被吞掉');
  assert.ok(/ro\.disconnect\(\)/.test(seg), '必须在 cleanup 里 disconnect');
  // 基准快照要在 handleScroll 的程序滚动早退【之前】刷新,否则用过期基准算位置
  const hs = src.slice(src.indexOf('const handleScroll = () => {'), src.indexOf('// Restore the saved scroll position'));
  assert.ok(hs.indexOf('scrollGeomRef.current = {') < hs.indexOf('if (programmaticScrollRef.current)'),
    'scrollGeomRef 必须在程序滚动早退之前刷新');
}

console.log('✓ check-scroll-clamp: 钳位 + 宽度变化等比还原 + effect 守卫全过');
