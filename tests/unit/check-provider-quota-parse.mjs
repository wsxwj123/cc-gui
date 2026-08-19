#!/usr/bin/env node
// r16-2:第三方 provider 额度接口的候选选择 + 响应解析护栏。
// Run: node tests/unit/check-provider-quota-parse.mjs
//
// 守的是"规格里那些有实证的坑",每条都对应一次线上会读错的展示:
//   ① One-API 无限额度返回 1e8 —— 要认成"无限",不能显示一亿
//   ② One-API 的 hard_limit_usd 单位不可靠 —— currency 必须为 null(UI 不加 ¥/$)
//   ③ 智谱/MiniMax 出错时 HTTP 仍是 200,错误在 body 的 code / base_resp.status_code
//   ④ MiniMax 的 total_count/usage_count 可能双 0 —— 直接读 percent,不许反算(除零)
//   ⑤ OpenRouter 的 limit_reset=null 是终身累计上限 —— 绝不能标"本月"
//   ⑥ 智谱窗口靠 unit+number 判(官方脚本自己把两条都命名成 5 小时,不能跟着抄)
//   ⑦ 字符串数字(DeepSeek/SiliconFlow)先 Number() 再 isFinite;空串不是 0
// 另外钉死方向词:三家方向不一致(已用% / 剩余% / 剩余绝对量),UI 少一个方向词就读反。
import assert from 'node:assert/strict';
import {
  pickCandidates, authHeaders, parseQuota, computeLow, normalizeThresholds,
  DEFAULT_THRESHOLDS, reasonNote, num, toMs, windowLabel,
} from '../../server/services/provider-quota.js';
import {
  quotaItemText, quotaUsedPercent, quotaTone, directionWord, currencySymbol,
} from '../../client/src/utils/quotaFormat.js';

const one = (provider) => {
  const c = pickCandidates(provider);
  assert.equal(c.length, 1, `期望恰好一个候选:${provider.baseURL}`);
  return c[0];
};
const parse1 = (provider, body) => parseQuota(one(provider), [body]);

