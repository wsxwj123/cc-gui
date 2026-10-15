// r151c 二期辅助(只走 HTTP / WS / 文件 / 外部进程记录,不 import 产品代码)。一期 helpers/ 原样复用,这里只放二期新增的能力:
//   真 CLI 回合里按脚本调用工具并取回"模型看到的工具结果"、假 CLI 会话建档、接收设置、带时间戳的 WS 收集、
//   可平移服务端墙上时间的一次性实例、二期定稿文案常量、界面上"更多"菜单与接收设置的操作。
import { expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKTREE, dataRoot, fakebinDir, buildHome, mockDir, uniq } from '../../r151b-xsession-p1/helpers/fixtures.mjs';
import { client, readStream, waitFor, ID_RE, API } from '../../r151b-xsession-p1/helpers/api.mjs';
import { freePort } from '../../r151b-xsession-p1/helpers/instance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------- 定稿文案(全角标点) ----------------
export const SM = 'mcp__ccgui-sessions__send_message';
export const LS = 'mcp__ccgui-sessions__list_sessions';
export const NOTE = {
  card: '对方设置为待处理，需其用户确认后才会处理',
  queued: '对方正在运行，回合结束后自动处理',
  auto: '对方将立即开始处理',
  merged: '与前面的目标是同一个会话，已合并',
};
export const SEND_NOTICE = '发送后不会同步收到回复。对方若回复，会作为一条新的跨会话消息到达本会话。对方处理消息会消耗额度。';
export const HELD = {
  'target-card': '等待你确认后处理',
  'chain-limit': '已到连锁上限（4 次）',
  paused: '自动处理已暂停',
  'no-profile': '没有可用的发送设置，需在该会话里手动处理',
  'profile-stale': '该会话上次发送后切换过 provider，需在该会话里手动处理一次',
  'class-mismatch': '发送方与目标会话的权限类别不同（一方是「放任」档、另一方不是），不自动处理',
  'target-stuck': '目标会话的上一条消息还没处理完',
  interrupted: '上次处理被中断',
};
export const QUEUED_REASON = '目标会话正在运行，回合结束后自动处理';
export const BANNER_TEXT = '跨会话自动处理已暂停（10 分钟内已自动处理 20 次）。';
export const INBOUND_CONFIRM = '开启后，这个会话收到其它会话的消息会自行开始回合并消耗额度。发送方与这个会话的权限类别相同（都是「放任」档，或都不是）时才自动处理，不同时仍显示为卡片。两个会话都处于「放任」档时，对方的消息会在这里直接执行，不经任何确认。';
export const REFUSAL_P2 = '这个会话由 CC-GUI 管理。给 CC-GUI 里的其它会话发消息请用 mcp__ccgui-sessions__send_message（可先用 mcp__ccgui-sessions__list_sessions 查看）；它也能发给当前没在运行的会话。';
export const ALL = 'pending,queued,claimed,processing,done,dismissed';

// ---------------- 假模型接口(二期 mock-p2.mjs)的车道 ----------------
const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
export const laneReq = (lane) => jsonl(path.join(mockDir(), 'lanes', lane, 'requests.jsonl'));
const ctlPath = (lane) => path.join(mockDir(), 'lanes', lane, 'ctl.json');
export function addScript(lane, mark, steps, watch = []) {
  let ctl = {};
  try { ctl = JSON.parse(fs.readFileSync(ctlPath(lane), 'utf8')); } catch { ctl = {}; }
  ctl.scripts = { ...(ctl.scripts || {}), [mark]: steps };
  ctl.watch = [...new Set([...(ctl.watch || []), ...watch])];
  fs.mkdirSync(path.dirname(ctlPath(lane)), { recursive: true });
  fs.writeFileSync(ctlPath(lane), JSON.stringify(ctl));
}
export const touchMock = (name) => fs.writeFileSync(path.join(mockDir(), name), String(Date.now()));
/** 工具结果文字 → JSON(先整段解析;不行就取第一个 { 到最后一个 });解析不了为 null。 */
export function toJson(text) {
  const t = String(text || '');
  try { return JSON.parse(t); } catch { /* 往下 */ }
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* */ } }
  return null;
}

/**
 * 真 CLI 会话跑一回合,模型按 steps 依次调用工具。steps = [{ name, input, waitFile? }]。
 * 返回 { sid, pid, evs, results:[{ text, is_error, json }] }(results = 这一回合里模型新看到的本车道工具结果,按发生先后)。
 */
