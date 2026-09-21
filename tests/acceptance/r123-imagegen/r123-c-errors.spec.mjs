// r123 · C 组:报错分层(INTERFACE-r123 §C)——失败条目的 errorInfo 结构、分类判据、界面展示、脱敏。
// 依据只有 .devflow/BRIEF-r123.md 与 .devflow/INTERFACE-r123.md;没看实现代码。
import { test, expect } from '@playwright/test';
import { createProvider, generate, waitTerminal, newSaveDir, cancelIfRunning, listProviders, history, containsText, FAKE_KEY } from './helpers/api.mjs';
import { createFakeUpstream } from './helpers/fake-upstream.mjs';
import { unlistenedPort } from './helpers/ports.mjs';
import { boot, openImagePanel, openTaskList, imagePanel, textOf } from './helpers/ui.mjs';

const KINDS = ['base-url', 'auth', 'balance', 'rate-limit', 'moderation', 'task-failed', 'timeout', 'no-image', 'network', 'other'];
const BODY_MARK = 'R123-BODY-MARK-7f3a';
const LONG_HTML = `<!doctype html><html><head><title>New API</title></head><body><div id="app">${BODY_MARK} ${'网站首页 '.repeat(120)}</div></body></html>`;

let up;
test.beforeAll(async () => { up = createFakeUpstream(); await up.listen(); });
test.afterAll(async () => { await up?.close(); });
const jobs = [];
test.afterEach(async () => { while (jobs.length) await cancelIfRunning(jobs.pop()); });
const show = (e) => JSON.stringify(e);

async function failWith(baseURL, overrides = {}, prompt) {
  const p = await createProvider({ baseURL, savePath: newSaveDir('c'), ...overrides });
  const jobId = await generate(p.id, prompt);
  jobs.push(jobId);
  const e = await waitTerminal(jobId, 30_000);
  expect(e, `历史里应能找到任务 ${jobId}`).toBeTruthy();
  expect(e.status, show(e)).toBe('error');
  return e;
}
/** 只对 POST /images/generations 回固定响应的脚本。 */
const onGenerate = (prefix, out) => up.scenario(prefix, ({ method, path: p }) => (method === 'POST' && p === '/images/generations' ? out : null));
/** 任务失败脚本(带任务号)。 */
const failedTask = (prefix) => up.scenario(prefix, ({ method, path: p }) => {
  if (method === 'POST' && p === '/images/generations') return { body: { id: 'tsk_img_1', object: 'generation.task', status: 'queued' } };
  if (method === 'GET' && p === '/images/generations/tsk_img_1') return { body: { id: 'tsk_img_1', status: 'failed', error: { message: 'render exploded' } } };
  return null;
});

// ───────────────────────── C1 字段形状 ─────────────────────────
test('C1-1 失败条目除 error 外有 errorInfo={kind,summary,action,detail}:kind 在枚举内、summary/action 非空、error 以 summary 开头', async () => {
  const e = await failWith(up.scenario('/c1a', () => ({ status: 200, type: 'text/html; charset=utf-8', body: LONG_HTML })));
  const info = e.errorInfo;
  expect(info, show(e)).toBeTruthy();
  expect(KINDS, `kind=${info?.kind}`).toContain(info.kind);
  expect(typeof info.summary === 'string' && info.summary.length > 0, `summary=${show(info.summary)}`).toBe(true);
  expect(typeof info.action === 'string' && info.action.length > 0, `action=${show(info.action)}`).toBe(true);
  expect(info.detail && typeof info.detail === 'object', `detail=${show(info.detail)}`).toBe(true);
  expect(typeof e.error, 'error 字符串保留').toBe('string');
  expect(e.error.startsWith(info.summary), `error 应以 summary 开头:error=${show(e.error)} summary=${show(info.summary)}`).toBe(true);
});

test('C1-2 detail.url 是最终请求地址、detail.status 是 HTTP 状态、detail.contentType 是上游 content-type', async () => {
  const base = onGenerate('/c1b', { status: 401, type: 'application/json', body: { error: { message: `bad key ${BODY_MARK}` } } });
  const e = await failWith(base);
  const d = e.errorInfo?.detail;
  expect(d, show(e)).toBeTruthy();
  expect(d.url).toBe(`${base}/images/generations`);
  expect(d.status).toBe(401);
  expect(String(d.contentType || '')).toContain('application/json');
});

