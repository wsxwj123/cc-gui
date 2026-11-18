// 跑用例之前的预检:确认连的是本套件自己的隔离后端(端口在 6700–6999、不是保留端口),并且它活着。
import { backendBase, EnvironmentBlocked } from './helpers/env.mjs';

export default async function globalSetup() {
  const base = backendBase();
  const r = await fetch(`${base}/api/health`).catch((e) => {
    throw new EnvironmentBlocked(`health unreachable at ${base}: ${e.message}`);
  });
  if (!r.ok) throw new EnvironmentBlocked(`health returned HTTP ${r.status}`);
}
