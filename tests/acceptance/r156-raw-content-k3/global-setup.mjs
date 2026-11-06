// 起跑前:对真实授权文件 ~/.claude-gui/cu-runtime/grants.json 只记 stat(mtime + size),不读内容。
// 收尾时 global-teardown 对比,变了就让整个套件失败(说明有被测进程绕过了假家目录)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suite = path.dirname(fileURLToPath(import.meta.url));
export const SNAP = path.join(suite, '.artifacts', 'real-grants-stat-before.json');

/** 真实家目录用 userInfo(不受 HOME 环境变量影响)。 */
export function realGrantsFile() {
  return path.join(os.userInfo().homedir, '.claude-gui', 'cu-runtime', 'grants.json');
}
/** 只取 mtime(毫秒)与 size;文件不存在记 null。绝不读内容。 */
export function statGrants(file = realGrantsFile()) {
  try {
    const s = fs.statSync(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

export default async function globalSetup() {
  fs.mkdirSync(path.dirname(SNAP), { recursive: true });
  fs.writeFileSync(SNAP, JSON.stringify({ file: realGrantsFile(), stat: statGrants() }, null, 2));
  console.log('[r156] 已记录真实 grants.json 的 stat(只读 mtime+size,收尾对比)');
}
