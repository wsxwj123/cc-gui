#!/usr/bin/env node
// 单测:r122 R3 —— 订阅额度区分"CLI 没登录"与"账户没订阅"(INTERFACE-r122 C1/C2)。
// 判据是纯函数(isCliNotLoggedIn / buildQuotaPayload),只用 CLI 报回的 accountScope,不读本机凭据。
// Run: node tests/unit/check-r122-subscription-login.mjs
import assert from 'node:assert/strict';
import { buildQuotaPayload, isCliNotLoggedIn } from '../../server/routes/subscription-usage.js';
import { accountScopeOf, CLI_CODES } from '../../server/utils/cli-official.js';

const fetchedAt = '2026-09-21T05:00:00.000Z';
const notApplicable = (scope) => buildQuotaPayload({
  result: { ok: true, value: { scope, rateLimitsAvailable: false, rateLimits: null } },
  previous: null,
  fetchedAt,
});
const NOT_LOGGED_IN_SCOPE = { kind: 'official-cli', scopeId: 'unidentified', authKind: 'oauth-or-none', subscription: null };

// ── ① C2 命中:未识别 + oauth-or-none + 无订阅类型 → not-logged-in ─────────────
{
  const p = notApplicable(NOT_LOGGED_IN_SCOPE);
  assert.equal(p.status, 'not-logged-in', '①: plan 限额不适用 + 账户未识别 → not-logged-in');
  assert.equal(p.code, 'NOT_LOGGED_IN', '①: 稳定 code');
  assert.equal(p.official, false, '①: 没有官方额度数据 → official:false');
  assert.deepEqual([p.session, p.weekAll, p.weekScoped], [null, null, null], '①: 三段是 null 不是 0');
  assert.ok(p.error.includes('未登录'), `①: error 要明说未登录: ${p.error}`);
  assert.ok(p.error.includes('claude auth login'), `①: error 要给办法: ${p.error}`);
  assert.ok(!p.error.includes('没有官方订阅额度'), '①: 不得再说"没有官方订阅额度"');
  assert.deepEqual(p.accountScope, NOT_LOGGED_IN_SCOPE, '①: accountScope 原样透出(不含凭据)');
  assert.equal(p.fetchedAt, fetchedAt, '①: 带抓取时间');
  assert.ok(CLI_CODES.includes('NOT_LOGGED_IN'), '①: NOT_LOGGED_IN 进合同 code 枚举');
}

// ── ② 有账户身份 → 维持 not-subscribed(API key / 控制台账户确实没订阅)───────
{
  for (const scope of [
    { kind: 'official-cli', scopeId: 'acct-0123456789abcdef', authKind: 'oauth-or-none', subscription: null },
    { kind: 'official-cli', scopeId: 'acct-0123456789abcdef', authKind: 'api-key', subscription: null },
    { kind: 'official-cli', scopeId: 'unidentified', authKind: 'api-key', subscription: null },
    { kind: 'official-cli', scopeId: 'unidentified', authKind: 'console-managed-key', subscription: null },
    { kind: 'official-cli', scopeId: 'unidentified', authKind: 'oauth-or-none', subscription: 'pro' },
  ]) {
    const p = notApplicable(scope);
    assert.equal(p.status, 'not-subscribed', `②: ${JSON.stringify(scope)} 应维持 not-subscribed`);
    assert.equal(p.code, 'NOT_SUBSCRIBED', '②: 既有 code 不变');
    assert.equal(p.error, '该账户/会话没有可用的官方订阅额度（CLI 报告 plan 限额不适用）', '②: 既有 error 逐字不变');
  }
}

// ── ③ scope 缺失(拿不到账户信息)不算未登录:维持原判 ─────────────────────────
{
  for (const scope of [null, undefined, {}, 'x', 42]) {
    const p = notApplicable(scope);
    assert.equal(p.status, 'not-subscribed', `③: scope=${JSON.stringify(scope)} 拿不到账户信息时不猜"未登录"`);
    assert.equal(isCliNotLoggedIn(scope), false, `③: isCliNotLoggedIn(${JSON.stringify(scope)}) 必须 false 且不抛`);
  }
}

// ── ④ 限额适用时登录判据不介入:仍是 available ────────────────────────────────
{
  const p = buildQuotaPayload({
    result: {
      ok: true,
      value: {
        scope: NOT_LOGGED_IN_SCOPE,
        rateLimitsAvailable: true,
        rateLimits: { five_hour: { utilization: 10, resets_at: '2026-09-21T10:00:00Z' } },
      },
    },
    previous: null,
    fetchedAt,
  });
  assert.equal(p.status, 'available', '④: CLI 给得出额度就按 available,不被登录判据抢走');
  assert.equal(p.official, true, '④: official:true');
}

// ── ⑤ 与 cli-official.accountScopeOf 对齐:SDK tokenSource:none + 无 email 就是未登录形态 ──
{
  const scope = accountScopeOf({ tokenSource: 'none' });
  assert.equal(isCliNotLoggedIn(scope), true, '⑤: tokenSource none + 无 email → 未登录');
  assert.equal(notApplicable(scope).status, 'not-logged-in', '⑤: 端到端形状一致');
  assert.equal(isCliNotLoggedIn(accountScopeOf({ tokenSource: 'none', email: 'a@b.c' })), false, '⑤: 有 email 就有账户身份 → 不是未登录');
  assert.equal(isCliNotLoggedIn(accountScopeOf({ tokenSource: 'ANTHROPIC_API_KEY' })), false, '⑤: API key 身份 → 不是未登录');
  assert.equal(isCliNotLoggedIn(accountScopeOf(null)), false, '⑤: accountInfo 失败(null)→ authKind unknown → 不是未登录');
}

// ── ⑥ 失败路径不受影响:有旧值 stale、无旧值 unavailable ──────────────────────
{
  const fail = { ok: false, code: 'CLI_TIMEOUT', message: '超时' };
  assert.equal(buildQuotaPayload({ result: fail, previous: null, fetchedAt }).status, 'unavailable', '⑥: 无旧值 → unavailable');
  const prev = { status: 'available', official: true, fetchedAt: '2026-09-21T04:00:00.000Z', accountScope: NOT_LOGGED_IN_SCOPE, session: { percent: 1 } };
  assert.equal(buildQuotaPayload({ result: fail, previous: prev, fetchedAt }).status, 'stale', '⑥: 有旧值 → stale');
}

console.log('check-r122-subscription-login: all passed');
