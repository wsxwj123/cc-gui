// r151d 本套件辅助(只走 HTTP / WS / 文件 / 外部进程记录,不 import 产品代码)。
// 一期 helpers/ 与二期 helpers/p2.mjs 原样复用;这里只放本轮新增:界面同步全局设置、进程列表、切档、
// 让旧进程推迟退出(配合 hold-claude.mjs)、真 CLI 发送方发一条消息。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { waitFor, readStream } from '../../r151b-xsession-p1/helpers/api.mjs';
import { SM, aiCalls, resultJson, msgs, entry } from '../../r151c-xsession-p2/helpers/p2.mjs';

export const NOTE_TEXT = '本机其它程序，以及「放任」档会话里的 AI，都能通过本地接口修改这里的设置和各会话的接收方式。';
export const fromSession = (x) => Boolean(x && x.from && x.from.kind === 'session');
const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 界面同步全局设置(PUT /api/xsession/send-settings,请求体恰好 7 个键) ----------------
export const newUiId = (tag) => `r151d-${tag}-${crypto.randomBytes(4).toString('hex')}`;
export const settings = (uiId, over = {}) => ({
  uiId, globalRead: false, addDirs: [], maxBudgetUsd: null, keepAlive: true, promptSuggestions: false, genui: false, ...over,
});
export async function syncUi(c, body, what = `界面 ${body.uiId} 同步全局设置`) {
  const r = await c.put('/api/xsession/send-settings', body);
  expect([r.status, r.body], `${what}(应答原文:${r.text.slice(0, 200)})`).toEqual([200, { ok: true }]);
}

// ---------------- 进程是否常驻:会话列表的 state + 进程列表(GET /api/processes 的 claudeProcesses)里是否还有这个会话的进程 ----------------
/** 返回 { state: 会话列表里该会话的 state, listed: 进程列表里命令行带该会话 id 的进程个数 }。 */
export async function residency(c, sid) {
  const e = await entry(c, sid);
  const r = await c.get('/api/processes');
  expect(r.status, `GET /api/processes 应 200(${r.text.slice(0, 200)})`).toBe(200);
  const list = r.body && Array.isArray(r.body.claudeProcesses) ? r.body.claudeProcesses : [];
  return { state: e ? e.state : null, listed: list.filter((p) => String((p && p.command) || '').includes(sid)).length };
}
export const RESIDENT = { state: 'idle', listed: 1 };
export const GONE = { state: 'stopped', listed: 0 };
/** 等到 residency 等于 want(最多 ms 毫秒),返回最后一次看到的样子。 */
export async function waitResidency(c, sid, want, ms = 12_000) {
  let last = null;
  await waitFor(async () => { last = await residency(c, sid); return last.state === want.state && last.listed === want.listed; }, ms, 300);
  return last;
}

// ---------------- 权限请求(事件流 permission:request;应答走 POST /api/permissions/respond/:id) ----------------
export const allowPerm = (c, req) => c.post(`/api/permissions/respond/${encodeURIComponent(req.id)}`, { decision: 'allow', nonce: req.nonce });
/** 事件流里某会话的权限请求(按出现先后)。 */
export const permRequests = (ws, sid) => ws.msgs.filter((m) => m && m.type === 'permission:request' && m.request && m.request.sessionId === sid).map((m) => m.request);

// ---------------- 切档 ----------------
export const setMode = (c, sid, mode) => c.post('/api/chat/permission-mode', { sessionId: sid, mode });

// ---------------- 推迟退出(hold-claude.mjs 的约定) ----------------
const mark = (ctl, dir, sid) => { const d = path.join(ctl, dir); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, sid), String(Date.now())); };
/** 从现在起,会话 sid 的进程被要求退出后先不退,直到 releaseExit。 */
export const holdExit = (ctl, sid) => mark(ctl, 'r151d-hold', sid);
export const releaseExit = (ctl, sid) => mark(ctl, 'r151d-release', sid);
export const exitLog = (ctl) => jsonl(path.join(ctl, 'r151d-exit.jsonl'));

// ---------------- 会话跑一个回合(可指定模型:发送档案里记着模型,内容有变化的回合才会重写档案) ----------------
export async function turnWith(c, s, { mode = 'bypassPermissions', model, note = '' } = {}) {
  const r = await c.post('/api/chat', { sessionId: s.sid, cwd: s.cwd, prompt: `R151D ${crypto.randomBytes(3).toString('hex')} 回合 ${note}`.trim(), permissionMode: mode, ...(model ? { model } : {}) });
  expect(r.status, `前置:${s.sid} 跑一个回合(${r.text.slice(0, 200)})`).toBe(200);
  await readStream(r.body.pid, { timeoutMs: 25_000, base: c.base });
}

// ---------------- 真 CLI 发送方(ws/real-*)发一条跨会话消息 ----------------
/**
 * sender = { cwd, sid? };发完把 sid 记回 sender。返回工具结果里的第一项(results[0])。
 * 非「放任」档的发送方调 send_message 会挂权限卡:这里替用户点"允许"(只认这个发送方工作目录下的 send_message 请求)。
 */
export async function sendFrom(c, sender, toSid, message, mode = 'bypassPermissions') {
  const p = aiCalls(c, { cwd: sender.cwd, sid: sender.sid, mode, steps: [{ name: SM, input: { to: [toSid], message } }] });
  let stop = false;
  const approver = (async () => {
    if (mode === 'bypassPermissions') return;
    const seen = new Set();
    while (!stop) {
      const b = (await c.get('/api/permissions/pending').catch(() => ({ body: null }))).body;
      for (const it of (b && Array.isArray(b.items) ? b.items : [])) {
        if (it && it.toolName === SM && it.cwd === sender.cwd && !seen.has(it.id)) { seen.add(it.id); await allowPerm(c, it); }
      }
      await sleep(150);
    }
  })();
  let r;
  try { r = await p; } finally { stop = true; await approver; }
  if (!sender.sid) sender.sid = r.sid;
  const j = resultJson(r, 0, 1);
  return j && Array.isArray(j.results) ? j.results[0] : j;
}
/** 收件列表里新出现的、来自 AI 会话的消息(不在 knownIds 里)。 */
export async function waitNewMsg(c, sid, knownIds, ms = 30_000) {
  return waitFor(async () => (await msgs(c, sid)).find((x) => fromSession(x) && !knownIds.has(x.id)) || null, ms);
}
export async function msgById(c, sid, id) { return (await msgs(c, sid)).find((x) => x.id === id) || null; }
/** 等某条消息进入终态之一(pending/done/dismissed),返回最后一次看到的样子。 */
export async function waitSettled(c, sid, id, ms = 40_000) {
  let last = null;
  await waitFor(async () => { last = await msgById(c, sid, id); return last && ['pending', 'done', 'dismissed'].includes(last.status) ? last : null; }, ms);
  return last;
}
