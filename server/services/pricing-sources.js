// R20 价格来源目录与采集器。
//
// 只有两件事在这里:①「哪个预设对应哪家官方源」的元数据;②怎么把该官方源公布的
// 价目页/公开 JSON 解析成统一报价(quote)。网络抓取、超时、状态机在 pricing-catalog.js。
//
// 硬规矩(与 .devflow/INTERFACE.md「官方价格、用量和展示」一致):
// - sourceUrl 必须是该家官方域名(thepreset 表的「官方来源」列);不用第三方索引冒充官网。
// - 拿不到的维度一律 null,绝不写 0;0 只在来源明确写 Free/免费 时使用。
// - 只解释来源里真实出现的字段,不按倍率推算缺失维度(例如没有写缓存写列就不给写价)。
//
// 预设全集来自产品唯一 registry(server/utils/builtin-providers.js),这里只登记
// 「这个 presetId 的价格身份」;registry 里新增而没有登记的预设会自动落 unmapped,
// 不在这里维护第二份 id 清单。

import { BUILTIN_PROVIDERS } from '../utils/builtin-providers.js';
import { DEEPSEEK_PEAK_VALID_FROM } from '../utils/pricing-rules.js';

/** 官方价目页的中文时段标签 → 消费侧闭集 'peak'/'off-peak'(映射不出来的原样保留 = 消费侧判不适用)。 */
const DEEPSEEK_PERIOD_KEYS = { '高峰时段': 'peak', '空闲时段': 'off-peak' };

