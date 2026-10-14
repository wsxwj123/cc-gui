// r151a 接口层工具:HTTP、WS 广播收集、事件流读取、provider 场景、文件快照、只读注入、假 CLI 记录读取。
// 全部是黑盒仪器:只走 HTTP / 文件 / 假 CLI 的记录,不碰产品代码。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  ctlDir, mockDir, PREFS, OVERRIDES, SETTINGS, ACTIVE_PROVIDER, GUI_DIR, CLAUDE_DIR, makeWorkspace,
} from './fixtures.mjs';

export const API = process.env.R151A_API_BASE || 'http://127.0.0.1:0';
export const MOCK = process.env.R151A_MOCK_BASE || 'http://127.0.0.1:0';
export const WS_URL = API.replace(/^http/, 'ws') + '/ws';

// ---------------- HTTP ----------------
/** 发请求,返回 { status, body(解析后的 JSON 或 null), text }。body 传字符串时原样发(用来发非对象请求体)。 */
export async function call(method, p, body, { headers = {}, timeoutMs = 20_000 } = {}) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.headers['content-type'] = init.headers['content-type'] || 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const r = await fetch(API + p, init);
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: r.status, body: parsed, text };
}
export const get = (p, o) => call('GET', p, undefined, o);
export const put = (p, b, o) => call('PUT', p, b, o);
export const post = (p, b, o) => call('POST', p, b, o);

/** 断言一个错误应答:状态码、错误体三件套逐字相等(Y.3 开头:错误体统一为 { ok:false, code, error })。 */
export function expectError(res, e, what = '') {
  expect(res.status, `${what} 状态码(应答原文:${res.text.slice(0, 300)})`).toBe(e.status);
  expect(res.body, `${what} 错误体应是 JSON(应答原文:${res.text.slice(0, 300)})`).not.toBeNull();
  expect(res.body.ok, `${what} ok`).toBe(false);
  expect(res.body.code, `${what} code`).toBe(e.code);
  expect(res.body.error, `${what} error 文案`).toBe(e.error);
}

// ---------------- WS 广播 ----------------
/** 连上 /ws,把收到的每条 JSON 消息都记下来。用完必须 close()。 */
export async function wsCollector() {
  const msgs = [];
  const ws = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS 连接超时')), 10_000);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = (e) => { clearTimeout(t); reject(new Error(`WS 连接失败:${e.message || e.type}`)); };
  });
  ws.onmessage = (e) => { try { msgs.push(JSON.parse(String(e.data))); } catch { /* 非 JSON */ } };
  await new Promise((r) => setTimeout(r, 300));   // 让连接期的首包先过去
  return {
    msgs,
    ofType: (type) => msgs.filter((m) => m && m.type === type),
    async waitFor(pred, ms = 5_000) {
      const t0 = Date.now();
      for (;;) {
        const hit = msgs.find(pred);
        if (hit) return hit;
        if (Date.now() - t0 > ms) return null;
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    close: () => { try { ws.close(); } catch { /* */ } },
  };
}

// ---------------- 会话事件流 ----------------
/** 读 GET /api/chat/:pid/stream(SSE),直到出现 type=done / type=result 之后再收 600ms,或超时。返回事件数组。 */
export async function readStream(pid, { timeoutMs = 20_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const events = [];
  try {
    const r = await fetch(`${API}/api/chat/${encodeURIComponent(pid)}/stream`, { signal: ctrl.signal });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let doneAt = 0;
    for (;;) {
      const race = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res({ tick: true }), 200))]);
      if (race && race.tick) { if (doneAt && Date.now() - doneAt > 600) break; continue; }
      const { value, done } = race;
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data) continue;
        try { const ev = JSON.parse(data); events.push(ev); if ((ev.type === 'done' || ev.type === 'result') && !doneAt) doneAt = Date.now(); } catch { /* 非 JSON */ }
      }
      if (doneAt && Date.now() - doneAt > 600) break;
    }
  } catch { /* 超时 / 中断:返回已收到的 */ } finally { clearTimeout(timer); ctrl.abort(); }
  return events;
}
/** 去掉事件里随运行变化的键(runId / seq / uuid / session_id),便于逐字比对。 */
export const stripRunKeys = (ev) => { const { runId, seq, uuid, session_id: s, ...rest } = ev; return rest; };