// ── 候选端点选择(识别 = host + path,逐条照规格) ──────────────────────────
{
  const kimi = one({ baseURL: 'https://api.kimi.com/coding', type: 'anthropic' });
  assert.equal(kimi.vendor, 'kimi-coding');
  assert.deepEqual(kimi.urls, ['https://api.kimi.com/coding/v1/usages'], '/v1/usages 是复数');
  assert.equal(kimi.auth, 'bearer');
  assert.deepEqual(one({ baseURL: 'https://api.kimi.com/coding/v1', type: 'anthropic' }).urls,
    ['https://api.kimi.com/coding/v1/usages'], 'base 已以 /v1 结尾时不许拼成 /v1/v1(与 opencode 同一套防御)');
  // 同 host 但 path 不含 /coding → 不是 Kimi Code 那条线
  assert.deepEqual(pickCandidates({ baseURL: 'https://api.kimi.com/v1', type: 'anthropic' }), [],
    'api.kimi.com 非 /coding 路径没有实证端点 → 不瞎猜');

  const ms = one({ baseURL: 'https://api.moonshot.cn/anthropic', type: 'anthropic' });
  assert.deepEqual(ms.urls, ['https://api.moonshot.cn/v1/users/me/balance'], '余额端点在 origin 顶级,不跟 path');
  assert.equal(ms.currency, 'CNY', '.cn 计人民币');
  assert.equal(one({ baseURL: 'https://api.moonshot.ai/v1', type: 'openai' }).currency, 'USD', '.ai 计美元');

  assert.deepEqual(one({ baseURL: 'https://api.deepseek.com/anthropic', type: 'anthropic' }).urls,
    ['https://api.deepseek.com/user/balance'], 'DeepSeek 余额是顶级路径,要剥掉 /anthropic');

  const zp = one({ baseURL: 'https://open.bigmodel.cn/api/anthropic', type: 'anthropic' });
  assert.deepEqual(zp.urls, ['https://open.bigmodel.cn/api/monitor/usage/quota/limit']);
  assert.equal(zp.auth, 'raw', '智谱是裸 token,不加 Bearer');
  assert.equal(one({ baseURL: 'https://api.z.ai/api/anthropic', type: 'anthropic' }).vendor, 'zhipu');

  assert.deepEqual(one({ baseURL: 'https://api.minimaxi.com/anthropic', type: 'anthropic' }).urls,
    ['https://api.minimaxi.com/v1/token_plan/remains']);
  assert.equal(one({ baseURL: 'https://api.minimax.io/v1', type: 'openai' }).vendor, 'minimax');

  // opencode:base 已以 /v1 结尾就直接拼 /usage,别拼成 /v1/v1
  assert.deepEqual(one({ baseURL: 'https://opencode.ai/zen/v1', type: 'openai' }).urls, ['https://opencode.ai/zen/v1/usage']);
  assert.deepEqual(one({ baseURL: 'https://opencode.ai/zen', type: 'openai' }).urls, ['https://opencode.ai/zen/v1/usage']);
  assert.deepEqual(one({ baseURL: 'https://opencode.ai/zen/v1/', type: 'openai' }).urls, ['https://opencode.ai/zen/v1/usage'],
    '尾部斜杠不该产生 //usage');

  assert.deepEqual(one({ baseURL: 'https://api.siliconflow.cn/v1', type: 'openai' }).urls, ['https://api.siliconflow.cn/v1/user/info']);
  const or = one({ baseURL: 'https://openrouter.ai/api/v1', type: 'openai' });
  assert.deepEqual(or.urls, ['https://openrouter.ai/api/v1/key']);
  assert.equal(or.currency, 'USD');

  // 兜底:其余 openai 协议 → 两条 dashboard 端点(两条都要)
  const fb = one({ baseURL: 'https://my-relay.example.com/v1', type: 'openai' });
  assert.equal(fb.vendor, 'oneapi');
  assert.deepEqual(fb.urls, [
    'https://my-relay.example.com/v1/dashboard/billing/subscription',
    'https://my-relay.example.com/v1/dashboard/billing/usage',
  ], 'One-API 兜底要两条端点');
  // anthropic 协议的陌生 host 没有兜底(表里只给 openai 协议)
  assert.deepEqual(pickCandidates({ baseURL: 'https://relay.example.com/anthropic', type: 'anthropic' }), []);

  // 明确"没有额度接口"的几家:一个请求都不该发
  for (const host of ['api.xiaomimimo.com', 'dashscope.aliyuncs.com', 'ark.cn-beijing.volces.com',
    'api.hunyuan.cloud.tencent.com', 'qianfan.baidubce.com']) {
    assert.deepEqual(pickCandidates({ baseURL: `https://${host}/v1`, type: 'openai' }), [], `${host} 无额度接口`);
  }
  // 脏 baseURL 不抛
  for (const bad of [null, '', 'not a url', 'ftp:/x']) {
    assert.deepEqual(pickCandidates({ baseURL: bad, type: 'openai' }), [], `脏 baseURL(${bad})不抛也不发请求`);
  }
}

// ── 认证头:智谱裸 token 是唯一特例(写错就是 401) ─────────────────────────
{
  assert.deepEqual(authHeaders('bearer', 'K'), { Authorization: 'Bearer K' });
  assert.deepEqual(authHeaders('raw', 'K'), { Authorization: 'K' });
}

// ── Kimi Code:剩余量(绝对数),currency 恒 null(是 token/次数不是钱) ────────
{
  const p = { baseURL: 'https://api.kimi.com/coding', type: 'anthropic' };
  const r = parse1(p, {
    usage: { remaining: 1200, limit: 5000 },
    limits: [{ window: 18000, detail: { remaining: 300, limit: 1000 } }],
  });
  assert.equal(r.kind, 'amount');
  assert.equal(r.currency, null, 'Kimi 的额度不是钱 → 不加货币符号');
  assert.equal(r.items[0].direction, 'left', '方向是剩余');
  assert.equal(r.items[0].value, 1200);
  assert.equal(r.items[0].max, 5000);
  assert.equal(r.items[1].label, '5 小时', 'window=18000 秒 → 5 小时');
  assert.equal(r.items[1].value, 300);
  assert.equal(parse1(p, { usage: {} }), null, '没有可解析字段 → null(静默降级)');
  assert.equal(parse1(p, '<html>404</html>'), null, '非对象 → null 不抛');
}

