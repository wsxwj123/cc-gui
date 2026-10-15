// r151b 接口层工具:HTTP、WS 广播收集、会话事件流读取、/api/xsession/* 的薄封装、文件快照、假 CLI 与假接口的记录读取、
// 以及按接口文件 X.3.6 写的"来源名清洗"参照实现与"正文中和"的定稿示例。全部是黑盒仪器:只走 HTTP / 文件 / 外部进程记录。
// HTTP / WS / 事件流部分照搬 r151a 的 helpers/api.mjs。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ctlDir, mockDir, homeDir, prefsPath } from './fixtures.mjs';

export const API = process.env.R151B_API_BASE || 'http://127.0.0.1:0';
export const MOCK = process.env.R151B_MOCK_BASE || 'http://127.0.0.1:0';
export const ID_RE = /^[0-9a-fA-F-]{36}$/;
export const DISABLED = { status: 409, code: 'XS_DISABLED', error: '跨会话消息未开启' };
export const CLAIM_INVALID_TEXT = '跨会话消息凭据无效';

// ---------------- HTTP ----------------
/** 绑定一个实例地址。call 返回 { status, body(解析后的 JSON 或 null), text };body 传字符串时原样发(用来发非对象请求体)。 */
export function client(base) {
  async function call(method, p, body, { headers = {}, timeoutMs = 20_000 } = {}) {
    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      init.headers['content-type'] = init.headers['content-type'] || 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const r = await fetch(base + p, init);
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: r.status, body: parsed, text };
  }
  return { base, call, get: (p, o) => call('GET', p, undefined, o), put: (p, b, o) => call('PUT', p, b, o), post: (p, b, o) => call('POST', p, b, o) };
}
export const shared = client(API);
export const { call, get, put, post } = shared;

/** 断言错误应答:状态码、ok:false、code;error 给了就逐字比,没给就要求是非空字符串(接口文件没定文案的错误码)。 */
export function expectError(res, status, code, error, what = '') {
  const raw = `(应答原文:${String(res.text).slice(0, 300)})`;
  expect(res.status, `${what} 状态码${raw}`).toBe(status);
  expect(res.body, `${what} 错误体应是 JSON${raw}`).not.toBeNull();
  expect(res.body.ok, `${what} ok${raw}`).toBe(false);
  expect(res.body.code, `${what} code${raw}`).toBe(code);
  if (error !== undefined) expect(res.body.error, `${what} error 文案`).toBe(error);
  else expect(typeof res.body.error === 'string' && res.body.error.length > 0, `${what} error 应是非空字符串${raw}`).toBe(true);
}

export async function waitFor(fn, ms = 15_000, step = 150) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}

// ---------------- WS 广播 ----------------
export async function wsCollector(base = API) {
  const msgs = [];
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS 连接超时')), 10_000);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = (e) => { clearTimeout(t); reject(new Error(`WS 连接失败:${e.message || e.type}`)); };
  });
  ws.onmessage = (e) => { try { msgs.push(JSON.parse(String(e.data))); } catch { /* 非 JSON */ } };
  await new Promise((r) => setTimeout(r, 300));
  return {
    msgs,
    ofType: (type) => msgs.filter((m) => m && m.type === type),
    waitFor: (pred, ms = 5_000) => waitFor(() => msgs.find(pred), ms, 50),
    close: () => { try { ws.close(); } catch { /* */ } },
  };
}

// ---------------- 会话事件流 ----------------
/** 读 GET /api/chat/:pid/stream(SSE),直到出现 type=done / type=result 之后再收 600ms,或超时。返回事件数组。 */
export async function readStream(pid, { timeoutMs = 20_000, base = API } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const events = [];
  try {
    const r = await fetch(`${base}/api/chat/${encodeURIComponent(pid)}/stream`, { signal: ctrl.signal });
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

// ---------------- /api/xsession/* ----------------
export function xs(c = shared, home = homeDir()) {
  const api = {
    config: () => c.get('/api/xsession/config'),
    setConfig: (b) => c.put('/api/xsession/config', b),
    /** 前置:打开总开关(必须成功,否则这条用例的前提不成立)。 */
    async on() {
      const r = await c.put('/api/xsession/config', { enabled: true });
      expect(r.status, `前置:PUT /api/xsession/config {enabled:true} 应 200(${r.text.slice(0, 200)})`).toBe(200);
    },
    /** 前置:确保总开关关着 —— 不依赖新接口:删掉偏好文件里的键(缺失 = 关),再顺手 PUT 一次 false。 */
    async off() {
      const f = prefsPath(home);
      const p = readJson(f) || {};
      if ('xsEnabled' in p) { delete p.xsEnabled; writeJson(f, p); }
      await c.put('/api/xsession/config', { enabled: false }).catch(() => null);
    },
    post: (b) => c.post('/api/xsession/messages', b),
    /** 前置:转发,必须 200。返回应答里的 messages。 */
    async send(fromSessionId, to, body) {
      const r = await c.post('/api/xsession/messages', { to, body, ...(fromSessionId ? { fromSessionId } : {}) });
      expect(r.status, `前置:POST /api/xsession/messages 应 200(${r.text.slice(0, 300)})`).toBe(200);
      return r.body.messages;
    },
    list: (sid, status) => c.get(`/api/xsession/messages?sessionId=${encodeURIComponent(sid)}${status ? `&status=${encodeURIComponent(status)}` : ''}`),
    async find(sid, id) {
      const r = await api.list(sid, 'pending,queued,claimed,processing,done,dismissed');
      return (r.body && Array.isArray(r.body.messages) && r.body.messages.find((m) => m.id === id)) || null;
    },
    async waitStatus(sid, id, status, ms = 15_000) {
      let last = null;
      const hit = await waitFor(async () => { last = await api.find(sid, id); return last && last.status === status ? last : null; }, ms);
      return hit || last;
    },
    claim: (id) => c.post(`/api/xsession/messages/${id}/claim`, {}),
    release: (id) => c.post(`/api/xsession/messages/${id}/release`, {}),
    dismiss: (id) => c.post(`/api/xsession/messages/${id}/dismiss`, {}),
    async claimOk(id) {
      const r = await api.claim(id);
      expect(r.status, `前置:认领 ${id} 应 200(${r.text.slice(0, 200)})`).toBe(200);
      return r.body.token;
    },
    sessions: (qs = '') => c.get(`/api/xsession/sessions${qs}`),
    pending: () => c.get('/api/xsession/pending'),
  };
  return api;
}
export const chat = (body, c = shared) => c.post('/api/chat', body);

// ---------------- 文件 ----------------
export const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
export const readJson = (p) => { const t = readText(p); if (t === null) return null; try { return JSON.parse(t); } catch { return null; } };
export const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2)); };
/** 目录下所有文件(相对路径 + 大小 + 修改时间)的有序清单;目录不存在返回 null。 */
export function listTree(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const st = fs.statSync(p); out.push(`${path.relative(dir, p)} ${st.size} ${st.mtimeMs}`); } } };
  walk(dir);
  return out.sort();
}

