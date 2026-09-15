#!/usr/bin/env node
// R33 护栏:轮末回合用量/花费必须用【整轮累计】口径,不是最后一次 API 调用。
//
// 用户实测(CLI 2.1.227,一轮 num_turns=2):
//   result.usage          = input 2771 / cache_read 56704 / output 99        ← 最后一次调用
//   result.modelUsage[..] = inputTokens 3018 / cacheReadInputTokens 57216 / outputTokens 339  ← 整轮累计
// 修前:回合气泡的输入/输出/花费与「整轮命中率」都吃 result.usage = 只算最后一次调用。
// 修后:resolveTurnUsage 优先取 modelUsage 的整轮累计,挑不中/缺失才回落 result.usage。
//
// 三条红线(本文件逐条守卫):
//  ① 上下文徽章「当前占用」链一字不动(分子只来自 message_start/message_delta);
//  ② 端到端接线:App.jsx result 分支必须走 resolveTurnUsage,旧裸赋值不得回潮;
//  ③ 命中率是加权累计口径 read/(input+read+creation),不是算术平均,分母 0 显示 —。
// 变异哨兵:把 App.jsx 的 resolveTurnUsage 换回 `resultUsage = event.usage;` → ⑧ 段断言红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  pickCliTurnUsage, resolveTurnUsage,
} from '../../client/src/utils/contextWindow.js';
import { cacheHitPct, formatHitPct, formatHitPctOrDash } from '../../client/src/utils/cacheStats.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// fixture:R33 实测真实数字。entry 形态同 CLI(camelCase),
const muEntry = (extra = {}) => ({
  inputTokens: 3018, outputTokens: 339, cacheReadInputTokens: 57216,
  cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.01,
  contextWindow: 200000, maxOutputTokens: 64000, ...extra,
});
// result.usage = 最后一次调用(实测值)
const lastCallUsage = {
  input_tokens: 2771, output_tokens: 99, cache_read_input_tokens: 56704,
  cache_creation_input_tokens: 0,
};

// ── ① 多调用回合:用 modelUsage 累计值,不是 result.usage(最后一次) ──────────
{
  const mu = { 'deepseek-flash': muEntry() };
  const out = resolveTurnUsage(lastCallUsage, mu, 'deepseek-flash');
  assert.deepEqual(
    { i: out.input_tokens, o: out.output_tokens, r: out.cache_read_input_tokens, c: out.cache_creation_input_tokens },
    { i: 3018, o: 339, r: 57216, c: 0 },
    '回合四字段必须是整轮累计(3018/339/57216/0),不是最后一次调用(2771/99/56704/0)');
  // 反向:不得等于 result.usage 的数(变异哨兵:回落到旧行为这里红)
  assert.notEqual(out.input_tokens, lastCallUsage.input_tokens, '不得沿用最后一次调用的 input');
  assert.notEqual(out.cache_read_input_tokens, lastCallUsage.cache_read_input_tokens, '不得沿用最后一次调用的 cache_read');
  // 其余字段(如 ccgui_usage 码)原样保留
  const withCodes = resolveTurnUsage(
    { ...lastCallUsage, ccgui_usage: { codes: ['USAGE_INCONSISTENT'], raw: { a: 1 } } }, mu, 'deepseek-flash');
  assert.deepEqual(withCodes.ccgui_usage, { codes: ['USAGE_INCONSISTENT'], raw: { a: 1 } },
    'event.usage 的非 token 字段(ccgui_usage 告警)必须保留');
  // pickCliTurnUsage 直出形状
  assert.deepEqual(pickCliTurnUsage(mu, 'deepseek-flash').usage.input_tokens, 3018, 'pickCliTurnUsage 返回归一后的 snake_case');
}

// ── ② modelUsage 缺失 / 挑不中 → 回落 result.usage(旧行为) ─────────────────
{
  assert.deepEqual(resolveTurnUsage(lastCallUsage, undefined, 'm'), lastCallUsage, 'modelUsage 缺失回落');
  assert.deepEqual(resolveTurnUsage(lastCallUsage, null, 'm'), lastCallUsage, 'null 回落');
  assert.equal(resolveTurnUsage(null, undefined, 'm'), null, '两者都缺 → null');
  // 多 entry 且无 exact(子代理跑了别的模型)→ 不猜,回落
  const multi = { 'm-a': muEntry(), 'm-b': muEntry({ outputTokens: 7 }) };
  assert.equal(pickCliTurnUsage(multi, 'm-c'), null, '多 entry 无 exact 不猜');
  assert.deepEqual(resolveTurnUsage(lastCallUsage, multi, 'm-c'), lastCallUsage, '挑不中回落 result.usage');
}

