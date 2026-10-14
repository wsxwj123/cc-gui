// K 组:端到端链路 —— 本机真实 claude CLI(自动档)→ 被测工作树的 openai 协议代理 → 本地假模型接口。
// 验的是 BRIEF 的成功标准第 1 条"第三方 provider 的会话选了 auto 后真的生效:工具调用由审计模型判定,
// 不是一律放行或一律询问"。CLI 的环境按 INTERFACE Y.3.2 给:CLAUDE_CODE_AUTO_MODE_SERVER=0(GUI 在第三方 + 开关开时传的值),
// 审核模型 = sonnet 档(ANTHROPIC_DEFAULT_SONNET_MODEL)。全程零真实模型调用:所有请求都落在本地假接口。
// 本机没有真实 CLI 时整组跳过(会在报告里标出)。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { setLane, laneRequests, clearLane } from './helpers/api.mjs';
import { dataRoot } from './helpers/fixtures.mjs';
import { runRealCli, realCliPath } from './helpers/real-cli.mjs';

const PROXY = process.env.R151A_PROXY_BASE || 'http://127.0.0.1:0';
const LANE = 'proxy';
const REASON = 'R151 e2e: 写到工作目录之外';
const ENV = { CLAUDE_CODE_AUTO_MODE_SERVER: '0', ANTHROPIC_DEFAULT_SONNET_MODEL: 'r151-audit' };

test.describe.configure({ timeout: 180_000 });
test.skip(!realCliPath(), '本机没有真实 claude CLI');

async function runCase(tag, classifier) {
  const root = path.join(dataRoot(), 'e2e', `${tag}-${Date.now().toString(36)}`);
  const marker = path.join(root, `r151-e2e-${tag}`);
  setLane(LANE, { classifier, blockReason: REASON, main: { tools: [{ name: 'Bash', input: { command: `touch ../r151-e2e-${tag}`, description: 'r151 e2e touch' } }], text: 'R151-E2E-DONE' } });
  clearLane(LANE);
  const asked = [];
  const r = await runRealCli({ root, baseURL: PROXY, env: ENV, prompt: `R151 e2e ${tag}`, permissionMode: 'auto', logFile: path.join(root, 'lines.jsonl'),
    timeoutMs: 150_000, onCanUseTool: async (req) => { asked.push(req); return { behavior: 'deny', message: 'r151a host: 测试里不该走到询问' }; } });
  const denials = r.lines.filter((l) => l.type === 'system' && l.subtype === 'permission_denied');
  const upstream = laneRequests(LANE);
  return { r, marker, executed: fs.existsSync(marker), denials, asked, classifierReqs: upstream.filter((q) => q.kind === 'oa-classifier'), mainReqs: upstream.filter((q) => q.kind === 'oa-main') };
}

test('K1 审核模型放行 → 工具真的执行了(文件被创建),没有拒绝事件', async () => {
  const c = await runCase('allow', 'allow');
  expect(c.r.timedOut, 'CLI 不应超时').toBe(false);
  expect(c.denials.map((d) => d.decision_reason), '不应被拒绝').toEqual([]);
  expect(c.executed, '放行后命令应真的执行').toBe(true);
});

test('K2 审核模型拦下 → 工具没有执行,拒绝事件的原因就是审核模型给的原因(不是"审核不可用")', async () => {
  const c = await runCase('block', 'block');
  expect(c.executed, '被拦下的命令不应执行').toBe(false);
  expect(c.denials.length, '应有一条拒绝事件').toBeGreaterThan(0);
  expect(c.denials[0].decision_reason_type).toBe('classifier');
  expect(c.denials[0].decision_reason).toBe(REASON);
});

test('K3 审核请求经代理到上游时是非流式:stream:false、没有 stream_options、stop = ["</block>"]', async () => {
  const c = await runCase('shape', 'allow');
  expect(c.classifierReqs.length, '上游应收到审核请求').toBeGreaterThan(0);
  const b = c.classifierReqs[0].body;
  expect(b.stream).toBe(false);
  expect(b).not.toHaveProperty('stream_options');
  expect(b.stop).toEqual(['</block>']);
});

test('K4 主回合请求经代理仍是流式(stream:true + include_usage),与改动前一致', async () => {
  const c = await runCase('main', 'allow');
  expect(c.mainReqs.length).toBeGreaterThan(0);
  for (const q of c.mainReqs) {
    expect(q.body.stream).toBe(true);
    expect(q.body.stream_options).toEqual({ include_usage: true });
  }
});

test('K5 审核请求用的是 sonnet 档的模型(ANTHROPIC_DEFAULT_SONNET_MODEL)', async () => {
  const c = await runCase('model', 'allow');
  expect(c.classifierReqs.length).toBeGreaterThan(0);
  expect(c.classifierReqs[0].body.model).toBe('r151-audit');
});

test('K6 偏安全:审核模型出错(上游 500)→ 工具不执行,原因是"审核不可用"', async () => {
  const c = await runCase('down', 'http500');
  expect(c.executed).toBe(false);
  expect(c.denials.length).toBeGreaterThan(0);
  expect(c.denials[0].decision_reason).toBe('Classifier unavailable');
});

test('K7 偏安全:审核模型答非所问(无法解析)→ 工具不执行', async () => {
  const c = await runCase('garbage', 'garbage');
  expect(c.executed).toBe(false);
});
