#!/usr/bin/env node
// 单测:R28 官方侧辅助查询的纯函数面(额度窗口解析 / 响应组装 / 账户范围标记 / CLI 错误分类)。
// 合同来源:.devflow/INTERFACE.md「官方辅助能力、历史与外部项目(R25–R28)」前两条。
// Run: node tests/unit/check-r28-official-query.mjs
import assert from 'node:assert/strict';
import { parseCliUsageWindows, buildQuotaPayload, SOURCE } from '../../server/routes/subscription-usage.js';
import { classifyCliError, accountScopeOf, CLI_CODES } from '../../server/utils/cli-official.js';

const STATUS_ENUM = ['available', 'stale', 'unavailable', 'not-subscribed'];
const SOURCE_ENUM = ['official-cli', 'official-sdk-experimental'];

// ── t1 额度窗口解析:三档 + model_scoped,未知一律 null 不写 0 ─────────────
{
  const w = parseCliUsageWindows({
    five_hour: { utilization: 12.4, resets_at: '2026-09-11T05:00:00Z' },
    seven_day: { utilization: 63, resets_at: '2026-09-15T00:00:00Z' },
    seven_day_sonnet: { utilization: 5, resets_at: '2026-09-15T00:00:00Z' },
    model_scoped: [{ display_name: 'Fable', utilization: 41, resets_at: '2026-09-15T00:00:00Z' }],
  });
  assert.equal(w.session.percent, 12, 't1: 四舍五入到整数百分数');
  assert.equal(w.weekAll.percent, 63, 't1: 周·全模型');
  assert.equal(w.weekScoped.label, 'Fable', 't1: 有 model_scoped 时优先用它,标签跟服务端');
  assert.equal(w.weekScoped.percent, 41, 't1: 分模型窗口');
  assert.equal(w.session.resetAt, '2026-09-11T05:00:00Z', 't1: resetAt 是有效时间');

  const empty = parseCliUsageWindows(null);
  assert.deepEqual([empty.session, empty.weekAll, empty.weekScoped], [null, null, null], 't1: 无数据 → 三段 null(不是 0)');
  const noUtil = parseCliUsageWindows({ five_hour: { utilization: null, resets_at: '2026-09-11T05:00:00Z' } });
  assert.equal(noUtil.session, null, 't1: utilization 缺失 → 该段 null,不冒充 0%');

  const alias = parseCliUsageWindows({ seven_day_sonnet: { utilization: 9, resets_at: '2026-09-15T00:00:00Z' } });
  assert.equal(alias.weekScoped.label, 'Sonnet', 't1: 无 model_scoped 时回落 seven_day_sonnet');

  const clamped = parseCliUsageWindows({ five_hour: { utilization: 140 } });
  assert.equal(clamped.session.percent, 100, 't1: 越界百分比夹到 0–100');
  assert.equal(clamped.session.resetAt, null, 't1: 非法时间 → resetAt null');
}

