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
export function saveConfig(obj) {
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
  updateConfig({ passwordHash: { salt, hash } });
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
export function isLocalReq(req) {
  const a = req?.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
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
