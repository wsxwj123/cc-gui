// r123 · A 组:任务形态(INTERFACE-r123 §A)。全部用本地假上游驱动,观察 GET /api/image/history 里条目的终态。
// 依据只有 .devflow/BRIEF-r123.md 与 .devflow/INTERFACE-r123.md;没看实现代码。
// 每条用例注册自己的路径前缀(/aN…),提供方基址 = 假上游 + 前缀,请求日志按前缀查,互不串。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createProvider, generate, waitTerminal, newSaveDir, cancelIfRunning } from './helpers/api.mjs';
import { createFakeUpstream, createDecoy } from './helpers/fake-upstream.mjs';
import { PNG, PNG_B64 } from './helpers/images.mjs';

const FIX = path.resolve(process.env.WORKTREE || process.cwd(), 'tests', 'fixtures');
const MJ_SUBMIT = JSON.parse(fs.readFileSync(path.join(FIX, 'mj-submit.sample.json'), 'utf8'));
const MJ_RESULT = JSON.parse(fs.readFileSync(path.join(FIX, 'mj-result.sample.json'), 'utf8'));
const MJ_TASK_ID = MJ_SUBMIT.data[0].task_id;

let up;
test.beforeAll(async () => { up = createFakeUpstream(); await up.listen(); });
test.afterAll(async () => { await up?.close(); });

const jobs = [];
test.afterEach(async () => { while (jobs.length) await cancelIfRunning(jobs.pop()); });

/** 落盘文件列表:任务链路给 files;同步链路现状只给 file —— 两种都接受(用户只关心图落没落)。 */
const filesOf = (e) => (Array.isArray(e?.files) && e.files.length ? e.files : (e?.file ? [e.file] : []));
const show = (e) => JSON.stringify(e);
const sizeOf = (f) => (fs.existsSync(f) ? fs.statSync(f).size : -1);

/** 视频式任务脚本:POST /images/generations 回任务对象;GET /images/generations/{id} 按第几次轮询回 polls(n)。 */
function taskScenario(prefix, { id = 'tsk_img_1', submit, polls }) {
  return up.scenario(prefix, ({ method, path: p, hits }) => {
    if (method === 'POST' && p === '/images/generations') return { body: submit || { id, object: 'generation.task', model: 'm', status: 'queued', progress: 0, created_at: 1 } };
    if (method === 'GET' && p === `/images/generations/${id}`) return { body: polls(hits) };
    return null;
  });
}
async function runJob(baseURL, overrides = {}) {
  const p = await createProvider({ baseURL, savePath: newSaveDir('a'), ...overrides });
  const jobId = await generate(p.id);
  jobs.push(jobId);
  const e = await waitTerminal(jobId, 30_000);
  expect(e, `历史里应能找到任务 ${jobId}`).toBeTruthy();
  return e;
}
const gets = (list, pathname) => list.filter((r) => r.method === 'GET' && r.path === pathname);

// ───────────────────────── A1 视频式任务对象 ─────────────────────────
const A1_DONE = () => ({ id: 'tsk_img_1', status: 'completed', result: { data: [{ url: up.img('a1') }] }, billing: { cost_usd: '0.04', credits: '4' } });

test('A1-1 视频式任务对象:queued → in_progress → completed(result.data[].url)→ done 且落一张图,轮询地址 = 提交地址 + /{id}', async () => {
  const base = taskScenario('/a1a/v1', { polls: (n) => (n < 2 ? { id: 'tsk_img_1', status: 'in_progress', progress: 50 } : A1_DONE()) });
  const e = await runJob(base);
  expect(e.status, show(e)).toBe('done');
  expect(filesOf(e), show(e)).toHaveLength(1);
  expect(sizeOf(filesOf(e)[0])).toBe(PNG.length);
  const got = await up.received('/a1a/v1');
  expect(gets(got, '/a1a/v1/images/generations/tsk_img_1').length, `轮询地址应是提交地址 + /tsk_img_1;实际请求:${show(got.map((r) => `${r.method} ${r.path}`))}`).toBeGreaterThanOrEqual(2);
});

