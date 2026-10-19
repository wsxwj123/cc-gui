// r151h 本套件辅助(只走 HTTP / SSE / WS / 文件 / 外部进程记录,不 import 产品代码)。
// 复用 r151b 的临时 HOME / 假 CLI 记录与 r151c 的 startInstanceP2(已复制到本套件 helpers/p2.mjs,
// 并加上了 envExtra 参数);这里只放本轮要用的最小工具:
//   落一个会话、读进程列表 / 回合记录、实时收集某个 chat 的 SSE 事件(可在中途按条件等)、
//   给 fx-claude.mjs 摆"立刻报后台 shell 任务开始 / 定时报终态"的控制文件。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { uniq, seedSession } from '../../r151b-xsession-p1/helpers/fixtures.mjs';
import { turnRecords, waitFor, touchCtl } from '../../r151b-xsession-p1/helpers/api.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

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

// ---------------- fx-claude.mjs 的 r151h 控制(约定见 fx-claude.mjs 开头) ----------------
/**
 * 这个回合里,第一次吐出带 Task 工具调用的 assistant 消息之后,立刻报一条后台 shell 任务开始。
 * opts = { pid?, taskId?, toolUseId?, description?, notifyAfterMs?, notifyStatus?, notifySummary? }。
 */
export function armBgStart(ctl, sid, opts = {}) {
  const d = path.join(ctl, 'r151h', 'bgstart');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, String(sid)), JSON.stringify(opts));
}
/**
 * r151i level-only 模式:第一次吐出带 Task 工具调用的 assistant 消息之后,只报一条 level 信号
 * system/background_tasks_changed(tasks:[{ task_id, run_id?, task_type:"local_bash", description }]),
 * **不报** task_started。opts = { pid?, taskId?, runId?, description? }。
 */
export function armLevelOnly(ctl, sid, opts = {}) {
  const d = path.join(ctl, 'r151h', 'levelonly');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, String(sid)), JSON.stringify(opts));
}
/** fx-claude 记下的 r151h/r151i 后台任务事件 { action: task_started | task_notification | background_tasks_changed, task_id, ... }。 */
export const bgStartLog = (ctl, sid) => jsonl(path.join(ctl, 'r151h-bgtask.jsonl')).filter((x) => !sid || x.sid === sid);

// ---------------- SSE:实时收集一个 chat 的事件 ----------------
/**
 * 连 GET /api/chat/:pid/stream,边收边放进 events(用例可在中途 waitFor,不必等流结束)。
 * 返回 { events, ready, done, waitFor(pred, ms), stop() }。stop() 只中止本连接,不杀进程。
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

/** 这个 SSE 事件是不是"assistant 消息里带了一次 Task 工具调用"。 */
export const isTaskToolUseEvent = (e) => Boolean(e && e.type === 'assistant' && e.message && Array.isArray(e.message.content)
  && e.message.content.some((b) => b && b.type === 'tool_use' && b.name === 'Task'));

/**
 * 看门狗发的中性提示事件(stall_notice);文案不会变。返回事件里的 text(没有就给空串)。
 * 注意:只按事件类型取,不把"有没有这条"写死在这里 —— 用例自己断言有没有。
 */
export const stallNotices = (events) => events.filter((e) => e && e.type === 'stall_notice');
export const stallText = (ev) => String((ev && ev.text) || '');

/**
 * 后台任务被停的通知:该任务的 task_notification 终态(stopped / killed / failed),
 * 或任何提到"后台任务…停 / 终止"的文本事件。fixed 行为下一条都不该有。
 */
export function bgTaskStopNotices(events, taskId) {
  return events.filter((e) => {
    if (!e) return false;
    const terminal = e.type === 'system' && e.subtype === 'task_notification'
      && (!taskId || e.task_id === taskId || e.tool_use_id === taskId)
      && ['stopped', 'killed', 'failed'].includes(String(e.status));
    const text = typeof e.text === 'string' && /后台任务[^。\n]{0,20}(已停|被停|终止|停止)/.test(e.text);
    return terminal || text;
  });
}
