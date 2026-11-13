// r179 · 接口用例的"一条用例一个全新环境":全新隔离家目录 + 一个后端实例 + 若干假上游 / 假代理。
// 每条用例结束(afterEach)统一收尾;只收自己起的东西。
import { caseRoot, startInstance, stopAll, req } from './instance.mjs';
import { startUpstream, startProxy } from './fakes.mjs';

let closers = [];

export async function newCase(slug) {
  const c = caseRoot(slug);
  const inst = await startInstance(c, {}, { label: 'instance' });
  const tracked = (fake) => { closers.push(() => fake.close()); return fake; };
  return {
    ...c, inst, req: (method, url, body) => req(inst.base, method, url, body),
    upstream: async (opts) => tracked(await startUpstream(opts)),
    proxy: async () => tracked(await startProxy()),
    /** 先 stop 再用同一个家目录重新起实例(G2b 预置数据文件用)。 */
    restart: async () => { await inst.stop(); const next = await startInstance(c, {}, { label: 'instance2' }); return next; },
  };
}

export async function closeCase() {
  const list = closers; closers = [];
  for (const fn of list) { try { await fn(); } catch { /* 收尾尽力而为 */ } }
  await stopAll();
}
