#!/usr/bin/env node
// 单条用例子进程(r151m 的做法):HOME 由父进程指向临时目录,进程内加载两个代理的公开入口、配本进程内的假上游,
// 通过代理的 HTTP 口转发,把"上游实际收到的 model"等事实打印成一行 R151Q_RESULT <json>;断言在 c-proxy.spec.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { createContext, postMessages, makeChatBody, captureLogs, sleep } from '../../r151m-model-fallback/lib/harness.mjs';

const id = Number(process.argv[2]);
const settingsFile = path.join(process.env.HOME, '.claude', 'settings.json');
const writeSettings = async (obj) => {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, typeof obj === 'string' ? obj : JSON.stringify(obj));
  await sleep(30); // 让修改时间一定变化
};
const setup = (ctx, kind, opts) => (kind === 'anthropic' ? ctx.prepareAnthropic(opts) : ctx.prepareOpenAI(opts));
async function forward(up, requested) {
  const n = up.fake.records.length;
  const res = await postMessages(up.base, makeChatBody(requested));
  const rec = up.fake.records.slice(n).filter((r) => r.method === 'POST');
  return { status: res.status, upstreamModel: rec.length ? (rec[rec.length - 1].json && rec[rec.length - 1].json.model) ?? null : null };
}
const M1 = 'r151q-m1'; const M2 = 'r151q-m2';
const TOKEN = 'R151QSECRET-9f3a7c1d2e';

const CASES = {
  async 6(ctx, kind) {
    await writeSettings({ env: { ANTHROPIC_MODEL: M1 } });
    const up = await setup(ctx, kind, { models: [M1, M2], model: M1 });
    const before = await forward(up, 'claude-opus-4-7');
    await writeSettings({ env: { ANTHROPIC_MODEL: `${M2}[1m]` } });
    const after = await forward(up, 'claude-opus-4-7');
    return { before, after };
  },
  async 7(ctx, kind) {
    await writeSettings({ model: 'claude-opus-4-6', env: { ANTHROPIC_MODEL: M1, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5' } });
    const up = await setup(ctx, kind, { models: [M1, 'claude-opus-4-7'], model: M1 });
    return {
      haiku: await forward(up, 'claude-haiku-4-5'),
      topModel: await forward(up, 'claude-opus-4-6'),
      unconfigured: await forward(up, 'claude-sonnet-4-6'),
      inList: await forward(up, 'claude-opus-4-7'),
    };
  },
  async 8(ctx, kind) {
    await writeSettings({ env: { ANTHROPIC_MODEL: M1, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5' } });
    const up = await setup(ctx, kind, { models: [M1, M2], model: M1 });
    return { haiku: await forward(up, 'claude-haiku-4-5') };
  },
  async 9(ctx, kind) {
    await writeSettings({ env: { ANTHROPIC_MODEL: M2 } });
    const up = await setup(ctx, kind, { models: [M1, M2], model: M1 });
    const logs = captureLogs();
    let out;
    try {
      const good = await forward(up, 'claude-opus-4-7');
      await writeSettings(`{"env": {"ANTHROPIC_MODEL": "${M2}", "ANTHROPIC_AUTH_TOKEN": "${TOKEN}`); // 写到一半(token 字符串中间被截断)
      const broken1 = await forward(up, 'claude-opus-4-7');
      await writeSettings(`{"env": {"ANTHROPIC_MODEL": "${M2}", "ANTHROPIC_AUTH_TOKEN": ${TOKEN}-bad,`); // 损坏(token 恰在出错位置)
      const broken2 = await forward(up, 'claude-opus-4-7');
      await writeSettings({ env: { ANTHROPIC_MODEL: M1 } });
      const recovered = await forward(up, 'claude-opus-4-7');
      out = { good, broken1, broken2, recovered };
    } finally { logs.stop(); }
    return { ...out, leakedToken: logs.text().includes('R151QSECRET'), logTail: logs.text().slice(-400) };
  },
};

const ctx = await createContext({ caseId: 600 + id, artifactDir: process.env.R151Q_ART ? path.join(process.env.R151Q_ART, 'proxy') : undefined });
const result = {};
try {
  for (const kind of ['anthropic', 'openai']) result[kind] = await CASES[id](ctx, kind);
} finally { await ctx.cleanup(); }
console.log(`R151Q_RESULT ${JSON.stringify(result)}`);
process.exit(0);