export async function aiCalls(c, { lane = 'real', cwd, sid, mode = 'bypassPermissions', steps, watch = [], timeoutMs = 150_000 }) {
  const mark = uniq('R151CK');
  addScript(lane, mark, steps, watch);
  const seen = new Set(laneReq(lane).flatMap((r) => r.toolResults.map((t) => t.id)));
  const res = await c.post('/api/chat', { cwd, ...(sid ? { sessionId: sid } : {}), permissionMode: mode, prompt: `${mark} 请按约定调用工具` });
  expect(res.status, `前置:真 CLI 回合应 200(${res.text.slice(0, 200)})`).toBe(200);
  const evs = await readStream(res.body.pid, { timeoutMs, base: c.base });
  const results = [];
  for (const r of laneReq(lane)) for (const t of r.toolResults) if (!seen.has(t.id)) { seen.add(t.id); results.push({ ...t, json: toJson(t.text) }); }
  const got = res.body.sessionId || (evs.find((e) => e && typeof e.session_id === 'string' && ID_RE.test(e.session_id)) || {}).session_id;
  return { sid: got, pid: res.body.pid, evs, results };
}
/** 断言工具结果条数(前置),返回第 i 条的 JSON。 */
export function resultJson(r, i, n = r.results.length) {
  expect(r.results.length, `模型应拿到 ${n} 个工具结果(实际:${JSON.stringify(r.results.map((x) => x.text.slice(0, 160)))})`).toBe(n);
  return r.results[i].json;
}
/** 把一批目标拆成"每次 ≤8 个、每回合 ≤2 次"发出去(每回合 ≤16 条)。返回每次调用的结果 JSON。 */
export async function blast(c, sender, targetSids, message) {
  const calls = [];
  for (let i = 0; i < targetSids.length; i += 8) calls.push(targetSids.slice(i, i + 8));
  const out = [];
  for (let i = 0; i < calls.length; i += 2) {
    const steps = calls.slice(i, i + 2).map((to) => ({ name: SM, input: { to, message } }));
    const r = await aiCalls(c, { cwd: sender.cwd, sid: sender.sid, steps });
    out.push(...r.results.map((x) => x.json));
    if (!sender.sid) sender.sid = r.sid;
  }
  return out;
}

// ---------------- /api/xsession/* 二期 ----------------
export const setInbound = (c, sid, mode) => c.put(`/api/xsession/sessions/${sid}/inbound`, { mode });
export async function inboundOk(c, sid, mode) {
  const r = await setInbound(c, sid, mode);
  expect(r.status, `前置:把 ${sid} 的接收设置改成 ${mode}(${r.text.slice(0, 200)})`).toBe(200);
}
export async function entry(c, sid) {
  const r = await c.get(`/api/xsession/sessions?ids=${sid}`);
  return (r.body && Array.isArray(r.body.sessions) && r.body.sessions.find((s) => s.sessionId === sid)) || null;
}
export async function msgs(c, sid, status = ALL) {
  const r = await c.get(`/api/xsession/messages?sessionId=${sid}&status=${encodeURIComponent(status)}`);
  return (r.body && Array.isArray(r.body.messages)) ? r.body.messages : [];
}
export async function waitMsg(c, sid, pred, ms = 20_000) {
  let last = [];
  const hit = await waitFor(async () => { last = await msgs(c, sid); return last.find(pred) || null; }, ms);
  return hit || null;
}
/** 假 CLI 会话(普通工作目录)在开关开着时跑一个回合 = 建档;mode 是这一回合的档位。 */
export async function profileTurn(c, s, mode = 'bypassPermissions', extra = '') {
  const r = await c.post('/api/chat', { sessionId: s.sid, cwd: s.cwd, prompt: `${uniq('R151CP')} 建档 ${extra}`.trim(), permissionMode: mode });
  expect(r.status, `前置:${s.sid} 跑一个回合(${r.text.slice(0, 200)})`).toBe(200);
  await readStream(r.body.pid, { timeoutMs: 25_000, base: c.base });
  return r.body.pid;
}

// ---------------- WS(带收到时刻) ----------------
export async function wsT(base = API) {
  const msgs2 = [];
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS 连接超时')), 10_000);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = (e) => { clearTimeout(t); reject(new Error(`WS 连接失败:${e.message || e.type}`)); };
  });
  ws.onmessage = (e) => { try { msgs2.push({ ...JSON.parse(String(e.data)), __at: Date.now() }); } catch { /* */ } };
  await new Promise((r) => setTimeout(r, 300));
  return {
    msgs: msgs2,
    ofType: (type) => msgs2.filter((m) => m && m.type === type),
    waitFor: (pred, ms = 8_000) => waitFor(() => msgs2.find(pred), ms, 50),
    close: () => { try { ws.close(); } catch { /* */ } },
  };
}

