// F 组:openai 协议代理发往上游的请求(INTERFACE Y.3.2 前半)。
// 代理 = 被测工作树里的 openai 协议代理,run.sh 在测试端口单独起了一份(上游 = 假接口的 proxy 车道)。
// "改动前" = fixtures/proxy-baseline.json(在未改动的工作树上录的原文)。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { setLane, laneRequests, clearLane } from './helpers/api.mjs';
import { suitePath } from './helpers/fixtures.mjs';
import { STREAM_CASES, NOSTREAM_BASE, NOSTREAM_TOOLS } from './helpers/proxy-cases.mjs';

const PROXY = process.env.R151A_PROXY_BASE || 'http://127.0.0.1:0';
const BASE = JSON.parse(fs.readFileSync(suitePath('fixtures', 'proxy-baseline.json'), 'utf8')).cases;
const LANE = 'proxy';

test.beforeEach(() => { setLane(LANE, {}); clearLane(LANE); });

/** 经代理发一次,返回上游收到的那一个请求 { path, body, raw }。 */
async function viaProxy(input) {
  clearLane(LANE);
  const r = await fetch(`${PROXY}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'dummy-r151', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(input), signal: AbortSignal.timeout(15_000),
  });
  await r.text();
  const reqs = laneRequests(LANE);
  expect(reqs.length, '上游应恰好收到 1 个请求').toBe(1);
  return reqs[0];
}
const without = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

test.describe('F 流式输入:与改动前逐字节相同', () => {
  for (const [name, input] of Object.entries(STREAM_CASES)) {
    test(`F1 ${name}:上游请求体原文与改动前基线逐字节相同`, async () => {
      const got = await viaProxy(input);
      expect(got.raw).toBe(BASE[name].raw);
      expect(got.path).toBe(BASE[name].path);
    });
  }

  test('F1b 流式输入:输出 stream:true 且 stream_options = {include_usage:true}', async () => {
    const got = await viaProxy(STREAM_CASES['stream-basic']);
    expect(got.body.stream).toBe(true);
    expect(got.body.stream_options).toEqual({ include_usage: true });
  });

  test('F4 流式输入带 stop_sequences:输出里没有 stop 键', async () => {
    const got = await viaProxy(STREAM_CASES['stream-with-stop']);
    expect(got.body).not.toHaveProperty('stop');
  });
});

test.describe('F 非流式输入:stream:false、没有 stream_options', () => {
  for (const [label, patch] of [
    ['stream 缺失', {}],
    ['stream:false', { stream: false }],
    ['stream:"true"(字符串)', { stream: 'true' }],
    ['stream:1', { stream: 1 }],
    ['stream:null', { stream: null }],
  ]) {
    test(`F2 ${label} → 输出 stream:false 且没有 stream_options 键`, async () => {
      const input = { ...NOSTREAM_BASE, ...patch };
      if (label === 'stream 缺失') delete input.stream;
      const got = await viaProxy(input);
      expect(got.body.stream).toBe(false);
      expect(got.body).not.toHaveProperty('stream_options');
    });
  }

  test('F5 非流式(审核形态)的其余键与改动前逐项相同(只允许 stream / stream_options / stop 不同)', async () => {
    const got = await viaProxy(NOSTREAM_BASE);
    const before = JSON.parse(BASE['nostream-base'].raw);
    expect(without(got.body, ['stream', 'stream_options', 'stop'])).toEqual(without(before, ['stream', 'stream_options', 'stop']));
  });

  test('F5b 非流式带工具的请求:其余键与改动前逐项相同', async () => {
    const got = await viaProxy(NOSTREAM_TOOLS);
    const before = JSON.parse(BASE['nostream-tools'].raw);
    expect(without(got.body, ['stream', 'stream_options', 'stop'])).toEqual(without(before, ['stream', 'stream_options', 'stop']));
  });

  test('F6 非流式请求仍发往同一个上游路径', async () => {
    const got = await viaProxy(NOSTREAM_BASE);
    expect(got.path).toBe(BASE['nostream-base'].path);
  });
});

test.describe('F 非流式输入:stop_sequences → stop', () => {
  const cases = [
    ['单个 ["</block>"]', ['</block>'], ['</block>']],
    ['夹着空串、超过 4 个:取非空的前 4 个、保持顺序', ['', 'a', 'b', '', 'c', 'd', 'e'], ['a', 'b', 'c', 'd']],
    ['非字符串项被跳过', [1, null, 'x', {}, ['y']], ['x']],
    ['中文与表情', ['</块>', '😀'], ['</块>', '😀']],
    ['只有空白的串也算非空', [' '], [' ']],
  ];
  for (const [label, seqs, want] of cases) {
    test(`F3 ${label} → stop = ${JSON.stringify(want)}`, async () => {
      const got = await viaProxy({ ...NOSTREAM_BASE, stop_sequences: seqs });
      expect(got.body.stop).toEqual(want);
    });
  }
  const none = [
    ['缺失', undefined],
    ['空数组', []],
    ['不是数组(字符串)', '</block>'],
    ['全是空串', ['', '']],
    ['没有任何非空字符串', [0, null, false]],
  ];
  for (const [label, seqs] of none) {
    test(`F3n stop_sequences ${label} → 输出里没有 stop 键`, async () => {
      const input = { ...NOSTREAM_BASE };
      if (seqs === undefined) delete input.stop_sequences; else input.stop_sequences = seqs;
      const got = await viaProxy(input);
      expect(got.body).not.toHaveProperty('stop');
    });
  }
});