// ── t2 响应组装:成功/未订阅/字段变动/失败降级四条路径 ────────────────────
{
  const fetchedAt = new Date().toISOString();
  const ok = buildQuotaPayload({
    result: {
      ok: true,
      value: {
        scope: { kind: 'official-cli', scopeId: 'acct-1', authKind: 'oauth-or-none', subscription: 'max' },
        subscriptionType: 'max',
        rateLimitsAvailable: true,
        rateLimits: { five_hour: { utilization: 10, resets_at: '2026-09-11T05:00:00Z' } },
      },
    },
    previous: null,
    fetchedAt,
  });
  assert.equal(ok.status, 'available', 't2: 有额度 → available');
  assert.equal(ok.official, true, 't2: 官方数据 → official true');
  assert.equal(ok.fetchedAt, fetchedAt, 't2: 带上抓取时间');
  assert.ok(SOURCE_ENUM.includes(ok.source) && ok.source === SOURCE, 't2: source 取自枚举');
  assert.equal(ok.session.percent, 10, 't2: 段数据透出');

  const notSub = buildQuotaPayload({
    result: { ok: true, value: { scope: { kind: 'official-cli', scopeId: 'x' }, rateLimitsAvailable: false, rateLimits: null } },
    previous: null,
    fetchedAt,
  });
  assert.equal(notSub.status, 'not-subscribed', 't2: plan 限额不适用 → not-subscribed');
  assert.equal(notSub.code, 'NOT_SUBSCRIBED', 't2: 稳定 code');
  assert.deepEqual([notSub.session, notSub.weekAll, notSub.weekScoped], [null, null, null], 't2: 三段必须是 null 而不是 0');
  assert.equal(notSub.official, false, 't2: 没有官方额度数据 → 不冒 official:true');

  const invalid = buildQuotaPayload({
    result: { ok: true, value: { scope: null, rateLimitsAvailable: true, rateLimits: { five_hour: { utilization: null } } } },
    previous: null,
    fetchedAt,
  });
  assert.equal(invalid.status, 'unavailable', 't2: 说"限额适用"却解析不出窗口 → unavailable');
  assert.equal(invalid.code, 'CLI_RESPONSE_INVALID', 't2: 字段变动 code');

  const failed = buildQuotaPayload({ result: { ok: false, code: 'CLI_TIMEOUT', message: '超时' }, previous: null, fetchedAt });
  assert.equal(failed.status, 'unavailable', 't2: 无旧值的失败 → unavailable');
  assert.equal(failed.code, 'CLI_TIMEOUT', 't2: 保留稳定 code');
  assert.deepEqual([failed.session, failed.weekAll, failed.weekScoped], [null, null, null], 't2: 失败不得伪造 0');
  assert.ok(!JSON.stringify(failed).includes('"percent":0'), 't2: 失败路径不出现 0 占位');

  const stale = buildQuotaPayload({
    result: { ok: false, code: 'CLI_UNAVAILABLE', message: 'CLI 没了' },
    previous: { ...ok, fetchedAt: '2026-09-10T00:00:00Z' },
    fetchedAt,
  });
  assert.equal(stale.status, 'stale', 't2: 有同账户旧值 → 降级 stale');
  assert.equal(stale.fetchedAt, '2026-09-10T00:00:00Z', 't2: stale 保留上次成功时间');
  assert.equal(stale.session.percent, 10, 't2: stale 保留旧值内容');
  assert.match(String(stale.reason || stale.error), /CLI_UNAVAILABLE/, 't2: stale 必须给出原因');
  assert.ok(STATUS_ENUM.includes(stale.status), 't2: status 取自合同枚举');
}

// ── t3 账户范围标记:不含 email / 凭据字样,长度受限,换账户即变 ──────────
{
  const a = accountScopeOf({ email: 'Someone@Example.com', tokenSource: 'none', subscriptionType: 'max' });
  const b = accountScopeOf({ email: 'other@example.com', tokenSource: 'none', subscriptionType: 'max' });
  assert.notEqual(a.scopeId, b.scopeId, 't3: 换账户 → scopeId 变');
  assert.equal(a.scopeId, accountScopeOf({ email: 'someone@example.com' }).scopeId, 't3: 同一账户(大小写不敏感)同值');
  const serialized = JSON.stringify(a);
  assert.doesNotMatch(serialized, /[\w.+-]+@[\w-]+\.[\w.]+/, 't3: 不得含 email');
  assert.doesNotMatch(serialized, /token|secret|bearer/i, 't3: 不得含凭据字样');
  assert.ok(serialized.length <= 400, 't3: 长度受限');
  assert.equal(accountScopeOf({ tokenSource: 'ANTHROPIC_API_KEY' }).authKind, 'api-key', 't3: 认证来源归类');
  assert.equal(accountScopeOf(null).scopeId, 'unidentified', 't3: 拿不到身份 → unidentified');
}

// ── t4 CLI 错误分类:合同 code 枚举内,且不把超时误报成不可用 ──────────────
{
  assert.equal(classifyCliError(new Error('Native CLI binary for darwin-arm64 not found')), 'CLI_UNAVAILABLE', 't4: 缺 CLI → CLI_UNAVAILABLE');
  const t = new Error('boom'); t.code = 'CLI_TIMEOUT';
  assert.equal(classifyCliError(t), 'CLI_TIMEOUT', 't4: 自己的超时 code 原样保留');
  assert.equal(classifyCliError(new Error('429 Too Many Requests')), 'CLI_RATE_LIMITED', 't4: 限流');
  assert.equal(classifyCliError(new Error('Unknown control request: foo')), 'CLI_CAPABILITY_UNAVAILABLE', 't4: 方法不支持');
  for (const code of ['CLI_UNAVAILABLE', 'CLI_CAPABILITY_UNAVAILABLE', 'CLI_RESPONSE_INVALID', 'CLI_RATE_LIMITED', 'NOT_SUBSCRIBED', 'CLI_TIMEOUT']) {
    assert.ok(CLI_CODES.includes(code), `t4: ${code} 在合同枚举里`);
  }
  assert.ok(CLI_CODES.includes(classifyCliError(new Error('随便一个意外错误'))), 't4: 未知错误也落到合同 code');
}

console.log('check-r28-official-query: all passed');