// ── Moonshot:钱,单位由 host 决定 ────────────────────────────────────────
{
  const cn = { baseURL: 'https://api.moonshot.cn/anthropic', type: 'anthropic' };
  const r = parse1(cn, { code: 0, data: { available_balance: 110.5, cash_balance: 100 } });
  assert.equal(r.kind, 'amount');
  assert.equal(r.currency, 'CNY');
  assert.equal(r.items[0].value, 110.5);
  assert.equal(r.items[0].direction, 'left');
  assert.equal(parse1({ baseURL: 'https://api.moonshot.ai/v1', type: 'openai' },
    { data: { available_balance: 3 } }).currency, 'USD');
  assert.equal(parse1(cn, { error: { type: 'auth_error' } }), null, '错误体 → null');
}

// ── DeepSeek:字符串金额(坑⑦) ──────────────────────────────────────────
{
  const p = { baseURL: 'https://api.deepseek.com/anthropic', type: 'anthropic' };
  const r = parse1(p, {
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '0.00', topped_up_balance: '110.00' }],
  });
  assert.equal(r.items[0].value, 110, '字符串 "110.00" → 数字 110');
  assert.equal(r.currency, 'CNY');
  assert.equal(parse1(p, { balance_infos: [{ currency: 'CNY', total_balance: '' }] }), null,
    '空串不是 0(Number("")===0 会把缺字段伪装成余额 0)');
  assert.equal(parse1(p, { balance_infos: [] }), null, '空数组 → null');
  assert.equal(parse1(p, { balance_infos: [{ total_balance: 'abc' }] }), null, '非数字字符串 → null');
}

// ── 智谱:已用%,窗口靠 unit+number(坑⑥),HTTP 200 但 body 报错(坑③) ────
{
  const p = { baseURL: 'https://open.bigmodel.cn/api/anthropic', type: 'anthropic' };
  const ok = parse1(p, {
    code: 200,
    msg: 'success',
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 44.4 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 12 },
        { type: 'TIME_LIMIT', percentage: 3 },
      ],
    },
  });
  assert.equal(ok.kind, 'percent');
  assert.deepEqual(ok.items.map((i) => i.label), ['5 小时', '周', '月'],
    '两条 TOKENS_LIMIT 必须按 unit+number 分成 5 小时 / 周(官方脚本把两条都叫 5 小时,不能抄)');
  assert.ok(ok.items.every((i) => i.direction === 'used'), '智谱回的是已用%');
  assert.equal(ok.items[0].percent, 44.4);
  // 坑③:HTTP 200 但 body 里 code 非 200/0
  assert.equal(parse1(p, { code: 401, msg: 'token 无效', data: { limits: [{ unit: 3, number: 5, percentage: 0 }] } }), null,
    'body 里 code 报错 → 解析失败(不能只看 HTTP 状态码)');
  assert.equal(parse1(p, { data: { limits: [] } }), null, '空 limits → null');
}

// ── MiniMax:剩余%,双 0 不许反算(坑④),base_resp 报错(坑③) ──────────────
{
  const p = { baseURL: 'https://api.minimaxi.com/anthropic', type: 'anthropic' };
  const r = parse1(p, {
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [{
      model: 'MiniMax-M2', total_count: 0, usage_count: 0,
      current_interval_remaining_percent: 13, current_weekly_remaining_percent: 88,
    }],
  });
  assert.equal(r.kind, 'percent');
  assert.ok(r.items.every((i) => i.direction === 'left'), 'MiniMax 回的是剩余%');
  assert.deepEqual(r.items.map((i) => [i.label, i.percent]), [['5 小时', 13], ['周', 88]],
    'total/usage 双 0 时照样出百分比(直接读 percent 字段,不反算)');
  assert.equal(parse1(p, {
    base_resp: { status_code: 1004, status_msg: 'auth failed' },
    model_remains: [{ current_interval_remaining_percent: 100 }],
  }), null, 'base_resp.status_code 非 0 → 解析失败(HTTP 仍是 200)');
  assert.equal(parse1(p, { base_resp: { status_code: 0 }, model_remains: [] }), null, '空 model_remains → null');
}