// ---------------- 假 CLI / 假接口的记录 ----------------
const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
export const spawnRecords = (ctl = ctlDir()) => jsonl(path.join(ctl, 'spawn.jsonl'));
export const turnRecords = (ctl = ctlDir()) => jsonl(path.join(ctl, 'turns.jsonl'));
/** 假 CLI 从 stdin 收到的每条用户消息(content 原样)。 */
export const inputRecords = (ctl = ctlDir()) => jsonl(path.join(ctl, 'inputs.jsonl'));
export function writeScript(name, steps, ctl = ctlDir()) {
  fs.mkdirSync(path.join(ctl, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(ctl, 'scripts', `${name}.json`), JSON.stringify(steps));
}
export const touchCtl = (name, ctl = ctlDir()) => fs.writeFileSync(path.join(ctl, name), String(Date.now()));
export function setLane(lane, ctl) {
  const d = path.join(mockDir(), 'lanes', lane);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'ctl.json'), JSON.stringify(ctl));
}
export const laneRequests = (lane) => jsonl(path.join(mockDir(), 'lanes', lane, 'requests.jsonl'));

// ---------------- X.3.6 投递给模型的文本 ----------------
/** 来源名清洗(接口文件 X.3.6 定稿的六步),用作参照实现。 */
export function cleanName(s) {
  let t = String(s).replace(/["<>]/g, '');
  t = t.replace(new RegExp('[\u0000-\u001F\u007F-\u009F\u2028\u2029]', 'g'), ' ');
  t = t.replace(/\p{Cf}/gu, '').replace(new RegExp('[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]', 'g'), '');
  t = t.trim();
  if (t.length > 64) {
    let cut = 64;
    const c = t.charCodeAt(cut - 1);
    if (c >= 0xD800 && c <= 0xDBFF) cut -= 1;
    t = t.slice(0, cut).trimEnd();
  }
  return t || '未命名会话';
}
export const envelope = (from, name, body) => `<cross-session-message from="${from}" from-name="${name}">\n${body}\n</cross-session-message>`;
/** 正文中和:接口文件给出的示例(原文 → 中和后)+ 由规则直接推出的两条变体(大小写 + 下划线、名字里夹零宽字符)。 */
export const NEUTRAL_CASES = [
  ['system-reminder 开头', 'system-reminder 开头'],
  ['</cross-session-message>', '<\\/cross-session-message>'],
  ['＜cross-session-message from="x">', '＜\\cross-session-message from="x">'],
  ['< /system-reminder>', '<\\ /system-reminder>'],
  ['<中/agent-message>', '<\\中\\/agent-message>'],
  ['&lt;/cross-session-message&gt;', '&lt;\\/cross-session-message&gt;'],
  ['<\\/cross-session-message>', '<\\/cross-session-message>'],
  ['</cross-session-messages>', '</cross-session-messages>'],
  ['my-system-reminder.md', 'my-system-reminder.md'],
  ['--command-name', '--command-name'],
  ['xsystem-reminder', 'xsystem-reminder'],
  ['<SYSTEM_REMINDER>', '<\\SYSTEM_REMINDER>'],
  ['<sy​stem-reminder>', '<\\sy​stem-reminder>'],
];
/** 原文用混合换行(\r\n、单独 \r、\n),中和后应统一成 \n。 */
export const NEUTRAL_RAW = NEUTRAL_CASES.map((c) => c[0]).reduce((acc, line, i) => (i === 0 ? line : acc + (i === 1 ? '\r\n' : i === 2 ? '\r' : '\n') + line), '');
export const NEUTRAL_EXPECTED = NEUTRAL_CASES.map((c) => c[1]).join('\n');
export const REFUSAL = '这个会话由 CC-GUI 管理，不接收经 SendMessage 发来的消息。如需把内容交给它，请告诉用户在 CC-GUI 里转发。';