test('C1-3 detail.bodyHead 是上游正文前缀且不超过 300 字', async () => {
  const e = await failWith(up.scenario('/c1c', () => ({ status: 200, type: 'text/html; charset=utf-8', body: LONG_HTML })));
  const head = e.errorInfo?.detail?.bodyHead;
  expect(typeof head, show(e.errorInfo)).toBe('string');
  expect(head.length).toBeGreaterThan(0);
  expect(head.length).toBeLessThanOrEqual(300);
  expect(LONG_HTML.startsWith(head), `bodyHead 应是正文前缀:${show(head)}`).toBe(true);
});

test('C1-4 任务失败时 detail.taskId 给出任务号', async () => {
  const e = await failWith(failedTask('/c1d/v1'));
  expect(e.errorInfo?.detail?.taskId, show(e)).toBe('tsk_img_1');
});

// ───────────────────────── C2 分类判据 ─────────────────────────
const C2 = [
  ['C2-1 HTML 网页响应', () => up.scenario('/c2-1', () => ({ status: 200, type: 'text/html', body: LONG_HTML })), 'base-url', 200],
  ['C2-2 /v1/v1 404 Invalid URL', () => onGenerate('/c2-2/v1/v1', { status: 404, body: { error: { message: 'Invalid URL (POST /v1/v1/images/generations)' } } }), 'base-url', 404],
  ['C2-3 HTTP 401', () => onGenerate('/c2-3', { status: 401, body: { error: { message: 'Incorrect API key provided' } } }), 'auth', 401],
  ['C2-4 HTTP 403', () => onGenerate('/c2-4', { status: 403, body: { error: { message: 'forbidden' } } }), 'auth', 403],
  ['C2-5 HTTP 402', () => onGenerate('/c2-5', { status: 402, body: { error: { message: 'payment required' } } }), 'balance', 402],
  ['C2-6 正文含 insufficient', () => onGenerate('/c2-6', { status: 400, body: { error: { message: 'insufficient balance for this request' } } }), 'balance', 400],
  ['C2-7 正文含 quota', () => onGenerate('/c2-7', { status: 400, body: { error: { message: 'You exceeded your current quota' } } }), 'balance', 400],
  ['C2-8 HTTP 429', () => onGenerate('/c2-8', { status: 429, body: { error: { message: 'Too many requests' } } }), 'rate-limit', 429],
  ['C2-9 正文含 content_policy', () => onGenerate('/c2-9', { status: 400, body: { error: { code: 'content_policy_violation', message: 'Your request was rejected' } } }), 'moderation', 400],
  ['C2-10 正文含「敏感」', () => onGenerate('/c2-10', { status: 400, body: { error: { message: '提示词包含敏感内容,已拦截' } } }), 'moderation', 400],
  ['C2-11 任务终态 failed', () => failedTask('/c2-11/v1'), 'task-failed', 200],
  ['C2-13 成功响应但没取到图', () => onGenerate('/c2-13', { status: 200, body: { created: 1, data: [] } }), 'no-image', 200],
  ['C2-15 其余(500 内部错误)', () => onGenerate('/c2-15', { status: 500, body: { error: { message: 'internal server error' } } }), 'other', 500],
];
for (const [title, mk, kind, status] of C2) {
  test(`${title} → errorInfo.kind = ${kind},detail.status = ${status}`, async () => {
    const e = await failWith(mk());
    expect(e.errorInfo?.kind, show(e)).toBe(kind);
    expect(e.errorInfo?.detail?.status, show(e.errorInfo)).toBe(status);
  });
}

test('C2-12 轮询超时 → timeout', async () => {
  test.skip(true, 'INTERFACE 只给了轮询间隔的调短口,没有总超时的调短口;默认超时按分钟算,验收里等不起 —— 未覆盖,见报告');
});

test('C2-14 连接被拒(回环上没人听的端口)→ network,detail.status 为 null', async () => {
  const port = await unlistenedPort();
  const e = await failWith(`http://127.0.0.1:${port}/v1`);
  expect(e.errorInfo?.kind, show(e)).toBe('network');
  expect(e.errorInfo?.detail?.status, show(e.errorInfo)).toBeNull();
});

// ───────────────────────── C4 脱敏 ─────────────────────────
test('C4-1 上游把 key 回显在 401 正文里:条目所有字段(含 bodyHead)都不出现 key,提供方回显也不含;而上游确实收到了 Bearer key', async () => {
  const base = onGenerate('/c4a', { status: 401, body: { error: { message: `Invalid API key: ${FAKE_KEY}` } } });
  const e = await failWith(base);
  const got = await up.received('/c4a');
  expect(got[0]?.auth, '自证:上游确实收到了这把 key(脱敏断言才有意义)').toBe(`Bearer ${FAKE_KEY}`);
  expect(containsText(e, FAKE_KEY), `条目里不得出现 key:${show(e)}`).toBe(false);
  expect(containsText(await listProviders(), FAKE_KEY), '提供方列表回显里不得出现 key').toBe(false);
});