test('A1-2 视频式任务对象:条目 taskId 为上游任务号 tsk_img_1', async () => {
  const base = taskScenario('/a1b/v1', { polls: () => A1_DONE() });
  const e = await runJob(base);
  expect(e.status, show(e)).toBe('done');
  expect(e.taskId, show(e)).toBe('tsk_img_1');
});

test('A1-3 实付字段是字符串(billing.cost_usd:"0.04")时,条目 cost 为数值 0.04', async () => {
  const base = taskScenario('/a1c/v1', { polls: () => A1_DONE() });
  const e = await runJob(base);
  expect(e.status, show(e)).toBe('done');
  expect(e.cost, show(e)).toBe(0.04);
});

// ───────────────────────── A2 顶层 task_id ─────────────────────────
test('A2 顶层 task_id 形态:提交回 {task_id,status:submitted},GET 提交地址/{task_id} 回 {status:completed,url} → done', async () => {
  const base = up.scenario('/a2/v1', ({ method, path: p }) => {
    if (method === 'POST' && p === '/images/generations') return { body: { task_id: 't-1', status: 'submitted' } };
    if (method === 'GET' && p === '/images/generations/t-1') return { body: { task_id: 't-1', status: 'completed', url: up.img('a2') } };
    return null;
  });
  const e = await runJob(base);
  expect(e.status, show(e)).toBe('done');
  expect(sizeOf(filesOf(e)[0])).toBe(PNG.length);
});

// ───────────────────────── A3 polling_url ─────────────────────────
test('A3-1 polling_url 形态(同源):轮询该地址,{status:"Ready",result.sample} → done', async () => {
  const base = up.scenario('/a3a/v1', ({ method, path: p }) => {
    if (method === 'POST' && p === '/images/generations') return { body: { id: 'p-1', polling_url: `${up.base}/a3a/v1/poll/p-1` } };
    if (method === 'GET' && p === '/poll/p-1') return { body: { status: 'Ready', result: { sample: up.img('a3') } } };
    return null;
  });
  const e = await runJob(base);
  expect(e.status, show(e)).toBe('done');
  expect(sizeOf(filesOf(e)[0])).toBe(PNG.length);
  const got = await up.received('/a3a/v1');
  expect(gets(got, '/a3a/v1/poll/p-1').length, `应按 polling_url 轮询;实际:${show(got.map((r) => `${r.method} ${r.path}`))}`).toBeGreaterThanOrEqual(1);
});

test('A3-2 polling_url 跨源(另一个端口):条目 error 含「同源」或「拒绝」,且跨源地址一个请求都没收到', async () => {
  const decoy = createDecoy(up.img('a3-decoy')); await decoy.listen();
  try {
    const base = up.scenario('/a3b/v1', ({ method, path: p }) => {
      if (method === 'POST' && p === '/images/generations') return { body: { id: 'p-2', polling_url: `${decoy.base}/steal/p-2` } };
      return null;
    });
    const e = await runJob(base);
    expect(e.status, show(e)).toBe('error');
    expect(e.error || '', show(e)).toMatch(/同源|拒绝/);
    expect(decoy.requests.map((r) => `${r.method} ${r.path}`), '跨源 polling_url 不得被请求(会把 key 带到别的主机)').toEqual([]);
  } finally { await decoy.close(); }
});

// ───────────────────────── A4 状态词表 ─────────────────────────
test('A4-1 进行中词表:pending → queued → in_progress → processing → running → 未知值 xyz → completed 全程不判死', async () => {
  const seq = ['pending', 'queued', 'in_progress', 'processing', 'running', 'xyz'];
  const base = taskScenario('/a4a/v1', { polls: (n) => (n <= seq.length ? { id: 'tsk_img_1', status: seq[n - 1] } : A1_DONE()) });
  const e = await runJob(base);
  expect(e.status, show(e)).toBe('done');
  const got = await up.received('/a4a/v1');
  expect(gets(got, '/a4a/v1/images/generations/tsk_img_1').length, '应轮询过全部 6 个进行中状态再拿到 completed').toBeGreaterThanOrEqual(seq.length + 1);
});

