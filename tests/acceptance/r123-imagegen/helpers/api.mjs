// r123 · 对隔离实例直调接口(只用 INTERFACE-r123「既有接口」公布的那几条)。
//   R123_API_BASE / R123_DATA_ROOT / R123_HOME 由 run.sh 注入。
import fs from 'node:fs';
import path from 'node:path';

export const API_BASE = process.env.R123_API_BASE || '';
export const HOME_DIR = process.env.R123_HOME || '';
/** 可辨识的假 key:C4 用它在所有字段里搜。 */
export const FAKE_KEY = 'sk-r123-SECRET-KEY-9f8e7d6c5b4a3210';

export async function req(method, url, body) {
  if (!API_BASE) throw new Error('R123_API_BASE 未设置(run.sh 负责)');
  const res = await fetch(API_BASE + url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, text, json };
}

/** 每条用例自己的落盘目录(隔离 HOME 之下,跑完由 run 目录整体留档)。 */
export function newSaveDir(label) {
  if (!HOME_DIR) throw new Error('R123_HOME 未设置(run.sh 负责)');
  const dir = path.join(HOME_DIR, 'images', `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 建一个提供方(默认 openai 协议 + 假 key),返回接口回显(含 id)。 */
export async function createProvider(overrides = {}) {
  const body = { name: `r123 ${overrides.protocol || 'openai'} ${Date.now().toString(36)}`, protocol: 'openai', apiKey: FAKE_KEY, model: 'm', size: '1024x1024', ...overrides };
  const r = await req('POST', '/api/image-providers', body);
  if (r.status !== 200 || !r.json?.id) throw new Error(`建提供方失败:HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}

export async function listProviders() {
  const r = await req('GET', '/api/image-providers');
  const j = r.json;
  return Array.isArray(j) ? j : (j?.providers || j?.items || []);
}

export async function generate(providerId, prompt = 'r123 一只猫') {
  const r = await req('POST', '/api/image/generate', { providerId, prompt });
  if (r.status !== 200 || !r.json?.jobId) throw new Error(`提交生成失败:HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r.json.jobId;
}

export async function history() {
  const r = await req('GET', '/api/image/history');
  const j = r.json;
  return Array.isArray(j) ? j : (j?.history || j?.items || []);
}

export async function entryOf(jobId) {
  return (await history()).find((e) => e.id === jobId) || null;
}

const TERMINAL = (s) => s === 'done' || s === 'error' || /cancel/i.test(String(s || ''));

/** 轮询历史直到条目落终态(done / error / 取消);超时返回最后看到的条目(status 仍非终态)或 null。 */
export async function waitTerminal(jobId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await entryOf(jobId);
    if (last && TERMINAL(last.status)) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** 兜底:用例结束时把还没落终态的任务取消掉,免得占并发名额拖累后面的用例(不是判据)。 */
export async function cancelIfRunning(jobId) {
  if (!jobId) return;
  const e = await entryOf(jobId).catch(() => null);
  if (!e || TERMINAL(e.status)) return;
  await req('POST', `/api/image/jobs/${jobId}/cancel`).catch(() => {});
}

/** 条目全文(含嵌套)里是否出现某段文字 —— C4 搜 key 用。 */
export const containsText = (obj, needle) => JSON.stringify(obj ?? null).includes(needle);

/** 落终态的条目里所有文件是否都真的在磁盘上,并返回字节长度数组。 */
export const fileSizes = (entry) => (entry.files || []).map((f) => (fs.existsSync(f) ? fs.statSync(f).size : -1));
export const readFile = (f) => fs.readFileSync(f);
