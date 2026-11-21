// r196 T2:routing.resolveHistModel 拆成 lastRealModelMsg(找最后一条真实模型消息,不门控)+ gateHistModel(providerEpoch 门控),
// 原函数是二者的组合。这里核对:组合结果与拆分前的写法(从 cbeb0f5ef 逐行誊写)在一组输入上逐个相同;两个新函数各自的边界。
// node tests/unit/check-r196-hist-model-split.mjs
import assert from 'node:assert/strict';
import { resolveHistModel, lastRealModelMsg, gateHistModel } from '../../client/src/utils/routing.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

// 拆分前的 resolveHistModel(cbeb0f5ef,逐行誊写)
function oldResolveHistModel(messages, providerEpoch = 0, officialAnthropic = false) {
  const ms = messages || [];
  for (let i = ms.length - 1; i >= 0; i--) {
    if (!ms[i]?.model) continue;
    if (/^</.test(ms[i].model)) continue;
    if (providerEpoch && !officialAnthropic
      && (!ms[i].timestamp || Date.parse(ms[i].timestamp) <= providerEpoch)) return null;
    return ms[i].model;
  }
  return null;
}

const EPOCH = Date.parse('2026-11-01T00:00:00Z');
const HIST = [
  { model: 'claude-sonnet-4-6', timestamp: '2026-09-01T00:00:00Z' },
  { model: '<synthetic>', timestamp: '2026-11-02T00:00:00Z' },
  { text: 'no model' },
];
const LISTS = [
  HIST,
  [{ model: 'm-new', timestamp: '2026-11-05T00:00:00Z' }],
  [{ model: 'm-old', timestamp: '2026-10-05T00:00:00Z' }, { model: 'm-new', timestamp: '2026-11-05T00:00:00Z' }],
  [{ model: 'm-new', timestamp: '2026-11-05T00:00:00Z' }, { model: 'm-old', timestamp: '2026-10-05T00:00:00Z' }],
  [{ model: 'no-ts' }],
  [{ model: 'bad-ts', timestamp: 'not a date' }],
  [{ model: '<synthetic>' }],
  [null, undefined, {}],
  [],
  null,
  undefined,
];
for (const ms of LISTS) {
  for (const ep of [0, undefined, EPOCH]) {
    for (const off of [false, true, undefined]) {
      eq(resolveHistModel(ms, ep, off), oldResolveHistModel(ms, ep, off), `组合 = 拆分前:${JSON.stringify(ms)} / ${ep} / ${off}`);
    }
  }
}

eq(lastRealModelMsg(HIST), HIST[0], 'lastRealModelMsg:跳过没有模型与伪 id 的,回最后一条真实模型消息(原对象)');
eq(lastRealModelMsg(null), null, 'lastRealModelMsg:空输入 → null');
eq(lastRealModelMsg([{ model: '<synthetic>' }]), null, 'lastRealModelMsg:只有伪 id → null');
eq(lastRealModelMsg([{ model: 'm-old', timestamp: '2026-10-05T00:00:00Z' }]), { model: 'm-old', timestamp: '2026-10-05T00:00:00Z' },
  'lastRealModelMsg:不做 epoch 门控(切 provider 之前的也照样找出来)');
eq(gateHistModel(null, EPOCH, false), null, 'gateHistModel:没有消息 → null');
eq(gateHistModel({ model: '<synthetic>', timestamp: '2026-11-05T00:00:00Z' }, 0, true), null, 'gateHistModel:不放行伪 id');
eq(gateHistModel({ model: 'm', timestamp: '2026-10-01T00:00:00Z' }, EPOCH, false), null, 'gateHistModel:切 provider 之前的消息,非官方 → null');
eq(gateHistModel({ model: 'm', timestamp: '2026-10-01T00:00:00Z' }, EPOCH, true), 'm', 'gateHistModel:官方豁免 epoch 门控');
eq(gateHistModel({ model: 'm' }, EPOCH, false), null, 'gateHistModel:没有时间戳、非官方、有 epoch → null');
eq(gateHistModel({ model: 'm' }, 0, false), 'm', 'gateHistModel:没有 epoch → 放行');

console.log(`✓ check-r196-hist-model-split:${checks} 项断言全部通过`);