// ── 每家官方来源的计费身份 ────────────────────────────────────────────────
// billingMode: payg 按量 / subscription 套餐 / points 积分 / contract 合同
export const PRESET_SOURCES = {
  'deepseek-official': { billingProvider: 'deepseek', market: 'cn', billingMode: 'payg', sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', currency: 'CNY', collector: 'deepseek' },
  'deepseek-anthropic': { billingProvider: 'deepseek', market: 'cn', billingMode: 'payg', sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', currency: 'CNY', collector: 'deepseek' },
  'anthropic-official': { billingProvider: 'anthropic', market: 'global', billingMode: 'payg', sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing', currency: 'USD', collector: 'anthropic' },
  openai: { billingProvider: 'openai', market: 'global', billingMode: 'payg', sourceUrl: 'https://developers.openai.com/api/docs/pricing', currency: 'USD', collector: 'openai' },
  gemini: { billingProvider: 'google', market: 'global', billingMode: 'payg', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing', currency: 'USD', collector: 'gemini' },
  moonshot: { billingProvider: 'moonshot', market: 'cn', billingMode: 'payg', sourceUrl: 'https://platform.kimi.com/docs/pricing/chat', currency: 'CNY', collector: null },
  'xai-grok': { billingProvider: 'xai', market: 'global', billingMode: 'payg', sourceUrl: 'https://docs.x.ai/developers/pricing', currency: 'USD', collector: 'xai' },
  'zhipu-glm': { billingProvider: 'zhipu', market: 'cn', billingMode: 'payg', sourceUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing', currency: 'CNY', collector: 'bigmodel' },
  minimax: { billingProvider: 'minimax', market: 'cn', billingMode: 'payg', sourceUrl: 'https://platform.minimaxi.com/docs/guides/pricing-paygo', currency: 'CNY', collector: 'minimax' },
  'minimax-anthropic': { billingProvider: 'minimax', market: 'cn', billingMode: 'payg', sourceUrl: 'https://platform.minimaxi.com/docs/guides/pricing-paygo', currency: 'CNY', collector: 'minimax' },
  'qwen-dashscope': { billingProvider: 'aliyun', market: 'cn', billingMode: 'payg', sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', currency: 'CNY', collector: null },
  'qwen-dashscope-anthropic': { billingProvider: 'aliyun', market: 'cn', billingMode: 'payg', sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', currency: 'CNY', collector: null },
  'doubao-volc': { billingProvider: 'volcengine', market: 'cn', billingMode: 'payg', sourceUrl: 'https://docs.volcengine.com/api/doc/getDocDetail?LibraryID=82379&DocumentID=1544106&lang=zh', currency: 'CNY', collector: 'volc' },
  'ernie-qianfan': { billingProvider: 'baidu', market: 'cn', billingMode: 'payg', sourceUrl: 'https://cloud.baidu.com/doc/qianfan/s/wmh4sv6ya', currency: 'CNY', collector: null },
  hunyuan: { billingProvider: 'tencent', market: 'cn', billingMode: 'payg', sourceUrl: 'https://cloud.tencent.cn/document/product/1729/97731', currency: 'CNY', collector: null },
  stepfun: { billingProvider: 'stepfun', market: 'cn', billingMode: 'payg', sourceUrl: 'https://platform.stepfun.com/docs/zh/guides/pricing/details', currency: 'CNY', collector: 'stepfun' },
  'stepfun-anthropic': { billingProvider: 'stepfun', market: 'cn', billingMode: 'payg', sourceUrl: 'https://platform.stepfun.com/docs/zh/guides/pricing/details', currency: 'CNY', collector: 'stepfun' },
  mistral: { billingProvider: 'mistral', market: 'global', billingMode: 'payg', sourceUrl: 'https://mistral.ai/pricing/api/', currency: 'USD', collector: null },
  perplexity: { billingProvider: 'perplexity', market: 'global', billingMode: 'payg', sourceUrl: 'https://docs.perplexity.ai/docs/getting-started/pricing', currency: 'USD', collector: 'perplexity' },
  'zai-intl': { billingProvider: 'zai', market: 'global', billingMode: 'payg', sourceUrl: 'https://docs.z.ai/guides/overview/pricing', currency: 'USD', collector: 'zai' },
  siliconflow: { billingProvider: 'siliconflow', market: 'cn', billingMode: 'payg', sourceUrl: 'https://siliconflow.cn/pricing', currency: 'CNY', collector: null },
  groq: { billingProvider: 'groq', market: 'global', billingMode: 'payg', sourceUrl: 'https://console.groq.com/docs/models', currency: 'USD', collector: 'groq' },
  together: { billingProvider: 'together', market: 'global', billingMode: 'payg', sourceUrl: 'https://www.together.ai/pricing', currency: 'USD', collector: 'together' },
  fireworks: { billingProvider: 'fireworks', market: 'global', billingMode: 'payg', sourceUrl: 'https://docs.fireworks.ai/serverless/pricing', currency: 'USD', collector: 'fireworks' },
  'fireworks-anthropic': { billingProvider: 'fireworks', market: 'global', billingMode: 'payg', sourceUrl: 'https://docs.fireworks.ai/serverless/pricing', currency: 'USD', collector: 'fireworks' },
  cerebras: { billingProvider: 'cerebras', market: 'global', billingMode: 'payg', sourceUrl: 'https://api.cerebras.ai/public/v1/models', currency: 'USD', collector: 'cerebras' },
  // 官方旧价页已跳新首页,现无 token 价可取得 —— 如实记来源不可用,不沿用旧索引。
  hyperbolic: { billingProvider: 'hyperbolic', market: 'global', billingMode: 'payg', sourceUrl: 'https://docs.hyperbolic.xyz/docs/hyperbolic-pricing', currency: 'USD', collector: 'none' },
  openrouter: { billingProvider: 'openrouter', market: 'global', billingMode: 'payg', sourceUrl: 'https://openrouter.ai/api/v1/models', currency: 'USD', collector: 'openrouter' },
  'openrouter-anthropic': { billingProvider: 'openrouter', market: 'global', billingMode: 'payg', sourceUrl: 'https://openrouter.ai/api/v1/models', currency: 'USD', collector: 'openrouter' },
  // 官方 JSON 可匿名取到,但响应样例没有币种字段,官方未补证前不得标 USD → 只报 partial,不落价。
  '302ai': { billingProvider: '302ai', market: 'cn', billingMode: 'payg', sourceUrl: 'https://api.302.ai/dashboard/prices?path=%2Fchat%2Fcompletions&lang=zh', currency: null, collector: '302ai' },
  '302ai-anthropic': { billingProvider: '302ai', market: 'cn', billingMode: 'payg', sourceUrl: 'https://api.302.ai/dashboard/prices?path=%2Fchat%2Fcompletions&lang=zh', currency: null, collector: '302ai' },
  aihubmix: { billingProvider: 'aihubmix', market: 'global', billingMode: 'payg', sourceUrl: 'https://aihubmix.com/models', currency: 'USD', collector: null },
  'aihubmix-anthropic': { billingProvider: 'aihubmix', market: 'global', billingMode: 'payg', sourceUrl: 'https://aihubmix.com/models', currency: 'USD', collector: null },
  // 套餐类:不是逐 token 现付。当前未实现套餐规则采集 → 状态 not-token-priced,不冒充按量价。
  'mimo-tokenplan': { billingProvider: 'xiaomi', market: 'cn', billingMode: 'subscription', sourceUrl: 'https://mimo.mi.com/docs/zh-CN/tokenplan/Token%20Plan/subscription', currency: 'CNY', collector: null, planOnly: true },
  'mimo-tokenplan-anthropic': { billingProvider: 'xiaomi', market: 'cn', billingMode: 'subscription', sourceUrl: 'https://mimo.mi.com/docs/zh-CN/tokenplan/Token%20Plan/subscription', currency: 'CNY', collector: null, planOnly: true },
  'kimi-code': { billingProvider: 'moonshot', market: 'cn', billingMode: 'subscription', sourceUrl: 'https://www.kimi.com/help/membership/membership-pricing', currency: 'CNY', collector: null, planOnly: true },
  'kimi-code-anthropic': { billingProvider: 'moonshot', market: 'cn', billingMode: 'subscription', sourceUrl: 'https://www.kimi.com/help/membership/membership-pricing', currency: 'CNY', collector: null, planOnly: true },
  'glm-coding': { billingProvider: 'zhipu', market: 'cn', billingMode: 'subscription', sourceUrl: 'https://docs.bigmodel.cn/cn/coding-plan/tool/claude', currency: 'CNY', collector: null, planOnly: true },
  'glm-anthropic': { billingProvider: 'zhipu', market: 'cn', billingMode: 'subscription', sourceUrl: 'https://docs.bigmodel.cn/cn/coding-plan/tool/claude', currency: 'CNY', collector: null, planOnly: true },
  'zai-coding': { billingProvider: 'zai', market: 'global', billingMode: 'subscription', sourceUrl: 'https://docs.z.ai/devpack/quick-start', currency: 'USD', collector: null, planOnly: true },
  'zai-coding-anthropic': { billingProvider: 'zai', market: 'global', billingMode: 'subscription', sourceUrl: 'https://docs.z.ai/devpack/quick-start', currency: 'USD', collector: null, planOnly: true },
  'qwen-coding-anthropic': { billingProvider: 'aliyun', market: 'cn', billingMode: 'subscription', sourceUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan', currency: 'CNY', collector: null, planOnly: true },
  poe: { billingProvider: 'poe', market: 'global', billingMode: 'points', sourceUrl: 'https://creator.poe.com/docs/external-applications/openai-compatible-api', currency: null, collector: null, planOnly: true },
};

/** 产品唯一 registry 里的全部预设 id(新增预设自动进目录,不需要改本文件)。 */
export function registryPresetIds() {
  return BUILTIN_PROVIDERS.map((p) => p.id);
}

/** 某预设的官方来源 URL:登记过用登记的(官方价目页),没登记回落 registry 的 docs/baseURL。 */
export function sourceUrlFor(presetId) {
  const meta = PRESET_SOURCES[presetId];
  if (meta) return meta.sourceUrl;
  const builtin = BUILTIN_PROVIDERS.find((p) => p.id === presetId);
  return builtin?.docs || builtin?.baseURL || '';
}

export function metaFor(presetId) {
  const builtin = BUILTIN_PROVIDERS.find((p) => p.id === presetId);
  return PRESET_SOURCES[presetId] || {
    billingProvider: builtin?.name || presetId,
    market: 'unknown',
    billingMode: 'payg',
    sourceUrl: builtin?.docs || builtin?.baseURL || '',
    currency: null,
    collector: null,
  };
}

// ── 表格解析(价目页 → 结构化行)──────────────────────────────────────────

function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanCell(text) {
  const raw = String(text ?? '');
  return (raw.includes('<') ? stripTags(raw) : raw)
    .replace(/\\([\\$*_`~.\-[\]()#+!])/g, '$1') // markdown 转义:\\$ → $, \\- → -
    .replace(/\\\$/g, '$')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Markdown 管道表 → [{ headers, rows }]。 */
export function tablesFromMarkdown(text) {
  const lines = String(text ?? '').split('\n');
  const tables = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) continue;
    const isSeparator = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line);
    if (!isSeparator(lines[i + 1] || '')) continue;
    const headers = lines[i].split('|').slice(1, -1).map(cleanCell);
    const rows = [];
    for (let j = i + 2; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]); j += 1) {
      if (isSeparator(lines[j])) continue;
      const cells = lines[j].split('|').slice(1, -1).map(cleanCell);
      rows.push(cells);
    }
    tables.push({ headers, rows });
    i += 1;
  }
  return tables;
}

/** HTML 表 → [{ headers, rows }]。浅层正则:价目页的表格都是平铺表格,不含嵌套表。 */
export function tablesFromHtml(html) {
  const tables = [];
  const raw = String(html ?? '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  for (const tableMatch of raw.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const body = tableMatch[0];
    if (/<table[\s\S]*?<table/i.test(body.slice(1))) continue; // 嵌套表跳过(结构不可靠)
    const headerRows = [];
    const rows = [];
    for (const rowMatch of body.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells = [...rowMatch[0].matchAll(/<t[hd][\s\S]*?<\/t[hd]>/gi)].map((m) => cleanCell(stripTags(m[0])));
      if (!cells.length) continue;
      // 分组表头(如 OpenAI 的「Short context / Long context」+ 列名两行)取最后一行列名。
      if (/<th/i.test(rowMatch[0])) headerRows.push(cells);
      else rows.push(cells);
    }
    if (rows.length) tables.push({ headers: headerRows[headerRows.length - 1] || [], headerRows, rows });
  }
  return tables;
}

// ── 单元格 → 价格 ────────────────────────────────────────────────────────

/**
 * 价格单元格 → { value, currency } | null。
 * 只认来源明确给出的数字/免费字样:数字(含 $/¥/元/CNY/USD 前缀)、Free/免费 = 0;
 * '-'、'\\'、'不支持'、'议价'、'Contact Sales'、'限时免费' 等 → null(未知,不猜 0)。
 */
export function cellPrice(raw) {
  const text = cleanCell(raw);
  if (!text) return null;
  if (/(限时免费|限时|暂免|不支持|议价|contact|sales|negotiat|n\/a|preview|—|^-$|^\\$|^-+$)/i.test(text)) return null;
  const m = text.match(/(\$|¥|￥|usd|cny|eur|€|元|美元)?\s*(-?\d[\d,]*(?:\.\d+)?)/i);
  if (!m) {
    if (/(free|免费)/i.test(text)) return { value: 0, currency: null };
    return null;
  }
  const value = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(value) || value < 0) return null;
  const sign = (m[1] || '').toLowerCase();
  let currency = null;
  if (sign === '$' || sign === 'usd' || sign === '美元') currency = 'USD';
  else if (sign === '¥' || sign === '￥' || sign === 'cny' || sign === '元') currency = 'CNY';
  else if (sign === 'eur' || sign === '€') currency = 'EUR';
  return { value, currency };
}

/** 表头里的计量单位倍率:源用「元/千 tokens」时乘 1000 归一到每百万。 */
export function unitMultiplier(header) {
  const text = cleanCell(header);
  if (/(^|[^0-9])1\s*b|十亿|billion/i.test(text)) return 1000;
  if (/(千|1k|per 1k|thousand)/i.test(text)) return 1000;
  return 1;
}

function findColumn(headers, pattern) {
  return headers.findIndex((h) => pattern.test(h));
}

// ── 采集器 ───────────────────────────────────────────────────────────────
// 每个采集器:{ id, presetIds, request: { url, format }, parse(text) → { quotes, unresolved? , partial? } }
//
// parse 只做「把官方公布的内容变成报价」,不碰网络与状态;失败(空表/首页/币种不明)由
// catalog 判 SOURCE_INVALID_CONTENT。

function splitModelLabel(label) {
  const text = cleanCell(label);
  const match = text.match(/^(.*?)\s*[（(]([^）)]*)[）)]\s*$/);
  if (!match) return { name: text, conditions: null };
  const inner = match[2].trim();
  if (!inner || /^见|^注|^https?:/i.test(inner)) return { name: text, conditions: null };
  return { name: match[1].trim(), conditions: { note: inner } };
}

/**
 * 把「有 模型/输入/输出 列的价目表」按表头映射成报价(多家共用)。
 * 表头认不出输入或输出列的表直接跳过 —— 宁缺勿猜。
 */
function quotesFromTables(tables, {
  currency,
  inputPattern = /输入|input/i,
  outputPattern = /输出|output/i,
  cacheReadPattern = /缓存命中|缓存读取|cached input|cache read|命中输入/i,
  cacheWritePattern = /缓存写|cache write/i,
  modelPattern = /模型|model/i,
  conditions = null,
}) {
  const quotes = [];
  for (const table of tables) {
    const headers = table.headers.map(cleanCell);
    const modelCol = findColumn(headers, modelPattern);
    const inputCol = findColumn(headers, inputPattern);
    const outputCol = findColumn(headers, outputPattern);
    const readCol = findColumn(headers, cacheReadPattern);
    const writeCol = findColumn(headers, cacheWritePattern);
    if (modelCol < 0 || inputCol < 0 || outputCol < 0) continue;
    const inMul = unitMultiplier(headers[inputCol]);
    const outMul = unitMultiplier(headers[outputCol]);
    for (const row of table.rows) {
      const label = cleanCell(row[modelCol]);
      if (!label) continue;
      const input = cellPrice(row[inputCol]);
      const output = cellPrice(row[outputCol]);
      if (!input || !output) continue;
      const read = readCol >= 0 ? cellPrice(row[readCol]) : null;
      const write = writeCol >= 0 ? cellPrice(row[writeCol]) : null;
      const { name, conditions: cellConditions } = splitModelLabel(label);
      quotes.push({
        displayName: name,
        currency: input.currency || currency,
        prices: {
          input: input.value * inMul,
          output: output.value * outMul,
          cacheRead: read ? read.value * unitMultiplier(headers[readCol]) : null,
          cacheWrite5m: write ? write.value * unitMultiplier(headers[writeCol]) : null,
          cacheWrite1h: null,
        },
        conditions: cellConditions || conditions,
      });
    }
  }
  return quotes;
}

function modelFromHeaderRow(table, { namePattern = /模型|model/i, pricePattern = /输入|input/i }) {
  // 表头第一行是分组名(如「Short context」「Long context」),第二行才是列名 —— HTML 表里
  // 分组表头会被拼进同一行。这里还原:第一行有分组名、第二行有列名时,列名行才是真表头。
  return table.headers.length > 0 && !pricePattern.test(table.headers.join(' ')) &&
    namePattern.test(table.headers.join(' ')) ? false : true;
}

export const COLLECTORS = {
  // DeepSeek:官方价目页是文档站的表格,直接取 HTML 表;峰谷两档条件写进 conditions。
  deepseek: {
    id: 'deepseek',
    presetIds: ['deepseek-official', 'deepseek-anthropic'],
    request: { url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', format: 'html' },
    parse(text) {
      // 官方表是「模型横向、价格纵向」的表:列头是模型名,行是各种价格/时段。
      const quotes = [];
      for (const table of tablesFromHtml(text)) {
        // Docusaurus 表头是 <td> 不是 <th> → 表头不在 headers 里,用首行补。
        const headers = /^模型/.test(cleanCell(table.headers[0] || '')) ? table.headers : (table.rows[0] || []);
        const bodyRows = headers === table.headers ? table.rows : table.rows.slice(1);
        const modelNames = headers.slice(1).map((h) => cleanCell(h).replace(/\s*\(\d+\)\s*$/, ''));
        if (!modelNames.length || !/模型/.test(headers[0] || '')) continue;
        // 找出价格块:标签行 + 时段行(空闲/高峰),时段行的值是「时段名 + 各模型值」。
        const sections = [
          { key: 'cacheRead', re: /输入.*缓存命中/ },
          { key: 'input', re: /输入.*缓存未命中/ },
          { key: 'output', re: /输出/ },
        ];
        const acc = modelNames.map(() => ({}));
        for (let i = 0; i < bodyRows.length; i += 1) {
          const row = bodyRows[i];
          // 价格块首行的标签可能被挤到第 2 格(前有 rowspan 的「价格」格)。
          const labelIdx = [0, 1].find((idx) => /百万/.test(cleanCell(row[idx])) && sections.some((s) => s.re.test(cleanCell(row[idx]))));
          if (labelIdx === undefined) continue;
          const section = sections.find((s) => s.re.test(cleanCell(row[labelIdx])));
          let valueStart = labelIdx + 1;
          const periods = [];
          if (/^(空闲时段|高峰时段)/.test(cleanCell(row[valueStart]))) {
            periods.push({ name: cleanCell(row[valueStart]), values: row.slice(valueStart + 1) });
            valueStart = -1;
          }
          for (let j = i + 1; j < bodyRows.length; j += 1) {
            const next = bodyRows[j];
            if (!/^(空闲时段|高峰时段)/.test(cleanCell(next[0]))) break;
            periods.push({ name: cleanCell(next[0]), values: next.slice(1) });
          }
          if (!periods.length) periods.push({ name: null, values: row.slice(labelIdx + 1) });
          for (const period of periods) {
            for (let m = 0; m < modelNames.length; m += 1) {
              const price = cellPrice(period.values[m]);
              if (price) acc[m][`${section.key}${period.name ? `|${period.name}` : ''}`] = price.value;
            }
          }
        }
        for (let m = 0; m < modelNames.length; m += 1) {
          const keys = Object.keys(acc[m]);
          const hasInput = keys.some((k) => k === 'input' || k.startsWith('input|'));
          const hasOutput = keys.some((k) => k === 'output' || k.startsWith('output|'));
          if (!keys.length || !hasInput || !hasOutput) continue;
          const periods = new Set(keys.map((k) => k.split('|')[1]).filter(Boolean));
          const list = periods.size ? [...periods] : [null];
          for (const period of list) {
            const pick = (key) => acc[m][period ? `${key}|${period}` : key] ?? null;
            // 时段标签规范化:消费侧(客户端计价)只认 period:'peak'/'off-peak' 这个闭集,
            // 中文标签映射不出来时把**原文**留在 period 上 —— 消费侧见到不认识的值判该 quote
            // 不适用(宁缺勿猜),绝不让一条来路不明的时段价落到「无条件」那一支。
            const periodKey = period ? (DEEPSEEK_PERIOD_KEYS[period] || period) : null;
            quotes.push({
              displayName: modelNames[m],
              currency: 'CNY',
              prices: { input: pick('input'), output: pick('output'), cacheRead: pick('cacheRead'), cacheWrite5m: null, cacheWrite1h: null },
              conditions: period ? { period: periodKey, periodLabel: period, timezone: 'Asia/Shanghai' } : null,
              // 峰谷价自官方公告的生效时刻起才适用(早于它的历史记录按当时价,不套峰谷)。
              validFrom: period ? DEEPSEEK_PEAK_VALID_FROM : null,
            });
          }
        }
      }
      return { quotes };
    },
  },

  // Anthropic:官方 Pricing 页的 markdown 源(.md 端点),5m/1h 写价分列保留。
  anthropic: {
    id: 'anthropic',
    presetIds: ['anthropic-official'],
    request: { url: 'https://platform.claude.com/docs/en/about-claude/pricing.md', format: 'md' },
    parse(text) {
      const quotes = [];
      for (const table of tablesFromMarkdown(text)) {
        const headers = table.headers;
        const modelCol = findColumn(headers, /^model$/i);
        const inputCol = findColumn(headers, /base input/i);
        const outCol = findColumn(headers, /output tokens/i);
        const w5Col = findColumn(headers, /5m cache writes/i);
        const w1Col = findColumn(headers, /1h cache writes/i);
        const readCol = findColumn(headers, /cache hits/i);
        if (modelCol < 0 || inputCol < 0 || outCol < 0) continue;
        for (const row of table.rows) {
          const label = cleanCell(row[modelCol]);
          if (!label) continue;
          const input = cellPrice(row[inputCol]);
          const output = cellPrice(row[outCol]);
          if (!input || !output || input.value <= 0) continue;
          const read = readCol >= 0 ? cellPrice(row[readCol]) : null;
          const w5 = w5Col >= 0 ? cellPrice(row[w5Col]) : null;
          const w1 = w1Col >= 0 ? cellPrice(row[w1Col]) : null;
          const { name, conditions } = splitModelLabel(label);
          quotes.push({
            displayName: name,
            currency: 'USD',
            prices: { input: input.value, output: output.value, cacheRead: read?.value ?? null, cacheWrite5m: w5?.value ?? null, cacheWrite1h: w1?.value ?? null },
            conditions,
          });
        }
      }
      return { quotes };
    },
  },

  // OpenAI:官方 API Pricing 页,短/长上下文各四列(HTML 分组表头)。
  openai: {
    id: 'openai',
    presetIds: ['openai'],
    request: { url: 'https://developers.openai.com/api/docs/pricing', format: 'html' },
    parse(text) {
      // 同一批模型在页面上按服务档(标准/Batch/Flex/Priority)重复出表,列结构一致。
      // 只取每个模型在页面里【第一次】出现的档(官方主档),后来的档不覆盖它 ——
      // 覆盖会让长上下文/高档价顶掉主价。未取到的档如实记 partial。
      const quotes = [];
      const seen = new Set();
      let partial = false;
      for (const table of tablesFromHtml(text)) {
        const headers = table.headers;
        const modelCol = findColumn(headers, /^model$/i);
        const cols = headers.map((h, i) => ({ h, i })).filter(({ h }) => /^(input|cached input|cache writes|output)$/i.test(h));
        if (modelCol < 0 || cols.length !== 8) continue;
        for (const row of table.rows) {
          const label = cleanCell(row[modelCol]);
          if (!label) continue;
          if (seen.has(label)) { partial = true; continue; }
          seen.add(label);
          for (const [half, tag] of [[0, 'short context'], [1, 'long context']]) {
            const group = cols.slice(half * 4, half * 4 + 4);
            const pick = (re) => {
              const hit = group.find(({ h }) => re.test(h));
              return hit ? cellPrice(row[hit.i]) : null;
            };
            const input = pick(/^input$/i);
            const output = pick(/^output$/i);
            if (!input || !output) continue;
            const write = pick(/^cache writes$/i);
            quotes.push({
              // 模型列原文即 API id(gpt-5.6-* 全系),直接当 modelId —— 消费侧才能**精确**命中,
              // 而不是退回显示名匹配/前缀兜底。显示名保留 (short/long context) 后缀供人看。
              modelId: label,
              displayName: `${label} (${tag})`,
              currency: 'USD',
              prices: { input: input.value, output: output.value, cacheRead: pick(/^cached input$/i)?.value ?? null, cacheWrite5m: write?.value ?? null, cacheWrite1h: null },
              conditions: { context: tag },
            });
          }
        }
      }
      return { quotes, partial };
    },
  },

  // Gemini:每个模型一个 section,表头写「Paid Tier, per 1M tokens in USD」,未来生效价不能被当现价。
  gemini: {
    id: 'gemini',
    presetIds: ['gemini'],
    request: { url: 'https://ai.google.dev/gemini-api/docs/pricing', format: 'html' },
    parse(text) {
      // 每个模型一个 h2 section,section 内按 h3 分档(Standard/Batch/Flex/Priority),表格是
      // 「行=价格项、列=Free/Paid」。只取 Standard + Paid,未来生效价不提前套用。
      const quotes = [];
      const html = String(text);
      const sectionRe = /<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2[^>]*>|$)/gi;
      const currentPrice = (cell) => {
        const text = cleanCell(cell);
        const parts = text.split(/(?=\$)/);
        // 形如 "$0.75 through December 31, 2026. $1.50 starting January 1, 2027."(中文版:
        // "2026 年 12 月 31 日前為 $0.75,2027 年 1 月 1 日起為 $1.50")→ 只取当前有效段。
        const expired = /(through|前為|前为|截至|直至)/i;
        const upcoming = /(starting|起為|起为|生效)/i;
        const active = parts.find((part) => expired.test(part));
        if (active) return cellPrice(active);
        if (parts.some((part) => upcoming.test(part)) && !parts.some(expired)) return null; // 未来价不提前套用
        return cellPrice(text);
      };
      for (const section of html.matchAll(sectionRe)) {
        const title = cleanCell(stripTags(section[1]));
        if (!title || /^(free|paid|enterprise|免費|付费|付費)/i.test(title)) continue;
        const h3Re = /<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3[^>]*>|$)/gi;
        let standardBody = null;
        for (const h3 of section[2].matchAll(h3Re)) {
          if (/^(standard|標準|标准)$/i.test(cleanCell(stripTags(h3[1])))) { standardBody = h3[2]; break; }
        }
        if (!standardBody) continue;
        const tables = tablesFromHtml(standardBody);
        for (const table of tables) {
          const headers = table.headers.join(' | ');
          if (!/(paid tier|付費層級|付费层级)/i.test(headers)) continue;
          const paidCol = table.headers.findIndex((h) => /(paid tier|付費層級|付费层级)/i.test(h));
          if (paidCol < 0) continue;
          const rowOf = (re) => table.rows.find((row) => re.test(cleanCell(row[0])));
          const input = rowOf(/(input price|輸入價格|输入价格)/i);
          const output = rowOf(/(output price|輸出價格|输出价格)/i);
          if (!input || !output) continue;
          const inputPrice = currentPrice(input[paidCol]);
          const outputPrice = currentPrice(output[paidCol]);
          if (!inputPrice || !outputPrice) continue;
          const caching = rowOf(/(context caching|上下文快取|上下文缓存)/i);
          const read = caching ? currentPrice(caching[paidCol]) : null;
          quotes.push({
            displayName: title,
            currency: 'USD',
            prices: { input: inputPrice.value, output: outputPrice.value, cacheRead: read?.value ?? null, cacheWrite5m: null, cacheWrite1h: null },
            conditions: { tier: 'standard' },
          });
        }
      }
      return { quotes };
    },
  },

  // Moonshot/Kimi:价目入口页只链到 chat-* 逐模型页(含内嵌 MDX 表),未实现多页发现 → 不登记采集器。


  xai: {
    id: 'xai',
    presetIds: ['xai-grok'],
    request: { url: 'https://docs.x.ai/developers/pricing.md', format: 'md' },
    parse(text) {
      const tables = tablesFromMarkdown(text).filter((t) => /input \/ 1m tokens/i.test(t.headers.join(' ')));
      const quotes = quotesFromTables(tables, {
        currency: 'USD',
        inputPattern: /^input \/ 1m tokens$/i,
        outputPattern: /^output \/ 1m tokens$/i,
        cacheReadPattern: /cached input/i,
        cacheWritePattern: /(?!)/,
      });
      return { quotes };
    },
  },

  bigmodel: {
    id: 'bigmodel',
    presetIds: ['zhipu-glm'],
    request: { url: 'https://docs.bigmodel.cn/cn/guide/start/pricing.md', format: 'md' },
    parse(text) {
      const quotes = [];
      for (const table of tablesFromMarkdown(text)) {
        const headers = table.headers;
        const modelCol = findColumn(headers, /模型/);
        const inputCol = findColumn(headers, /输入单价/);
        const outCol = findColumn(headers, /输出单价/);
        const readCol = findColumn(headers, /缓存命中/);
        if (modelCol < 0 || inputCol < 0 || outCol < 0) continue;
        for (const row of table.rows) {
          const label = cleanCell(row[modelCol]);
          const input = cellPrice(row[inputCol]);
          const output = cellPrice(row[outCol]);
          if (!label || !input || !output) continue;
          const read = readCol >= 0 ? cellPrice(row[readCol]) : null;
          const context = cleanCell(row[findColumn(headers, /上下文/)]);
          const { name, conditions } = splitModelLabel(label);
          quotes.push({
            displayName: name,
            currency: 'CNY',
            prices: { input: input.value, output: output.value, cacheRead: read?.value ?? null, cacheWrite5m: null, cacheWrite1h: null },
            conditions: conditions || (context && context !== '1M' ? { inputLength: context } : null),
          });
        }
      }
      return { quotes };
    },
  },

  minimax: {
    id: 'minimax',
    presetIds: ['minimax', 'minimax-anthropic'],
    request: { url: 'https://platform.minimaxi.com/docs/guides/pricing-paygo.md', format: 'md' },
    parse(text) {
      const quotes = [];
      for (const table of tablesFromMarkdown(text)) {
        const headers = table.headers;
        const modelCol = findColumn(headers, /模型/);
        const inputCol = findColumn(headers, /输入价格/);
        const outCol = findColumn(headers, /输出价格/);
        const readCol = findColumn(headers, /缓存读取/);
        const writeCol = findColumn(headers, /缓存写入/);
        if (modelCol < 0 || inputCol < 0 || outCol < 0) continue;
        for (const row of table.rows) {
          const label = cleanCell(row[modelCol]);
          const input = cellPrice(row[inputCol]);
          const output = cellPrice(row[outCol]);
          if (!label || !input || !output) continue;
          quotes.push({
            displayName: label.replace(/^\*\*|\*\*$/g, ''),
            currency: 'CNY',
            prices: {
              input: input.value,
              output: output.value,
              cacheRead: readCol >= 0 ? cellPrice(row[readCol])?.value ?? null : null,
              cacheWrite5m: writeCol >= 0 ? cellPrice(row[writeCol])?.value ?? null : null,
              cacheWrite1h: null,
            },
            conditions: null,
          });
        }
      }
      return { quotes };
    },
  },

  stepfun: {
    id: 'stepfun',
    presetIds: ['stepfun', 'stepfun-anthropic'],
    request: { url: 'https://platform.stepfun.com/docs/zh/guides/pricing/details.md', format: 'md' },
    parse(text) {
      const quotes = [];
      for (const table of tablesFromMarkdown(text)) {
        const headers = table.headers;
        const modelCol = findColumn(headers, /模型/);
        // 「输入价格(缓存未命中)」与「输入价格(缓存命中)」两列都存在,必须按"是否含未命中"精确区分。
        const inputCol = headers.findIndex((h) => /输入价格/.test(h) && /未命中/.test(h));
        const outCol = findColumn(headers, /输出价格/);
        const readCol = headers.findIndex((h) => /输入价格/.test(h) && /命中/.test(h) && !/未命中/.test(h));
        if (modelCol < 0 || inputCol < 0 || outCol < 0) continue;
        const unit = cleanCell(row0(table, 1, headers));
        for (const row of table.rows) {
          const label = cleanCell(row[modelCol]);
          const input = cellPrice(row[inputCol]);
          const output = cellPrice(row[outCol]);
          if (!label || !input || !output) continue;
          quotes.push({
            displayName: label,
            currency: 'CNY',
            prices: {
              input: input.value,
              output: output.value,
              cacheRead: readCol >= 0 ? cellPrice(row[readCol])?.value ?? null : null,
              cacheWrite5m: null,
              cacheWrite1h: null,
            },
            conditions: unit ? { unit } : null,
          });
        }
      }
      return { quotes };
    },
  },

  perplexity: {
    id: 'perplexity',
    presetIds: ['perplexity'],
    request: { url: 'https://docs.perplexity.ai/docs/getting-started/pricing.md', format: 'md' },
    parse(text) {
      const quotes = quotesFromTables(tablesFromMarkdown(text), { currency: 'USD' });
      return { quotes };
    },
  },

  zai: {
    id: 'zai',
    presetIds: ['zai-intl'],
    request: { url: 'https://docs.z.ai/guides/overview/pricing.md', format: 'md' },
    parse(text) {
      const quotes = [];
      for (const table of tablesFromMarkdown(text)) {
        const headers = table.headers;
        const modelCol = findColumn(headers, /^model$/i);
        const inputCol = findColumn(headers, /^input$/i);
        const outCol = findColumn(headers, /^output$/i);
        const readCol = findColumn(headers, /^cached input$/i);
        if (modelCol < 0 || inputCol < 0 || outCol < 0) continue;
        for (const row of table.rows) {
          const label = cleanCell(row[modelCol]);
          const input = cellPrice(row[inputCol]);
          const output = cellPrice(row[outCol]);
          if (!label || !input || !output) continue;
          const read = readCol >= 0 ? cellPrice(row[readCol]) : null;
          quotes.push({
            displayName: label,
            currency: 'USD',
            prices: { input: input.value, output: output.value, cacheRead: read?.value ?? null, cacheWrite5m: null, cacheWrite1h: null },
            conditions: null,
          });
        }
      }
      return { quotes };
    },
  },

  groq: {
    id: 'groq',
    presetIds: ['groq'],
    request: { url: 'https://console.groq.com/docs/models.md', format: 'md' },
    parse(text) {
      // 价格单元格是「$0.15 input$0.60 output」;非 token 计价(每小时/每字符)与
      // ContactSales 一律跳过(不把别的单位当 token 价)。
      const quotes = [];
      for (const table of tablesFromMarkdown(text)) {
        const headers = table.headers;
        const modelCol = findColumn(headers, /^model id$/i);
        const priceCol = findColumn(headers, /price per 1m tokens/i);
        if (modelCol < 0 || priceCol < 0) continue;
        for (const row of table.rows) {
          const raw = String(row[modelCol] || '');
          const link = raw.match(/\]\((?:https:\/\/console\.groq\.com)?\/docs\/model\/([^)\s]+)\)/);
          const modelId = link ? link[1] : null;
          const label = cleanCell(raw.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
          const priceText = cleanCell(row[priceCol]);
          if (!modelId || /contact|per hour|per 1m characters|per character/i.test(priceText)) continue;
          const inputMatch = priceText.match(/\$([\d.,]+)\s*input/i);
          const outputMatch = priceText.match(/\$([\d.,]+)\s*output/i);
          if (!inputMatch || !outputMatch) continue;
          quotes.push({
            modelId,
            displayName: (label || modelId).replace(new RegExp(`${modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '').trim() || modelId,
            currency: 'USD',
            prices: { input: Number(inputMatch[1].replace(/,/g, '')), output: Number(outputMatch[1].replace(/,/g, '')), cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
            conditions: null,
          });
        }
      }
      return { quotes };
    },
  },

  together: {
    id: 'together',
    presetIds: ['together'],
    request: { url: 'https://www.together.ai/pricing', format: 'html' },
    parse(text) {
      const quotes = [];
      for (const table of tablesFromHtml(text)) {
        // 这些表没有表头(模型 / 输入 / 输出 三列),第一列是平台模型名。
        if (table.headers.length) continue;
        for (const row of table.rows) {
          const label = cleanCell(row[0]);
          if (!label || /^\$/.test(label)) continue;
          const input = cellPrice(row[1]);
          const output = cellPrice(row[2]);
          if (!input || !output || input.value <= 0) continue;
          const readMatch = cleanCell(row[1]).match(/(\$[\d.]+)\s*\(cached\)/i);
          quotes.push({
            displayName: label,
            currency: 'USD',
            prices: { input: input.value, output: output.value, cacheRead: readMatch ? cellPrice(readMatch[1])?.value ?? null : null, cacheWrite5m: null, cacheWrite1h: null },
            conditions: null,
          });
        }
      }
      return { quotes };
    },
  },

  fireworks: {
    id: 'fireworks',
    presetIds: ['fireworks', 'fireworks-anthropic'],
    request: { url: 'https://docs.fireworks.ai/serverless/pricing.md', format: 'md' },
    parse(text) {
      // 单元格是「input / cached / output」三段;模型名是带官方模型库链接的 markdown 链接。
      const quotes = [];
      for (const table of tablesFromMarkdown(text)) {
        const headers = table.headers;
        const modelCol = findColumn(headers, /^model$/i);
        const standardCol = findColumn(headers, /^standard$/i);
        const priorityCol = findColumn(headers, /^priority$/i);
        if (modelCol < 0 || standardCol < 0) continue;
        for (const row of table.rows) {
          const raw = row[modelCol];
          const link = String(raw).match(/\[([^\]]+)\]\((https:\/\/(?:app\.)?fireworks\.ai\/models\/([^)\s]+))\)/);
          const label = cleanCell(link ? link[1] : raw);
          if (!label) continue;
          const modelId = link ? link[3] : null;
          for (const [col, tier] of [[standardCol, 'standard'], [priorityCol, 'priority']]) {
            if (col < 0) continue;
            const parts = cleanCell(row[col]).split('/').map((part) => cellPrice(part));
            if (parts.length < 3 || !parts[0] || !parts[2]) continue;
            quotes.push({
              modelId,
              displayName: label,
              currency: 'USD',
              prices: { input: parts[0].value, output: parts[2].value, cacheRead: parts[1]?.value ?? null, cacheWrite5m: null, cacheWrite1h: null },
              conditions: tier === 'priority' ? { tier } : null,
            });
          }
        }
      }
      return { quotes };
    },
  },

  // Cerebras:公开 JSON API,单位 USD/token → 归一到每百万 token。
  cerebras: {
    id: 'cerebras',
    presetIds: ['cerebras'],
    request: { url: 'https://api.cerebras.ai/public/v1/models', format: 'json' },
    parse(text) {
      const data = JSON.parse(text);
      const list = Array.isArray(data?.data) ? data.data : [];
      const quotes = [];
      for (const item of list) {
        const id = typeof item?.id === 'string' ? item.id : null;
        const prompt = Number(item?.pricing?.prompt);
        const completion = Number(item?.pricing?.completion);
        if (!id || !Number.isFinite(prompt) || !Number.isFinite(completion)) continue;
        quotes.push({
          modelId: id,
          displayName: item.name || id,
          currency: 'USD',
          prices: { input: prompt * 1e6, output: completion * 1e6, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
          conditions: null,
        });
      }
      return { quotes };
    },
  },

  // OpenRouter:公开 Models JSON;长上下文 overrides 单独成一条报价(条件区分,不互相覆盖)。
  openrouter: {
    id: 'openrouter',
    presetIds: ['openrouter', 'openrouter-anthropic'],
    request: { url: 'https://openrouter.ai/api/v1/models', format: 'json' },
    parse(text) {
      const data = JSON.parse(text);
      const list = Array.isArray(data?.data) ? data.data : [];
      const quotes = [];
      for (const item of list) {
        const id = typeof item?.id === 'string' ? item.id : null;
        if (!id) continue;
        const price = item.pricing || {};
        const num = (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 0 ? n * 1e6 : null;
        };
        const input = num(price.prompt);
        const output = num(price.completion);
        if (input === null || output === null) continue;
        const base = {
          displayName: item.name || id,
          currency: 'USD',
          prices: { input, output, cacheRead: num(price.input_cache_read), cacheWrite5m: num(price.input_cache_write), cacheWrite1h: null },
        };
        const overrides = Array.isArray(price.overrides) ? price.overrides : [];
        if (!overrides.length) {
          quotes.push({ ...base, modelId: id, conditions: null });
          continue;
        }
        for (const override of overrides) {
          const minTokens = Number(override?.min_prompt_tokens);
          quotes.push({
            ...base,
            modelId: id,
            prices: {
              input: num(override?.prompt) ?? input,
              output: num(override?.completion) ?? output,
              cacheRead: num(override?.input_cache_read) ?? base.prices.cacheRead,
              cacheWrite5m: num(override?.input_cache_write) ?? base.prices.cacheWrite5m,
              cacheWrite1h: null,
            },
            conditions: Number.isFinite(minTokens) ? { minPromptTokens: minTokens } : { tier: 'override' },
          });
        }
      }
      return { quotes };
    },
  },

  // 火山方舟:官网壳页无价,走其公开文档接口拿 Result.MDContent(markdown 表)。
  volc: {
    id: 'volc',
    presetIds: ['doubao-volc'],
    request: { url: 'https://docs.volcengine.com/api/doc/getDocDetail?LibraryID=82379&DocumentID=1544106&lang=zh', format: 'json' },
    parse(text) {
      const data = JSON.parse(text);
      const result = data?.Result || {};
      const code = String(result.DocumentCode || '');
      if (!/model-pricing/i.test(code)) return { quotes: [] };
      const md = String(result.MDContent || '');
      return { quotes: quotesFromTables(tablesFromMarkdown(md), { currency: 'CNY' }) };
    },
  },

  // 302.AI:JSON 能取到,但响应里没有币种字段,官方未补证前不得标 USD → 只回报 partial,不落价。
  '302ai': {
    id: '302ai',
    presetIds: ['302ai', '302ai-anthropic'],
    request: { url: 'https://api.302.ai/dashboard/prices?path=%2Fchat%2Fcompletions&lang=zh', format: 'json' },
    parse(text) {
      const data = JSON.parse(text);
      const list = Array.isArray(data?.data) ? data.data : [];
      const modelCount = list.filter((item) => item && typeof item.model === 'string').length;
      return { quotes: [], modelCount, partialReason: 'PRICE_DIMENSION_UNKNOWN' };
    },
  },

  // Hyperbolic:旧价页已跳新首页,当前 token 价不可取得 —— 不请求,直接 source-unavailable。
  none: {
    id: 'none',
    presetIds: ['hyperbolic'],
    request: null,
    parse() {
      return { quotes: [], unavailable: true };
    },
  },
};

function row0(table, idx, headers) {
  return table.rows[0]?.[idx] ?? headers?.[idx] ?? '';
}

export function collectorFor(presetId) {
  const meta = PRESET_SOURCES[presetId];
  const collectorId = meta?.collector;
  if (!collectorId) return null;
  return COLLECTORS[collectorId] || null;
}

// 采集/报价形状的版本戳。旧快照的解析器版本不同 → 载入时直接丢弃(见 pricing-catalog.loadDisk),
// 下次刷新按新形状重建。pr6-1:DeepSeek 时段标签规范化(period:'peak'/'off-peak' + periodLabel)
// 与 validFrom;OpenAI 补 modelId。
export const PARSER_VERSION = 'pr6-1';