test('A4-2 终态 failed → 条目 error,error 含「上游任务失败」', async () => {
  const base = taskScenario('/a4b/v1', { polls: () => ({ id: 'tsk_img_1', status: 'failed', error: { message: 'render exploded' } }) });
  const e = await runJob(base);
  expect(e.status, show(e)).toBe('error');
  expect(e.error || '', show(e)).toContain('上游任务失败');
});

test('A4-3 终态 canceled(美式拼写)→ 条目 error,error 含「已取消」', async () => {
  const base = taskScenario('/a4c/v1', { polls: () => ({ id: 'tsk_img_1', status: 'canceled' }) });
  const e = await runJob(base);
  expect(e.status, show(e)).toBe('error');
  expect(e.error || '', show(e)).toContain('已取消');
});

for (const word of ['succeeded', 'success', 'ready', 'done', 'finished']) {
  test(`A4-4 成功词 ${word} → 按成功取图 → done`, async () => {
    const base = taskScenario(`/a4d-${word}/v1`, { polls: () => ({ id: 'tsk_img_1', status: word, result: { data: [{ url: up.img(`a4-${word}`) }] } }) });
    const e = await runJob(base);
    expect(e.status, show(e)).toBe('done');
    expect(sizeOf(filesOf(e)[0])).toBe(PNG.length);
  });
}

// ───────────────────────── A5 取图位置 ─────────────────────────
const A5_CASES = [
  ['result.data[].b64_json', () => ({ id: 'tsk_img_1', status: 'completed', result: { data: [{ b64_json: PNG_B64 }] } })],
  ['output.results[].url', () => ({ id: 'tsk_img_1', status: 'completed', output: { results: [{ url: up.img('a5-output') }] } })],
  ['result.url', () => ({ id: 'tsk_img_1', status: 'completed', result: { url: up.img('a5-result') } })],
  ['顶层 url', () => ({ id: 'tsk_img_1', status: 'completed', url: up.img('a5-top') })],
  ['data.url', () => ({ id: 'tsk_img_1', status: 'completed', data: { status: 'completed', url: up.img('a5-data') } })],
];
A5_CASES.forEach(([where, body], i) => {
  test(`A5-${i + 1} 取图位置 ${where} → done 且图落盘`, async () => {
    const base = taskScenario(`/a5-${i + 1}/v1`, { polls: body });
    const e = await runJob(base);
    expect(e.status, show(e)).toBe('done');
    expect(sizeOf(filesOf(e)[0]), show(e)).toBe(PNG.length);
  });
});

// ───────────────────────── A6 防误判 ─────────────────────────
test('A6-1 提交直接回同步形态 {created,data[].url} → done,且假上游没有收到任何 GET 轮询', async () => {
  const base = up.scenario('/a6a/v1', ({ method, path: p }) => {
    if (method === 'POST' && p === '/images/generations') return { body: { created: 1, data: [{ url: up.img('a6') }] } };
    // 万一被当任务去轮询,这里也回"完成",让错误行为快速跑完、被下面的断言抓住
    if (method === 'GET') return { body: { id: 'x', status: 'completed', result: { data: [{ url: up.img('a6') }] } } };
    return null;
  });
  const e = await runJob(base);
  expect(e.status, show(e)).toBe('done');
  const got = await up.received('/a6a/v1');
  expect(got.filter((r) => r.method === 'GET').map((r) => r.path), '同步响应不得触发轮询').toEqual([]);
});

