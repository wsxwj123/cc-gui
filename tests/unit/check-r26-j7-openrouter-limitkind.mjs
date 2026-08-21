#!/usr/bin/env node
// r26-J7【单测】:OpenRouter「无限」文案改实话 —— limitKind 三态映射。
// 修前:limit/limit_remaining 双 null(= 这把 key 没设花费上限)显示「无限」,
// 用户会以为账户钱花不完;而账户余额要 management key 走 /credits 才查得到。
// 哨兵:①parseOpenrouter 双 null → item.limitKind === 'none'(不再裸 unlimited);
// ②有上限 → limitKind === 'set',正常数值渲染;③字段缺失(读不到)→ 仍整条降级 null
// (不拿"读不到"冒充"没上限");④quotaItemText 三态文案映射钉死;⑤One-API 1e8 哨兵
// 保持「无限」(站点侧真·未限量,回归);⑥quotaUsedPercent 对 unlimited 仍 null(不画条)。
// Run: node tests/unit/check-r26-j7-openrouter-limitkind.mjs
import assert from 'node:assert/strict';
import { parseQuota } from '../../server/services/provider-quota.js';
import { quotaItemText, quotaUsedPercent } from '../../client/src/utils/quotaFormat.js';

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };
const OR = { vendor: 'openrouter', currency: 'USD' };

// ① 双 null → limitKind 'none'
{
  const r = parseQuota(OR, [{ data: { limit: null, limit_remaining: null, usage: 3.2 } }]);
  assert.equal(r?.items?.[0]?.unlimited, true, 'J7: 双 null 仍是 unlimited 形态(无分母)');
  assert.equal(r?.items?.[0]?.limitKind, 'none', 'J7: 双 null → limitKind none(密钥未设上限)');
  n += 2;
}
// ② 有上限 → limitKind 'set' + 正常数值
{
  const r = parseQuota(OR, [{ data: { limit: 10, limit_remaining: 7.5, limit_reset: 'monthly' } }]);
  assert.equal(r?.items?.[0]?.limitKind, 'set', 'J7: 有上限 → limitKind set');
  assert.equal(quotaItemText(r.items[0], r.currency), '月 · 剩余 $7.50 / $10', 'J7: set 态正常数值渲染');
  n += 2;
}
// ③ 字段缺失 → 整条降级 null(「读不到」≠「没上限」)
{
  const r = parseQuota(OR, [{ data: { usage: 1 } }]);
  assert.equal(r, null, 'J7: limit 键缺失 → 降级查不到,不得冒充无上限');
  n += 1;
}
// ④ 三态文案映射
{
  assert.equal(quotaItemText({ label: '额度', direction: 'left', unlimited: true, limitKind: 'none' }),
    '额度 · 该密钥未设花费上限；账户余额需额度查询密钥', 'J7: none 态说实话');
  assert.equal(quotaItemText({ label: '额度', direction: 'left', unlimited: true, limitKind: 'unknown' }),
    '额度 · 上限未知', 'J7: unknown 态文案');
  assert.equal(quotaItemText({ label: '额度', direction: 'left', unlimited: true }),
    '额度 · 无限', 'J7: 无 limitKind(旧数据/One-API)→ 保持「无限」');
  n += 3;
}
// ⑤ One-API 1e8 哨兵回归:真·未限量,不带 limitKind,文案「无限」
{
  const r = parseQuota({ vendor: 'oneapi' }, [{ hard_limit_usd: 100000000 }, { total_usage: 500 }]);
  assert.equal(r?.items?.[0]?.unlimited, true, 'J7: One-API 1e8 仍识别为无限');
  assert.equal(r?.items?.[0]?.limitKind, undefined, 'J7: One-API 不带 limitKind(真无限)');
  assert.equal(quotaItemText(r.items[0]), '额度 · 无限', 'J7: One-API 文案回归');
  n += 3;
}
// ⑥ unlimited 不画进度条(无分母)
{
  assert.equal(quotaUsedPercent({ unlimited: true, limitKind: 'none' }), null, 'J7: unlimited 不画条');
  n += 1;
}

console.log(`PASS check-r26-j7-openrouter-limitkind (${n} assertions)`);
