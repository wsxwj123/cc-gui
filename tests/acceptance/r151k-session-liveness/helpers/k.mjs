// r151k 本套件辅助(只走 HTTP / SSE / 文件 / 外部进程记录,不 import 产品代码)。
// 复用 r151b 的临时 HOME / 假 CLI 记录与 r151c 的 startInstanceP2(已复制到本套件 helpers/p2.mjs);
// 这里只放本轮要用的最小工具:
//   落一个会话、读进程列表 / 回合记录、实时收集某个 chat 的 SSE 事件(可在中途按条件等)、
//   读 / 答复权限卡(GET /api/permissions/pending + POST /api/permissions/respond/:id)。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { uniq, seedSession } from '../../r151b-xsession-p1/helpers/fixtures.mjs';
import { turnRecords, waitFor, touchCtl, writeScript } from '../../r151b-xsession-p1/helpers/api.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

/** 一次性实例里的假 CLI 会话 T(已落盘的旧记录,工作目录在本用例自己的工作区)。 */
export const newT = (inst, tag) => seedSession(`${tag}-t-${uniq('')}`, { home: inst.home });

/** 进程列表(GET /api/processes 的 claudeProcesses)里命令行带 sid 的进程的 pid(数字)。 */
export async function procPids(c, sid) {
  const r = await c.get('/api/processes');
  expect(r.status, `GET /api/processes 应 200(${String(r.text).slice(0, 200)})`).toBe(200);
  const list = r.body && Array.isArray(r.body.claudeProcesses) ? r.body.claudeProcesses : [];
  return list.filter((p) => String((p && p.command) || '').includes(sid)).map((p) => Number(p && p.pid));
}

/** 假 claude 记下的、会话 sid 的每个回合 { at, pid, sid, mode, text }(按发生先后)。 */
export const turnsOf = (ctl, sid) => turnRecords(ctl).filter((t) => t && t.sid === sid);
export const lastTurnPid = (ctl, sid) => { const t = turnsOf(ctl, sid); return t.length ? t[t.length - 1].pid : null; };

/** 等假 claude 记下"跑了带 marker 的回合",返回那条记录。 */
export const waitTurn = (inst, sid, marker, ms = 20_000) =>
  waitFor(() => turnsOf(inst.ctl, sid).find((x) => String(x.text).includes(marker)) || null, ms, 80);

/** 放行脚本里的 waitFile(<CTL>/<名字> 出现即继续)。用例的 finally 里调用,让假 CLI 能收尾退出。 */
export const releaseWait = (ctl, name) => touchCtl(name, ctl);

// ---------------- SSE:实时收集一个 chat 的事件 ----------------
/**
 * 连 GET /api/chat/:pid/stream,边收边放进 events(用例可在中途 waitFor,不必等流结束)。
 * 返回 { events, ready, done, waitFor(pred, ms), stop() }。stop() 只中止本连接,不杀进程。
 * 服务端会把"连接前已收到的行"从 earlyLines 回放出来,所以晚连也不会漏掉 done / stall_notice。
 */
export function streamT(base, pid) {
  const events = [];
  const ctrl = new AbortController();
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const done = (async () => {
    try {
      const r = await fetch(`${base}/api/chat/${encodeURIComponent(pid)}/stream`, { signal: ctrl.signal });
      resolveReady(true);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: fin } = await reader.read();
        if (fin) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          try { events.push(JSON.parse(data)); } catch { /* 非 JSON */ }
        }
      }
    } catch { /* 中止 / 断流:保留已收到的 */ } finally { resolveReady(false); }
  })();
  return {
    events,
    ready,
    done,
    waitFor: (pred, ms = 10_000) => waitFor(() => events.find(pred), ms, 50),
    stop: () => { try { ctrl.abort(); } catch { /* */ } },
  };
}

