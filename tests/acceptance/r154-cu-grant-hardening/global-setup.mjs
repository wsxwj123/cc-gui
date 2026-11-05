// 起跑前:只读地给"真实状态"拍个哈希(grants.json 与 ~/.claude.json),收尾对比 —— 本套件不会写它们,这是自检。
// 只算 sha256,不输出内容;文件不存在记 null。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suite = path.dirname(fileURLToPath(import.meta.url));
export const SNAP = path.join(suite, '.artifacts', 'real-state-before.json');
export function realFiles() {
  const home = os.userInfo().homedir;
  return [path.join(home, '.claude-gui', 'cu-runtime', 'grants.json'), path.join(home, '.claude.json')];
}
export function hashFile(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

export default async function globalSetup() {
  fs.mkdirSync(path.dirname(SNAP), { recursive: true });
  const snap = Object.fromEntries(realFiles().map((f) => [f, hashFile(f)]));
  fs.writeFileSync(SNAP, JSON.stringify(snap, null, 2));
  console.log('[r154] 已记录真实 grants.json / ~/.claude.json 的哈希(只读,收尾对比)');
}
