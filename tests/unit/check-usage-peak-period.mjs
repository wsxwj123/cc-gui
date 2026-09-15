#!/usr/bin/env node
// 用量面板「当前计价时段」(峰/谷)行 —— BRIEF 2026-09-14 的 P1~P5。
//
// 验法:真组件渲染(esbuild 打包 UsagePanel.jsx + react-dom/server;JSX 进不了 node 的 loader)。
// 【时刻打桩】组件收 nowMs(默认 Date.now()),本测试一律传**写死的 epoch 毫秒** ——
//   峰态与谷态都在同一秒里渲染出来,不靠"跑到下午三点才能验谷态"的真实时钟撞运气。
// 【口径的独立对证】文案说"金额按每条记录自身时间戳分档计价后相加、不按当前时段算",
//   这句话由 aggregateCost 直接对证:同一批 token,把全局时钟分别拨到峰/谷,金额必须一模一样,
//   且等于(峰桶按峰价 + 谷桶按谷价)的手算值。
// 无 client/node_modules(裸检出)时明确跳过渲染组并打印,不静默转绿。
// Run: node tests/unit/check-usage-peak-period.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const clientDir = join(root, 'client');
const requireCjs = createRequire(import.meta.url);

// 计价模块在模块顶层读 localStorage,裸 node 下没有 window —— 与 check-subagent-cost-bg-card 同款桩。
{
  const mem = new Map();
  globalThis.localStorage = {
    get length() { return mem.size; },
    key: (index) => [...mem.keys()][index] ?? null,
    getItem: (key) => (mem.has(key) ? mem.get(key) : null),
    setItem: (key, value) => { mem.set(key, String(value)); },
    removeItem: (key) => { mem.delete(key); },
  };
}

const fixture = JSON.parse(readFileSync(join(root, 'tests/unit/fixtures/pricing-catalog-fixture.json'), 'utf8'));
const { setPricingCatalog } = await import('../../client/src/utils/pricingCatalog.js');
const { hasPeriodQuote, aggregateCost } = await import('../../client/src/utils/pricing.js');
const { periodFor, PERIOD_SCHEDULES, DEFAULT_SCHEDULE_KEY } = await import('../../server/utils/pricing-rules.js');

setPricingCatalog(fixture);

// 固定时刻表(全部是 epoch 毫秒;注释给的是北京时间)。峰谷边界半开:09:00 进峰、12:00 出峰。
const AT = {
  fri0859: Date.parse('2026-09-11T00:59:00.000Z'),   // 周五 08:59
  fri0900: Date.parse('2026-09-11T01:00:00.000Z'),   // 周五 09:00
  fri1159: Date.parse('2026-09-11T03:59:00.000Z'),   // 周五 11:59
  fri1200: Date.parse('2026-09-11T04:00:00.000Z'),   // 周五 12:00
  fri1359: Date.parse('2026-09-11T05:59:00.000Z'),   // 周五 13:59
  fri1400: Date.parse('2026-09-11T06:00:00.000Z'),   // 周五 14:00
  fri1759: Date.parse('2026-09-11T09:59:00.000Z'),   // 周五 17:59
  fri1800: Date.parse('2026-09-11T10:00:00.000Z'),   // 周五 18:00
  sat1000: Date.parse('2026-09-12T02:00:00.000Z'),   // 周六 10:00
  sun1000: Date.parse('2026-09-13T02:00:00.000Z'),   // 周日 10:00
  mon0900: Date.parse('2026-09-14T01:00:00.000Z'),   // 周一 09:00
};

const WITH_PERIOD = [{ model: 'deepseek-flash', input: 1000, output: 200 }];            // 夹具里有峰谷价
const MIXED = [{ model: 'claude-opus-5' }, { model: 'deepseek-flash' }];                // 一个有一个没有
const NO_PERIOD = [{ model: 'claude-opus-5', input: 1000 }, { model: 'glm-5.3-flash' }]; // 都没峰谷价

// ── 0. 判据本身与计价同源(面板不会比计价多认/少认一个模型) ────────────────
{
  assert.equal(hasPeriodQuote('deepseek-flash'), true, 'deepseek-flash 有分时段报价');
  assert.equal(hasPeriodQuote('claude-opus-5'), false, 'claude-opus-5 没有分时段报价');
  assert.equal(hasPeriodQuote(undefined), false, '字段缺失不抛,也不当成分时段模型');
  assert.equal(hasPeriodQuote(''), false, '空 model 同上');
}

