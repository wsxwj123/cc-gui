// PA-423…425：`GET /api/usage` 的 `byPeriod` 端到端分桶（契约 §3.3 + §10.11④）。
//
// §10.11④ 公布了可隔离的观察点：`usage-stats.js` 的项目根 = `$HOME/.claude/projects`，
// 于是「隔离 HOME + 手写 jsonl」就能喂出已知时段的记录，从而断言三桶的**条数与数值**，
// 不再只靠 PA-411 的恒等式。缓存注意（§10.11④）：先写夹具、后起实例。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { WORKTREE, suitePath } from './helpers/pa-runtime.mjs';

const SERVER_ENTRY = path.join(WORKTREE, 'server', 'index.js');
const DATA_ROOT = suitePath('.artifacts', 'usage-e2e');
const HOME = path.join(DATA_ROOT, 'home');
const PROJECT_HASH = '-pa-byperiod-e2e';
const SESSION_ID = 'b7c1e2f3-0000-4000-8000-0000000000e2';

/**
 * 夹具记录（每条一个独立的 message.id = 一次 API 调用）。
 * 时段按契约 §1 的北京时间口径：
 *   peak     工作日 09:00–12:00 / 14:00–18:00；
 *   offPeak  周末全天、工作日 20:00、以及「北京周六凌晨 = UTC 周五 17:00」这条**时区判别点**；
 *   unknown  没有可解析的时间戳。
 */
const RECORDS = [
  { id: 'msg_pa_bp_peak', bucket: 'peak', timestamp: '2026-09-11T02:00:00.000Z', // 周五北京 10:00
    input: 100, output: 10, cacheRead: 1, cacheWrite: 2 },
  { id: 'msg_pa_bp_weekend', bucket: 'offPeak', timestamp: '2026-09-12T02:00:00.000Z', // 周六北京 10:00
    input: 200, output: 20, cacheRead: 2, cacheWrite: 4 },
  { id: 'msg_pa_bp_evening', bucket: 'offPeak', timestamp: '2026-09-11T12:00:00.000Z', // 周五北京 20:00
    input: 300, output: 30, cacheRead: 3, cacheWrite: 6 },
  { id: 'msg_pa_bp_unknown', bucket: 'unknown', timestamp: null, // 无时间戳
    input: 400, output: 40, cacheRead: 4, cacheWrite: 8 },
  { id: 'msg_pa_bp_tz', bucket: 'offPeak', timestamp: '2026-09-11T17:00:00.000Z', // 北京周六 01:00（UTC 还是周五 17:00）
    input: 500, output: 50, cacheRead: 5, cacheWrite: 10 },
];

const BUCKETS = ['peak', 'offPeak', 'unknown'];
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

function expectedTotals() {
  const totals = {};
  for (const bucket of BUCKETS) {
    totals[bucket] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  }
  for (const record of RECORDS) {
    const bucket = totals[record.bucket];
    bucket.calls += 1;
    for (const field of FIELDS) bucket[field] += record[field];
  }
  return totals;
}

