// r209 验收套件的公共件:路径、造文件、HTTP 调用、原始请求。只通过 HTTP 与页面观测被测系统,不 import 任何 server/ client/ 模块。
// 家目录一律是套件自己 .artifacts 下的假家目录;任何写文件、删文件的辅助都先核对路径落在 .artifacts 里面。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const art = (...p) => path.join(suiteDir, '.artifacts', ...p);
export const dataRoot = () => art('runtime-data');
export const mainHome = () => path.join(dataRoot(), 'home');
export const sweepHome = () => path.join(dataRoot(), 'home-sweep');
export const projectsOf = (home) => path.join(home, '.claude', 'projects');
export const mainR = () => projectsOf(mainHome());
export const sweepR = () => projectsOf(sweepHome());
export const manifestPath = () => art('fixture-manifest.json');
export const stdoutLog = (name) => path.join(dataRoot(), `server-${name}.stdout.log`);
export const stderrLog = (name) => path.join(dataRoot(), `server-${name}.stderr.log`);
export const DAY = 86_400_000;
export const CAP_RULE = { maxAgeDays: 14, maxPerSession: 3 };

export class EnvironmentBlocked extends Error {
  constructor(m) { super(`ENVIRONMENT_BLOCKED: ${m}`); this.name = 'EnvironmentBlocked'; }
}
export function getRuntime() {
  const baseURL = process.env.BASE_URL;
  if (!baseURL) throw new EnvironmentBlocked('set BASE_URL (use run.sh)');
  const u = new URL(baseURL);
  const port = Number(u.port || 80);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new EnvironmentBlocked('BASE_URL must be loopback');
  if ([6677, 6689, 6710, 8788, 8789, 8798, 8799].includes(port) || port < 6700 || port > 6999) throw new EnvironmentBlocked(`port ${port} not allowed`);
  return { baseURL: u.toString().replace(/\/$/, ''), port };
}
export function backendUrl() {
  const b = process.env.R209_BACKEND_URL;
  if (!b) throw new EnvironmentBlocked('set R209_BACKEND_URL (use run.sh)');
  const port = Number(new URL(b).port);
  if (![6811, 6813].includes(port)) throw new EnvironmentBlocked(`backend port ${port} not one of this suite's`);
  return b;
}
export function fixtureManifest() {
  if (!fs.existsSync(manifestPath())) throw new EnvironmentBlocked(`missing ${manifestPath()}`);
  return JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
}

// ───────── 造文件 ─────────
/** 保险:任何改动只许发生在本套件 .artifacts 之内。 */
export function guard(p) {
  const root = fs.realpathSync(art()) + path.sep;
  let probe = path.resolve(p);
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = path.join(fs.realpathSync(probe), path.relative(probe, path.resolve(p)));
  if (!(real + path.sep).startsWith(root) && real !== root.slice(0, -1)) throw new Error(`拒绝在套件目录之外动文件:${p}`);
  return p;
}
export const sidOf = (n) => `a0900000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const tok = (c) => c.repeat(24);
export const hb = (sid, ts, token) => `${sid}.jsonl.histbak-${ts}-${token}`;      // 现行
export const hbOld = (sid, ts) => `${sid}.jsonl.histbak-${ts}`;                    // 9 月旧形态
export const bakTs = (sid, ts) => `${sid}.jsonl.bak-${ts}`;                        // 体检
export const bakPlain = (sid) => `${sid}.jsonl.bak`;                               // 古早

/** 写一个文件:size 字节(内容可指定,不够补空格)、可设修改时间(毫秒,取整秒)。 */
export function putFile(dir, name, { size = 100, content, mtimeMs } = {}) {
  guard(dir);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  let body = content ?? '';
  const buf = Buffer.alloc(size, 0x20);
  Buffer.from(body).copy(buf, 0, 0, size);
  if (Buffer.byteLength(body) > size) throw new Error(`内容 ${Buffer.byteLength(body)} 字节超过指定大小 ${size}`);
  if (size > 0 && body) buf[Math.min(size - 1, Buffer.byteLength(body))] = 0x0a;
  fs.writeFileSync(f, buf.subarray(0, size));
  if (mtimeMs !== undefined) { const s = Math.floor(mtimeMs / 1000); fs.utimesSync(f, s, s); }
  return f;
}
export const userLine = (text) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}`;
/** 一份会话记录(只有一行用户消息),标题取这条。 */
export function putSession(dir, sid, text = 'R209 会话') {
  const body = `${JSON.stringify({ type: 'summary', summary: text, leafUuid: 'x' })}\n${userLine(text)}\n`;
  return putFile(dir, `${sid}.jsonl`, { size: Buffer.byteLength(body), content: body.slice(0, -1) });
}
export const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
export const names = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return null; } };
/** 目录里属于某个 sid 的四种形态备份文件名(不含 .jsonl 本身、.archived)。 */
export const backupNamesOf = (dir, sid) => (names(dir) || []).filter((n) => n.startsWith(`${sid}.jsonl.histbak-`) || n.startsWith(`${sid}.jsonl.bak`));
export const sizeOfBak = (f) => fs.lstatSync(f).size;

/** 清掉主假家目录里的备份(用例之间互不依赖):动态目录 r209-dyn-* 整个删;其余目录里只删名字含 .jsonl.histbak- / .jsonl.bak 的文件。 */
export function wipeMainBackups() {
  const R = mainR();
  guard(R);
  for (const n of fs.readdirSync(R)) {
    const p = path.join(R, n);
    if (n.startsWith('r209-dyn-') || n.startsWith('.r209-')) { fs.rmSync(guard(p), { recursive: true, force: true }); continue; }
    let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(p)) if (/\.jsonl\.(histbak-|bak)/.test(f)) fs.rmSync(guard(path.join(p, f)), { recursive: true, force: true });
  }
  fs.rmSync(guard(path.join(mainHome(), 'r209-outside')), { recursive: true, force: true });
}
export const dynDir = (tag) => path.join(mainR(), `r209-dyn-${tag}`);

// ───────── HTTP ─────────
export async function api(method, urlPath, body, base = backendUrl()) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = typeof body === 'string' ? body : JSON.stringify(body); }
  const res = await fetch(`${base}${urlPath}`, init);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
  return { status: res.status, json, text };
}
/** 原始请求:路径原样发出,不做 URL 规范化(要发 %2e%2e 这类路径)。 */
export function rawRequest(method, rawPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(backendUrl());
    const headers = body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    const req = http.request({ host: u.hostname, port: u.port, method, path: rawPath, headers }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch { /* */ } resolve({ status: res.statusCode, json, text: t }); });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('请求超时 15s')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
export const listBackups = () => api('GET', '/api/history-backups');
export const delSingle = (hash, sid) => api('DELETE', `/api/history-backups/${encodeURIComponent(hash)}/${encodeURIComponent(sid)}`);
export const delAll = () => api('DELETE', '/api/history-backups/all');
