// r151e 本套件辅助(只走 HTTP / WS / 文件 / 外部进程记录,不 import 产品代码)。
// 一期 helpers/、二期 helpers/p2.mjs、r151d helpers/d.mjs 原样复用;这里只放本轮新增:
//   偏好文件"读不出"(权限 000,所在目录保持可写)与恢复、偏好文件字节 / JSON 读取、只让发送档案写不进(复制自 r151d d04)、
//   进程列表里某会话的 pid、假 claude 的回合记录、让某个进程吞掉切档请求(配合 mute-claude.mjs)、限时切档、
//   「放任」发送方发一条跨会话消息并等它落定。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prefsPath, xsDir, encodeProjectDir } from '../../r151b-xsession-p1/helpers/fixtures.mjs';
import { turnRecords, readStream } from '../../r151b-xsession-p1/helpers/api.mjs';
import { wsT, msgs } from '../../r151c-xsession-p2/helpers/p2.mjs';
import { sendFrom, waitNewMsg, waitSettled, msgById } from '../../r151d-xsession-hardening/helpers/d.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// ---------------- 偏好接口 / 偏好文件 ----------------
export const setHidden = (c, hidden) => c.put('/api/prefs/hidden-projects', { hidden });
export const prefsBytes = (home) => fs.readFileSync(prefsPath(home));
/** 偏好文件解析成 JSON;读不了 / 解析不了返回 null(不抛)。 */
export function prefsJson(home) { try { return JSON.parse(fs.readFileSync(prefsPath(home), 'utf8')); } catch { return null; } }

/**
 * 把偏好文件设为"读不出":权限改成 000(所在目录不动,仍可写)。先断言本进程确实读不了它(以 root 运行时 000 拦不住,前提不成立)。
 * 返回 restore():把权限改回原值。可重复调用(只动手一次);文件已不在时不报错。用例必须在 finally 里调用它。
 */
export function makePrefsUnreadable(home) {
  const f = prefsPath(home);
  const mode = fs.statSync(f).mode & 0o777;
  fs.chmodSync(f, 0o000);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { fs.chmodSync(f, mode); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  };
  let code = null;
  try { fs.readFileSync(f); } catch (e) { code = e && e.code; }
  if (code !== 'EACCES') restore();
  expect(code, `前置:偏好文件权限设为 000 后读它应报 EACCES(实际 ${code};以 root 运行时权限拦不住)`).toBe('EACCES');
  return restore;
}

// ---------------- 只让发送档案写不进(复制自 r151d d04-profile-write.spec.mjs 的 blockProfileWrites,逻辑未改) ----------------
/**
 * 在临时 HOME 的跨会话数据目录里,用同名空目录占住 profiles.json 的位置;原来有这个文件就先改名留在同目录(不删)。
 * 返回 { file, aside, hadFile, restore };restore 只用非递归的 rmdirSync 删掉这个空目录(重复调用不再动手)。
 */
export function blockProfileWrites(home) {
  const dir = xsDir(home);
  const file = path.join(dir, 'profiles.json');
  const aside = path.join(dir, `profiles.json.r151e-aside-${Date.now().toString(36)}`);
  const hadFile = fs.existsSync(file);
  if (hadFile) {
    expect(fs.lstatSync(file).isFile(), `前置:${file} 是普通文件`).toBe(true);
    fs.renameSync(file, aside);
  }
  fs.mkdirSync(file);
  let restored = false;
  const restore = () => { if (restored) return; restored = true; fs.rmdirSync(file); };
  return { file, aside: hadFile ? aside : null, hadFile, restore };
}

// ---------------- 进程列表 / 假 claude 的记录 ----------------
/** 进程列表(GET /api/processes 的 claudeProcesses)里命令行带 sid 的进程的 pid(数字)。 */
export async function procPids(c, sid) {
  const r = await c.get('/api/processes');
  expect(r.status, `GET /api/processes 应 200(${r.text.slice(0, 200)})`).toBe(200);
  const list = r.body && Array.isArray(r.body.claudeProcesses) ? r.body.claudeProcesses : [];
  return list.filter((p) => String((p && p.command) || '').includes(sid)).map((p) => Number(p && p.pid));
}
/** 假 claude 记下的、会话 sid 的每个回合 { at, pid, sid, mode, text }(按发生先后)。 */
export const turnsOf = (ctl, sid) => turnRecords(ctl).filter((t) => t && t.sid === sid);
export const lastTurnPid = (ctl, sid) => { const t = turnsOf(ctl, sid); return t.length ? t[t.length - 1].pid : null; };
/** 从现在起,会话 sid 的进程 pid 收到切档请求一律不回应(mute-claude.mjs 的约定:<CTL>/r151e-mute/<sid> 的内容 = pid)。 */
export function muteModeSwitch(ctl, sid, pid) {
  const d = path.join(ctl, 'r151e-mute');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, sid), String(pid));
}
/** mute-claude.mjs 吞掉的切档请求 { at, t, pid, sid, request }。 */
export const mutedLog = (ctl, sid) => jsonl(path.join(ctl, 'r151e-muted.jsonl')).filter((x) => !sid || x.sid === sid);

