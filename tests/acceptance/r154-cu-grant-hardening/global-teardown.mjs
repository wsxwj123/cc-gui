// 收尾:①对比真实状态哈希(变了只告警 —— ~/.claude.json 可能被正在运行的真实 app 自己改);
//       ②按记录的 pid 收掉本套件漏掉的服务/vite 进程(命令行里必须带本套件目录,绝不误杀别人)。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SNAP, realFiles, hashFile } from './global-setup.mjs';

const suite = path.dirname(fileURLToPath(import.meta.url));

export default async function globalTeardown() {
  try {
    const before = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
    for (const f of realFiles()) {
      const now = hashFile(f);
      console.log(now === before[f] ? `[r154] 真实状态未变:${f}` : `[r154][警告] 真实文件哈希变了(本套件不写它,多半是运行中的真实 app 所为):${f}`);
    }
  } catch { /* 没有快照就不比 */ }
  const pidFile = path.join(suite, '.artifacts', 'pids.txt');
  let pids = [];
  try { pids = fs.readFileSync(pidFile, 'utf8').split('\n').map(Number).filter(Boolean); } catch { /* 没有记录 */ }
  for (const pid of pids) {
    const cmd = String(spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout || '');
    if (cmd.includes('r154-cu-grant-hardening')) { try { process.kill(pid, 'SIGKILL'); console.log(`[r154] 收掉遗留进程 pid=${pid}`); } catch { /* 已退 */ } }
  }
  try { fs.writeFileSync(pidFile, ''); } catch { /* 没有记录文件 */ } // 只清空,不删除
}