test('A6-2 提交回 {id:"x",object:"list",data:[]}(有 id 但不像任务)→ error,且不轮询', async () => {
  const base = up.scenario('/a6b/v1', ({ method, path: p }) => {
    if (method === 'POST' && p === '/images/generations') return { body: { id: 'x', object: 'list', data: [] } };
    if (method === 'GET') return { body: { id: 'x', status: 'completed', result: { data: [{ url: up.img('a6b') }] } } };
    return null;
  });
  const e = await runJob(base);
  expect(e.status, show(e)).toBe('error');
  const got = await up.received('/a6b/v1');
  expect(got.filter((r) => r.method === 'GET').map((r) => r.path), '不像任务的响应不得被当任务去轮询').toEqual([]);
});

// ───────────────────────── A7 既有 APImart 形态零回归 ─────────────────────────
test('A7 APImart 形态(mj 协议,夹具原件):照常 done、4 张全落盘,轮询地址仍是 {base}/tasks/{id}', async () => {
  // 夹具原件里的 4 个图片链接指向公网,这里只把链接换成本机假图片(不联外网),其余字节不动。
  const result = JSON.parse(JSON.stringify(MJ_RESULT));
  result.data.result.images[0].url = [0, 1, 2, 3].map((i) => up.img(`a7-${i}`));
  const base = up.scenario('/a7/v1', ({ method, path: p }) => {
    if (method === 'POST' && p === '/midjourney/generations') return { body: MJ_SUBMIT };
    if (method === 'GET' && p === `/tasks/${MJ_TASK_ID}`) return { body: result };
    return null;
  });
  const e = await runJob(base, { protocol: 'mj', model: 'midjourney', size: '16:9' });
  expect(e.status, show(e)).toBe('done');
  expect(filesOf(e), show(e)).toHaveLength(4);
  for (const f of filesOf(e)) expect(sizeOf(f)).toBe(PNG.length);
  const got = await up.received('/a7/v1');
  expect(gets(got, `/a7/v1/tasks/${MJ_TASK_ID}`).length, '轮询地址仍应是 {base}/tasks/{id}').toBeGreaterThanOrEqual(1);
  expect(gets(got, `/a7/v1/midjourney/generations/${MJ_TASK_ID}`).map((r) => r.path), '不得改用"提交地址 + /{id}"去轮询 APImart').toEqual([]);
});

// ───────────────────────── A8 既有同步三协议 ─────────────────────────
test('A8-1 openai 同步:{data[].b64_json} → done,落 .png 一张', async () => {
  const base = up.scenario('/a8a/v1', ({ method, path: p }) => (method === 'POST' && p === '/images/generations' ? { body: { created: 1, data: [{ b64_json: PNG_B64 }] } } : null));
  const e = await runJob(base);
  expect(e.status, show(e)).toBe('done');
  expect(filesOf(e)[0]).toMatch(/\.png$/);
  expect(sizeOf(filesOf(e)[0])).toBe(PNG.length);
});

test('A8-2 gemini 同步:candidates[].content.parts[].inlineData → done', async () => {
  const base = up.scenario('/a8b/v1', ({ method, path: p }) => (method === 'POST' && p === '/models/m:generateContent'
    ? { body: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] } } : null));
  const e = await runJob(base, { protocol: 'gemini' });
  expect(e.status, show(e)).toBe('done');
  expect(sizeOf(filesOf(e)[0])).toBe(PNG.length);
});

test('A8-3 chat 同步:choices[0].message.content 里的 markdown 图片链接 → done', async () => {
  const base = up.scenario('/a8c/v1', ({ method, path: p }) => (method === 'POST' && p === '/chat/completions'
    ? { body: { choices: [{ message: { content: `![img](${up.img('a8c')})` } }] } } : null));
  const e = await runJob(base, { protocol: 'chat' });
  expect(e.status, show(e)).toBe('done');
  expect(sizeOf(filesOf(e)[0])).toBe(PNG.length);
});
