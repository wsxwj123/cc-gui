// r151u 本套件辅助:HTTP、SSE(带到达时刻、能分清"服务端关闭"和"客户端中止")、WebSocket 广播、agents/active 状态、
// 会话句柄(发送 / 引导 / 放行假命令行 / 读它的吐出记录)。只走 HTTP / SSE / WS / 文件 / 外部进程记录,不 import 产品代码。
import crypto from 'node:crypto';
import { sleep, seedSession } from './inst.mjs';

export { sleep };
/** 接口文件:"立即"= 2 秒内。轮询有间隔,量到的时刻允许多出这点误差(不放宽到 2 秒以外的语义)。 */
export const IMMEDIATE_MS = 2000;
export const TOL_MS = 300;

export async function http(base, method, p, body, timeoutMs = 20_000) {
  const init = { method, headers: {}, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = typeof body === 'string' ? body : JSON.stringify(body); }
  const r = await fetch(base + p, init);
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: r.status, body: parsed, text };
}

/** 轮询到 fn() 返回真值或超时(返回 null)。 */
export async function waitFor(fn, ms = 10_000, step = 50) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}
export const sleepUntil = (ts) => sleep(Math.max(0, ts - Date.now()));

// ---------------- SSE ----------------
/**
 * 连 GET /api/chat/:pid/stream(不带游标),边收边放进 events。
 * closedByServer:读到流的正常结束(服务端关了连接);客户端 abort() 不算。
 */
export function openStream(base, pid) {
  const events = [];
  const stamps = new WeakMap();
  const ctrl = new AbortController();
  const st = { status: null, closedByServer: false, closedAt: null, error: null };
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const run = (async () => {
    try {
      const r = await fetch(`${base}/api/chat/${encodeURIComponent(pid)}/stream`, { signal: ctrl.signal });
      st.status = r.status;
      resolveReady(r.status);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { st.closedByServer = true; st.closedAt = Date.now(); break; }
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          try { const ev = JSON.parse(data); stamps.set(ev, Date.now()); events.push(ev); } catch { /* 非 JSON */ }
        }
      }
    } catch (e) { st.error = String((e && e.name) || e); } finally { resolveReady(st.status); }
  })();
  const isDone = (e) => Boolean(e && e.type === 'done');
  return {
    events, ready, run, st,
    get closedByServer() { return st.closedByServer; },
    get closedAt() { return st.closedAt; },
    stampOf: (ev) => stamps.get(ev) || null,
    doneEvent: () => events.find(isDone) || null,
    doneAt: () => { const d = events.find(isDone); return d ? stamps.get(d) : null; },
    texts: () => events.filter((e) => e && e.type === 'assistant' && e.message && Array.isArray(e.message.content))
      .flatMap((e) => e.message.content.filter((b) => b && b.type === 'text').map((b) => b.text)),
    stallNotices: () => events.filter((e) => e && e.type === 'stall_notice'),
    waitFor: (pred, ms = 10_000) => waitFor(() => events.find(pred) || null, ms, 40),
    waitDone: (ms) => waitFor(() => events.find(isDone) || null, ms, 40),
    waitClosed: (ms) => waitFor(() => st.closedByServer || null, ms, 40),
    abort: () => { try { ctrl.abort(); } catch { /* */ } },
    summary: () => JSON.stringify({ status: st.status, closedByServer: st.closedByServer, error: st.error, types: events.map((e) => e && (e.type === 'assistant' ? `assistant:${(e.message?.content?.[0]?.text) || (e.message?.content?.[0]?.name) || ''}` : e.type)).slice(-14) }),
  };
}

// ---------------- WebSocket 广播 ----------------
export async function wsOpen(base) {
  const msgs = [];
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS 连接超时')), 10_000);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = (e) => { clearTimeout(t); reject(new Error(`WS 连接失败:${e.message || e.type}`)); };
  });
  ws.onmessage = (e) => { try { msgs.push({ t: Date.now(), m: JSON.parse(String(e.data)) }); } catch { /* 非 JSON */ } };
  await sleep(300);
  return {
    msgs,
    ofType: (type, sid) => msgs.filter((x) => x.m && x.m.type === type && (!sid || x.m.sessionId === sid)),
    close: () => { try { ws.close(); } catch { /* */ } },
  };
}

// ---------------- agents/active ----------------
export async function activeEntry(base, sid) {
  const r = await http(base, 'GET', '/api/agents/active', undefined, 5_000);
  const list = r.body && Array.isArray(r.body.agents) ? r.body.agents : [];
  return list.find((x) => x && x.kind === 'chat-process' && x.sessionId === sid) || null;
}
export const statusOf = async (base, sid) => { try { const e = await activeEntry(base, sid); return e ? e.status : null; } catch { return 'ERR'; } };

// ---------------- 会话句柄 ----------------
/** 假命令行吐出记录(emit.jsonl 摘要)的常用判断。 */
export const isText = (text) => (e) => e.ev === 'assistant' && e.text === text;
export const isLife = (state, cu) => (e) => e.ev === 'command_lifecycle' && e.sub === state && (!cu || e.cu === cu);
export const isEv = (ev) => (e) => e.ev === ev;

/**
 * 一个会话(实例的临时 HOME 里已落好旧记录)。同一实例里可建多个会话:脚本名、放行文件名都带会话名前缀,互不串。
 * 用法:ses.script('a', 定义) → ses.send('标签', 'a') → ses.steer('标签', 'b') → ses.release('holdA') …
 */