// ── opencode:已用%,三窗口 ───────────────────────────────────────────────
{
  const p = { baseURL: 'https://opencode.ai/zen/v1', type: 'openai' };
  const r = parse1(p, {
    usage: {
      rolling: { percent: 22, resetsAt: '2026-08-19T10:00:00Z' },
      weekly: { percent: 61, resetsAt: 1755600000 },
      monthly: { percent: 5 },
    },
  });
  assert.deepEqual(r.items.map((i) => i.label), ['滚动窗口', '周', '月']);
  assert.ok(r.items.every((i) => i.direction === 'used'));
  assert.equal(r.items[0].resetAt, Date.parse('2026-08-19T10:00:00Z'), 'ISO 时间 → 毫秒');
  assert.equal(r.items[1].resetAt, 1755600000000, 'epoch 秒 → 毫秒');
  assert.equal(r.items[2].resetAt, null, '没有 resetsAt → null');
  assert.equal(parse1(p, { usage: {} }), null);
}

// ── SiliconFlow:balance 是剩余可用,totalBalance 会虚高 ────────────────────
{
  const p = { baseURL: 'https://api.siliconflow.cn/v1', type: 'openai' };
  const r = parse1(p, { code: 20000, message: 'OK', status: true, data: { balance: '8.50', totalBalance: '108.50' } });
  assert.equal(r.items[0].value, 8.5, '取 data.balance(剩余可用),不是 totalBalance');
  assert.equal(r.currency, null, '站点侧不回传计价口径 → 不加货币符号');
}

// ── OpenRouter:null limit = 无上限(坑⑤ 顺带钉死"不许标本月") ─────────────
{
  const p = { baseURL: 'https://openrouter.ai/api/v1', type: 'openai' };
  const unl = parse1(p, { data: { label: 'sk-or-…', usage: 3.2, limit: null, limit_remaining: null } });
  assert.equal(unl.items[0].unlimited, true, 'limit 与 limit_remaining 同为 null = 无上限');
  assert.equal(unl.items[0].percent, undefined, '无上限就没有分母,不许给百分比');
  assert.equal(quotaItemText(unl.items[0], unl.currency), '额度 · 无限');

  const life = parse1(p, { data: { limit: 10, limit_remaining: 2.5, limit_reset: null } });
  assert.equal(life.items[0].label, '累计（终身）', 'limit_reset=null 是终身累计上限');
  assert.ok(!/月/.test(quotaItemText(life.items[0], life.currency)), '绝不能标"本月"');
  assert.equal(life.items[0].value, 2.5);
  assert.equal(life.items[0].max, 10);
  assert.equal(parse1(p, { data: { limit: 10, limit_remaining: 2.5, limit_reset: 'monthly' } }).items[0].label, '月');
  assert.equal(parse1(p, {}), null);
  // 有上限但读不到剩余量 → 整条降级成"查不到",不许渲染一行只有周期、没数字没方向词的空条目
  assert.equal(parse1(p, { data: { limit: 10, limit_remaining: null, limit_reset: null } }), null,
    'limit_remaining 缺失 → 不给半条数据(UI 会显示成一行光秃秃的"累计（终身）")');
  // "两者为 null = 无上限"的判据是**两个键都在且都为 null**,不能把"根本没这两个键"当无限
  assert.equal(parse1(p, { data: { label: 'sk-or-…', usage: 3.2 } }), null,
    '响应里根本没有 limit/limit_remaining 键 → 不许自信地判成"无限"');
}

