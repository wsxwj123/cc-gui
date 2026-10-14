#!/usr/bin/env node
// r151a T-Y10 ② 的最小端到端(零模型成本):本机真实 claude CLI(自动档)+ 本地假模型接口 + SDK query,
// PreToolUse 回调用产品代码 makePreToolUseHook(slot)。主模型发一条危险 Bash(rm -rf ../victim,工作目录之外),审核模型会放行。
//   A 第三方槽(thirdPartyProvider:true):回调返回 ask → CLI 交给 canUseTool(宿主拒绝)、审核请求 0 次、victim 还在;
//   B 对照(官方槽,回调 continue):审核放行 → canUseTool 没被调、审核请求 ≥1 次、victim 被删。
// 本机找不到真实 CLI 时跳过(打印 SKIP,退出码 0)。假接口复用验收套件的 mock-upstream.mjs(只读运行)。
// node tests/unit/check-r151a-tighten-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = [process.env.R151A_REAL_CLAUDE, join(userInfo().homedir, '.npm-global', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]
  .filter(Boolean).find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
if (!CLI) { console.log('check-r151a-tighten-e2e: SKIP(本机没有真实 claude CLI)'); process.exit(0); }

const tmp = mkdtempSync(join(tmpdir(), 'cgui-r151a-tighten-e2e-'));
// 产品模块读 homedir() 的地方都指到临时目录(本测试不经 GUI 服务端,只用 makePreToolUseHook)
process.env.HOME = join(tmp, 'gui-home');
mkdirSync(process.env.HOME, { recursive: true });
const { makePreToolUseHook } = await import('../../server/routes/chat.js');
const { THIRD_PARTY_AUTO_ASK_REASON } = await import('../../server/services/auto-audit.js');
const { query } = await import('@anthropic-ai/claude-agent-sdk');

const freePort = async () => {
  for (let p = 6900; p <= 6999; p++) {
    if (p === 6710) continue;
    const ok = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); });
    if (ok) return p;
  }
  throw new Error('6900-6999 没有空闲端口');
};
const port = await freePort();
const mockDir = join(tmp, 'mock');
const mock = spawn(process.execPath, [join(root, 'tests/acceptance/r151a-auto-audit/helpers/mock-upstream.mjs'), String(port), mockDir], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('假接口没起来')), 10_000);
  mock.stdout.on('data', (d) => { if (String(d).includes('就绪')) { clearTimeout(t); resolve(); } });
  mock.once('exit', (c) => { clearTimeout(t); reject(new Error(`假接口退出 ${c}`)); });
});

const lane = (name, ctl) => { const d = join(mockDir, 'lanes', name); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'ctl.json'), JSON.stringify(ctl)); };
const laneKinds = (name) => { try { return readFileSync(join(mockDir, 'lanes', name, 'requests.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).kind); } catch { return []; } };

async function runCase(tag, slot) {
  const base = join(tmp, tag);
  const work = join(base, 'work');
  const victim = join(base, 'victim');   // 放在工作目录之外:目录内的操作 CLI 自动档不送审核(实测),对照组就测不到审核放行
  for (const d of [join(base, 'home'), join(base, 'cfg'), join(base, 'tmp'), work, victim]) mkdirSync(d, { recursive: true });
  writeFileSync(join(victim, 'keep.txt'), 'r151a');
  lane(tag, { classifier: 'allow', main: { tools: [{ name: 'Bash', input: { command: 'rm -rf ../victim', description: 'r151 tighten e2e' } }], text: 'R151-E2E-DONE' } });
  const asked = [];
  const env = {
    PATH: process.env.PATH, HOME: join(base, 'home'), CLAUDE_CONFIG_DIR: join(base, 'cfg'), TMPDIR: join(base, 'tmp'), LANG: 'en_US.UTF-8',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/lane/${tag}`, ANTHROPIC_AUTH_TOKEN: 'dummy-r151-token', ANTHROPIC_MODEL: 'r151-main',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'r151-audit', CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1',
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120_000);
  const q = query({
    prompt: `R151 tighten e2e ${tag}`,
    options: {
      cwd: work, model: 'r151-main', permissionMode: 'auto', pathToClaudeCodeExecutable: CLI, env, settingSources: [], maxTurns: 4,
      abortController: ac,
      hooks: { PreToolUse: [{ hooks: [makePreToolUseHook(slot)] }] },
      canUseTool: async (toolName, input, opts = {}) => {
        asked.push({ toolName, command: input?.command, reason: opts.decisionReason });
        return { behavior: 'deny', message: 'r151a e2e: 宿主拒绝' };
      },
    },
  });
  try { for await (const m of q) { if (m.type === 'result') break; } } finally { clearTimeout(timer); try { q.close?.(); } catch { /* */ } }
  const kinds = laneKinds(tag);
  return { asked, victimExists: existsSync(join(victim, 'keep.txt')), classifier: kinds.filter((k) => k === 'classifier').length, main: kinds.filter((k) => k === 'main').length, kinds };
}

try {
  const a = await runCase('tp', { thirdPartyProvider: true, guiMode: 'auto' });
  assert.ok(a.main >= 1, `A:主模型请求应已发出(${JSON.stringify(a)})`);
  assert.equal(a.asked.length, 1, `A:回调返回 ask 后 CLI 应把这次调用交给 canUseTool(${JSON.stringify(a)})`);
  assert.equal(a.asked[0].toolName, 'Bash');
  const reasonText = typeof a.asked[0].reason === 'string' ? a.asked[0].reason : JSON.stringify(a.asked[0].reason ?? '');
  assert.ok(reasonText.includes(THIRD_PARTY_AUTO_ASK_REASON), `A:上交原因应是回调给的原因(${JSON.stringify(a.asked[0])})`);
  assert.equal(a.classifier, 0, 'A:审核请求不应发出');
  assert.equal(a.victimExists, true, 'A:宿主拒绝 → 危险命令没执行');

  const b = await runCase('off', { thirdPartyProvider: false, guiMode: 'auto' });
  assert.equal(b.asked.length, 0, `B 对照:审核放行时 CLI 不回调宿主(${JSON.stringify(b)})`);
  assert.ok(b.classifier >= 1, `B 对照:审核请求应已发出(${JSON.stringify(b)})`);
  assert.equal(b.victimExists, false, 'B 对照:审核放行 → 命令真的执行了(这正是 ② 要堵的路径)');
  console.log(`check-r151a-tighten-e2e: OK(A ${JSON.stringify(a)};B ${JSON.stringify(b)})`);
} finally {
  try { mock.kill(); } catch { /* */ }
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
