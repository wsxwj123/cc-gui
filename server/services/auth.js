// Password auth for LAN/Tailscale exposure.
//
// Design (per the user's choices): only EXTERNAL clients need a password —
// requests originating from 127.0.0.1 (the Mac itself) always bypass auth so
// local use is friction-free. A password is only meaningful when the server is
// bound to 0.0.0.0; in loopback-only mode every request is local anyway.
//
// No third-party deps: scrypt for the password hash, HMAC-signed cookie tokens,
// all from Node's built-in `crypto`. The token secret is persisted in
// network.json so a restart doesn't force every phone to re-login.
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const CONFIG_PATH = join(homedir(), '.claude-gui', 'network.json');

// ── config (shared file with host/port) ──────────────────────────
export function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {}
  return {};
}
function saveConfig(obj) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2));
}
// Merge a partial update WITHOUT clobbering sibling fields (host/port vs
// passwordHash vs tokenSecret all live in this one file).
export function updateConfig(partial) {
  const next = { ...loadConfig(), ...partial };
  saveConfig(next);
  return next;
}

// ── password ─────────────────────────────────────────────────────
export function hasPassword() {
  return !!loadConfig().passwordHash;
}
export function setPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(plain), salt, 64).toString('hex');
  // 用户显式设的密码 → 清掉"默认密码"标记与明文(不再在 UI 提示"你在用默认密码")。
  updateConfig({ passwordHash: { salt, hash }, defaultPassword: false, defaultPasswordPlain: null });
}
// 公开版首启:生成【每台随机】的默认局域网密码(非全网统一硬编码),存明文供本机 UI 显示一次
// (手机连时要输;显示随机串成本为零,消灭"全网统一已知凭证"这个灾难面)。返回明文。
export function setDefaultRandomPassword() {
  const plain = randomBytes(4).toString('hex'); // 8 位十六进制,32bit 熵,配合限速在线爆破不可行
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(plain, salt, 64).toString('hex');
  updateConfig({ passwordHash: { salt, hash }, defaultPassword: true, defaultPasswordPlain: plain });
  return plain;
}
export function clearPassword() {
  const c = loadConfig();
  delete c.passwordHash;
  saveConfig(c);
}
export function verifyPassword(plain) {
  const rec = loadConfig().passwordHash;
  if (!rec || !rec.salt || !rec.hash) return false;
  const candidate = scryptSync(String(plain), rec.salt, 64);
  const stored = Buffer.from(rec.hash, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

// ── token (HMAC-signed cookie) ───────────────────────────────────
function getSecret() {
  const c = loadConfig();
  if (c.tokenSecret) return c.tokenSecret;
  const secret = randomBytes(32).toString('hex');
  updateConfig({ tokenSecret: secret });
  return secret;
}
export function issueToken(days = 30) {
  const payload = { exp: Date.now() + days * 24 * 3600 * 1000 };
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', getSecret()).update(p).digest('base64url');
  return `${p}.${sig}`;
}
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [p, sig] = token.split('.');
  if (!p || !sig) return false;
  const expected = createHmac('sha256', getSecret()).update(p).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(p, 'base64url').toString());
    return !exp || exp > Date.now();
  } catch { return false; }
}

// ── request helpers ──────────────────────────────────────────────
// 从 Host 头取主机名(剥端口)。用 URL 归一化 —— 手写正则 `:\d+$` 会把带括号的
// `[::1]:port` 剥错(IPv6 环回白名单变死代码)。URL 正确处理 [v6]:port 与 v4:port。
// 已知边界(行为 fail-safe,不改):裸 `::1`(无括号,非标准 Host 形态,浏览器总会
// 带括号)URL 解析会抛 → 走 fallback 剥成 `:` → 不匹配白名单被拒,方向是"多拦"
// 不是"多放",安全。
export function requestHostname(req) {
  const host = req?.headers?.host || '';
  if (!host) return '';
  try { return new URL('http://' + host).hostname.replace(/^\[|\]$/g, ''); }
  catch { return host.replace(/:\d+$/, ''); }
}

// 隧道域名(手机经 Cloudflare Tunnel 访问时 Host 头的值),从 network.json 读。
// 每请求现读(与 hasPassword 同模式,换配置免重启是有意为之)。小写化后校验为
// 纯主机名(不含 scheme/端口/路径);缺省/非法 → '' = 视为未配置(不放行,行为与
// 改动前完全一致),写错不炸,绝不"读不到就全开"。
export function getTunnelHostname() {
  const v = loadConfig().tunnelHostname;
  if (typeof v !== 'string') return '';
  const h = v.toLowerCase();
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h) ? h : '';
}

// 判"本机 vs 外部"的三信号与判定:socket 回环 ∧ 无 CF 四件套 ∧ Host 缺省或本机集,
// 全部满足才判本机(免密),任一不满足即外部(要密码)。拿不准一律外部(fail-safe)。
// 为什么不再只看 socket:cloudflared 跑在本机,它向 127.0.0.1 拨入,所有隧道流量的
// socket 都是回环(实测 ::ffff:127.0.0.1),只看 socket 会把公网流量误放成本机免密。
// CF 标记头(只数枚举四件套 cf-ray/cf-connecting-ip/cf-visitor/cf-ipcountry,
// cdn-loop、cf-cache-status 等不参与判定)由 Cloudflare 边缘写入,客户端无法剥离,
// 本机直连者伪造它们只会把自己判成外部 —— 但 CF 头只用于【否决】,绝不用作放行依据
// (X-Forwarded-For / cf-connecting-ip 本机可伪造,同样绝不用于 grant)。
// Host 头 curl 能伪造,但伪造方向只会"更像外部"(伪造 localhost 仍过不了 CF 否决),
// 判错永远偏向要密码一侧,属 fail-safe。
const LOCAL_SOCKET_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const CF_MARKER_HEADERS = ['cf-ray', 'cf-connecting-ip', 'cf-visitor', 'cf-ipcountry'];
export function isLocalReq(req) {
  if (!LOCAL_SOCKET_ADDRS.has(req?.socket?.remoteAddress || '')) return false;
  const headers = req?.headers || {};
  for (const h of CF_MARKER_HEADERS) if (headers[h] !== undefined) return false; // node 已小写化 header 名
  const host = requestHostname(req);
  if (host && !LOCAL_HOSTNAMES.has(host)) return false;
  return true;
}
export function parseCookies(req) {
  const raw = req?.headers?.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// True when this request is allowed through (local, no-password, or valid token).
export function isAuthorized(req) {
  if (!hasPassword()) return true;
  if (isLocalReq(req)) return true;
  return verifyToken(parseCookies(req).cgui_token);
}

// Express middleware mounted at /api. Lets /login and /auth-status through so
// the login page can load and submit; gates everything else for external
// clients when a password is set.
export function authMiddleware(req, res, next) {
  if (req.path === '/login' || req.path === '/auth-status') return next();
  if (isAuthorized(req)) return next();
  return res.status(401).json({ error: 'unauthorized', authRequired: true });
}
