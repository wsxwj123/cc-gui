#!/usr/bin/env node
// r151d:假 claude 的外壳(只属于本套件,不改一期 / 二期夹具)。原样跑一期的假 claude(r151b-xsession-p1/helpers/fake-claude.mjs),
// 只多一件事 —— 让指定会话的旧进程"推迟退出",好在新进程起来之前切档:
//   <CTL>/r151d-hold/<会话id> 存在,且 <CTL>/r151d-release/<会话id>、$R151D_RELEASE_ALL 都不存在时,
//   这个会话的交互进程被要求退出(stdin 关闭 → 假 claude 调 process.exit / SIGTERM / SIGINT / SIGHUP)后先不退,
//   等到放行文件出现(最多 120 秒)再退;信号仍按原信号退出(不改退出方式)。SIGKILL 拦不住,也不拦。
// 每次被要求退出、真正退出都记进 <CTL>/r151d-exit.jsonl:{ at, t, pid, sid, ev:"exit-requested"|"exit", why, held }。
// 没有推迟时行为与假 claude 完全相同(立即退出,信号照原样)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(here, '..', '..', 'r151b-xsession-p1', 'helpers', 'fake-claude.mjs');
const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const ALL = process.env.R151D_RELEASE_ALL || '';
const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(n);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const p = argv.find((a) => a.startsWith(`${n}=`));
  return p ? p.slice(n.length + 1) : undefined;
};
const sid = argOf('--session-id') || argOf('--resume') || null;
const interactive = argv.includes('--input-format');
const holdFile = sid ? path.join(CTL, 'r151d-hold', sid) : null;
const releaseFile = sid ? path.join(CTL, 'r151d-release', sid) : null;
const held = () => Boolean(interactive && holdFile && fs.existsSync(holdFile) && !fs.existsSync(releaseFile) && !(ALL && fs.existsSync(ALL)));
const log = (o) => {
  if (!interactive || !sid) return;
  try { fs.mkdirSync(CTL, { recursive: true }); fs.appendFileSync(path.join(CTL, 'r151d-exit.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), t: Date.now(), pid: process.pid, sid, ...o })}\n`); } catch { /* 忽略 */ }
};

const realExit = process.exit.bind(process);
const finish = (how) => {
  if (how.signal) { process.removeAllListeners(how.signal); process.kill(process.pid, how.signal); return; }
  realExit(how.code);
};
let leaving = false;
function leave(how, why) {
  if (!held()) { log({ ev: 'exit', why, held: false }); finish(how); return; }
  if (leaving) { log({ ev: 'exit-requested-again', why }); return; }
  leaving = true;
  log({ ev: 'exit-requested', why, held: true });
  const t0 = Date.now();
  const tick = () => {
    if (!held() || Date.now() - t0 > 120_000) { log({ ev: 'exit', why, held: true, waitedMs: Date.now() - t0 }); finish(how); return; }
    setTimeout(tick, 40);
  };
  setTimeout(tick, 40);
}
process.exit = (code) => leave({ code: code === undefined ? 0 : code }, 'process.exit');
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => leave({ signal: s }, s));

await import(pathToFileURL(FAKE).href);
