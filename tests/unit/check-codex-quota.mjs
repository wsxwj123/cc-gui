#!/usr/bin/env node
// D-3:OpenAI 的本地 codex 通道(④ 类)。
// Run: node tests/unit/check-codex-quota.mjs
//
// 契约硬要求(INTERFACE §10.4 / PLAN §10.12③):
//   ① **不读凭证** —— 不读 ~/.codex/auth.json 的内容,连存在性判断都不做(token 一概不碰);
//   ② **只读** —— 只发 initialize / initialized / account/rateLimits/read 三个方法;
//   ③ **随用随退** —— 15s 超时后子进程必须被杀掉,不常驻、不重试;
//   ④ 三档降级逐字:④a 找不到可执行文件(**连进程都不起**)、④b 未登录、④c 通道失败;
//   ⑤ 响应键名照 V-D4 实测(camelCase),不是二进制里的 snake_case。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { probeCodexQuota, projectCodexRateLimits, CODEX_NOTES, CODEX_ANNOTATION }
  from '../../server/services/provider-quota.js';
import { readCodexRateLimits, findCodexBin, CODEX_TIMEOUT_MS }
  from '../../server/services/codex-quota.js';

// ── ④ 类文案逐字(INTERFACE §10.4 表) ────────────────────────────────────
{
  assert.equal(CODEX_NOTES['no-binary'], '本机未找到 codex（ChatGPT 应用），无法读取 OpenAI 额度，请去官网查看');
  assert.equal(CODEX_NOTES['not-logged-in'], '本机 codex 未登录 ChatGPT 账户，无法读取额度，请去官网查看');
  assert.equal(CODEX_NOTES.failed, 'codex 额度查询失败（超时或返回异常），请稍后重试');
  assert.equal(CODEX_ANNOTATION, '本机 codex 登录的 ChatGPT/Codex 账户额度，与当前 API key 无绑定');
}

// ── 解析:真响应夹具(V-D4 实测,原样抄) ──────────────────────────────────
const REAL = {
  rateLimits: {
    limitId: 'codex', limitName: null,
    primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1789610404 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    individualLimit: null, spendControlReached: false, planType: 'prolite', rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex', limitName: null,
      primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1789610404 },
      secondary: null, credits: { hasCredits: false, unlimited: false, balance: '0' },
      individualLimit: null, spendControlReached: false, planType: 'prolite', rateLimitReachedType: null,
    },
    codex_bengalfox: {
      limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark',
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1789165924 },
      secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1789752724 },
      credits: null, individualLimit: null, spendControlReached: null,
      planType: 'prolite', rateLimitReachedType: null,
    },
  },
  rateLimitResetCredits: { availableCount: 0, credits: [] },
  accountId: '18f1f611-844e-433d-b530-08970286ea76',
  rateLimitUpsell: null,
};

