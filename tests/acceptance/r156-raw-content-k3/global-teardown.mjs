// 收尾:①按记录的 pid(+进程启动时间,防 pid 复用)收掉本套件漏掉的后端进程;
//       ②核对 6700-6999 没有本套件遗留的监听;③真实 grants.json 的 stat 前后对比,变了就抛错让套件失败。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SNAP, statGrants, realGrantsFile } from './global-setup.mjs';

const suite = path.dirname(fileURLToPath(import.meta.url));

function lstartOf(pid) {
  return String(spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout || '').trim();
}

export default async function globalTeardown() {
  // ① 收遗留进程:pids.txt 每行 "pid<TAB>启动时间",两者都对得上才杀
  const pidFile = path.join(suite, '.artifacts', 'pids.txt');
  let lines = [];
  try { lines = fs.readFileSync(pidFile, 'utf8').split('\n').filter(Boolean); } catch { /* 没有记录 */ }
  const mine = new Set(lines.map((l) => Number(l.split('\t')[0])).filter(Boolean));
  for (const line of lines) {
    const [pidText, started] = line.split('\t');
    const pid = Number(pidText);
    if (!pid) continue;
    const now = lstartOf(pid);
    if (now && now === started) {
      try { process.kill(pid, 'SIGKILL'); console.log(`[r156] 收掉遗留进程 pid=${pid}`); } catch { /* 已退 */ }
    }
  }
  try { fs.writeFileSync(pidFile, ''); } catch { /* 没有记录文件 */ }

  // ② 监听核对:只对"本套件记录过的 pid"判残留(别的会话的监听只作提示,绝不杀)
  await new Promise((r) => setTimeout(r, 300));
  const out = String(spawnSync('lsof', ['-nP', '-iTCP:6700-6999', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8' }).stdout || '');
  const listeners = [];
  for (const l of out.split('\n')) {
    if (l.startsWith('p')) listeners.push({ pid: Number(l.slice(1)), names: [] });
    else if (l.startsWith('n') && listeners.length) listeners[listeners.length - 1].names.push(l.slice(1));
  }
  const leftover = listeners.filter((x) => mine.has(x.pid));
  const others = listeners.filter((x) => !mine.has(x.pid));
  console.log(`[r156] 收尾监听核对:本套件残留 ${leftover.length} 个;非本套件(仅提示)${others.map((x) => `pid=${x.pid} ${x.names.join(',')}`).join(' | ') || '无'}`);
  if (leftover.length) throw new Error(`[r156][残留监听] 本套件起的进程仍在监听:${leftover.map((x) => `pid=${x.pid} ${x.names.join(',')}`).join(' | ')}`);

  // ③ 真实授权文件守卫(只比 stat,不读内容)
  let before;
  try { before = JSON.parse(fs.readFileSync(SNAP, 'utf8')); } catch { before = null; }
  if (before) {
    const after = statGrants();
    if (JSON.stringify(after) !== JSON.stringify(before.stat)) {
      throw new Error(`[r156][守卫失败] 真实授权文件 ${realGrantsFile()} 的 stat 变了:前 ${JSON.stringify(before.stat)} → 后 ${JSON.stringify(after)}(说明有被测进程绕过了假家目录)`);
    }
    console.log(`[r156] 守卫通过:真实 grants.json stat 未变 ${JSON.stringify(after)}`);
  }
}
