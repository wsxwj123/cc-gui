#!/usr/bin/env node
// A 项(2026-09-11)后台子代理的花费只在监控面板显示 —— 对话流那张 Task 卡片不渲染金额。
// 用户需求原文:「如果是后台子代理就显示在监控按钮页面下对应的子代理上,如果是前台代理就在前台和后台
// 都显示」;落字口径见 .devflow/INTERFACE-20260911-pricing.md §10.3 / §10.6 #15。
//
// 判定依据 = 这次工具调用自己的 `input.run_in_background`(jsonl 的 tool_use.input 原样透传;
// 不去猜 tool_result 的 isAsync)—— 与验收用例 PA-515 的夹具自证同一字段。
//
// 验法:真组件渲染(esbuild 打包 TaskCard.jsx + react-dom/server;JSX 进不了 node 的 loader)。
//   · 后台(run_in_background: true)→ 卡片里一个金额元素都没有,连「未能计价」小标也不画;
//   · 前台(false)→ 金额照旧显示;
//   · 字段缺失(别的 provider 的 Agent 别名 / 旧记录)→ 按前台走:**宁多显示,不误藏**;
//   · 渲染不得改动共享的计价索引(金额数据源与监控面板是同一份,动它就等于把面板也关了)。
// 无 client/node_modules(裸检出)时明确跳过并打印,不静默转绿。
// Run: node tests/unit/check-subagent-cost-bg-card.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const clientDir = join(root, 'client');
const requireCjs = createRequire(import.meta.url);

// 计价模块在模块顶层读 localStorage(订阅判定),裸 node 下没有 window —— 与 check-pricing-cost 同款桩。
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

const { formatCost, displayUsd } = await import('../../client/src/utils/pricing.js');

function loadTaskCardRenderer() {
  let esbuild;
  try {
    esbuild = requireCjs(join(clientDir, 'node_modules/esbuild'));
    requireCjs(join(clientDir, 'node_modules/react-dom/server'));
  } catch {
    return null; // 裸检出:没装 client 依赖
  }
  const work = mkdtempSync(join(tmpdir(), 'subagent-cost-bg-'));
  const entry = join(work, 'entry.jsx');
  writeFileSync(entry, [
    "import React from 'react';",
    "import { renderToStaticMarkup } from 'react-dom/server';",
    `import { TaskCard } from ${JSON.stringify(join(clientDir, 'src/components/tools/TaskCard.jsx'))};`,
    `import { SubagentCostContext } from ${JSON.stringify(join(clientDir, 'src/components/tools/SubagentCost.jsx'))};`,
    'export function render({ toolCall, cost }) {',
    '  return renderToStaticMarkup(',
    '    React.createElement(SubagentCostContext.Provider, { value: cost },',
    '      React.createElement(TaskCard, { toolCall })));',
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
  const { render } = requireCjs(join(work, 'bundle.cjs'));
  return { render, cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

// 一张卡片 + 它的语境。金额索引的形状照 §10.3 的 byToolUseId(usd/currency/priced/failed/reason)。
const CALL_ID = 'toolu_bg_or_fg';
const USD = 0.05;
const MONEY = formatCost(displayUsd(USD, null));        // 期望金额字面量(不写死,由计价模块算)
const EMPTY_INDEX = () => ({ byToolUseId: new Map(), byAgentId: new Map() });

const card = (input) => ({ id: CALL_ID, name: 'Task', input, result: { content: 'done' } });
const costCtxWithRecord = () => ({
  index: { byToolUseId: new Map([[CALL_ID, { usd: USD, currency: null, priced: 1, failed: 0, reason: '' }]]), byAgentId: new Map() },
  history: true,
});

const renderer = loadTaskCardRenderer();
if (!renderer) {
  console.log('! 跳过 真组件渲染:未找到 client/node_modules/esbuild 或 react-dom(裸检出环境)');
} else {
  const { render, cleanup } = renderer;
  try {
    const moneyOf = (html) => (html.match(/[¥$]\s?[\d,]+(?:\.\d+)?/g) || []);

    // ① 后台子代理:一个金额元素都没有 —— 这也是 PA-515 在真浏览器里断言的那条。
    const bg = render({ toolCall: card({ description: 'bg agent', run_in_background: true }), cost: costCtxWithRecord() });
    assert.deepEqual(moneyOf(bg), [], '后台子代理(run_in_background: true)的卡片不得渲染金额');
    assert.ok(!bg.includes('未能计价'), '后台子代理的卡片连「未能计价」小标也不画(它不在对话流显示花费)');

    // ② 前台子代理:照旧显示金额(需求书「前台代理在前台和后台都显示」)。
    const fg = render({ toolCall: card({ description: 'fg agent', run_in_background: false }), cost: costCtxWithRecord() });
    assert.deepEqual(moneyOf(fg), [MONEY], `前台子代理的卡片应显示金额 ${MONEY}`);

    // ③ 字段缺失 = 判不出后台(别的 provider 的 Agent 别名、旧记录)→ 按前台走,不误藏金额。
    const absent = render({ toolCall: card({ description: 'no flag' }), cost: costCtxWithRecord() });
    assert.deepEqual(moneyOf(absent), [MONEY], '拿不到 run_in_background 时按前台处理(宁多显示,不误藏)');

    // ④ 前台没有记录:小标本来的行为不变(历史 + 索引里没这个 toolUseId)→ 仍出「未能计价」。
    const fgMissing = render({ toolCall: card({ description: 'fg agent', run_in_background: false }), cost: { index: EMPTY_INDEX(), history: true } });
    assert.ok(fgMissing.includes('未能计价'), '前台子代理没有用量记录时照旧出「未能计价」小标');

    // ⑤ 后台没有记录:同样不画小标(后台的花费只在监控面板说)。
    const bgMissing = render({ toolCall: card({ description: 'bg agent', run_in_background: true }), cost: { index: EMPTY_INDEX(), history: true } });
    assert.ok(!bgMissing.includes('未能计价'), '后台子代理的卡片不画「未能计价」小标');

    // ⑥ 金额数据源(共享索引)不被卡片渲染改动 —— 监控面板读的就是这一份,改了等于把面板也关了。
    const shared = costCtxWithRecord();
    render({ toolCall: card({ description: 'bg agent', run_in_background: true }), cost: shared });
    assert.equal(shared.index.byToolUseId.get(CALL_ID).usd, USD, '渲染后台卡片不得从共享索引里摘掉该 agent(否则监控面板也没金额了)');
    assert.equal(shared.index.byToolUseId.size, 1, '索引条数不变');

    console.log('✓ 子代理花费卡片口径:后台不渲染 / 前台渲染 / 字段缺失按前台 / 索引不被改动');
  } finally {
    cleanup();
  }
}
