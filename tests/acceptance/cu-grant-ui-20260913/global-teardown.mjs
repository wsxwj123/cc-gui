// 收尾:把授权真源按原字节还原,并清掉备份。
// 备份不覆盖(见 global-setup):上次跑挂了留下的那份是最早的真状态,按它还原才不会把
// 测试期间的改动当成"原来的样子"。还原成功即删备份,下次跑重新备份。
import { restoreGrants, clearBackup, hasBackup } from './helpers/grants.mjs';

export default async function globalTeardown() {
  if (!hasBackup()) return;
  const r = restoreGrants();
  clearBackup();
  console.log(`[cu-grant-ui] 授权真源已还原(existed=${r.existed})`);
}
