#!/usr/bin/env node
// r151e:假 claude 的外壳(只属于本套件,不改一期 / 二期 / r151d 夹具)。原样跑一期的假 claude(r151b-xsession-p1/helpers/fake-claude.mjs),
// 只多一件事 —— 让指定进程"收到切档请求后一直不回应":
//   <CTL>/r151e-mute/<会话id> 的内容等于本进程的 pid 时,宿主经 stdin 发来的 control_request(request.subtype 为 "set_permission_mode")
//   被吞掉:不交给假 claude,也就没有 control_response。其它输入(初始化等其它控制请求、用户消息、非 JSON 行)原样交给假 claude。
//   每吞掉一条记进 <CTL>/r151e-muted.jsonl:{ at, t, pid, sid, request }。
// 做法:假 claude 用 readline 读 process.stdin。这里先接管真正的 stdin 逐行过滤,把 process.stdin 换成过滤后的流,再加载假 claude ——
// 同一个进程,pid 不变(进程列表、假 claude 自己的记录里看到的都是这个 pid);真 stdin 关闭照样传给假 claude(它照旧退出)。
// 没有标记(或标记里不是本进程 pid)时,行为与假 claude 完全相同。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(here, '..', '..', 'r151b-xsession-p1', 'helpers', 'fake-claude.mjs');
const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
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
  const realIn = process.stdin;
  const filtered = new PassThrough();
  const muted = () => {
    try { return fs.readFileSync(path.join(CTL, 'r151e-mute', sid), 'utf8').trim() === String(process.pid); } catch { return false; }
  };
  const log = (request) => {
    try {
      fs.mkdirSync(CTL, { recursive: true });
      fs.appendFileSync(path.join(CTL, 'r151e-muted.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), t: Date.now(), pid: process.pid, sid, request })}\n`);
    } catch { /* 忽略 */ }
  };
  const rl = readline.createInterface({ input: realIn, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let msg = null;
    try { msg = JSON.parse(line); } catch { msg = null; }
    if (msg && msg.type === 'control_request' && msg.request && msg.request.subtype === 'set_permission_mode' && muted()) { log(msg.request); return; }
    filtered.write(`${line}\n`);
  });
  rl.on('close', () => filtered.end());
  Object.defineProperty(process, 'stdin', { configurable: true, enumerable: true, get: () => filtered });
}

await import(pathToFileURL(FAKE).href);