// ── One-API 兜底:1e8=无限(坑①)、单位不可靠(坑②)、total_usage 已 ×100 ────
{
  const p = { baseURL: 'https://my-relay.example.com/v1', type: 'openai' };
  const c = one(p);
  const r = parseQuota(c, [{ object: 'billing_subscription', hard_limit_usd: 100 }, { object: 'list', total_usage: 2500 }]);
  assert.equal(r.items[0].value, 75, '余额 = hard_limit_usd − total_usage/100');
  assert.equal(r.items[0].max, 100);
  assert.equal(r.currency, null, '单位不可靠(站点可配 USD/CNY/token 数)→ UI 不加符号');
  assert.ok(!/[¥$]/.test(quotaItemText(r.items[0], r.currency)), '文案里不许出现货币符号');

  const unl = parseQuota(c, [{ hard_limit_usd: 100000000 }, { total_usage: 12345 }]);
  assert.equal(unl.items[0].unlimited, true, '1e8 = 无限额度');
  assert.ok(!/100,?000,?000/.test(quotaItemText(unl.items[0], unl.currency)), '不能把一亿显示出来');
  assert.equal(parseQuota(c, [{}, { total_usage: 1 }]), null, '缺 hard_limit_usd → null');
  assert.equal(parseQuota(c, [{ hard_limit_usd: 10 }]), null, '缺第二条响应 → total_usage 缺失');
}

// ── 低额度判定:方向词是判据的一半 ────────────────────────────────────────
{
  const pct = (direction, percent) => ({ kind: 'percent', currency: null, items: [{ label: 'x', direction, percent }] });
  assert.equal(computeLow(pct('used', 90)), true, '已用 90% → 亮红点');
  assert.equal(computeLow(pct('used', 89.9)), false);
  assert.equal(computeLow(pct('left', 10)), true, '剩余 10% → 亮红点');
  assert.equal(computeLow(pct('left', 10.1)), false);
  // 方向读反的后果(这条断言就是防它):剩余 95% 绝不能报警
  assert.equal(computeLow(pct('left', 95)), false, '剩余 95% 不是低额度');
  assert.equal(computeLow(pct('used', 5)), false, '已用 5% 不是低额度');

  const money = (currency, value) => ({ kind: 'amount', currency, items: [{ label: '余额', direction: 'left', value }] });
  assert.equal(computeLow(money('CNY', 9.99)), true, '默认 ¥10 阈值');
  assert.equal(computeLow(money('CNY', 10.01)), false);
  assert.equal(computeLow(money('USD', 1.99)), true, '默认 $2 阈值');
  assert.equal(computeLow(money('USD', 5)), false, '$5 不低(用人民币阈值就会误报)');
  assert.equal(computeLow(money(null, 5)), true, '单位不明按人民币档兜底');

  // 有分母的绝对数走比例,不走钱的阈值(Kimi 的 token 数用 ¥10 判毫无意义)
  const ratio = (value, max) => ({ kind: 'amount', currency: null, items: [{ label: '额度', direction: 'left', value, max }] });
  assert.equal(computeLow(ratio(50, 1000)), true, '剩余 5% → 低');
  assert.equal(computeLow(ratio(300, 1000)), false, '剩余 30% 不低(尽管 300 > ¥10 阈值也不该走钱那条)');
  assert.equal(computeLow({ items: [{ label: '额度', direction: 'left', unlimited: true }] }), false, '无限永不报警');
  assert.equal(computeLow(null), false, '空 payload 不抛');
  // 多项里任一触发即亮
  assert.equal(computeLow({ items: [{ direction: 'used', percent: 1 }, { direction: 'used', percent: 99 }] }), true);
}

// ── 阈值可配(prefs.json 的 quotaThresholds),脏值回落默认 ──────────────────
{
  assert.deepEqual(normalizeThresholds(null), DEFAULT_THRESHOLDS);
  assert.deepEqual(normalizeThresholds({ usedPercent: 'x', cny: -1, usd: null }), DEFAULT_THRESHOLDS, '脏值一律回落默认');
  assert.equal(normalizeThresholds({ cny: 50 }).cny, 50);
  assert.equal(normalizeThresholds({ cny: 50 }).usd, DEFAULT_THRESHOLDS.usd, '只覆盖传进来的键');
  const t = { usedPercent: 50, leftPercent: 40, cny: 100, usd: 50 };
  assert.equal(computeLow({ items: [{ direction: 'used', percent: 60 }] }, t), true, '自定义阈值生效');
  assert.equal(computeLow({ items: [{ direction: 'used', percent: 60 }] }), false, '同一份数据在默认阈值下不报警');
}