function loadRenderer() {
  let esbuild;
  try {
    esbuild = requireCjs(join(clientDir, 'node_modules/esbuild'));
    requireCjs(join(clientDir, 'node_modules/react-dom/server'));
  } catch {
    return null; // 裸检出:没装 client 依赖
  }
  const work = mkdtempSync(join(tmpdir(), 'usage-peak-period-'));
  const entry = join(work, 'entry.jsx');
  writeFileSync(entry, [
    "import React from 'react';",
    "import { renderToStaticMarkup } from 'react-dom/server';",
    `import { UsagePeriodNote } from ${JSON.stringify(join(clientDir, 'src/components/UsagePanel.jsx'))};`,
    `import { setPricingCatalog } from ${JSON.stringify(join(clientDir, 'src/utils/pricingCatalog.js'))};`,
    // 打包产物自带一份 pricing 模块实例:价目表要在**包内**喂,外面喂的是另一个实例。
    'export function seed(catalog) { setPricingCatalog(catalog); }',
    'export function render({ byModel, nowMs }) {',
    '  return renderToStaticMarkup(React.createElement(UsagePeriodNote, { byModel, nowMs }));',
    '}',
  ].join('\n'));
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(work, 'bundle.cjs'),
    jsx: 'automatic',
    nodePaths: [join(clientDir, 'node_modules')],
    loader: { '.js': 'jsx', '.css': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
  });
  const { render, seed } = requireCjs(join(work, 'bundle.cjs'));
  seed(fixture);
  return { render, cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

/** 渲染结果 → 可见文本(去掉标签与 react-dom/server 在相邻文本节点间插的 `<!-- -->`)。 */
const textOf = (html) => html.replace(/<[^>]*>/g, '');

// 面板接线哨兵:这一行必须真被 UsagePanel 用上(不是死代码),且判据不是按 provider 名字白名单。
{
  const src = readFileSync(join(root, 'client/src/components/UsagePanel.jsx'), 'utf8');
  assert.ok(src.includes('<UsagePeriodNote byModel={stats.byModel} />'),
    '用量面板必须渲染 UsagePeriodNote(传 stats.byModel)');
  assert.equal(src.split('<UsagePeriodNote').length - 1, 1, '只挂一处');
  const noteSrc = src.slice(src.indexOf('export function UsagePeriodNote'), src.indexOf('export function UsagePanel'));
  assert.ok(noteSrc.includes('hasPeriodQuote'), '显示判据用 hasPeriodQuote(与计价同一判据)');
  assert.ok(noteSrc.includes('periodFor('), '档位判定用 periodFor,不自写一套');
  assert.ok(!/deepseek|claude|gpt/i.test(noteSrc), '不许按 provider/模型名字白名单判');
  assert.ok(!/setInterval|setTimeout/.test(noteSrc), '不新开定时器(刷新跟着面板既有的轮询与广播)');
}

const renderer = loadRenderer();
if (!renderer) {
  console.log('! 跳过 真组件渲染:未找到 client/node_modules/esbuild 或 react-dom(裸检出环境)');
} else {
  const { render, cleanup } = renderer;
  try {
    // ── P1:有峰谷价 → 出这一行,档位与 periodFor(同一时刻) 逐点一致 ─────────
    for (const [label, ms] of Object.entries(AT)) {
      const html = render({ byModel: WITH_PERIOD, nowMs: ms });
      assert.notEqual(html, '', `${label}:有分时段模型时必须出这一行`);
      const text = textOf(html);
      const wantKey = periodFor(ms).key;
      const gotKey = text.includes('：高峰') ? 'peak' : (text.includes('：空闲') ? 'off-peak' : '?');
      assert.equal(gotKey, wantKey, `${label}:档位必须与 periodFor 一致(期望 ${wantKey},渲染 ${gotKey})`);
      assert.ok(text.includes('北京时间') && text.includes('UTC+08:00'),
        `${label}:判定时区必须写出来(北京时间 +08:00,可能与本机时区不同)`);
      assert.ok(text.includes('周一至周五 09:00–12:00、14:00–18:00'),
        `${label}:高峰时间窗来自时段表(周一至周五 09:00–12:00、14:00–18:00)`);
    }

    // 混合列表:只要有一个模型带峰谷价就显示(P1 的"至少一个")
    assert.notEqual(render({ byModel: MIXED, nowMs: AT.fri0900 }), '', '列表里有一个分时段模型就要出这一行');

    // ── P5:峰 / 谷两态都能渲染(同一秒内用固定时刻打桩,不靠真实时钟) ──────
    const peakHtml = render({ byModel: WITH_PERIOD, nowMs: AT.fri0900 });
    const offHtml = render({ byModel: WITH_PERIOD, nowMs: AT.sat1000 });
    assert.ok(textOf(peakHtml).includes('：高峰'), 'P5 峰态:周五 09:00 渲染「高峰」');
    assert.ok(textOf(offHtml).includes('：空闲'), 'P5 谷态:周六 10:00 渲染「空闲」');
    assert.notEqual(peakHtml, offHtml, '两态文案必须不同(同一个组件同一秒渲染出来的)');

    // ── P2:没有峰谷价 → 整行不出现 ────────────────────────────────────────
    assert.equal(render({ byModel: NO_PERIOD, nowMs: AT.fri0900 }), '', 'P2:没有分时段报价的模型 → 不出这一行');
    assert.equal(render({ byModel: [], nowMs: AT.fri0900 }), '', 'P2:列表为空 → 不出这一行');
    assert.equal(render({ byModel: undefined, nowMs: AT.fri0900 }), '', 'P2:byModel 缺失 → 不出这一行(不抛)');

    // ── P4:periodFor 判不出(非法时刻)→ 不显示档位、不显示「未知」 ──────────
    // 注意 undefined 不在这一列:它是"没给 nowMs",走默认(本机此刻),不是"时刻非法"。
    for (const bad of [NaN, '不是时间', null, {}]) {
      const html = render({ byModel: WITH_PERIOD, nowMs: bad });
      assert.equal(html, '', `P4:时刻 ${String(bad)} 判不出 → 整行不显示`);
    }

    // ── P3:金额口径说明与 aggregateCost 的实际行为逐字对得上 ────────────────
    const p3 = textOf(render({ byModel: WITH_PERIOD, nowMs: AT.sat1000 }));
    assert.ok(p3.includes('分档计价后相加'), 'P3:必须写明"分档计价后相加"');
    const idx = p3.indexOf('按当前时段');
    assert.ok(idx > 0, 'P3:必须提到"按当前时段"这件事本身(否定式)');
    assert.equal(p3[idx - 1], '不', 'P3:只允许"不按当前时段计算"这一种说法');
    assert.equal(p3.indexOf('按当前时段', idx + 1), -1, 'P3:同一句不得出现第二次');
    assert.ok(!/按当前档位|按此刻|随当前档位变/.test(p3), 'P3:不得暗示金额随当前档位变');

    // 对证:同一批分桶 token,全局时钟拨到峰 / 拨到谷,金额必须一模一样。
    const tokens = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 2,
      byPeriod: {
        peak: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 },
        offPeak: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 },
        unknown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
      },
    };
    const realNow = Date.now;
    Date.now = () => AT.fri0900;
    const atPeak = aggregateCost('deepseek-flash', tokens, null);
    Date.now = () => AT.sat1000;
    const atOff = aggregateCost('deepseek-flash', tokens, null);
    Date.now = realNow;
    assert.equal(atOff.usd, atPeak.usd, 'P3:金额是分档各自计价后相加,与"此刻"无关(拨钟不变)');
    // 手算:夹具里 deepseek-flash 高峰 ¥2/M、空闲 ¥1/M,各 1000 token → 0.002 + 0.001
    assert.ok(Math.abs(atPeak.usd - 0.003) < 1e-9, `P3:金额=峰桶按峰价+谷桶按谷价 的手算值(实测 ${atPeak.usd})`);

    // 相邻文案里的时段表口径没被动过:periodFor 仍然只认这一个 schedule key。
    assert.equal(DEFAULT_SCHEDULE_KEY, 'deepseek-cn-peak', '时段表 key 未变');
    assert.deepEqual(PERIOD_SCHEDULES[DEFAULT_SCHEDULE_KEY].weekdays, [1, 2, 3, 4, 5], '高峰只在周一至周五');

    console.log('✓ 用量面板当前计价时段:峰/谷两态(固定时刻打桩)+ 无峰谷价不显示 + 判不出不猜 + 金额口径与 aggregateCost 对证');
  } finally {
    cleanup();
  }
}