function writeFixture() {
  if (!DATA_ROOT.startsWith(suitePath('.artifacts'))) {
    throw new Error(`夹具根必须在本套件 .artifacts 下：${DATA_ROOT}`);
  }
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
  const projectDir = path.join(HOME, '.claude', 'projects', PROJECT_HASH);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(HOME, '.claude-gui'), { recursive: true });

  const lines = [JSON.stringify({
    type: 'user', uuid: 'pa-bp-user-1', sessionId: SESSION_ID,
    timestamp: '2026-09-11T01:59:00.000Z',
    message: { role: 'user', content: 'pa byperiod e2e fixture' },
  })];
  for (const record of RECORDS) {
    const line = {
      type: 'assistant', uuid: `pa-bp-${record.id}`, sessionId: SESSION_ID,
      message: {
        id: record.id, model: 'deepseek-flash', role: 'assistant',
        usage: {
          input_tokens: record.input,
          output_tokens: record.output,
          cache_read_input_tokens: record.cacheRead,
          cache_creation_input_tokens: record.cacheWrite,
        },
      },
    };
    if (record.timestamp) line.timestamp = record.timestamp;
    lines.push(JSON.stringify(line));
  }
  fs.writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), `${lines.join('\n')}\n`);
  return path.join(projectDir, `${SESSION_ID}.jsonl`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseURL, child, logFile, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseURL}/api/health`);
      if (response.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-800) : '(没有日志)';
  throw new Error(`隔离实例没能在 ${timeoutMs}ms 内起来（exitCode=${child.exitCode}）。server.log 末尾：\n${tail}`);
}

let child = null;
let baseURL = null;
let usageBody = null;

test.describe('byPeriod 端到端分桶（隔离 HOME + 手写 jsonl）', () => {
  test.beforeAll(async () => {
    const jsonl = writeFixture();
    const port = await freePort();
    baseURL = `http://127.0.0.1:${port}`;
    const logFile = path.join(DATA_ROOT, 'server.log');
    const env = {
      ...process.env, HOME, PORT: String(port),
      CGUI_DISABLE_FILE_WATCHER: '1', CGUI_ENABLE_LOCAL_ROUTES: '1', CGUI_TAURI: '1',
    };
    for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL']) delete env[key];
    const out = fs.openSync(logFile, 'a');
    child = spawn(process.execPath, [SERVER_ENTRY], { env, cwd: WORKTREE, stdio: ['ignore', out, out] });
    try {
      await waitForHealth(baseURL, child, logFile);
    } catch (error) {
      // 起不来时把日志一起抛出来，测试报告里能直接看到原因（不是静默环境跳过）。
      throw new Error(`${error.message}\n夹具：${jsonl}`);
    }
    const response = await fetch(`${baseURL}/api/usage`);
    expect(response.status, '夹具实例的 /api/usage').toBe(200);
    usageBody = await response.json();
  });

  test.afterAll(async () => {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    const deadline = Date.now() + 5_000;
    while (child.exitCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  function deepseekRow() {
    const row = (usageBody?.byModel || []).find(item => item?.model === 'deepseek-flash');
    expect(row, '夹具实例里必须有 deepseek-flash 这一行（夹具只喂了这一个模型）').toBeTruthy();
    // 先钉住夹具本身成立（行合计 = 夹具记录之和），这样失败时读起来是「缺 byPeriod」而不是夹具问题。
    const all = expectedTotals();
    for (const field of FIELDS) {
      expect(row[field], `夹具前提：行 ${field} = 全部夹具记录之和`).toBe(
        BUCKETS.reduce((acc, bucket) => acc + all[bucket][field], 0),
      );
    }
    expect(row.byPeriod, `契约 §3.3 要求每行都带 byPeriod（三桶：${BUCKETS.join('/')}）`).toBeTruthy();
    return row;
  }

  test('PA-423 byPeriod 条数：peak=1 / offPeak=3 / unknown=1，且三桶之和等于该行 calls', async () => {
    const row = deepseekRow();
    const expected = expectedTotals();
    for (const bucket of BUCKETS) {
      expect(row.byPeriod?.[bucket]?.calls, `${bucket} 桶的调用次数`).toBe(expected[bucket].calls);
    }
    const sum = BUCKETS.reduce((acc, bucket) => acc + (row.byPeriod?.[bucket]?.calls ?? 0), 0);
    expect(sum, '三桶条数之和 = 该行 calls').toBe(row.calls);
  });

  test('PA-424 byPeriod 数值：每桶逐字段等于夹具里该时段记录的 token 之和，且行合计 = 全部记录之和', async () => {
    const row = deepseekRow();
    const expected = expectedTotals();
    for (const bucket of BUCKETS) {
      for (const field of FIELDS) {
        expect(row.byPeriod?.[bucket]?.[field], `${bucket}.${field}`).toBe(expected[bucket][field]);
      }
    }
    for (const field of FIELDS) {
      const total = BUCKETS.reduce((acc, bucket) => acc + expected[bucket][field], 0);
      expect(row[field], `行 ${field} = 全部夹具记录之和（分桶不重不漏）`).toBe(total);
    }
  });

  test('PA-425 反向：按北京时间判时段 —— UTC 周五 17:00/北京周六 01:00 那条必须落 offPeak，不得落 peak', async () => {
    const row = deepseekRow();
    const tzRecord = RECORDS.find(record => record.id === 'msg_pa_bp_tz');
    expect(tzRecord.bucket, '夹具前提：这条按北京口径是空闲').toBe('offPeak');
    expect(row.byPeriod.peak.input, 'peak 桶只装工作日 09–12/14–18 的记录')
      .toBe(RECORDS.filter(r => r.bucket === 'peak').reduce((acc, r) => acc + r.input, 0));
    expect(row.byPeriod.offPeak.input, '跨日记录按北京时间归桶')
      .toBeGreaterThanOrEqual(tzRecord.input);
    expect(row.byPeriod.peak.input, 'peak 桶不得混入这条（若按 UTC 判会误进 peak）').not.toBe(tzRecord.input);
  });
});