// ── ③ exact 优先 / 单 entry 兜底(与徽章分母同源策略) ────────────────────────
{
  const multi = { 'main-model': muEntry(), 'claude-haiku-4-5': muEntry({ outputTokens: 7 }) };
  assert.equal(pickCliTurnUsage(multi, 'main-model').usage.output_tokens, 339, '多 entry 时 exact 命中主模型');
  const single = { 'claude-opus-5': muEntry({ inputTokens: 100 }) };
  assert.equal(pickCliTurnUsage(single, 'opus').usage.input_tokens, 100, '单 entry 兜底(第三方别名)');
  assert.equal(pickCliTurnUsage(single, null).usage.input_tokens, 100, 'modelId 缺失(无 message_start)单 entry 兜底');
}

// ── ④ 防伪:HALF 字段 / 脏值 ────────────────────────────────────────────────
{
  // entry 全部 token 字段缺失(CLI 换字段名等)→ 不采,宁可回落也不显示全 0
  assert.equal(pickCliTurnUsage({ m: { contextWindow: 200000 } }, 'm'), null, 'token 全缺不采');
  assert.equal(pickCliTurnUsage({ m: muEntry({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }) }, 'm'),
    null, 'token 全 0 不采(视为未上报)');
  // 脏值(负数/NaN/字符串)单字段归 0;全部字段脏 → total<=0 不采
  assert.equal(pickCliTurnUsage({ m: muEntry({ inputTokens: -5, outputTokens: NaN, cacheReadInputTokens: '99' }) }, 'm'),
    null, '全脏字段归一为 0 → 不采');
  const dirty2 = pickCliTurnUsage({ m: muEntry({ inputTokens: -5 }) }, 'm');
  assert.equal(dirty2.usage.input_tokens, 0, '负数归 0');
  assert.equal(dirty2.usage.cache_read_input_tokens, 57216, '其余字段照常');
}

// ── ⑤ 命中率 = 加权累计口径(合同公式),分母 0 → — ───────────────────────────
{
  const out = resolveTurnUsage(lastCallUsage, { 'deepseek-flash': muEntry() }, 'deepseek-flash');
  const i = out.input_tokens, r = out.cache_read_input_tokens, c = out.cache_creation_input_tokens;
  const pct = cacheHitPct(r, c, i);
  const expected = (r / (i + r + c)) * 100;             // 合同:read/(input+read+creation)
  assert.ok(Math.abs(pct - expected) < 1e-9, `命中率=${pct} 必须等于加权累计 ${expected}`);
  // 与"两次调用各自命中率取算术平均"对照:第一次 read 512/input 247(67.5%),
  // 第二次 read 56704/input 2771(95.3%)→ 平均 ≈ 81.4%;加权累计 = 95.0% —— 口径必须后者。
  const perCall = [
    { r: r - lastCallUsage.cache_read_input_tokens, i: i - lastCallUsage.input_tokens, c: 0 },
    { r: lastCallUsage.cache_read_input_tokens, i: lastCallUsage.input_tokens, c: 0 },
  ].map((u) => cacheHitPct(u.r, u.c, u.i));
  const naiveAvg = (perCall[0] + perCall[1]) / 2;
  assert.ok(Math.abs(pct - naiveAvg) > 0.5, `加权累计(${pct.toFixed(2)})与算术平均(${naiveAvg.toFixed(2)})必须可区分`);
  assert.equal(formatHitPct(pct), '95.0%', '显示格式');
  // 分母 0(纯输出回合)→ 显示「—」不显示 0.0%
  assert.equal(formatHitPctOrDash(cacheHitPct(0, 0, 0), 0), '—', '分母 0 显示 —');
  assert.equal(formatHitPctOrDash(cacheHitPct(r, c, i), i + r + c), formatHitPct(pct), '分母>0 正常显示');
}

