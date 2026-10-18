#!/usr/bin/env node
// r151f:假 claude 的外壳(只属于本套件,不改一期 / 二期 / r151d / r151e 夹具)。原样跑一期的假 claude(r151b-xsession-p1/helpers/fake-claude.mjs),
// 在它前面多做几件事。每件事都由测试往 <CTL>/r151f/<类别>/<键> 写一个 JSON 文件来开启;没有这些文件时,行为与假 claude 完全相同。
//  1) mute/<会话id> = {pid}
//     这个进程收到的切档请求(control_request.subtype = set_permission_mode)被吞掉:不交给假 claude,也就没有 control_response。
//  2) delay/<会话id> = {pid, ms}
//     这个进程收到的**第一条**切档请求压住 ms 毫秒再交给假 claude;之后的照常。压住期间到的后续请求不排队、直接交给假 claude
//     (模拟"第一次处理得慢"。宿主若按发起顺序一个个发,后一条要等前一条回应才会到这里)。
//  3) reject/<会话id> = {pid, modes?, error?}
//     这个进程收到切档请求(modes 给了就只针对这些档位)时回一条 subtype:"error" 的 control_response(命令行明确拒绝),不交给假 claude。
//  4) hold/<pid>(release/<pid> 出现即放行)
//     这个进程被"客客气气要求退出"(宿主关 stdin → 假 claude 调 process.exit)后先不退,直到 release/<pid> 出现(最多 90 秒)。
//     模拟"旧进程被它起的后台命令吊着"。收到信号(SIGTERM / SIGKILL …)照常立即退出 —— 被后台命令吊着的真进程拦不住信号。
//     另:不管有没有 hold,"客气退出"(关 stdin)时如果手上还有没结束的回合(收到的用户消息数 > 已吐出的 result 数),先等这个回合结束再退
//     (真命令行就是这样:stdin 关闭后先跑完手上的回合;一期假 claude 是立即退出,这里补上)。信号不受影响。
//  5) exec/<会话id> = {pid, runAt, cmd}
//     到 runAt(毫秒时间戳),这个进程如果还活着、且它自己认为的档位是 "auto",就执行 cmd(sh -c)。
//     模拟"自动档下,审核判为可以执行的命令由命令行直接执行(不再问宿主)"。进程认为的档位以启动参数 --permission-mode 为起点,
//     每交给假 claude 一条切档请求就更新(被吞 / 被拒的不算)。
//  6) 宿主答复 can_use_tool 为 allow 时,被问的工具若是 Write,这里把文件真的写出来(模拟命令行拿到许可后动手);假 claude 自己不写文件。
//  7) bgtask/<会话id> = {pid?, toolUseId?, taskId?, description?}
//     这个进程(pid 不给 = 谁先遇到谁发)在下一次吐出 result 之前,先吐一条后台任务开始的系统消息
//     {type:"system", subtype:"task_started", task_id, tool_use_id, description, task_type:"local_bash", is_backgrounded:true, uuid, session_id}
//     (格式见 SDK 公开类型 SDKTaskStartedMessage),之后不吐结束 —— 宿主据此认为这个进程还被后台命令吊着。一次性:发过就删掉控制文件。
// 记录(都在 <CTL> 下,一行一条 JSON,带 at / t / pid / sid):
//   r151f-switch.jsonl(每条切档请求怎么处理的:muted / rejected / delayed / delayed-passed / passed)、
//   r151f-tools.jsonl(写出的文件)、r151f-exec.jsonl(定时命令:executed / skipped / failed)、r151f-exit.jsonl(客气退出:exit-requested / exit)、r151f-bgtask.jsonl(报过的后台任务开始)。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(here, '..', '..', 'r151b-xsession-p1', 'helpers', 'fake-claude.mjs');
const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const FX = path.join(CTL, 'r151f');
const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(n);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const p = argv.find((a) => a.startsWith(`${n}=`));
  return p ? p.slice(n.length + 1) : undefined;
};
const sid = argOf('--session-id') || argOf('--resume') || null;
const interactive = argv.includes('--input-format');

