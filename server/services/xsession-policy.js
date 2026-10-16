// r151c:跨会话二期的判定纯函数(方案 §3 xsession-policy.js)。本文件只放无副作用的计算,读文件、读偏好由调用方做。
// provider 指纹(派工 2)、权限类别与去向表(派工 3)。
import { createHmac } from 'crypto';

// 参与指纹的 settings.json env 键:路由与模型(换 provider、换模型映射即变)+ 凭据。顺序固定,改动即所有旧档案按"换过"判。
// 审计 S5 补:OAuth 令牌、自定义请求头,以及 Bedrock / Vertex(和同类的 Foundry / Mantle / 网关)的开关、端点、区域、项目与凭据
// (键名按本机 CLI 认的环境变量核过)。按模型分区域的 VERTEX_REGION_* 另按前缀收(见 FP_ENV_PREFIXES)。
const FP_ENV_KEYS = Object.freeze([
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_UNIX_SOCKET',
  // Bedrock
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE',
  'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_BEDROCK', 'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
  // Vertex
  'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT',
  // 同类的云上路由
  'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH', 'CLAUDE_CODE_USE_GATEWAY',
]);
// 按前缀收的 env 键(键名本身不固定):Vertex 按模型分的区域。按键名排序后连同键名一起进指纹。
const FP_ENV_PREFIX_RE = /^VERTEX_REGION_[A-Z0-9_]+$/;
// settings.json 顶层与 apiKeyHelper 同类的凭据命令(Bedrock 的刷新 / 导出、Vertex 的刷新)。
const FP_HELPER_KEYS = Object.freeze(['awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh']);
const SALT_RE = /^[0-9a-f]{64}$/;
const str = (v) => (typeof v === 'string' ? v : '');

/**
 * provider 指纹:以 salt(本机随机 32 字节的十六进制)为键的 HMAC-SHA256,取前 16 位十六进制。
 * 内容 = settings.json env 里 FP_ENV_KEYS 的值、按前缀收的 VERTEX_REGION_*(键名排序,连键名)、settings.json 的 apiKeyHelper 原文、
 * OAuth 账号 uuid(~/.claude.json 的 oauthAccount.accountUuid)、settings.json 顶层的 FP_HELPER_KEYS(helpers 对象里给);
 * 缺的、不是字符串的按空串。凭据只在这里的内存里参与计算,返回值不可逆、不含原文;本函数不写盘、不打日志。
 * salt 不合规 → 抛 TypeError(调用方不该拿没盐的摘要去比较)。
 */
export function providerFingerprint({ settingsEnv, apiKeyHelper, accountId, helpers, salt } = {}) {
  if (typeof salt !== 'string' || !SALT_RE.test(salt)) throw new TypeError('providerFingerprint:salt 必须是 64 位十六进制');
  const env = settingsEnv && typeof settingsEnv === 'object' && !Array.isArray(settingsEnv) ? settingsEnv : {};
  const h = helpers && typeof helpers === 'object' && !Array.isArray(helpers) ? helpers : {};
  const prefixed = Object.keys(env).filter((k) => FP_ENV_PREFIX_RE.test(k) && typeof env[k] === 'string').sort().map((k) => [k, env[k]]);
  const parts = [...FP_ENV_KEYS.map((k) => str(env[k])), str(apiKeyHelper), str(accountId), prefixed, ...FP_HELPER_KEYS.map((k) => str(h[k]))];
  return createHmac('sha256', Buffer.from(salt, 'hex')).update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

// ── 权限类别(方案 §3;用户 2026-10-15 定:完全照 CLI 原生规则,只分「放任」与「非放任」两类,不按宽窄收紧)──────────
// 只认 GUI 六档(界面档位;不是 SDK 档位:「放任」在 SDK 层是 default,拿 SDK 档位判会把它误归为非放任)。
const PERMISSIVE_MODES = new Set(['bypassPermissions']);
const GUARDED_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk']);

/** GUI 档位 → 'permissive'(「放任」)| 'guarded'(其余五档)| null(其它值、缺失:读不出的档位)。 */
export function permissionClass(mode) {
  if (PERMISSIVE_MODES.has(mode)) return 'permissive';
  if (GUARDED_MODES.has(mode)) return 'guarded';
  return null;
}

/** 两个档位是否同一权限类别;任一方读不出(null)一律按"不同"(落卡片,偏安全)。 */
export function sameClass(a, b) {
  const x = permissionClass(a);
  return x !== null && x === permissionClass(b);
}

export const XS_CHAIN_DEPTH = 4;

/**
 * 去向表(接口 §4;到达时判一次,queued 在投递那一刻按同表重判)。按顺序命中第一条即止:
 *   ① 手动转发 → target-card;② 目标接收设置不是 auto → target-card;③ hop > 4(或不是正整数)→ chain-limit;
 *   ④ 已暂停 → paused;⑤ 目标没有本次启用之后记录的档案 → no-profile;⑥ 档案的 provider 指纹与当前不同 → profile-stale;
 *   ⑦ 发送方与目标权限类别不同 → class-mismatch;⑧ 目标卡住 → target-stuck;⑨ 目标忙 → queued;⑩ 其它 → processing。
 * ctx = { manual, inbound('card'|'auto'), hop, paused, hasProfile, profileFresh, senderMode, targetMode, stuck, busy }。
 * 返回 { status:'pending', heldReason } | { status:'queued' } | { status:'processing' }。工作目录、项目、档位宽窄都不参与。
 */
export function decideRoute(ctx = {}) {
  const held = (heldReason) => ({ status: 'pending', heldReason });
  if (ctx.manual) return held('target-card');
  if (ctx.inbound !== 'auto') return held('target-card');
  if (!Number.isInteger(ctx.hop) || ctx.hop < 1 || ctx.hop > XS_CHAIN_DEPTH) return held('chain-limit');
  if (ctx.paused) return held('paused');
  if (!ctx.hasProfile) return held('no-profile');
  if (!ctx.profileFresh) return held('profile-stale');
  if (!sameClass(ctx.senderMode, ctx.targetMode)) return held('class-mismatch');
  if (ctx.stuck) return held('target-stuck');
  if (ctx.busy) return { status: 'queued' };
  return { status: 'processing' };
}

/**
 * 新回合的连锁标记(方案 A10):自动兑换 → 该消息的 { chainId, hop };点卡片兑换 → null;用户发的普通回合 → null,
 * 例外是本槽还有上一回合留下的在飞后台任务(liveTasks > 0)时继承上一回合的标记(堵"回合结束后才发消息的后台子代理")。
 */
export function chainForNewTurn({ redeemed = null, liveTasks = 0, previous = null } = {}) {
  if (redeemed) return redeemed.auto ? { chainId: redeemed.chainId, hop: redeemed.hop } : null;
  return liveTasks > 0 && previous ? { chainId: previous.chainId, hop: previous.hop } : null;
}