// ---------------- 假模型接口车道 ----------------
export const laneURL = (lane) => `${MOCK}/lane/${lane}`;
export function setLane(lane, ctl) {
  const d = path.join(mockDir(), 'lanes', lane);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'ctl.json'), JSON.stringify(ctl));
}
export function laneRequests(lane) {
  try {
    return fs.readFileSync(path.join(mockDir(), 'lanes', lane, 'requests.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
export function clearLane(lane) { try { fs.rmSync(path.join(mockDir(), 'lanes', lane, 'requests.jsonl')); } catch { /* */ } }

// ---------------- provider 场景 ----------------
/**
 * 建(或重置)一个第三方自定义 provider,车道 = key。config: { models, defaultModel, tierModels, laneModels, type }。
 * laneModels 省略时 = models(模型列表接口与配置一致);config.models 为空时,laneModels 决定"取不到 / 为空"。
 * 返回 provider id。
 */
export async function ensureProvider(key, config = {}) {
  const models = config.models ?? ['r151-chat', 'r151-reasoner'];
  const laneModels = config.laneModels ?? models;
  setLane(key, { models: laneModels });
  const body = {
    name: `R151-${key}`, type: config.type || 'anthropic', baseURL: laneURL(key), apiKey: 'dummy-r151-key',
    models, defaultModel: config.defaultModel ?? (models[0] || ''), tierModels: config.tierModels ?? null,
  };
  const created = await post('/api/custom-providers', body);
  expect(created.status, `前置:建 provider ${key}(${created.text.slice(0, 200)})`).toBe(200);
  const id = created.body.id;
  if (created.body.existed) {
    const upd = await put(`/api/custom-providers/${id}`, body);
    expect(upd.status, `前置:重置 provider ${key}(${upd.text.slice(0, 200)})`).toBe(200);
  }
  return id;
}
export async function useProvider(id) {
  const r = await post('/api/provider/switch', { id });
  expect(r.status, `前置:切到 provider ${id}(${r.text.slice(0, 200)})`).toBe(200);
  return r.body;
}
export const OFFICIAL_ID = 'builtin-official';
export const useOfficial = () => useProvider(OFFICIAL_ID);
/** "认不出当前 provider":settings.json 指向一个不属于任何 provider 的第三方地址,且没有当前 provider 记录。 */
export function useUnknownProvider() {
  writeJson(SETTINGS(), { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:6998/lane/nobody', ANTHROPIC_AUTH_TOKEN: 'dummy-r151-unknown', ANTHROPIC_MODEL: 'r151-chat', ANTHROPIC_DEFAULT_SONNET_MODEL: 'r151-chat' } });
  for (const f of [ACTIVE_PROVIDER(), path.join(GUI_DIR(), 'anthropic-active.json')]) { try { fs.rmSync(f); } catch { /* */ } }
}

// ---------------- 第三方 auto 总开关 ----------------
export const setTpAuto = (enabled) => put('/api/prefs/third-party-auto', { enabled });
/** 前置:打开开关(必须成功,否则这条用例的前提不成立)。 */
export async function tpAutoOn() {
  const r = await setTpAuto(true);
  expect(r.status, `前置:PUT /api/prefs/third-party-auto {enabled:true} 应成功(${r.text.slice(0, 200)})`).toBe(200);
}
/** 前置:确保开关关着 —— 不依赖新接口:删掉偏好文件里的键(键缺失 = 关),再顺手 PUT 一次 false(实现若有内存缓存也会被刷掉)。 */
export async function tpAutoOff() {
  const prefs = readJson(PREFS()) || {};
  delete prefs.thirdPartyAuto;
  writeJson(PREFS(), prefs);
  await setTpAuto(false).catch(() => null);
  const p2 = readJson(PREFS()) || {};
  if (p2.thirdPartyAuto === true) { delete p2.thirdPartyAuto; writeJson(PREFS(), p2); }
}
export function resetOverrides(obj = {}) { writeJson(OVERRIDES(), obj); }

// ---------------- 文件 ----------------
export const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
export const readJson = (p) => { const t = readText(p); if (t === null) return null; try { return JSON.parse(t); } catch { return null; } };
export const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2)); };
/** 文件快照(不存在记为 null)。 */
export const snapshot = (paths) => Object.fromEntries(paths.map((p) => [p, readText(p)]));
export function expectUnchanged(before, what) {
  for (const [p, content] of Object.entries(before)) expect(readText(p), `${what}:${path.basename(p)} 不应被改动`).toBe(content);
}
export const settingsEnv = () => (readJson(SETTINGS()) || {}).env || {};
export { PREFS, OVERRIDES, SETTINGS, ACTIVE_PROVIDER, GUI_DIR, CLAUDE_DIR };

/**
 * 把这些路径临时设成只读(文件 0444、目录 0555),跑完 fn 一定还原。用来造"落盘失败"。
 * 目录也要锁:原子写(写临时文件再改名)只锁文件挡不住。
 */
export async function withReadOnly(paths, fn) {
  const saved = [];
  for (const p of paths) {
    let st; try { st = fs.statSync(p); } catch { continue; }
    saved.push([p, st.mode & 0o777]);
    fs.chmodSync(p, st.isDirectory() ? 0o555 : 0o444);
  }
  try { return await fn(); } finally {
    for (const [p, m] of saved.reverse()) { try { fs.chmodSync(p, m); } catch { /* */ } }
  }
}

// ---------------- 假 CLI 的记录 ----------------
const jsonl = (file) => { try { return fs.readFileSync(path.join(ctlDir(), file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
export const spawnRecords = () => jsonl('spawn.jsonl');
export const controlRecords = () => jsonl('control.jsonl');
export const permResponses = () => jsonl('perm-responses.jsonl');
export const hookResponses = () => jsonl('hook-responses.jsonl');
export const turnRecords = () => jsonl('turns.jsonl');
/** 等到出现一条"在 cwd 里起的交互式会话进程"的记录。 */
export async function waitSpawn(cwd, { timeoutMs = 15_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const hit = spawnRecords().filter((r) => r.interactive && r.cwd === cwd).pop();
    if (hit) return hit;
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}
export function writeScript(name, steps) {
  const d = path.join(ctlDir(), 'scripts');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${name}.json`), JSON.stringify(steps));
}
export const touchCtl = (name) => fs.writeFileSync(path.join(ctlDir(), name), String(Date.now()));

/**
 * 在一个全新工作区里起一回合(不带 sessionId = 新会话)。返回 { res, cwd }。
 * 默认让假 claude 在回合结束后自己退出(提示词里带 R151EXIT);要常驻进程(之后还要切档)就传 keepAlive:true。
 */
export async function startTurn(name, extra = {}) {
  const { keepAlive, prompt, ...rest } = extra;
  const cwd = makeWorkspace(name);
  const text = `${prompt || `R151 ${name}`}${keepAlive ? '' : ' R151EXIT'}`;
  const res = await post('/api/chat', { cwd, ...rest, prompt: text });
  return { res, cwd };
}
