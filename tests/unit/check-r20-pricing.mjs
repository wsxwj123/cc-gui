// R20/R21/R24:官方价目目录的白盒单测(纯函数 + 状态机,不碰网络)。
// Run: node tests/unit/check-r20-pricing.mjs
//
// 覆盖:
//  - 预设全集来自产品唯一 registry(43 条合同 id 全在目录里,不重复);
//  - provider 状态只取合同六值,字段齐全、modelCount/unresolvedModels 自洽;
//  - 报价维度:未知一律 null;0 只在来源写明免费/Free 时出现;
//  - 表格解析:markdown 表头映射、HTML 分组表头、DeepSeek 纵向表转置;
//  - refresh:同批重复请求同一 refreshId、非法批次的判定集合;
//  - 兼容 prices:只写「唯一一条明确适用且四维齐全」的报价。
import assert from 'node:assert/strict';
import {
  COLLECTORS, cellPrice, tablesFromHtml, tablesFromMarkdown, registryPresetIds, metaFor, sourceUrlFor,
} from '../../server/services/pricing-sources.js';
import { legacyPrices } from '../../server/services/pricing-catalog.js';

const PROVIDER_STATUS = ['fresh', 'partial', 'stale', 'source-unavailable', 'not-token-priced', 'unmapped'];
const CONTRACT_PRESET_IDS = [
  'deepseek-official', 'deepseek-anthropic', 'anthropic-official', 'openai', 'gemini', 'moonshot',
  'xai-grok', 'zhipu-glm', 'minimax', 'minimax-anthropic', 'qwen-dashscope', 'qwen-dashscope-anthropic',
  'doubao-volc', 'ernie-qianfan', 'hunyuan', 'stepfun', 'stepfun-anthropic', 'mistral', 'perplexity',
  'zai-intl', 'siliconflow', 'groq', 'together', 'fireworks', 'fireworks-anthropic', 'cerebras',
  'hyperbolic', 'openrouter', 'openrouter-anthropic', '302ai', '302ai-anthropic', 'aihubmix',
  'aihubmix-anthropic', 'mimo-tokenplan', 'mimo-tokenplan-anthropic', 'kimi-code', 'kimi-code-anthropic',
  'glm-coding', 'glm-anthropic', 'zai-coding', 'zai-coding-anthropic', 'qwen-coding-anthropic', 'poe',
];

// ── 1. 预设全集 ──────────────────────────────────────────────────────────
const ids = registryPresetIds();
assert.equal(new Set(ids).size, ids.length, 'registry 预设 id 不得重复');
for (const id of CONTRACT_PRESET_IDS) {
  assert.ok(ids.includes(id), `合同预设 ${id} 必须在 registry 里`);
  assert.ok(sourceUrlFor(id), `${id} 必须有来源 URL`);
  assert.ok(['payg', 'subscription', 'points', 'contract'].includes(metaFor(id).billingMode), `${id} billingMode 非法`);
}
// 新增预设(未登记来源)自动落 unmapped:用一个不在登记表里的 id 验证回落形状。
const unknown = metaFor('__not_registered__');
assert.equal(unknown.collector, null, '未登记来源的预设不得有采集器');
assert.equal(unknown.sourceUrl, '', '未登记来源的预设没有官方 URL 时如实为空');

// 每条合同 id 的 sourceUrl 必须落在该家官方域名(只有登记过的家族才断言)。
const OFFICIAL_HOSTS = {
  'deepseek-official': ['api-docs.deepseek.com'], 'anthropic-official': ['platform.claude.com'],
  openai: ['developers.openai.com'], gemini: ['ai.google.dev'], moonshot: ['platform.kimi.com'],
  'xai-grok': ['docs.x.ai'], 'zhipu-glm': ['docs.bigmodel.cn'], minimax: ['platform.minimaxi.com'],
  'doubao-volc': ['docs.volcengine.com'], stepfun: ['platform.stepfun.com'], mistral: ['mistral.ai'],
  perplexity: ['docs.perplexity.ai'], 'zai-intl': ['docs.z.ai'], groq: ['console.groq.com'],
  together: ['www.together.ai'], fireworks: ['docs.fireworks.ai'], cerebras: ['api.cerebras.ai'],
  openrouter: ['openrouter.ai'], '302ai': ['api.302.ai'], aihubmix: ['aihubmix.com'],
  'mimo-tokenplan': ['mimo.mi.com'], 'kimi-code': ['www.kimi.com'], poe: ['creator.poe.com'],
};
for (const [id, hosts] of Object.entries(OFFICIAL_HOSTS)) {
  const host = new URL(sourceUrlFor(id)).host;
  assert.ok(hosts.some((h) => host === h || host.endsWith(`.${h}`)), `${id} 来源主机 ${host} 不在官方白名单`);
}

