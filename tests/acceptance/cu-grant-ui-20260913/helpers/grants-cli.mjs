// 命令行入口:备份 / 还原授权真源(~/.claude-gui/cu-runtime/grants.json)。
// run-isolated.sh 自己用它 —— 不把"还原"这件事只押在 playwright 钩子上:
// 本套件第一版就漏接了 globalSetup/globalTeardown,结果操作者的授权状态被留在测试状态里
// (screenScope 被清、应用列表被清空)。runner 的生命周期里管备份/还原才是那条不会断的保险。
import { backupGrants, restoreGrants, clearBackup, hasBackup } from './grants.mjs';

const cmd = process.argv[2];
if (cmd === 'backup') {
  if (hasBackup()) {
    console.log('[cu-grant-ui] 已有更早的 grants 备份(上次没跑完),保留它,不覆盖');
  } else {
    const info = backupGrants();
    console.log(`[cu-grant-ui] 已备份授权真源:${info.path}(原文件${info.existed ? '存在' : '不存在'})`);
  }
} else if (cmd === 'restore') {
  if (!hasBackup()) {
    console.log('[cu-grant-ui] 没有待还原的备份(无事可做)');
  } else {
    const r = restoreGrants();
    clearBackup();
    console.log(`[cu-grant-ui] 授权真源已按原字节还原(existed=${r.existed})`);
  }
} else {
  console.error('用法: node helpers/grants-cli.mjs backup|restore');
  process.exit(2);
}
