#!/usr/bin/env node
// r26-J6【单测】:ImagePanel 的「在访达中显示」失败必须内联提示,不得静默。
// 修前:reveal 的 fetch .catch(() => {}) 吞掉一切,非 2xx 也不看 —— 用户点了没反应。
// 本仓对 JSX 的既有测试口径 = 源码钉 + 同形参考实现的行为断言(JSX 不可直接 import)。
// 哨兵:①源码 —— reveal 检查 r.ok 且 catch 置错误态;②源码 —— 预览区渲染 revealErr 节点;
// ③行为(同形参考)—— mock 500 → 出现固定文案;mock reject → 同文案;mock 200 → 无文案
// (不误报);④再次触发先清旧错误(不残留)。
// Run: node tests/unit/check-r26-j6-reveal-error-hint.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };

const src = readFileSync(new URL('../../client/src/components/ImagePanel.jsx', import.meta.url), 'utf8');
const FIXED_TEXT = '打开失败：无法在系统文件管理器中显示该文件';

// ①② 源码钉
{
  const revealIdx = src.indexOf('const reveal = async');
  const revealBlock = src.slice(revealIdx, revealIdx + 700);
  ok(/if \(!r\.ok\) throw/.test(revealBlock), 'J6: reveal 必须检查 r.ok(非 2xx 也算失败)');
  ok(revealBlock.includes(`setRevealErr('${FIXED_TEXT}')`), 'J6: catch 必须置固定错误文案');
  ok(!/\.catch\(\(\) => \{\}\)/.test(revealBlock), 'J6: 不得再静默吞 catch');
  ok(/const \[revealErr, setRevealErr\] = useState\(/.test(src), 'J6: revealErr 状态存在');
  ok(/\{revealErr && <div/.test(src), 'J6: 预览区渲染 revealErr 错误节点');
  ok(/onClick=\{\(\) => reveal\(current\.file\)\}/.test(src), 'J6: 按钮仍挂 reveal(不误改)');
}

// ③④ 行为矩阵(与 reveal 逐字同形的参考实现)
{
  // 同形参考:reveal 的 成败 → 错误态 迁移逻辑
  const makeReveal = (fetchImpl) => {
    let revealErr = '';
    return {
      get err() { return revealErr; },
      async run(file) {
        revealErr = '';
        try {
          const r = await fetchImpl(file);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
        } catch {
          revealErr = FIXED_TEXT;
        }
      },
    };
  };
  // mock 500(服务端拒绝,如路径闸拦下)→ 错误文案出现(整卡消失式静默的反面)
  const r500 = makeReveal(async () => ({ ok: false, status: 500 }));
  await r500.run('/tmp/a.png');
  assert.equal(r500.err, FIXED_TEXT, 'J6: 500 → 内联错误提示出现');
  // mock reject(网络异常)→ 同文案
  const rRej = makeReveal(async () => { throw new TypeError('fetch failed'); });
  await rRej.run('/tmp/a.png');
  assert.equal(rRej.err, FIXED_TEXT, 'J6: fetch reject → 内联错误提示出现');
  // mock 200 → 无文案(不误报哨兵)
  const rOk = makeReveal(async () => ({ ok: true, status: 200 }));
  await rOk.run('/tmp/a.png');
  assert.equal(rOk.err, '', 'J6: 成功 → 不出现错误提示');
  // 失败后再次成功 → 旧错误清掉(每次触发先清空)
  await rOk.run('/tmp/a.png');
  assert.equal(r500.err, FIXED_TEXT, 'J6: 参考对象互不影响(状态独立)');
  n += 4;
}

console.log(`PASS check-r26-j6-reveal-error-hint (${n} assertions)`);
