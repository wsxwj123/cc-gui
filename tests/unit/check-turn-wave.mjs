#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { turnWaveWidth } from '../../client/src/utils/turnWave.js';

const scrubber = readFileSync(new URL('../../client/src/components/TurnScrubber.jsx', import.meta.url), 'utf8');

assert.equal(turnWaveWidth(0), 18, '指针中心线宽必须是 18px');
assert.equal(turnWaveWidth(48), 6, '48px 外必须回到 6px 静止宽度');
assert.equal(turnWaveWidth(96), 6, '48px 外线宽不能继续变化');
for (let distance = 1; distance <= 48; distance += 1) {
  assert.ok(turnWaveWidth(distance) <= turnWaveWidth(distance - 1), '线宽必须随距离单调不增');
  assert.ok(turnWaveWidth(distance - 1) - turnWaveWidth(distance) <= 0.5, '相邻 1px 采样变化不能超过 0.5px');
}
assert.doesNotMatch(scrubber, /rounded-full/, '波形不能保留胶囊圆点外观');
assert.match(scrubber, /onPointerMove=\{moveBar\}/, '波形必须按实际 pointer Y 连续响应');
assert.match(scrubber, /requestAnimationFrame\(\(\) =>/, 'pointer 更新必须以 rAF 节流');
assert.match(scrubber, /Math\.abs\(next - committedPointerY\.current\) < 1/, '不足 1px 的 pointer 变化不能提交状态');
assert.match(scrubber, /position: 'absolute', top: `\$\{n \* 100\}%`, right: 0/, '所有线必须固定右端');

console.log('PASS check-turn-wave');
