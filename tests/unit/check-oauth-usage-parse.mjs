#!/usr/bin/env node
// /api/oauth/usage 响应解析护栏(server/routes/subscription-usage.js parseOAuthUsage)。
// 守两件事:①三档字段口径(five_hour / seven_day / limits[weekly_scoped])别被改坏;
// ②weekScoped 的模型名必须动态取 scope.model.display_name —— 服务端会换主力模型
// (现为 Fable,seven_day_sonnet 恒 null),写死字段名 = 第三行永远空。
// 直接 import 真函数(不复刻),末尾做一次变异验证:证明断言真的会挂。
import assert from 'node:assert/strict';
import { parseOAuthUsage } from '../../server/routes/subscription-usage.js';

const FULL = {
  five_hour: { utilization: 12.4, resets_at: '2026-07-27T18:00:00Z' },
  seven_day: { utilization: 63.7, resets_at: '2026-07-30T09:30:00Z' },
  seven_day_sonnet: null,
  limits: [
    { kind: 'weekly', percent: 63 },
    {
      kind: 'weekly_scoped',
      percent: 41.2,
      resets_at: '2026-07-30T09:30:00Z',
      scope: { model: { display_name: 'Fable' } },
    },
  ],
};

// ── 正常形状 ──────────────────────────────────────────────
{
  const r = parseOAuthUsage(JSON.stringify(FULL));
  assert.equal(r.session.percent, 12, 'five_hour.utilization 四舍五入');
  assert.equal(r.weekAll.percent, 64, 'seven_day.utilization 四舍五入');
  assert.equal(r.weekScoped.percent, 41, 'weekly_scoped.percent 四舍五入');
  assert.equal(r.weekScoped.label, 'Fable', '模型名取 scope.model.display_name(动态,不写死)');
  // resetText 是 server 本地时区的 "M月d日 HH:mm",不断言具体时刻,只断言形状。
  for (const k of ['session', 'weekAll', 'weekScoped']) {
    assert.match(r[k].resetText, /^\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/, `${k}.resetText 形状`);
  }
  // 对象入参与字符串入参等价(路由拿到的是字符串,测试两条路都通)。
  assert.deepEqual(parseOAuthUsage(FULL), r, '对象/字符串入参同解');
}

// ── limits 里没有 weekly_scoped:前两行照出,第三行 null(不是整体失败) ──
{
  const r = parseOAuthUsage({ ...FULL, limits: [{ kind: 'weekly', percent: 63 }] });
  assert.equal(r.weekScoped, null, '无 weekly_scoped → weekScoped 为 null');
  assert.equal(r.session.percent, 12, '缺 scoped 不影响 5h 段');
  // limits 字段整个缺失同理(老账号/字段改名都可能)
  const noLimits = parseOAuthUsage({ five_hour: FULL.five_hour });
  assert.equal(noLimits.weekScoped, null, 'limits 缺失不抛错');
  assert.equal(noLimits.weekAll, null, 'seven_day 缺失 → weekAll 为 null');
}

// ── 缺字段 / 脏值 ────────────────────────────────────────
{
  assert.equal(parseOAuthUsage({}), null, '空对象 → null(调用方报"无法解析")');
  assert.equal(parseOAuthUsage({ five_hour: {} }), null, 'utilization 缺失 → 该段无 percent → 整体 null');
  assert.equal(parseOAuthUsage({ five_hour: { utilization: '12' } }), null, '字符串 percent 不当数字用');
  const noIso = parseOAuthUsage({ five_hour: { utilization: 5 } });
  assert.equal(noIso.session.percent, 5, '缺 resets_at 仍返回百分比');
  assert.equal(noIso.session.resetText, null, '缺 resets_at → resetText 为 null');
  assert.equal(
    parseOAuthUsage({ five_hour: { utilization: 5, resets_at: 'not-a-date' } }).session.resetText,
    null, '非法时间 → resetText 为 null(不是 "NaN月NaN日")',
  );
  const noLabel = parseOAuthUsage({ limits: [{ kind: 'weekly_scoped', percent: 7 }] });
  assert.equal(noLabel.weekScoped.percent, 7, '无 scope 也给出百分比');
  assert.equal(noLabel.weekScoped.label, undefined, '无 display_name → 不给 label(前端回落通用文案)');
}

// ── 非 JSON / 非对象 ─────────────────────────────────────
{
  assert.equal(parseOAuthUsage('<html>502 Bad Gateway</html>'), null, '非 JSON → null 不抛');
  assert.equal(parseOAuthUsage(''), null, '空串 → null');
  assert.equal(parseOAuthUsage(null), null, 'null → null');
  assert.equal(parseOAuthUsage('[1,2,3]'), null, 'JSON 数组 → null');
}

// ── 变异验证:断言确实咬得住(改坏输入必须挂) ────────────────
{
  const mutated = JSON.parse(JSON.stringify(FULL));
  mutated.limits[1].scope.model.display_name = 'Sonnet';
  assert.equal(parseOAuthUsage(mutated).weekScoped.label, 'Sonnet',
    '变异验证:label 若被写死成常量,这里会读出 Fable 而挂');
}

console.log('✅ check-oauth-usage-parse 通过');