// ---------------- 切档 / 用户消息 ----------------
/** POST /api/chat/permission-mode,最多等 ms 毫秒;超时不抛,返回 status:'timeout'。返回 { status, body, text, elapsed }。 */
export async function switchMode(c, sid, mode, ms) {
  const t0 = Date.now();
  try {
    const r = await c.post('/api/chat/permission-mode', { sessionId: sid, mode }, { timeoutMs: ms });
    return { ...r, elapsed: Date.now() - t0 };
  } catch (e) {
    return { status: 'timeout', body: null, text: `${ms}ms 内没有应答(${e && e.name})`, elapsed: Date.now() - t0 };
  }
}
/**
 * 给会话 s 发一条用户消息(POST /api/chat),读完这一回合的事件流。消息里带唯一标记 mark(假 claude 的回合记录里能按它找到这一回合)。
 * 不断言;请求超时不抛。返回 { mark, status, text }。
 */
export async function userTurn(c, s, { mode, note = '', postMs = 20_000 } = {}) {
  const mark = `R151E${crypto.randomBytes(4).toString('hex')}`;
  let r;
  try {
    r = await c.post('/api/chat', { sessionId: s.sid, cwd: s.cwd, prompt: `${mark} ${note}`.trim(), ...(mode ? { permissionMode: mode } : {}) }, { timeoutMs: postMs });
  } catch (e) {
    return { mark, status: 'timeout', text: String(e) };
  }
  if (r.status === 200 && r.body && r.body.pid) await readStream(r.body.pid, { timeoutMs: 25_000, base: c.base });
  return { mark, status: r.status, text: r.text };
}

// ---------------- 项目 ----------------
/** 项目列表(GET /api/projects)里工作目录为 cwd 的那一项的 hash(找不到 = 前置失败)。 */
export async function projectHashOf(c, cwd) {
  const r = await c.get('/api/projects');
  const list = Array.isArray(r.body) ? r.body : (r.body && Array.isArray(r.body.projects) ? r.body.projects : []);
  const hit = list.find((p) => p && (p.path === cwd || p.cwd === cwd || p.fullPath === cwd))
    || list.find((p) => p && p.hash === encodeProjectDir(cwd)) || null;
  expect(hit && typeof hit.hash === 'string' ? hit.hash : null,
    `前置:项目列表里能找到 ${cwd}(GET /api/projects ${r.status},前几项:${JSON.stringify(list.slice(0, 3)).slice(0, 300)})`).toBeTruthy();
  return hit.hash;
}

// ---------------- 「放任」发送方发一条跨会话消息并等它落定 ----------------
export const HELD_EITHER = ['class-mismatch', 'no-profile'];
/**
 * 发送方 S(真 CLI 会话,「放任」)给 T 发一条消息:等它进 T 的收件列表、落到终态之一,再等 settleMs 看最后的样子。
 * 返回 { r(工具结果 results[0]), m(收件列表里第一次看到的样子), fin(最后一次看到的样子), turns(事件流里处理它的 xs:turn 事件) }。
 */
export async function sendAndSettle(inst, S, T, text, { settleMs = 3_000 } = {}) {
  const ws = await wsT(inst.base);
  try {
    const known = new Set((await msgs(inst.c, T.sid)).map((x) => x.id));
    const r = await sendFrom(inst.c, S, T.sid, text);
    const m = await waitNewMsg(inst.c, T.sid, known);
    expect(m, `前置:这条消息进了 T 的收件列表(工具结果:${JSON.stringify(r)})`).toBeTruthy();
    await waitSettled(inst.c, T.sid, m.id);
    await sleep(settleMs);
    const fin = await msgById(inst.c, T.sid, m.id);
    return { r, m, fin, turns: ws.ofType('xs:turn').filter((e) => e.messageId === m.id) };
  } finally { ws.close(); }
}
