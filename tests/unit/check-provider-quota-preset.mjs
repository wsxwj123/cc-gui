#!/usr/bin/env node
// D-1:预设身份判定(matchPresetByBaseURL)+ 额度候选**按预设身份**分派。
// Run: node tests/unit/check-provider-quota-preset.mjs
//
// 守的是两件事:
//   ① matchPresetByBaseURL 是全产品唯一一份"这是不是某家官方入口"的口径(D/E 共用),
//      比对 = host 逐字相等 —— 同家的 openai/anthropic 兼容入口都命中,子域不互相命中;
//   ② 候选分派按**预设 id**、不按 host 字面量;凭证只发该 key 的域族(CN 族 key 绝不
//      发 api.z.ai,反之亦然)—— 这条写错就是把用户 key 发到了另一个法人主体的服务器上。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchPresetByBaseURL, BUILTIN_PROVIDERS } from '../../server/utils/builtin-providers.js';
import { pickCandidates } from '../../server/services/provider-quota.js';

// ── ① matchPresetByBaseURL ───────────────────────────────────────────────
{
  // 自反性:预设表每一条的 baseURL 都能命中自己(表改了没人同步时这里先红)
  for (const p of BUILTIN_PROVIDERS) {
    const r = matchPresetByBaseURL(p.baseURL, { type: p.type });
    assert.equal(r.matched, true, `${p.id} 的 baseURL ${p.baseURL} 必须命中自己`);
    assert.ok(r.candidates.some((c) => c.id === p.id), `${p.id} 必须在自己那组 candidates 里`);
    assert.equal(r.host, new URL(p.baseURL).hostname.toLowerCase(), `${p.id} 的 host 要回传归一值`);
  }

  // 同一家的多个协议入口 = 同一条身份:open.bigmodel.cn 下三条预设并列
  const cn = matchPresetByBaseURL('https://open.bigmodel.cn/api/anthropic', { type: 'anthropic' });
  assert.deepEqual(cn.candidates.map((c) => c.id), ['zhipu-glm', 'glm-coding', 'glm-anthropic'],
    'candidates 按预设表声明顺序全列');
  assert.equal(cn.preset.id, 'glm-anthropic', '建议目标:同 type 优先');

  // 不做子域近似
  assert.equal(matchPresetByBaseURL('https://coding.dashscope.aliyuncs.com/apps/anthropic').host,
    'coding.dashscope.aliyuncs.com');
  assert.equal(matchPresetByBaseURL('https://dashscope.aliyuncs.com/api/v1').host, 'dashscope.aliyuncs.com');

  // host 归一:大小写 / 默认端口 / 末尾点
  for (const u of ['HTTPS://OPEN.BIGMODEL.CN/api/paas/v4', 'https://open.bigmodel.cn:443/api/paas/v4',
    'https://open.bigmodel.cn./api/paas/v4']) {
    const r = matchPresetByBaseURL(u);
    assert.equal(r.matched, true, `${u} 归一后应命中`);
    assert.equal(r.host, 'open.bigmodel.cn', `${u} 归一后 host 相同`);
  }

  // 非法输入一律 {matched:false} 且**不抛**
  for (const bad of [undefined, null, '', '   ', 'not a url', 'http://', 'file:///tmp/x', 42, {}, []]) {
    let r;
    assert.doesNotThrow(() => { r = matchPresetByBaseURL(bad); }, `${String(bad)} 不得抛`);
    assert.equal(r.matched, false, `${String(bad)} 应报未命中`);
  }
  // 合法 URL 但不在预设表里 → 未命中(自填第三方的正常路径)
  assert.equal(matchPresetByBaseURL('https://my-relay.example.com/v1').matched, false);
}

// ── ② 候选分派 ───────────────────────────────────────────────────────────
{
  const cn = pickCandidates({ baseURL: 'https://open.bigmodel.cn/api/anthropic', type: 'anthropic' });
  assert.deepEqual(cn.map((c) => c.vendor), ['zhipu', 'zhipu-cn-balance'],
    '智谱 CN:套餐额度与账户余额是**两个独立候选**,余额不得并进 zhipu');
  assert.equal(cn[0].auth, 'raw', '智谱是裸 token,不加 Bearer');
  assert.equal(cn[1].auth, 'raw', '余额端点同一把 key、同一形态(用户实测)');
  assert.deepEqual(cn[1].urls, ['https://www.bigmodel.cn/api/biz/account/query-customer-account-report'],
    '余额端点 URL 是用户实测过的那一条(禁探测:智谱对任意路径都回 200 + code:1001)');
  assert.equal(cn[1].currency, 'CNY');
  // 三个 CN 协议入口(openai 兼容 / 编码套餐 / anthropic 兼容)命中同一条身份
  for (const baseURL of ['https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/coding/paas/v4']) {
    assert.deepEqual(pickCandidates({ baseURL, type: 'openai' }).map((c) => c.vendor),
      ['zhipu', 'zhipu-cn-balance'], `${baseURL} 同属智谱 CN 身份`);
  }

  const zai = pickCandidates({ baseURL: 'https://api.z.ai/api/anthropic', type: 'anthropic' });
  assert.deepEqual(zai.map((c) => c.vendor), ['zhipu'],
    'Z.ai 只走 quota/limit —— 余额端点在 CN 域族,拿 Z.ai 的 key 跨域族发是凭证面红线');
  assert.ok(!zai.some((c) => c.urls.some((u) => u.includes('bigmodel.cn'))), 'Z.ai 的候选里不许出现 CN 域族 URL');
  assert.ok(!cn.some((c) => c.urls.some((u) => u.includes('z.ai'))), 'CN 族的候选里不许出现 Z.ai URL');

  // OpenAI 官方身份 → 本机 codex 通道:一个带 key 的 HTTP 都不发
  const oa = pickCandidates({ baseURL: 'https://api.openai.com/v1', type: 'openai' });
  assert.deepEqual(oa, [{ vendor: 'codex', auth: 'none', urls: [] }],
    'OpenAI 预设走 codex 通道(urls 为空 = 不发任何带 key 的请求)');
  assert.ok(!JSON.stringify(oa).includes('openai.com'), 'codex 候选里没有 api.openai.com 请求地址');

  // 未命中预设的自填第三方 → 原逻辑一字不变(openai 型走 One-API 兜底,anthropic 型空候选)
  assert.equal(pickCandidates({ baseURL: 'https://my-relay.example.com/v1', type: 'openai' })[0].vendor, 'oneapi');
  assert.deepEqual(pickCandidates({ baseURL: 'https://my-relay.example.com/v1', type: 'anthropic' }), []);
}

// ── 凭证面:key 只许进请求头,绝不许落进候选/响应/错误文案 ────────────────
{
  const src = readFileSync(new URL('../../server/services/provider-quota.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../../server/routes/provider-quota.js', import.meta.url), 'utf8');
  // 余额端点的 URL 是常量,不接受调用方传入(INTERFACE §10.4 ⑤:不接受调用方指定 URL)
  assert.match(src, /const ZHIPU_BALANCE_URL = 'https:\/\/www\.bigmodel\.cn\//, '余额 URL 必须是常量');
  assert.ok(!/console\.log|console\.error|console\.warn/.test(src), '这两个文件不许有任何 console 输出(key 会漏)');
}

console.log('✅ check-provider-quota-preset 通过');