// ---------------- 一次性实例(可平移服务端时间) ----------------
/** 同一期 startInstance,另可:clock:true → 服务进程以 node --require clock-shim.cjs 起,inst.setClock(ms) 平移墙上时间。 */
export async function startInstanceP2(tag, { prefs = {}, clock = false } = {}) {
  const root = path.join(dataRoot(), 'inst', `${tag}-${Date.now().toString(36)}`);
  const home = path.join(root, 'home'); const ctl = path.join(home, 'fake-claude'); const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  buildHome(home, ctl, prefs);
  const clockFile = path.join(root, 'clock-offset');
  const inst = { root, home, ctl, tmp, setClock: (ms) => fs.writeFileSync(clockFile, String(ms)) };
  const launch = async () => {
    const port = await freePort();
    const log = fs.openSync(path.join(root, `server-${port}.log`), 'a');
    const env = {
      PATH: `${fakebinDir()}:${process.env.PATH}`, HOME: home, USERPROFILE: home, USER: os.userInfo().username, LOGNAME: os.userInfo().username,
      SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TMPDIR: tmp, PORT: String(port), CGUI_FAKE_CLAUDE_DIR: ctl, CGUI_DISABLE_FILE_WATCHER: '1',
      ...(clock ? { R151C_CLOCK_FILE: clockFile } : {}),
    };
    const args = [...(clock ? ['--require', path.join(here, 'clock-shim.cjs')] : []), path.join(WORKTREE, 'server', 'index.js')];
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', log, log] });
    const exited = new Promise((r) => child.once('exit', r));
    const base = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    for (;;) {
      if (child.exitCode !== null) throw new Error(`一次性实例已退出,看 ${root}/server-${port}.log`);
      try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) }); if (r.ok) break; } catch { /* 还没起来 */ }
      if (Date.now() - t0 > 40_000) { child.kill('SIGKILL'); throw new Error(`一次性实例 40 秒没起来,看 ${root}/server-${port}.log`); }
      await new Promise((r) => setTimeout(r, 300));
    }
    Object.assign(inst, { port, base, pid: child.pid, child, exited, c: client(base) });
  };
  inst.stop = async () => {
    if (!inst.child || inst.child.exitCode !== null) return;
    try { process.kill(inst.pid, 'SIGTERM'); } catch { return; }
    const done = await Promise.race([inst.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 8_000))]);
    if (!done) { try { process.kill(inst.pid, 'SIGKILL'); } catch { /* 已退 */ } await inst.exited; }
  };
  inst.restart = async () => { await inst.stop(); await launch(); return inst; };
  await launch();
  return inst;
}

// ---------------- 界面 ----------------
/** 打开当前会话头部的"更多"菜单,直到 xs-inbound-select 出现(或超时)。 */
export async function openMoreMenu(page) {
  const cands = [
    page.locator('[data-testid="session-more"], [data-testid="chat-header-more"]'),
    page.locator('button[title="更多"], button[aria-label="更多"], button[title^="更多"], button[aria-label^="更多"]'),
    page.getByRole('button', { name: /更多/ }),
  ];
  for (const cand of cands) {
    const n = await cand.count();
    for (let i = n - 1; i >= 0; i -= 1) {
      const b = cand.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      await b.click().catch(() => {});
      if (await page.getByTestId('xs-inbound-select').first().isVisible({ timeout: 1_500 }).catch(() => false)) return true;
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
  return false;
}
/** 在 xs-inbound-select 里选 label("等你确认" / "自动处理"):是 <select> 就按选项文字选,否则点里面这段文字。 */
export async function chooseInbound(page, label) {
  const el = page.getByTestId('xs-inbound-select').first();
  const tag = await el.evaluate((e) => e.tagName);
  if (tag === 'SELECT') await el.selectOption({ label });
  else await el.getByText(label, { exact: true }).first().click();
}
export async function inboundValue(page) {
  const el = page.getByTestId('xs-inbound-select').first();
  return el.evaluate((e) => (e.tagName === 'SELECT' ? (e.options[e.selectedIndex] || {}).text : (e.querySelector('[aria-checked="true"],[aria-selected="true"],[data-selected="true"]') || {}).textContent || e.getAttribute('data-value') || ''));
}