{
  const r = projectCodexRateLimits(REAL);
  assert.equal(r.kind, 'percent');
  assert.equal(r.currency, null, '是百分比额度不是钱 → 不加货币符号');
  // 多桶视图:codex 的 primary(周)+ bengalfox 的 primary(5 小时)/secondary(周)
  assert.deepEqual(r.items.map((i) => [i.label, i.percent]), [
    ['周', 100],
    ['5 小时 · GPT-5.3-Codex-Spark', 0],
    ['周 · GPT-5.3-Codex-Spark', 0],
  ], 'rateLimitsByLimitId 有内容就用多桶视图;windowDurationMins 是分钟 → 10080分=周 / 300分=5 小时');
  assert.ok(r.items.every((i) => i.direction === 'used'), 'codex 回的是已用%');
  assert.equal(r.items[0].resetAt, 1789610404000, 'resetsAt 是**秒**,要折算成毫秒给 tooltip');
  // 键名必须是实测的 camelCase —— 照二进制里的 snake_case 写会解析出 0 行
  assert.equal(projectCodexRateLimits({ rateLimits: {
    primary: { used_percent: 50, window_minutes: 300, resets_at: 1 },
  } }), null, 'snake_case 键名(二进制结构体名)解析不出任何条目');

  // 兼容单桶视图:没有 rateLimitsByLimitId 时用 rateLimits
  const single = projectCodexRateLimits({ rateLimits: {
    limitId: 'codex', limitName: null, primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1 },
  } });
  assert.deepEqual(single.items.map((i) => [i.label, i.percent]), [['5 小时', 12.5]]);
  // 窗口长度读不到 → 标「额度」,绝不猜成"本月"
  assert.equal(projectCodexRateLimits({ rateLimits: { primary: { usedPercent: 7 } } }).items[0].label, '额度');
  // 一行都出不来 → null(整条降级,不编造)
  for (const bad of [undefined, null, {}, { rateLimitsByLimitId: {} }, { rateLimits: {} },
    { rateLimits: { primary: { usedPercent: null } } }, { rateLimits: { primary: { usedPercent: '' } } }]) {
    assert.equal(projectCodexRateLimits(bad), null, `${JSON.stringify(bad)} → null`);
  }
}

// ── probeCodexQuota:三档降级 + 成功路径(注入桩,零 IO) ────────────────────
{
  // ④a:三个查找路径全无 → **不 spawn**(read 一次都不该被调用)
  let readCalls = 0;
  const a = await probeCodexQuota(async () => { readCalls += 1; return { ok: true, result: REAL }; }, () => null);
  assert.deepEqual(a, { ok: false, reason: 'no-endpoint', note: CODEX_NOTES['no-binary'] });
  assert.equal(readCalls, 0, '找不到可执行文件时连进程都不许起');

  const withBin = async (read) => probeCodexQuota(read, () => '/Applications/ChatGPT.app/Contents/Resources/codex');

  // ④b:鉴权类错误 → auth
  const b = await withBin(async () => ({ ok: false, code: 'not-logged-in' }));
  assert.deepEqual(b, { ok: false, reason: 'auth', note: CODEX_NOTES['not-logged-in'] });
  assert.ok(!JSON.stringify(b).includes('token'), '错误文案里不许出现凭证相关字样');
  // ④c:spawn/RPC/超时/解析失败 → network
  for (const code of ['failed', undefined]) {
    const c = await withBin(async () => ({ ok: false, code }));
    assert.deepEqual(c, { ok: false, reason: 'network', note: CODEX_NOTES.failed }, `code=${code}`);
  }
  // read 自己抛(不该发生,但要兜住)→ ④c,不把异常漏到路由外
  assert.equal((await withBin(async () => { throw new Error('boom'); })).note, CODEX_NOTES.failed);
  // 拿到了结果但一行都解析不出 → ④c(不编造)
  assert.equal((await withBin(async () => ({ ok: true, result: {} }))).note, CODEX_NOTES.failed);

  // 成功:投影 + 卡片标注一起回
  const ok = await withBin(async () => ({ ok: true, result: REAL }));
  assert.equal(ok.ok, true);
  assert.equal(ok.endpoint, 'codex');
  assert.equal(ok.annotation, CODEX_ANNOTATION);
  assert.equal(ok.items.length, 3);
  assert.equal(await withBin(async () => ({ ok: false, code: 'not-logged-in' })).then((x) => x.reason), 'auth',
    '④b 的 reason 是 auth(闭集内),不许新增错误码');
}

