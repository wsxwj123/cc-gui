// r16-2:第三方额度卡的文案与进度条口径。抽出来是因为**方向词是正确性的一半** ——
// 三家接口方向不一致(智谱/opencode 回"已用%"、MiniMax 回"剩余%"、Kimi/余额类回绝对
// 剩余量),只写个百分比数字必被用户读反。这里保证每一项都带上「已用 / 剩余」。
// 纯函数,tests/unit/check-provider-quota-parse.mjs 直接 import。

const SYMBOL = { CNY: '¥', USD: '$' };

export function currencySymbol(currency) {
  return SYMBOL[currency] || '';
}

export function directionWord(direction) {
  return direction === 'used' ? '已用' : '剩余';
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2);
}

/** 一项的展示文案:`5 小时 · 已用 44%` / `周 · 剩余 13%` / `余额 ¥110.00` / `额度 · 剩余 123 / 500`。 */
export function quotaItemText(item, currency = null) {
  if (!item) return '';
  const label = item.label || '额度';
  // r26-J7:「无限」按 limitKind 说真话 —— OpenRouter 读到的是"这把 key 没设花费上限",
  // 账户余额要 management key 才查得到;笼统显示「无限」会让用户以为账户钱花不完。
  if (item.unlimited) {
    if (item.limitKind === 'none') return `${label} · 该密钥未设花费上限；账户余额需额度查询密钥`;
    if (item.limitKind === 'unknown') return `${label} · 上限未知`;
    return `${label} · 无限`; // One-API 系 1e8 哨兵:站点侧真·未限量
  }
  const dir = directionWord(item.direction);
  if (typeof item.percent === 'number') return `${label} · ${dir} ${item.percent}%`;
  if (typeof item.value !== 'number') return label;
  const sym = currencySymbol(currency);
  const val = `${sym}${fmtNum(item.value)}`;
  if (typeof item.max === 'number') return `${label} · ${dir} ${val} / ${sym}${fmtNum(item.max)}`;
  // 「余额」这个词本身就是方向,不再叠一个"剩余"。
  return label === '余额' ? `${label} ${val}` : `${label} · ${dir} ${val}`;
}

/**
 * 进度条填充百分比,统一换算成**已用**口径(与官方订阅额度卡同色阶:满格=耗尽)。
 * 没有分母(纯余额 / 无限)返回 null → 不画条,只显示数字。
 */
export function quotaUsedPercent(item) {
  if (!item || item.unlimited) return null;
  if (typeof item.percent === 'number') {
    const p = item.direction === 'used' ? item.percent : 100 - item.percent;
    return Math.min(100, Math.max(0, p));
  }
  if (typeof item.value === 'number' && typeof item.max === 'number' && item.max > 0) {
    const used = item.direction === 'used' ? item.value : item.max - item.value;
    return Math.min(100, Math.max(0, (used / item.max) * 100));
  }
  return null;
}

// 三档分色,与 SubscriptionUsageCard 同一组阈值与取色。
export function quotaTone(usedPercent) {
  if (usedPercent >= 90) return 'var(--color-error,#dc2626)';
  if (usedPercent >= 70) return '#d97706';
  return 'var(--color-accent)';
}

/** 重置时间 → tooltip 文案(毫秒时间戳;无则空串)。 */
export function resetTooltip(resetAt) {
  if (typeof resetAt !== 'number' || !Number.isFinite(resetAt)) return '';
  const d = new Date(resetAt);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `重置：${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