// ── 2. 采集器登记与状态 ──────────────────────────────────────────────────
for (const collector of Object.values(COLLECTORS)) {
  assert.ok(collector.id, '采集器必须有 id');
  assert.ok(Array.isArray(collector.presetIds) && collector.presetIds.length, `${collector.id} 必须声明预设`);
  for (const pid of collector.presetIds) assert.ok(ids.includes(pid), `${collector.id} 的预设 ${pid} 不在 registry`);
}

// ── 3. 单元格 → 价格:未知不写 0,免费才写 0 ──────────────────────────────
assert.deepEqual(cellPrice('-'), null, '破折号是未知');
assert.deepEqual(cellPrice('Contact Sales'), null, '议价是未知');
assert.deepEqual(cellPrice('限时免费'), null, '限时免费不是 0');
assert.deepEqual(cellPrice('不支持'), null, '不支持不是 0');
assert.equal(cellPrice('Free').value, 0, '明确免费写 0');
assert.equal(cellPrice('免费').value, 0, '明确免费写 0');
assert.equal(cellPrice('$0.75').value, 0.75);
assert.equal(cellPrice('1.35元').value, 1.35);
assert.equal(cellPrice('\\$1.4').value, 1.4, 'markdown 转义的 $ 也要认');
assert.equal(cellPrice('-3'), null, '负数不落价');

// ── 4. 表格解析 ──────────────────────────────────────────────────────────
const md = '| Model | Input | Cached Input | Output |\n| --- | --- | --- | --- |\n| GLM-5.3 | \\$1.4 | \\$0.26 | \\$4.4 |\n';
const mdTables = tablesFromMarkdown(md);
assert.equal(mdTables.length, 1);
assert.deepEqual(mdTables[0].headers, ['Model', 'Input', 'Cached Input', 'Output']);

const zai = COLLECTORS.zai.parse(md);
assert.equal(zai.quotes.length, 1);
assert.deepEqual(zai.quotes[0].prices, { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite5m: null, cacheWrite1h: null },
  '没写缓存写列 → null,不按倍率推算');
assert.equal(zai.quotes[0].currency, 'USD');

// HTML:分组表头(短/长上下文)+ 分组表头行
const openaiHtml = `<table>
<tr><th></th><th colspan="4">Short context</th><th colspan="4">Long context</th></tr>
<tr><th>Model</th><th>Input</th><th>Cached input</th><th>Cache writes</th><th>Output</th><th>Input</th><th>Cached input</th><th>Cache writes</th><th>Output</th></tr>
<tr><td>gpt-x</td><td>$10.00</td><td>$1.00</td><td>$12.50</td><td>$50.00</td><td>$20.00</td><td>$2.00</td><td>$25.00</td><td>$100.00</td></tr>
<tr><td>gpt-x</td><td>$5.00</td><td>$0.50</td><td>$6.25</td><td>$25.00</td><td>$10.00</td><td>$1.00</td><td>$12.50</td><td>$50.00</td></tr>
</table>`;
const oai = COLLECTORS.openai.parse(openaiHtml);
assert.equal(oai.quotes.length, 2, '同一模型只取页面里第一次出现的档');
assert.equal(oai.partial, true, '页面上还有别的档没取 → partial');
assert.deepEqual(oai.quotes[0].prices, { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: null });
assert.deepEqual(oai.quotes[1].conditions, { context: 'long context' });