if (interactive && sid) {
  const cfg = (kind, key) => { try { return JSON.parse(fs.readFileSync(path.join(FX, kind, String(key)), 'utf8')); } catch { return null; } };
  const log = (file, o) => {
    try {
      fs.mkdirSync(CTL, { recursive: true });
      fs.appendFileSync(path.join(CTL, file), `${JSON.stringify({ at: new Date().toISOString(), t: Date.now(), pid: process.pid, sid, ...o })}\n`);
    } catch { /* 忽略 */ }
  };
  let curMode = argOf('--permission-mode') || 'default';
  let delayedOnce = false;
  let execScheduled = false;
  const realIn = process.stdin;
  const filtered = new PassThrough();
  const toHost = process.stdout.write.bind(process.stdout);
  const asked = new Map();
  let inflight = 0;   // 收到的用户消息数 - 已吐出的 result 数
  const emitBgTask = () => {
    const c = cfg('bgtask', sid);
    if (!c || (c.pid !== undefined && c.pid !== null && c.pid !== process.pid)) return;
    try { fs.unlinkSync(path.join(FX, 'bgtask', String(sid))); } catch { return; }   // 一次性:谁先删掉控制文件谁发
    const msg = {
      type: 'system', subtype: 'task_started',
      task_id: c.taskId || `r151fbg${crypto.randomBytes(4).toString('hex')}`,
      tool_use_id: c.toolUseId || `toolu_r151fbg${crypto.randomBytes(4).toString('hex')}`,
      description: c.description || 'sleep 120', task_type: 'local_bash', is_backgrounded: true, uuid: crypto.randomUUID(), session_id: sid,
    };
    toHost(`${JSON.stringify(msg)}\n`);
    log('r151f-bgtask.jsonl', { action: 'task_started', task_id: msg.task_id, tool_use_id: msg.tool_use_id });
  };

  // 出站:记下假 claude 向宿主问过的 can_use_tool(request_id → request),宿主答 allow 时要用
  process.stdout.write = (chunk, ...rest) => {
    try {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue;
        let o = null;
        try { o = JSON.parse(line); } catch { o = null; }
        if (o && o.type === 'control_request' && o.request && o.request.subtype === 'can_use_tool') asked.set(o.request_id, o.request);
        if (o && o.type === 'result') { inflight = Math.max(0, inflight - 1); emitBgTask(); }
      }
    } catch { /* 忽略 */ }
    return toHost(chunk, ...rest);
  };

  const passDown = (line) => { if (!filtered.writableEnded) filtered.write(`${line}\n`); };

  function onHostAnswer(msg) {
    const rid = msg.response && msg.response.request_id;
    const req = rid && asked.get(rid);
    if (!req) return;
    asked.delete(rid);
    if (!JSON.stringify(msg).includes('"behavior":"allow"') || req.tool_name !== 'Write') return;
    const upd = (msg.response && msg.response.response && msg.response.response.updatedInput) || {};
    const input = req.input || {};
    const file = upd.file_path || input.file_path;
    const content = upd.content !== undefined ? upd.content : (input.content !== undefined ? input.content : '');
    if (typeof file !== 'string' || !file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(content));
      log('r151f-tools.jsonl', { tool: 'Write', file, action: 'written' });
    } catch (e) { log('r151f-tools.jsonl', { tool: 'Write', file, action: 'failed', error: String(e && e.message) }); }
  }

  const rl = readline.createInterface({ input: realIn, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let msg = null;
    try { msg = JSON.parse(line); } catch { msg = null; }
    if (msg && msg.type === 'control_response') onHostAnswer(msg);
    if (msg && msg.type === 'user') inflight += 1;
    if (msg && msg.type === 'control_request' && msg.request && msg.request.subtype === 'set_permission_mode') {
      const mode = msg.request.mode;
      const mute = cfg('mute', sid);
      const reject = cfg('reject', sid);
      const delay = cfg('delay', sid);
      if (mute && mute.pid === process.pid) { log('r151f-switch.jsonl', { mode, action: 'muted' }); return; }
      if (reject && reject.pid === process.pid && (!Array.isArray(reject.modes) || reject.modes.includes(mode))) {
        log('r151f-switch.jsonl', { mode, action: 'rejected' });
        toHost(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: reject.error || 'R151F fx-claude: 命令行拒绝切档' } })}\n`);
        return;
      }
      if (delay && delay.pid === process.pid && !delayedOnce) {
        delayedOnce = true;
        log('r151f-switch.jsonl', { mode, action: 'delayed', ms: delay.ms });
        setTimeout(() => { log('r151f-switch.jsonl', { mode, action: 'delayed-passed' }); curMode = mode; passDown(line); }, Number(delay.ms) || 0);
        return;
      }
      log('r151f-switch.jsonl', { mode, action: 'passed' });
      curMode = mode;
    }
    passDown(line);
  });
  rl.on('close', () => filtered.end());
  Object.defineProperty(process, 'stdin', { configurable: true, enumerable: true, get: () => filtered });

  // 定时命令:到点且自己认为是 auto 档才执行
  const poll = setInterval(() => {
    if (execScheduled) return;
    const c = cfg('exec', sid);
    if (!c || c.pid !== process.pid) return;
    execScheduled = true;
    setTimeout(() => {
      if (curMode !== 'auto') { log('r151f-exec.jsonl', { action: 'skipped', mode: curMode, cmd: c.cmd }); return; }
      try {
        execFileSync('/bin/sh', ['-c', c.cmd], { stdio: 'ignore', timeout: 10_000 });
        log('r151f-exec.jsonl', { action: 'executed', mode: curMode, cmd: c.cmd });
      } catch (e) { log('r151f-exec.jsonl', { action: 'failed', mode: curMode, cmd: c.cmd, error: String(e && e.message) }); }
    }, Math.max(0, Number(c.runAt) - Date.now()));
  }, 150);
  poll.unref();

  // 客气退出推迟;hold/<pid> = { signals?: true, bgChild?: true }:signals → 同时无视终止类信号(SIGKILL 拦不住);bgChild → 真的起一个后台子进程(sleep 120)
  const realExit = process.exit.bind(process);
  const holdCfg = () => (fs.existsSync(path.join(FX, 'release', String(process.pid))) ? null : cfg('hold', process.pid));
  const held = () => Boolean(holdCfg());
  let leaving = false;
  process.exit = (code) => {
    const c = code === undefined ? 0 : code;
    const mustWait = () => held() || inflight > 0;
    if (!mustWait()) { log('r151f-exit.jsonl', { ev: 'exit', held: false }); realExit(c); return; }
    if (leaving) return;
    leaving = true;
    log('r151f-exit.jsonl', { ev: 'exit-requested', held: held(), inflight });
    const t0 = Date.now();
    const tick = () => {
      if (!mustWait() || Date.now() - t0 > 90_000) { log('r151f-exit.jsonl', { ev: 'exit', held: held(), waitedMs: Date.now() - t0 }); realExit(c); return; }
      setTimeout(tick, 50);
    };
    setTimeout(tick, 50);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      const h = holdCfg();
      if (h && h.signals) { log('r151f-exit.jsonl', { ev: 'signal-ignored', sig }); return; }
      log('r151f-exit.jsonl', { ev: 'signal', sig });
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  }
  let bgStarted = false;
  const bgPoll = setInterval(() => {
    if (bgStarted) return;
    const h = holdCfg();
    if (!h || !h.bgChild) return;
    bgStarted = true;
    const child = spawn('sleep', ['120'], { stdio: 'ignore' });
    log('r151f-bg.jsonl', { child: child.pid });
  }, 200);
  bgPoll.unref();
}

await import(pathToFileURL(FAKE).href);
