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

// ── 浏览器来源(Origin)校验(r155)─────────────────────────────────────────────
// 规则:来源站点(主机名+端口)必须等于本次访问的站点(Host)。旧实现只比主机名,本机
// 别的端口上的网页(localhost:任意端口)就和本应用自己的页面一样能连 WS、开终端、读接口。
// 另有一对"浏览器自证":浏览器自报 same-site/cross-site 一律拒;自报 same-origin 且是
// 本机请求、来源是本机名,放行开发代理形态(Vite 的 /api 字符串代理会把 Host 改写成后端)。
// 判定顺序固定,命中即返回;rule 名进日志,便于定位误杀。
const HOST_HEADER_RE = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' };

// Origin → { scheme, hostname, port };非标准写法(null、非 http(s)、尾斜杠、大写等
// 序列化后与原文不一致的)一律 null。端口缺省按协议补全。
function parseOriginSite(origin) {
  if (typeof origin !== 'string') return null;
  let u;
  try { u = new URL(origin); } catch { return null; }
  if (!DEFAULT_PORTS[u.protocol]) return null;
  if (u.origin !== origin) return null;
  return {
    scheme: u.protocol,
    hostname: u.hostname.toLowerCase().replace(/^\[|\]$/g, ''),
    port: u.port || DEFAULT_PORTS[u.protocol],
  };
}

// Host 头 → { hostname, port };端口缺省按 Origin 的协议补全(https://x 与 Host x 视为同站)。
// 先过严格格式,再交给 URL 归一化(端口前导零、IPv6 写法),URL 解析失败按缺 Host 处理。
function parseHostSite(hostHeader, scheme) {
  if (typeof hostHeader !== 'string' || !HOST_HEADER_RE.test(hostHeader)) return null;
  let u;
  try { u = new URL(`${scheme}//${hostHeader}`); } catch { return null; }
  return {
    hostname: u.hostname.toLowerCase().replace(/^\[|\]$/g, ''),
    port: u.port || DEFAULT_PORTS[scheme],
  };
}

function secFetchSiteTokens(req) {
  const raw = req?.headers?.['sec-fetch-site'];
  if (raw === undefined || raw === null) return [];
  return [].concat(raw).join(',').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// ctx.isAllowedHostname(h) → bool:Host 白名单(回环/局域网/隧道名),由调用方注入,每次现读。
// ctx.getLanHostnames() → string[]:只在第 6 条且来源不是本机名时才调用(枚举网卡有开销)。
// 缺参数直接抛错 —— 宁可请求失败(调用方按拒绝处理),不能悄悄放行。
export function checkBrowserOrigin(origin, req, ctx) {
  const { isAllowedHostname, getLanHostnames } = ctx || {};
  if (typeof isAllowedHostname !== 'function' || typeof getLanHostnames !== 'function') {
    throw new TypeError('checkBrowserOrigin: ctx.isAllowedHostname and ctx.getLanHostnames must be functions');
  }
  // 1. 无 Origin:非浏览器客户端或浏览器同源 GET;密码闸照常兜底。
  if (origin === undefined || origin === '') return { ok: true, rule: 'no-origin' };
  // 2. 非法/非标准写法。
  const site = parseOriginSite(origin);
  if (!site) return { ok: false, rule: 'bad-origin' };
  // 3. 浏览器自己说不是同源(页面脚本改不了这个头)→ 拒,哪怕站点文本相同(跨协议同默认端口)。
  const sfs = secFetchSiteTokens(req);
  if (sfs.includes('same-site') || sfs.includes('cross-site')) return { ok: false, rule: 'sfs-veto' };
  // 4. 没有 Host 无从比较站点 → 拒(HTTP/1.0、原始 WS 升级可以不带 Host)。
  const hostSite = parseHostSite(req?.headers?.host, site.scheme);
  if (!hostSite) return { ok: false, rule: 'no-host' };
  // 5. 站点一致:主机名还须在 Host 白名单里(函数自包含,不依赖调用方先过 Host 门)。
  if (hostSite.hostname === site.hostname && hostSite.port === site.port) {
    return isAllowedHostname(site.hostname)
      ? { ok: true, rule: 'same-site' }
      : { ok: false, rule: 'hostname-not-allowed' };
  }
  // 6. 开发代理形态:Host 被本机代理改写。只认浏览器精确小写的 same-origin + 本机请求
  //    (回环、无 CF 标记、Host 是本机名)+ 来源是本机名;名单不含隧道名。
  if (req?.headers?.['sec-fetch-site'] === 'same-origin' && isLocalReq(req)) {
    if (LOCAL_HOSTNAMES.has(site.hostname) || getLanHostnames().includes(site.hostname)) {
      return { ok: true, rule: 'proxied-same-origin' };
    }
  }
  // 7. 其余(本机别的端口且浏览器没带 Sec-Fetch-Site、别名跨站等)。
  return { ok: false, rule: 'site-mismatch' };
}

export function parseCookies(req) {
  const raw = req?.headers?.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const value = part.slice(i + 1).trim();
    // r145 F5:单个 cookie 解码失败(裸 %,如同域别的页面写的 `x=100%`)只影响它自己 —— 保留原文,其余照常。
    // 此前 decodeURIComponent 直接抛 URIError:该设备所有 /api/* 回 500,WS 握手抛未捕获异常。
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { /* 保留原文 */ }
    out[part.slice(0, i).trim()] = decoded;
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