// ── ⑥ 源码哨兵:App.jsx 接线(R33) ──────────────────────────────────────────
{
  const app = readFileSync(join(root, 'client', 'src', 'App.jsx'), 'utf8');
  assert.ok(/resultUsage = resolveTurnUsage\(event\.usage, event\.modelUsage, turnModel\)/.test(app),
    'result 分支必须经 resolveTurnUsage(event.usage, event.modelUsage, turnModel)');
  assert.ok(!/resultUsage = event\.usage;/.test(app), '旧裸赋值(resultUsage = event.usage)不得回潮');
  assert.ok(/usage: resultUsage/.test(app), '回合记录仍接线 resultUsage(展示链不断)');
  assert.ok(/usage: resultUsage,[\s\S]{0,80}costUsd: resultCostUsd/.test(app), 'costUsd 接线原样(官方 total_cost_usd 优先逻辑不动)');
}

// ── ⑦ 源码哨兵:上下文徽章链一字不动(分子只来自单次调用) ────────────────────
{
  const app = readFileSync(join(root, 'client', 'src', 'App.jsx'), 'utf8');
  assert.ok(/setLiveContextUsage\(\{ \.\.\.u, _ts: Date\.now\(\) \}\)/.test(app), '分子仍来自 message_start');
  assert.ok(/setLiveContextUsage\(\{ \.\.\.ev\.usage, _ts: Date\.now\(\) \}\)/.test(app), '分子仍来自 message_delta');
  // R33 新块(set resultUsage 的那段)绝不写徽章分子
  const blkStart = app.indexOf("event.type === 'result' && !isCompact && (event.usage || event.modelUsage)");
  assert.ok(blkStart > -1, 'R33 result 分支存在');
  const blk = app.slice(blkStart, app.indexOf('\n          }', blkStart));
  assert.ok(!/setLiveContextUsage/.test(blk), 'R33 块绝不写徽章分子');
  // 且新版 modelUsage 消费点仍是 R8-6 那个只读 contextWindow 的块(未把 token 混进分母缓存)
  assert.ok(/pickCliContextWindow\(event\.modelUsage, turnModel\)/.test(app), 'R8-6 徽章分母消费点原样');
  assert.ok(!/resolvedWindowCache\.set\(wk, [^)]*Tokens/.test(app), '分母缓存不得混入整轮 token');
}

// ── ⑧ 源码哨兵:TurnBubble 整轮命中率公式与标注 ─────────────────────────────
{
  const tb = readFileSync(join(root, 'client', 'src', 'components', 'TurnBubble.jsx'), 'utf8');
  // R43 把这处从「行内展示」搬进了行容器的悬停文案(title) —— 哨兵不再钉 JSX 的花括号写法
  // (行内 `{…}` 与 title 模板 `${…}` 都要能过),但仍逐字钉住**名字与数值口径三件**:
  // 分母 = input+read+creation、数值 = 加权累计 cacheHitPct(read,creation,input)、分母 0 显示 —
  // 三件任一被改名/换公式/丢掉 0 分母回退(或整段被删) → 红。
  assert.ok(/整轮命中率\s*(\$\{|\{)/.test(tb),
    '轮末仍以「整轮命中率」标名,且名字后面必须跟一个插值的数值(不是写死的字符串,也不是注释里的提法)');
  assert.ok(/整轮命中率[\s\S]{0,60}?cacheRead \+ cacheWrite \+ input > 0[\s\S]{0,60}?formatHitPct\(cacheHitPct\(cacheRead, cacheWrite, input\)\)[\s\S]{0,60}?:\s*'—'/.test(tb),
    '轮末行:公式=加权累计 cacheHitPct(read,creation,input),分母 0 显示 —');
  // 2026-09-11 计价修正:UsageDisplay 的入参由 usage/model/costUsd 三件套换成整个 turn
  // (带 usageCalls 才能按每次调用各自的时刻计价)—— 口径不变:读数仍是 turn.usage(整轮累计)。
  assert.ok(/<UsageDisplay message=\{turn\} \/>/.test(tb), 'UsageDisplay 仍由 turn 驱动');
  assert.ok(/const usage = message\?\.usage;/.test(tb), 'UsageDisplay 取值仍是整轮 usage(不是最后一次调用)');
}

console.log('✓ check-r33-turn-usage-round: 整轮累计优先 + 回落 + 防伪 + 命中率加权 + 徽章红线守卫 全过');
