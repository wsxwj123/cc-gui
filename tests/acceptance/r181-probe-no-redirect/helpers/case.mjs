// r181 · 接口用例的"一条用例一个全新环境":全新隔离家目录 + 一个后端实例 + 若干假上游。
// 每条用例结束(afterEach)统一收尾;只收自己起的东西。
import { caseRoot, startInstance, stopAll, req } from './instance.mjs';
import { startFake } from './fakes.mjs';

let closers = [];

export async function newCase(slug) {
  const c = caseRoot(slug);
  const inst = await startInstance(c, {}, { label: 'instance' });
  return {
    ...c, inst, req: (method, url, body) => req(inst.base, method, url, body),
    /** 起一台可配置的本机假上游。 */
    fake: async () => { const f = await startFake(); closers.push(() => f.close()); return f; },
  };
}

export async function closeCase() {
  const list = closers; closers = [];
  for (const fn of list) { try { await fn(); } catch { /* 收尾尽力而为 */ } }
  await stopAll();
}