// ── 展示层:方向词 + 周期必须同时出现 ──────────────────────────────────────
{
  assert.equal(quotaItemText({ label: '5 小时', direction: 'used', percent: 44 }), '5 小时 · 已用 44%');
  assert.equal(quotaItemText({ label: '周', direction: 'left', percent: 13 }), '周 · 剩余 13%');
  assert.equal(quotaItemText({ label: '余额', direction: 'left', value: 110 }, 'CNY'), '余额 ¥110');
  assert.equal(quotaItemText({ label: '余额', direction: 'left', value: 110.5 }, 'CNY'), '余额 ¥110.50');
  assert.equal(quotaItemText({ label: '额度', direction: 'left', value: 1200, max: 5000 }), '额度 · 剩余 1,200 / 5,000');
  assert.equal(quotaItemText({ label: '额度', direction: 'left', value: 2.5, max: 10 }, 'USD'), '额度 · 剩余 $2.50 / $10');
  for (const it of [{ label: '周', direction: 'used', percent: 1 }, { label: '周', direction: 'left', percent: 1 }]) {
    assert.match(quotaItemText(it), /已用|剩余/, '每一项都必须带方向词');
  }
  assert.equal(directionWord('used'), '已用');
  assert.equal(directionWord('left'), '剩余');
  assert.equal(currencySymbol(null), '', 'currency=null 不加符号');

  // 进度条统一换算成"已用"口径(满格=耗尽),与官方订阅卡同色阶
  assert.equal(quotaUsedPercent({ direction: 'used', percent: 44 }), 44);
  assert.equal(quotaUsedPercent({ direction: 'left', percent: 13 }), 87, '剩余 13% → 条填 87%');
  assert.equal(quotaUsedPercent({ direction: 'left', value: 300, max: 1000 }), 70);
  assert.equal(quotaUsedPercent({ direction: 'left', value: 110 }), null, '没有分母 → 不画条');
  assert.equal(quotaUsedPercent({ unlimited: true }), null);
  assert.equal(quotaUsedPercent({ direction: 'left', percent: 130 }), 0, '脏数据夹紧到 0..100');
  assert.match(quotaTone(90), /error/);
  assert.equal(quotaTone(70), '#d97706');
  assert.match(quotaTone(69), /accent/);
}

// ── 小工具边界 ──────────────────────────────────────────────────────────
{
  assert.equal(num('  12.5 '), 12.5);
  assert.equal(num(''), null);
  assert.equal(num(true), null, '布尔不是数字(Number(true)===1)');
  assert.equal(num(Infinity), null);
  assert.equal(toMs('not-a-date'), null);
  assert.equal(windowLabel(604800), '周');
  assert.equal(windowLabel(86400), '日');
  assert.equal(windowLabel('5h'), '5 小时');
  assert.equal(windowLabel('weird-window'), 'weird-window', '认不出就原样回显,不猜成"本月"');
  assert.equal(reasonNote('no-endpoint'), '该 provider 不提供额度接口');
  assert.match(reasonNote('auth'), /密钥/);
  assert.match(reasonNote('network'), /网络/);
}

// ── 变异验证(证明断言真的咬得住) ─────────────────────────────────────────
{
  // 若 One-API 的 1e8 判定被删,unlimited 会变成一个天文数字的 value
  const c = one({ baseURL: 'https://r.example.com/v1', type: 'openai' });
  const unl = parseQuota(c, [{ hard_limit_usd: 1e8 }, { total_usage: 0 }]);
  assert.notEqual(unl.items[0].value, 1e8, '变异验证:去掉 UNLIMITED 分支这里会拿到 1e8');
  // 若智谱 unit/number 判被换成"都叫 5 小时",这条会挂
  const zp = parseQuota(one({ baseURL: 'https://open.bigmodel.cn/api/anthropic', type: 'anthropic' }),
    [{ code: 200, data: { limits: [{ unit: 6, number: 1, percentage: 9 }] } }]);
  assert.equal(zp.items[0].label, '周', '变异验证:窗口判据写死成 5 小时时这里会挂');
}

console.log('✅ check-provider-quota-parse 通过');