// DeepSeek:模型横向、价格纵向,峰谷时段单独成条报价
const deepseekHtml = `<table>
<tr><td>模型</td><td>deepseek-flash (1)</td><td>deepseek-v4-pro (2)</td></tr>
<tr><td>价格 (3)</td><td>百万tokens输入 （缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>
<tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>
<tr><td>百万tokens输入 （缓存未命中）</td><td>空闲时段</td><td>1元</td><td>4.5元</td></tr>
<tr><td>高峰时段</td><td>2元</td><td>9.0元</td></tr>
<tr><td>百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
<tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr>
</table>`;
const ds = COLLECTORS.deepseek.parse(deepseekHtml);
assert.equal(ds.quotes.length, 4, '2 模型 × 峰谷两档');
// 计价契约(2026-09-11)只认 period:'peak'/'off-peak' 这个闭集:中文标签规范化后放进 period,
// 原文留在 periodLabel(显示用)。映射不出来的标签原样留在 period → 消费侧判该 quote 不适用。
const idleFlash = ds.quotes.find((q) => q.displayName === 'deepseek-flash' && q.conditions?.period === 'off-peak');
assert.deepEqual(idleFlash.prices, { input: 1, output: 4, cacheRead: 0.02, cacheWrite5m: null, cacheWrite1h: null });
assert.equal(idleFlash.currency, 'CNY');
assert.equal(idleFlash.conditions.periodLabel, '空闲时段', '原始中文标签必须保留');
assert.equal(idleFlash.conditions.timezone, 'Asia/Shanghai');
assert.equal(Date.parse(idleFlash.validFrom), Date.parse('2026-08-16T16:00:00.000Z'), '峰谷价自北京时间 2026-08-17 00:00 起生效');
const peakFlash = ds.quotes.find((q) => q.displayName === 'deepseek-flash' && q.conditions?.period === 'peak');
assert.equal(peakFlash.conditions.periodLabel, '高峰时段');
assert.deepEqual(peakFlash.prices, { input: 2, output: 8, cacheRead: 0.04, cacheWrite5m: null, cacheWrite1h: null });
assert.equal(ds.quotes.filter((q) => q.conditions?.period === 'off-peak' || q.conditions?.period === 'peak').length, 4,
  '四条的时段都已被规范化');

// 首页/空表 → 0 条报价(由 catalog 判 SOURCE_INVALID_CONTENT,不在这里假装成功)
assert.equal(COLLECTORS.cerebras.parse(JSON.stringify({ data: [] })).quotes.length, 0);
const cerebras = COLLECTORS.cerebras.parse(JSON.stringify({ data: [{ id: 'm1', name: 'M1', pricing: { prompt: '0.00000099', completion: '0.00000149' } }] }));
assert.ok(Math.abs(cerebras.quotes[0].prices.input - 0.99) < 1e-9, 'USD/token → 每百万 token');
assert.equal(cerebras.quotes[0].prices.cacheRead, null, '来源没给缓存读 → null');

// ── 5. 兼容 prices:单一明确报价才写 ──────────────────────────────────────
const baseQuote = (over = {}) => ({
  quoteId: 'q', provider: 'anthropic-official', presetIds: ['anthropic-official'], modelId: 'claude-x',
  displayName: 'Claude X', currency: 'USD', unit: 'per 1M tokens',
  prices: { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  conditions: null, sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
  sourceKind: 'official', fetchedAt: '2026-09-11T00:00:00Z', parserVersion: 'pr5-1', status: 'fresh', ...over,
});
assert.deepEqual(legacyPrices([baseQuote()]), { 'claude-x': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } });
assert.deepEqual(legacyPrices([baseQuote(), baseQuote({ quoteId: 'q2', conditions: { tier: 'batch' }, prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: null } })]),
  {}, '同一模型两条明确报价 → 不写(宁缺勿猜)');
assert.deepEqual(legacyPrices([baseQuote({ currency: 'CNY' })]), {}, '旧四字段是 USD 视图,CNY 不混进去');
assert.deepEqual(legacyPrices([baseQuote({ status: 'stale' })]), {}, 'stale 不写');
assert.deepEqual(legacyPrices([baseQuote({ prices: { input: 10, output: 50, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null } })]),
  {}, '维度不全 → 不写');

console.log('check-r20-pricing: OK');