/**
 * 起一个回合并等它真的开始跑:POST /api/chat(带 R151S:<脚本名> 时假 CLI 按 steps 演),
 * 连 SSE、等假 CLI 的回合记录、确认进程列表里有它。返回 { inst, T, pid, cliPid, stream, turn }。
 * 这三条前置任一不成立就直接失败(断言失败在用例的"前置"上,不会被后面的结果断言掩盖)。
 */
export async function startTurn(inst, T, { mark, scriptName = null, steps = null, prompt = null, permissionMode = 'default' }) {
  if (scriptName) writeScript(scriptName, steps, inst.ctl);
  const r = await inst.c.post('/api/chat', {
    sessionId: T.sid, cwd: T.cwd, permissionMode,
    prompt: prompt || `${mark} R151S:${scriptName}`,
  }, { timeoutMs: 30_000 });
  expect(r.status, `前置:发出这一条消息(${String(r.text).slice(0, 240)})`).toBe(200);
  const pid = r.body && r.body.pid;
  expect(pid, `前置:应答里有 chat 的 pid(${String(r.text).slice(0, 240)})`).toBeTruthy();
  const stream = streamT(inst.base, pid);
  expect(await stream.ready, '前置:SSE 已连上').toBe(true);
  const turn = await waitTurn(inst, T.sid, mark);
  expect(turn, `前置:假 CLI 开始跑这一回合(回合记录:${JSON.stringify(turnsOf(inst.ctl, T.sid))})`).toBeTruthy();
  const cliPid = lastTurnPid(inst.ctl, T.sid);
  expect(cliPid, `前置:回合记录里有假 CLI 的 pid(记录:${JSON.stringify(turnsOf(inst.ctl, T.sid))})`).toBeTruthy();
  const listed = await waitFor(async () => {
    const pids = await procPids(inst.c, T.sid);
    return pids.includes(Number(cliPid)) ? true : null;
  }, 5_000, 100);
  expect(listed, `前置:进程列表里有假 CLI pid ${cliPid}(进程列表:${JSON.stringify(await procPids(inst.c, T.sid))})`).toBe(true);
  return { inst, T, pid, cliPid, stream, turn };
}

// ---------------- 权限卡(GET /api/permissions/pending + POST /respond/:id) ----------------
/** 当前挂着的卡(带 id / nonce / toolName / toolInput / sessionId)。 */
export async function pendingCards(c) {
  const r = await c.get('/api/permissions/pending');
  expect(r.status, `GET /api/permissions/pending 应 200(${String(r.text).slice(0, 200)})`).toBe(200);
  return r.body && Array.isArray(r.body.items) ? r.body.items : [];
}

/** 等这张会话的提问卡挂出来(卡里有 marker 才算,避免拿到别的卡)。返回卡(含 nonce)。 */
export function waitAskCard(c, sid, marker, ms = 20_000) {
  return waitFor(async () => (await pendingCards(c)).find((p) => p && p.toolName === 'AskUserQuestion'
    && p.sessionId === sid && JSON.stringify(p.toolInput || {}).includes(marker)) || null, ms, 100);
}

/** 答复一张卡(allow;updatedInput 给了就带上)。 */
export function answerCard(c, card, { decision = 'allow', updatedInput } = {}) {
  return c.post(`/api/permissions/respond/${encodeURIComponent(card.id)}`, {
    decision, nonce: card.nonce, ...(updatedInput ? { updatedInput } : {}),
  });
}

/** 看门狗发的中性提示事件(stall_notice);文案不会变。返回事件里的 text(没有就给空串)。 */
export const stallNotices = (events) => events.filter((e) => e && e.type === 'stall_notice');
export const stallText = (ev) => String((ev && ev.text) || '');

/** 某个会话的答复记录(假 CLI 的 perm-responses.jsonl,只读本套件实例的 HOME)。 */
export const permResponses = (ctl, sid) => jsonl(path.join(ctl, 'perm-responses.jsonl')).filter((x) => x && x.sid === sid);