test('C4-2 上游把 key 回显在网页正文里:条目所有字段都不出现 key,整份历史里也没有', async () => {
  const e = await failWith(up.scenario('/c4b', () => ({ status: 200, type: 'text/html', body: `<!doctype html><html><body><p>debug key=${FAKE_KEY}</p></body></html>` })));
  expect(containsText(e, FAKE_KEY), `条目里不得出现 key:${show(e)}`).toBe(false);
  expect(containsText(await history(), FAKE_KEY), '整份历史里不得出现 key').toBe(false);
});

// ───────────────────────── C3 界面 ─────────────────────────
test.describe('C3 界面上的失败条目', () => {
  test.skip(!process.env.R123_UI_BASE, '没有 dev server(R123_API_ONLY=1)');

  /** 在「任务列表」里找到带 mark 的那条(最内层同时罩住 mark 与诊断详情的容器)。 */
  async function openEntry(page, mark) {
    await boot(page); await openImagePanel(page); await openTaskList(page);
    await expect(imagePanel(page).getByText(mark).first(), `任务列表里应能看到提示词 ${mark}`).toBeVisible({ timeout: 15_000 });
    const entry = imagePanel(page).locator('li, article, div').filter({ hasText: mark }).filter({ has: page.locator('[data-testid="image-error-detail"]') }).last();
    await expect(entry, '失败条目里应有 [data-testid="image-error-detail"]').toHaveCount(1);
    return entry;
  }
  /** 展开诊断详情:<details> 点 summary;否则点带「详情/诊断」字样的按钮;再不行点它自己。 */
  async function expandDetail(entry) {
    const detail = entry.locator('[data-testid="image-error-detail"]').first();
    const summary = detail.locator('summary').first();
    if (await summary.count()) { await summary.click(); return; }
    const toggle = entry.getByRole('button', { name: /诊断|详情|展开/ }).first();
    if (await toggle.count()) { await toggle.click(); return; }
    await detail.click();
  }

  test('C3-1 失败条目显示 summary 与 action;诊断详情默认收起(请求地址不可见)', async ({ page }) => {
    const mark = `R123C3A-${Date.now().toString(36)}`;
    const base = onGenerate('/c3a', { status: 401, body: { error: { message: `Incorrect API key ${BODY_MARK}` } } });
    const e = await failWith(base, {}, mark);
    const entry = await openEntry(page, mark);
    const text = await textOf(entry);
    expect(text, '应显示人话原因 summary').toContain(e.errorInfo.summary);
    expect(text, '应显示建议动作 action').toContain(e.errorInfo.action);
    await expect(entry.getByText(`${base}/images/generations`).first(), '诊断详情默认收起:请求地址不该直接可见').toBeHidden();
  });

  test('C3-2 展开诊断详情后能看到 detail.url、HTTP 状态与 bodyHead', async ({ page }) => {
    const mark = `R123C3B-${Date.now().toString(36)}`;
    const base = onGenerate('/c3b', { status: 429, body: { error: { message: `Too many requests ${BODY_MARK}` } } });
    await failWith(base, {}, mark);
    const entry = await openEntry(page, mark);
    await expandDetail(entry);
    await expect(entry.getByText(`${base}/images/generations`).first(), '展开后应看到最终请求地址').toBeVisible();
    await expect(entry.getByText(/429/).first(), '展开后应看到 HTTP 状态').toBeVisible();
    await expect(entry.getByText(BODY_MARK).first(), '展开后应看到上游正文片段').toBeVisible();
  });

  test('C3-3 有任务号时显示任务号与「复制」按钮', async ({ page }) => {
    const mark = `R123C3C-${Date.now().toString(36)}`;
    await failWith(failedTask('/c3c/v1'), {}, mark);
    const entry = await openEntry(page, mark);
    await expandDetail(entry);
    await expect(entry.getByText('tsk_img_1').first(), '应显示任务号').toBeVisible();
    await expect(entry.getByRole('button', { name: /复制/ }).first(), '任务号旁应有「复制」按钮').toBeVisible();
  });

  test('C3-4【脱敏】失败条目展开诊断详情后,面板文字里也不出现 key', async ({ page }) => {
    const mark = `R123C3D-${Date.now().toString(36)}`;
    await failWith(onGenerate('/c3d', { status: 401, body: { error: { message: `Invalid API key: ${FAKE_KEY}` } } }), {}, mark);
    const entry = await openEntry(page, mark);
    await expandDetail(entry);
    await page.waitForTimeout(300);
    expect(await textOf(imagePanel(page))).not.toContain(FAKE_KEY);
  });
});