export function newSession(inst, name) {
  const { sid, cwd } = seedSession(inst, name);
  const ses = { inst, base: inst.base, sid, cwd, name, pid: null, lastStatuses: [] };
  ses.f = (n) => `${name}-${n}`;
  ses.mark = (key) => `U151:${name}-${key}`;
  ses.script = (key, def) => inst.writeScript(`${name}-${key}`, def);
  ses.release = (n) => inst.release(ses.f(n));
  ses.send = async (label, key, promptSuggestions) => {
    // 接口文件"测试环境约定":输入预测开关每次显式给 —— 每次 POST /api/chat 都带 promptSuggestions(true / false,按用例定)。不带时服务端按 settings 判渠道,
    // 本环境里会默认打开,时序会变,所以这里不给默认值、漏传直接抛错。本套件所有 POST /api/chat 都经这一个入口发。
    if (typeof promptSuggestions !== 'boolean') throw new Error('夹具错误:ses.send 必须显式传 promptSuggestions(true / false)');
    const body = { sessionId: sid, cwd, permissionMode: 'default', promptSuggestions, prompt: `${label}${key ? ` ${ses.mark(key)}` : ''}` };
    const r = await http(inst.base, 'POST', '/api/chat', body, 30_000);
    if (r.body && r.body.pid) ses.pid = r.body.pid;
    return r;
  };
  ses.stream = () => openStream(inst.base, ses.pid);
  ses.steer = async (label, key) => {
    const uuid = crypto.randomUUID();
    const r = await http(inst.base, 'POST', '/api/chat/steer', { sessionId: sid, uuid, content: `${label}${key ? ` ${ses.mark(key)}` : ''}` }, 15_000);
    return { ...r, uuid };
  };
  ses.stop = () => http(inst.base, 'POST', `/api/chat/${encodeURIComponent(ses.pid)}/stop`, {}, 20_000);
  ses.status = () => statusOf(inst.base, sid);
  ses.emits = () => inst.emits(sid);
  ses.find = (pred) => ses.emits().find(pred) || null;
  ses.waitEmit = (pred, ms = 10_000) => waitFor(() => ses.find(pred), ms, 30);
  ses.results = () => ses.emits().filter(isEv('result'));
  ses.waitResult = (n, ms = 10_000) => waitFor(() => ses.results()[n - 1] || null, ms, 30);
  ses.fakePid = () => inst.fakePids(sid)[0] ?? null;
  ses.diag = async () => {
    let entry = null;
    try { entry = await activeEntry(inst.base, sid); } catch { entry = 'ERR'; }
    const tail = ses.emits().slice(-10).map((e) => `${e.ev}${e.sub ? `/${e.sub}` : ''}${e.text ? `:${e.text}` : ''}`);
    return `active=${JSON.stringify(entry && entry.status !== undefined ? { status: entry.status, pid: entry.pid } : entry)};fake最近吐出=${JSON.stringify(tail)}`;
  };
  return ses;
}

/** 发第一条消息、开 S1、等假命令行吐出 firstText(默认 A-1)。前置不成立直接抛错(是夹具问题,不是产品问题)。 */
export async function start(ses, label, key, promptSuggestions, firstText = 'A-1') {
  const r = await ses.send(label, key, promptSuggestions);
  if (r.status !== 200 || !ses.pid) throw new Error(`前置失败:POST /api/chat 应 200 且带 pid(实际 ${r.status}:${String(r.text).slice(0, 240)})`);
  const s1 = ses.stream();
  const st = await s1.ready;
  if (st !== 200) throw new Error(`前置失败:发送时开流应 200(实际 ${st})`);
  const hit = await ses.waitEmit(isText(firstText), 10_000);
  if (!hit) throw new Error(`前置失败:假命令行没吐出 ${firstText}(记录:${JSON.stringify(ses.emits().slice(-8))};stdin:${JSON.stringify(ses.inst.stdinLines(ses.sid).slice(-3))})`);
  return { s1, r };
}

/**
 * 等会话报成 idle:采样时刻 ≥ settleFrom 且连续 ≥120ms 都是 idle 才算(防"result 与 completed 之间的瞬时 idle"误判);
 * 第一次稳定 idle 的时刻 ≤ by 才算 ok。超过 by+600ms 还没稳定就放弃。返回 { ok, firstIdleAt, last }。
 */
export async function waitIdle(ses, { settleFrom = 0, by }) {
  let streak = null; let last = null;
  for (;;) {
    const s = await ses.status();
    last = { at: Date.now(), status: s };
    if (s === 'idle' && last.at >= settleFrom) {
      if (streak === null) streak = last.at;
      if (last.at - streak >= 120) return { ok: streak <= by, firstIdleAt: streak, last };
    } else streak = null;
    if (Date.now() > by + 600) return { ok: false, firstIdleAt: null, last };
    await sleep(60);
  }
}

/** 从 fromMs 到 untilMs 每 stepMs 采一次状态。返回 [{ t, s }]。 */
export async function sampleStatus(ses, fromMs, untilMs, stepMs = 100) {
  await sleepUntil(fromMs);
  const out = [];
  while (Date.now() < untilMs) { out.push({ t: Date.now(), s: await ses.status() }); await sleep(stepMs); }
  return out;
}
export const histogram = (samples) => JSON.stringify(samples.reduce((a, x) => { a[x.s] = (a[x.s] || 0) + 1; return a; }, {}));
