// r151c:跨会话二期的判定纯函数(方案 §3 xsession-policy.js)。本文件只放无副作用的计算,读文件、读偏好由调用方做。
// 派工 2 先放 provider 指纹;权限类别、去向表由后续派工补进来。
import { createHmac } from 'crypto';

// 参与指纹的 settings.json env 键:路由与模型(换 provider、换模型映射即变)+ 两种凭据。顺序固定,改动即所有旧档案按"换过"判。
const FP_ENV_KEYS = Object.freeze([
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
]);
const SALT_RE = /^[0-9a-f]{64}$/;
const str = (v) => (typeof v === 'string' ? v : '');

/**
 * provider 指纹:以 salt(本机随机 32 字节的十六进制)为键的 HMAC-SHA256,取前 16 位十六进制。
 * 内容 = settings.json env 里 FP_ENV_KEYS 的值、settings.json 的 apiKeyHelper 原文、OAuth 账号 uuid(~/.claude.json 的
 * oauthAccount.accountUuid);缺的、不是字符串的按空串。凭据只在这里的内存里参与计算,返回值不可逆、不含原文。
 * salt 不合规 → 抛 TypeError(调用方不该拿没盐的摘要去比较)。
 */
export function providerFingerprint({ settingsEnv, apiKeyHelper, accountId, salt } = {}) {
  if (typeof salt !== 'string' || !SALT_RE.test(salt)) throw new TypeError('providerFingerprint:salt 必须是 64 位十六进制');
  const env = settingsEnv && typeof settingsEnv === 'object' && !Array.isArray(settingsEnv) ? settingsEnv : {};
  const parts = [...FP_ENV_KEYS.map((k) => str(env[k])), str(apiKeyHelper), str(accountId)];
  return createHmac('sha256', Buffer.from(salt, 'hex')).update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}
