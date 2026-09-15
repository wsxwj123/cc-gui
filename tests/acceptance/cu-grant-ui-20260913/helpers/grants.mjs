// 授权真源(~/.claude-gui/cu-runtime/grants.json)的备份/还原。
//
// 为什么不能像别的套件那样用夹具 HOME 隔走:cu-common.js 刻意用 os.userInfo().homedir
// (不受 $HOME 影响)算运行时目录,保证 GUI 后端与 CLI 起的 MCP 进程读到【同一份】授权
// (INTERFACE §I1 / PLAN §CG-8)。所以写授权的用例只能:
//   ① 显式带 CU_ALLOW_GRANT_WRITE=1(操作者同意改真实授权状态);
//   ② setup 备份、teardown 还原【原字节】。
// 缺 flag = ENVIRONMENT_BLOCKED,不静默跳过。只读用例(§F.0.4)不需要 flag。
import fs from 'node:fs';
import path from 'node:path';
import { userInfo } from 'node:os';
import { artifacts } from './harness.mjs';

export const GRANTS_FILE = path.join(userInfo().homedir, '.claude-gui', 'cu-runtime', 'grants.json');
const BACKUP_FILE = path.join(artifacts, 'grants-backup.json');

/** 备份当前 grants.json 的原字节(不存在也记下来,还原时删掉测试期间新建的那份)。 */
export function backupGrants() {
  fs.mkdirSync(artifacts, { recursive: true });
  const existed = fs.existsSync(GRANTS_FILE);
  fs.writeFileSync(BACKUP_FILE, JSON.stringify({
    existed, bytes: existed ? fs.readFileSync(GRANTS_FILE, 'utf8') : null, at: new Date().toISOString(),
  }, null, 2));
  return { existed, path: GRANTS_FILE };
}

export function hasBackup() {
  return fs.existsSync(BACKUP_FILE);
}

/** 按备份还原(字面还原,不重新序列化 —— 原文件怎么写回去就怎么回来)。 */
export function restoreGrants() {
  if (!hasBackup()) return { restored: false, reason: '没有备份' };
  const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
  if (!backup.existed) {
    fs.rmSync(GRANTS_FILE, { force: true });
    return { restored: true, existed: false };
  }
  fs.mkdirSync(path.dirname(GRANTS_FILE), { recursive: true });
  fs.writeFileSync(GRANTS_FILE, backup.bytes);
  return { restored: true, existed: true };
}

/** 还原成功后删掉备份:下一次跑重新按"当时的真状态"备份,不会拿旧备份盖掉这期间的正当改动。 */
export function clearBackup() {
  fs.rmSync(BACKUP_FILE, { force: true });
}

export function readGrants() {
  try { return JSON.parse(fs.readFileSync(GRANTS_FILE, 'utf8')); } catch { return null; }
}
