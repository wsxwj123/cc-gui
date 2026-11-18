// r195-trim-keep-titles 的共用工具:只通过 HTTP 接口 + 会话记录文件(接口文件里写明的被测对象)工作。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

export class EnvironmentBlocked extends Error {
  constructor(message) { super(`ENVIRONMENT_BLOCKED: ${message}`); this.name = 'EnvironmentBlocked'; }
}

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = path.join(suiteDir, '.artifacts', 'runtime-data', 'home');

export function backendBase() {
  const port = Number(process.env.R195_BACKEND_PORT || 0);
  if (!port) throw new EnvironmentBlocked('set R195_BACKEND_PORT (use run-isolated.sh)');
  if ([6677, 6689, 6710, 8788, 8789, 8798, 8799].includes(port)) throw new EnvironmentBlocked(`port ${port} is reserved`);
  if (port < 6700 || port > 6999) throw new EnvironmentBlocked(`port ${port} outside 6700-6999`);
  return `http://127.0.0.1:${port}`;
}

/** 调接口:返回 { status, json, text }。 */
export async function call(request, method, url, body) {
  const opts = { method };
  if (body !== undefined) { opts.data = body; opts.headers = { 'content-type': 'application/json' }; }
  const res = await request.fetch(`${backendBase()}${url}`, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status(), json, text };
}

export const uuid = () => crypto.randomUUID();
const T0 = Date.parse('2026-11-18T10:00:00.000Z');
export const iso = (n) => new Date(T0 + n * 1000).toISOString();

// ───────────── 会话记录各类行 ─────────────
const base = (sid, ws) => ({ isSidechain: false, userType: 'external', cwd: ws, sessionId: sid, version: '2.1.322', gitBranch: '' });
export const userRec = (c, id, parent, n, content) => ({ parentUuid: parent, ...base(c.sid, c.ws), type: 'user', message: { role: 'user', content }, uuid: id, timestamp: iso(n) });
export const asstRec = (c, id, parent, n, content) => ({
  parentUuid: parent, ...base(c.sid, c.ws), type: 'assistant',
  message: { id: `msg_${id.slice(0, 12)}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
  uuid: id, timestamp: iso(n),
});
export const customTitle = (sid, t) => ({ type: 'custom-title', customTitle: t, sessionId: sid });
export const aiTitle = (sid, t) => ({ type: 'ai-title', aiTitle: t, sessionId: sid });
export const tagRec = (sid, t) => ({ type: 'tag', tag: t, sessionId: sid });

const toLine = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
export function writeLines(file, lines) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${lines.map(toLine).join('\n')}\n`); }
export function appendLines(file, lines) { fs.appendFileSync(file, `${lines.map(toLine).join('\n')}\n`); }
/** 原样读出所有非空行(不解析)。 */
export function rawLines(file) { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== ''); }
export function records(file) { return rawLines(file).map((l) => JSON.parse(l)); }
export const lastOfType = (recs, type) => { for (let i = recs.length - 1; i >= 0; i -= 1) if (recs[i].type === type) return recs[i]; return null; };

/**
 * 新建一个全新的工作区(系统临时目录物理路径下)和会话 S 的记录文件。
 * opts.leading / opts.tail / opts.a2 可以是值或 (c)=>值;leading:第一条用户消息之前的行(默认:改名记录「旧名」);tail:第 2 轮之后追加的行。
 * 记录:[leading…, U1, A1, U2, A2, …tail]。
 */
export function newSession(opts = {}) {
  const ws = path.join(fs.realpathSync(os.tmpdir()), `r195ws-${crypto.randomBytes(5).toString('hex')}`);
  fs.mkdirSync(ws, { recursive: true });
  const hash = ws.replace(/\//g, '-');
  const sid = uuid();
  const c = { sid, ws, hash, dir: path.join(HOME, '.claude', 'projects', hash) };
  c.file = path.join(c.dir, `${sid}.jsonl`);
  c.u1 = uuid(); c.a1 = uuid(); c.u2 = uuid(); c.a2 = uuid();
  c.u2Text = opts.u2Text || '第二个问题:再说一遍';
  c.recU1 = userRec(c, c.u1, null, 1, '第一个问题:你好');
  c.recA1 = asstRec(c, c.a1, c.u1, 2, [{ type: 'text', text: '第一个回答' }]);
  c.recU2 = userRec(c, c.u2, c.a1, 3, c.u2Text);
  c.recA2 = opts.a2 ? opts.a2(c) : asstRec(c, c.a2, c.u2, 4, [{ type: 'text', text: '第二个回答' }]);
  const val = (v) => (typeof v === 'function' ? v(c) : v);
  c.leading = val(opts.leading) || [customTitle(sid, '旧名')];
  c.before = [...c.leading, c.recU1, c.recA1]; // 截断点(U2)之前的行
  writeLines(c.file, [...c.before, c.recU2, c.recA2, ...(val(opts.tail) || [])]);
  c.beforeRaw = c.before.map(toLine);
  return c;
}

// ───────────── 接口封装 ─────────────
export async function rename(request, sid, title) {
  const r = await call(request, 'PUT', '/api/prefs/custom-titles', { sessionId: sid, title });
  expect(r.status, `改名接口:${r.text}`).toBe(200);
  expect(r.json?.ok, '改名接口 ok').toBe(true);
  return r;
}

export async function listItem(request, hash, sid) {
  const r = await call(request, 'GET', `/api/projects/${encodeURIComponent(hash)}/sessions`);
  expect(r.status, `会话列表:${r.text}`).toBe(200);
  expect(Array.isArray(r.json), `会话列表应是数组:${r.text.slice(0, 200)}`).toBe(true);
  return r.json.find((x) => x.sessionId === sid) || null;
}

export async function prefTitles(request) {
  const r = await call(request, 'GET', '/api/prefs/custom-titles');
  expect(r.status).toBe(200);
  return r.json?.titles || {};
}

/** 预览 + 带令牌提交;两步都必须 200,返回提交应答。 */
export async function rollback(request, c, op, params, sid = c.sid) {
  const url = `/api/sessions/${sid}/${op}`;
  const pv = await call(request, 'POST', url, { projectHash: c.hash, dryRun: true, ...params });
  expect(pv.status, `${op} 预览:${pv.text}`).toBe(200);
  expect(typeof pv.json?.previewToken, `${op} 预览应给 previewToken`).toBe('string');
  const cm = await call(request, 'POST', url, { projectHash: c.hash, dryRun: false, previewToken: pv.json.previewToken, baseVersion: pv.json.baseVersion, ...params });
  expect(cm.status, `${op} 提交:${cm.text}`).toBe(200);
  expect(cm.json?.ok, `${op} 提交 ok`).toBe(true);
  return cm.json;
}
