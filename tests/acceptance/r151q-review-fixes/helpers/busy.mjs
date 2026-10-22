// r151q 会话忙场景辅助:假模型"扣住"的真 CLI 发送方(照 r151g 用例里的 startHeldSender)与跨会话消息收集。
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { uniq, makeWorkspace, mockDir } from '../../r151b-xsession-p1/helpers/fixtures.mjs';
import { readStream, waitFor } from '../../r151b-xsession-p1/helpers/api.mjs';
import { SM, addScript, msgs } from '../../r151c-xsession-p2/helpers/p2.mjs';
import { allowPerm } from '../../r151d-xsession-hardening/helpers/d.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 真 CLI 发送方:假模型等 <mock>/<go> 文件出现才调 send_message。返回 { S, fire(), finish() }。 */
export async function startHeldSender(inst, targetSid, text, { mode = 'bypassPermissions' } = {}) {
  const S = { cwd: makeWorkspace(`real-q-${uniq('')}`) };
  const mark = uniq('R151CK');
  const go = `q-go-${uniq('')}`;
  addScript('real', mark, [{ name: SM, input: { to: [targetSid], message: text }, waitFile: go }], []);
  const r = await inst.c.post('/api/chat', { cwd: S.cwd, permissionMode: mode, prompt: `${mark} 请按约定调用工具` });
  expect(r.status, `前置:发送方起一个真 CLI 回合(${String(r.text).slice(0, 200)})`).toBe(200);
  const events = readStream(r.body.pid, { timeoutMs: 90_000, base: inst.c.base });
  let stop = false;
  const seen = new Set();
  const approver = (async () => {
    while (!stop) {
      const b = (await inst.c.get('/api/permissions/pending').catch(() => ({ body: null }))).body;
      for (const it of (b && Array.isArray(b.items) ? b.items : [])) {
        if (it && it.toolName === SM && it.cwd === S.cwd && !seen.has(it.id)) { seen.add(it.id); await allowPerm(inst.c, it).catch(() => null); }
      }
      await sleep(120);
    }
  })();
  return {
    S,
    fire: () => { fs.mkdirSync(mockDir(), { recursive: true }); fs.writeFileSync(path.join(mockDir(), go), String(Date.now())); },
    finish: async () => { stop = true; await approver.catch(() => null); await events.catch(() => null); },
  };
}
export const crossMsgs = async (inst, sid) => (await msgs(inst.c, sid)).filter((x) => x.from && x.from.kind === 'session');
export const idsOf = async (inst, sid) => new Set((await msgs(inst.c, sid)).map((x) => x.id));
export const waitNewCross = (inst, sid, known, ms = 25_000) => waitFor(async () => (await crossMsgs(inst, sid)).find((x) => !known.has(x.id)) || null, ms, 100);
export const msgNow = async (inst, sid, id) => (await msgs(inst.c, sid)).find((x) => x.id === id) || null;