// ── 凭证面 + 只读面:源码级断言(这两条是"改坏了没人发现"的重灾区) ──────────
{
  const src = readFileSync(fileURLToPath(new URL('../../server/services/codex-quota.js', import.meta.url)), 'utf8');
  // 只看代码不看注释:注释里正当地提到了 auth.json(说明为什么不碰它)。
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/['"`][^'"`]*auth\.json/.test(code), '一个字节都不许碰 ~/.codex/auth.json(连存在性判断都不需要)');
  assert.ok(!/readFile|readFileSync|createReadStream/.test(code), '本模块不许读任何文件');
  assert.ok(!/CODE_HOME|\.codex/.test(code.replace(/'\/Applications[^']*'/g, '')), '不许拼 ~/.codex 下的任何路径');
  assert.ok(!/console\./.test(src), '不许有任何 console 输出(stderr 可能带凭证)');
  assert.match(src, /account\/rateLimits\/read/, '只调这一个 RPC 方法');
  const methods = [...src.matchAll(/method: '([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(methods, ['account/rateLimits/read', 'initialize', 'initialized'],
    '只许发这三个方法 —— 多一个都可能是会产生费用的动作');
  assert.match(src, /SIGKILL/, '进程随用随退:超时/拿到结果都必须杀掉');
  assert.match(src, /stdio: \['pipe', 'pipe', 'ignore'\]/, 'stderr 直接丢弃(别把 codex 日志读进来)');
  assert.equal(CODEX_TIMEOUT_MS, 15_000, '15s 超时(PLAN 定死)');

  // 接线:路由要在成功 payload 上带出卡片标注、失败时用 ④ 类自带文案(而不是原因表兜底);
  // 客户端要真的把 note 渲染出来 —— 这三处任一被删掉,标注就永远到不了用户眼前。
  const route = readFileSync(fileURLToPath(new URL('../../server/routes/provider-quota.js', import.meta.url)), 'utf8');
  assert.match(route, /result\.annotation \? \{ note: result\.annotation \}/, '成功 payload 必须带上 codex 标注');
  // 判据两处按 INTERFACE-20260913-quota-endpoint §D.4/D.5 同步(手填通道引入后):
  //  · 分派从 `candidates[0]?.vendor === 'codex'` 改成"列表里存在 codex 候选"——手填候选会插到首位;
  //  · 兜底从裸 `reasonNote(result.reason)` 改成按通道分流(自定义通道有自己的文案)。
  // 两处的**语义与强度不变**:仍要求路由按 vendor 分派、④ 类文案优先于兜底。
  assert.match(route, /candidates\.some\(\(c\) => c\.vendor === 'codex'\)/, '路由要按 vendor 分派到 codex 通道');
  assert.match(route, /result\.note \|\| noteFor\(result\.reason, custom\)/, '④ 类文案优先于兜底');
  assert.match(route, /custom \? customNote\(reason, custom\) : reasonNote\(reason\)/, '非自定义通道仍走既有原因表');
  const panel = readFileSync(fileURLToPath(new URL('../../client/src/components/UsagePanel.jsx', import.meta.url)), 'utf8');
  assert.match(panel, /\{data\.note && \(/, '额度卡要渲染 note(否则标注只在 degraded 时才出现)');
}

// ── 超时真的杀进程(用假 bin,不碰真 codex) ───────────────────────────────
{
  const bin = process.execPath; // 拿 node 本体冒充 codex:它不会说 JSON-RPC,必然走到超时
  const started = Date.now();
  const r = await readCodexRateLimits(bin, { timeoutMs: 600 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'failed');
  assert.ok(Date.now() - started < 6000, '超时必须触发(而不是干等到测试超时)');
}

// ── findCodexBin:顺序 CODEX_BIN → 应用内置 → PATH ─────────────────────────
{
  const saved = process.env.CODEX_BIN;
  process.env.CODEX_BIN = '/definitely/not/here/codex';
  try {
    // 显式指定的路径不存在 → 继续往下找(应用内置 / PATH),绝不返回不存在的路径
    const found = findCodexBin();
    if (found) assert.ok(!found.startsWith('/definitely/'), '不许把不存在的路径当结果返回');
    // 存在的路径必须被采纳
    process.env.CODEX_BIN = process.execPath;
    assert.equal(findCodexBin(), process.execPath, 'CODEX_BIN 排在第一位');
  } finally {
    if (saved === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = saved;
  }
}

console.log('✅ check-codex-quota 通过');
