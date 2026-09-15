// 起跑前:备份 grants.json(写授权的用例必须能原样还原)。
// 不做任何"清空授权"的动作 —— 需要空授权态的用例(CG-13)自己在前置里造并还原。
import { backupGrants, hasBackup } from './helpers/grants.mjs';

export default async function globalSetup() {
  if (hasBackup()) {
    console.log('[cu-grant-ui] 已存在上一次留下的 grants 备份(上次可能没跑完);本次不覆盖 —— 收尾时按最早那份(真状态)还原');
    return;
  }
  const { path } = backupGrants();
  console.log(`[cu-grant-ui] 已备份授权真源:${path}`);
}
