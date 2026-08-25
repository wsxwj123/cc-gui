#!/usr/bin/env node
// 单测:r51 生图任务化(POST /api/image/generate 秒回 jobId)+ 历史落盘 100 条
// + GET /api/image/history + 启动清障(遗留 running → interrupted)+ 前端恢复/自适应/放大。
// Run: node tests/unit/check-r51-image-jobs.mjs
//
// 核心牙:
//  ①「立即返回」—— 上游慢 3s,POST 必须 <1s 回 jobId(长连接是 "Load failed" 的成因,
//    WKWebView 对 fetch 有约 60s 资源超时,服务端却等到 120s)。
//  ② 历史上限 100 条(裁尾),否则文件无界增长。
//  ③ 启动清障:上次进程留下的 running 条目必须变 interrupted,不留僵尸"生成中"。
//  ④ 安全链路(SSRF 同源豁免 / redirect:manual / redactKey / readCapped / 体积闸)
//    只许整体搬进 runner,锚点数量不许变;失败 job 的 error 必须经 redactKey。
//
// 隔离:HOME/USERPROFILE 指向 mktemp 目录(真实 ~/.claude-gui 一个字节不碰);
// 上游全是本机假服务(6703 / 6704),绝不打真实网络。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须在 import 路由前改 HOME:真实 HOME 下的用户数据只读不写(红线)。
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-r51-home-'));
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'cgui-r51-save-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
mkdirSync(join(TMP_HOME, '.claude-gui'), { recursive: true });
const HISTORY_FILE = join(TMP_HOME, '.claude-gui', 'image-history.json');

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = 'sk-r51-stored-secret-abcdef123456';
// 1x1 png
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const express = (await import('express')).default;
const imageRouter = (await import('../../server/routes/image.js')).default;

const app = express();
app.use(express.json({ limit: '2mb' }));
// 慢上游:3s 后才回图 —— 用来钉死"POST 立即返回,不等上游"。
app.post('/slow/v1/images/generations', (_req, res) => {
  setTimeout(() => res.json({ data: [{ b64_json: PNG_B64 }] }), 3000);
});
// 中速上游:1s —— 与 3s 的慢上游并存,用来钉死"先完成的先 done,互不影响"。
app.post('/mid/v1/images/generations', (_req, res) => {
  setTimeout(() => res.json({ data: [{ b64_json: PNG_B64 }] }), 1000);
});
app.post('/fast/v1/images/generations', (_req, res) => res.json({ data: [{ b64_json: PNG_B64 }] }));
// 把密钥回显进错误正文的上游:失败 job 的 error 存进历史前必须过 redactKey。
app.post('/leak/v1/images/generations', (req, res) => res.status(401)
  .json({ error: { message: `invalid key ${req.headers.authorization}` } }));
app.use('/api', imageRouter);

// 端口只许 6703/6704,但隔壁分支的 E2E 也在用 → EADDRINUSE 退让重试,不当假失败。
async function listenWithRetry(port, tries = 40, make = (p) => app.listen(p, '127.0.0.1')) {
  for (let i = 0; i < tries; i++) {
    const s = make(port);
    const r = await new Promise((resolve) => {
      s.once('listening', () => resolve({ ok: true }));
      s.once('error', (e) => resolve({ ok: false, err: e }));
    });
    if (r.ok) return s;
    if (r.err?.code !== 'EADDRINUSE') throw r.err;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`端口 ${port} 持续被占用(隔壁 worktree 的 E2E?),重试 ${tries} 次后放弃`);
}
const server = await listenWithRetry(6703);
const BASE = 'http://127.0.0.1:6703';
const api = async (method, path, body, base = BASE) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
};
const mkProvider = async (name, path) => {
  const r = await api('POST', '/api/image-providers', {
    name, protocol: 'openai', baseURL: `${BASE}${path}`, apiKey: KEY, model: 'm', savePath: SAVE_DIR,
  });
  assert.equal(r.status, 200, `建 provider ${name}(${r.text})`);
  return r.json.id;
};
const waitFor = async (fn, ms = 12000, step = 200) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, step));
  }
};
const historyOf = async (id, base = BASE) => {
  const r = await api('GET', '/api/image/history', null, base);
  assert.equal(r.status, 200, `t: GET /image/history 必须存在(${r.status} ${r.text.slice(0, 120)})`);
  const list = r.json?.history || [];
  return { list, text: r.text, entry: id ? list.find((e) => e.id === id) : null };
};

let failure = null;
let restartServer = null;
try {
  // ───────────── 1. 立即返回 + 后台跑完 ─────────────
  {
    const pid = await mkProvider('慢上游', '/slow/v1');
    const t0 = Date.now();
    const r = await api('POST', '/api/image/generate', { providerId: pid, prompt: '一只慢吞吞的猫' });
    const took = Date.now() - t0;
    assert.equal(r.status, 200, `t1: 生成请求受理(${r.text})`);
    assert.ok(r.json?.jobId, `t1: 立即返回 jobId(实际:${r.text})`);
    assert.ok(!('file' in (r.json || {})), 't1: 不再是同步形态(响应体不带 file)');
    assert.ok(took < 1000, `t1【立即返回】:上游要 3s,POST 必须 <1s 返回(实际 ${took}ms)`);

    const { entry } = await historyOf(r.json.jobId);
    assert.ok(entry, 't1: 历史里立刻有该条目');
    assert.equal(entry.status, 'running', 't1: 此刻状态为 running');
    assert.equal(entry.prompt, '一只慢吞吞的猫', 't1: 条目记下提示词(供「恢复」用)');

    const done = await waitFor(async () => {
      const h = await historyOf(r.json.jobId);
      return h.entry && h.entry.status !== 'running' ? h : null;
    });
    assert.ok(done, 't1: 后台任务应在 12s 内落终态');
    assert.equal(done.entry.status, 'done', `t1: 后台跑完写 done(实际:${JSON.stringify(done.entry)})`);
    assert.ok(done.entry.file && existsSync(done.entry.file), 't1: 图片已落盘且条目记下路径');
    assert.ok(done.entry.previewUrl?.includes('/api/image/preview'), 't1: 条目带 previewUrl');
    assert.equal(typeof done.entry.tookMs, 'number', 't1: 条目记下耗时');
    assert.ok(!done.text.includes(KEY), 't1: 历史响应不含 apiKey');
    assert.ok(existsSync(HISTORY_FILE), 't1: 历史落盘到 ~/.claude-gui/image-history.json');
  }

  // ───────────── 1b. 并行多任务 + 并发上限 3(第 4 个 429) ─────────────
  {
    const slowId = await mkProvider('慢上游(并行)', '/slow/v1'); // 3s
    const midId = await mkProvider('中速上游', '/mid/v1'); // 1s
    const post = async (pid, prompt) => api('POST', '/api/image/generate', { providerId: pid, prompt });
    const j1 = await post(slowId, '并行-慢');
    const j2 = await post(midId, '并行-中1');
    const j3 = await post(midId, '并行-中2');
    for (const [i, j] of [j1, j2, j3].entries()) assert.ok(j.json?.jobId, `t1b: 第 ${i + 1} 个任务受理(${j.text})`);

    const { list } = await historyOf();
    const runningIds = list.filter((e) => e.status === 'running').map((e) => e.id);
    for (const j of [j1, j2, j3]) assert.ok(runningIds.includes(j.json.jobId), 't1b: 三个任务各自 running 共存');

    const j4 = await post(midId, '并行-第四个');
    assert.equal(j4.status, 429, `t1b【并发上限】:已有 3 个 running 时第 4 个必须 429(实际 ${j4.status} ${j4.text})`);
    assert.match(j4.json?.error || '', /上限/, 't1b: 429 给出可行动文案');
    assert.ok(!(await historyOf()).list.some((e) => e.prompt === '并行-第四个'), 't1b: 被拒的请求不写历史条目');

    // 先完先 done:中速(1s)先落 done,慢的(3s)还在 running,互不影响
    const mid1 = await waitFor(async () => {
      const cur = await historyOf(j2.json.jobId);
      return cur.entry && cur.entry.status !== 'running' ? cur : null;
    });
    assert.equal(mid1.entry.status, 'done', 't1b: 先完成的任务先落 done');
    assert.equal(mid1.list.find((e) => e.id === j1.json.jobId).status, 'running', 't1b: 慢任务不受影响,仍在跑');

    // 名额归还:两个中速任务完事后,还没跑完的只剩 1 个 → 又能发新任务了
    await waitFor(async () => (await historyOf(j3.json.jobId)).entry?.status !== 'running');
    const j5 = await post(midId, '并行-名额归还');
    assert.equal(j5.status, 200, `t1b: 任务结束要归还并发名额(实际 ${j5.status} ${j5.text})`);
    for (const j of [j1, j5]) {
      await waitFor(async () => (await historyOf(j.json.jobId)).entry?.status !== 'running');
    }
  }

  // ───────────── 2. 历史上限 100 条(裁尾) ─────────────
  {
    const old = Array.from({ length: 100 }, (_, i) => ({
      id: `old-${i}`, prompt: `旧提示词 ${i}`, status: 'done', startedAt: 1, file: '', previewUrl: '',
    }));
    writeFileSync(HISTORY_FILE, JSON.stringify(old, null, 2));
    const pid = await mkProvider('快上游', '/fast/v1');
    const r = await api('POST', '/api/image/generate', { providerId: pid, prompt: '第 101 条' });
    assert.ok(r.json?.jobId, `t2: 受理(${r.text})`);
    // 判据落在【文件】上:读端也按 limit 切,只看响应会把"写盘不裁尾"放过去(文件无界长)。
    const onDisk = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
    assert.equal(onDisk.length, 100, `t2【上限】:写第 101 条后文件里仍是 100 条(实际 ${onDisk.length})`);
    assert.equal(onDisk[0].id, r.json.jobId, 't2: 新条目在首位');
    assert.ok(!onDisk.some((e) => e.id === 'old-99'), 't2: 最旧的一条被裁掉');
    const { list } = await historyOf();
    assert.equal(list.length, 100, `t2: 响应同样是 100 条(实际 ${list.length})`);
    await waitFor(async () => (await historyOf(r.json.jobId)).entry?.status !== 'running');
  }

  // ───────────── 3. 失败 job:error 落历史且经 redactKey ─────────────
  {
    const pid = await mkProvider('回显密钥的上游', '/leak/v1');
    const r = await api('POST', '/api/image/generate', { providerId: pid, prompt: '会失败的图' });
    assert.ok(r.json?.jobId, `t3: 受理(${r.text})`);
    const h = await waitFor(async () => {
      const cur = await historyOf(r.json.jobId);
      return cur.entry && cur.entry.status !== 'running' ? cur : null;
    });
    assert.ok(h, 't3: 失败任务也要落终态');
    assert.equal(h.entry.status, 'error', 't3: 上游 401 → 条目 status:error');
    assert.ok(h.entry.error, 't3: 条目带错误文案');
    assert.ok(!h.text.includes(KEY), `t3【redact】:历史里不许有明文 key(实际:${h.entry.error})`);
    assert.ok(h.entry.error.includes('***'), 't3: 剥掉后留掩码(证明确实经过 redactKey)');
  }

  // ───────────── 4. 前置校验仍同步报错(不进后台) ─────────────
  {
    const ghost = await api('POST', '/api/image/generate', { providerId: 'no-such', prompt: 'x' });
    assert.equal(ghost.status, 404, 't4: provider 不存在 → 同步 404,不生成任务');
    const pid = await mkProvider('空提示词', '/fast/v1');
    const empty = await api('POST', '/api/image/generate', { providerId: pid, prompt: '   ' });
    assert.equal(empty.status, 400, `t4: 提示词为空 → 同步 400(${empty.text})`);
    const { list } = await historyOf();
    assert.ok(!list.some((e) => e.prompt === '   '), 't4: 校验失败不写历史条目');
  }

  // ───────────── 5. 启动清障:遗留 running → interrupted ─────────────
  {
    writeFileSync(HISTORY_FILE, JSON.stringify([
      { id: 'zombie', prompt: '上次没跑完', status: 'running', startedAt: 1 },
      { id: 'okay', prompt: '上次跑完了', status: 'done', startedAt: 1, file: '/x.png' },
    ], null, 2));
    // 重新 import(查询串绕开模块缓存)= 模拟重启:新进程的首次读历史必须清障。
    const freshRouter = (await import('../../server/routes/image.js?r51-restart')).default;
    const app2 = express();
    app2.use(express.json());
    app2.use('/api', freshRouter);
    restartServer = await listenWithRetry(6704, 40, (p) => app2.listen(p, '127.0.0.1'));
    const { list } = await historyOf(null, 'http://127.0.0.1:6704');
    const zombie = list.find((e) => e.id === 'zombie');
    assert.ok(zombie, 't5: 条目还在');
    assert.equal(zombie.status, 'interrupted', 't5【清障】:重启后遗留 running 必须变 interrupted');
    assert.equal(zombie.error, '应用重启，生成中断', 't5: 清障文案如实告知');
    assert.equal(list.find((e) => e.id === 'okay').status, 'done', 't5: 终态条目不动');
    const onDisk = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
    assert.equal(onDisk.find((e) => e.id === 'zombie').status, 'interrupted', 't5: 清障结果落盘(不是只在响应里改)');
  }
} catch (e) {
  failure = e;
} finally {
  for (const s of [server, restartServer]) {
    if (!s) continue;
    s.closeAllConnections?.();
    s.close();
    await new Promise((r) => s.once('close', r));
  }
  for (const d of [TMP_HOME, SAVE_DIR]) rmSync(d, { recursive: true, force: true });
}
if (failure) throw failure;

// ───────────── 6. 服务端源码:安全链路整体搬进 runner,锚点不许少 ─────────────
{
  const src = readFileSync(join(REPO, 'server/routes/image.js'), 'utf8');
  const count = (s, re) => (s.match(re) || []).length;
  // 全文件基线(r51 之前实测值):安全锚点只许搬位置,不许被删被弱化。
  assert.equal(count(src, /await assertPublicBaseURL\(/g), 4, 't6: assertPublicBaseURL 调用点数量不变(校验/拉模型/前置/下载复检)');
  assert.equal(count(src, /redirect: 'manual'/g), 3, "t6: redirect:'manual' 出现次数不变");
  assert.equal(count(src, /readCapped\(/g), 4, 't6: readCapped 出现次数不变');
  assert.ok(count(src, /redactKey\(/g) >= 7, 't6: redactKey 不少于原有 7 处(runner 顶层 catch 可再加)');

  const start = src.indexOf('async function runImageJob');
  assert.ok(start > 0, 't6: 生成主体已抽成 runImageJob(异步任务)');
  const end = src.indexOf("router.post('/image/generate'", start);
  assert.ok(end > start, 't6: 能定位 runner 源码块(runner 在路由之前)');
  const runner = src.slice(start, end);
  assert.equal(count(runner, /redirect: 'manual'/g), 2, "t6: runner 内两处 redirect:'manual'(生成 POST + 下载图片)");
  assert.equal(count(runner, /status >= 300 && [a-z]+\.status < 400/g), 2, 't6: runner 内两处 3xx 拒绝');
  assert.match(runner, /allowLoopback: sameOrigin/, 't6: 同源回环豁免仍在 runner 内');
  assert.equal(count(runner, /await assertPublicBaseURL\(/g), 1, 't6: 下载链接的 SSRF 复检仍在 runner 内');
  assert.equal(count(runner, /readCapped\(/g), 2, 't6: 错误分支与成功分支的限量读都在 runner 内');
  assert.ok(count(runner, /redactKey\(/g) >= 5, 't6: runner 内各处透传仍过 redactKey');
  assert.match(runner, /MAX_RESPONSE_BYTES/, 't6: 响应体积闸在 runner 内');
  assert.match(runner, /MAX_IMAGE_BYTES/, 't6: 图片体积闸在 runner 内');
  assert.match(runner, /Content-Type: \$\{ct/, 't6: 下载分支只认 Content-Type 的判据仍在');

  assert.match(src, /MAX_CONCURRENT_JOBS = 3/, 't6: 并发上限 3 放在常量里(便于调整)');
  assert.match(src, /activeJobs >= MAX_CONCURRENT_JOBS[\s\S]{0,200}429/, 't6: 超过上限的提交返回 429');
  assert.match(src, /finally \{\n\s*activeJobs -= 1;/, 't6: 任务结束必归还名额(finally,不是只在成功分支)');
  assert.match(src, /image-history\.json/, 't6: 历史文件落 ~/.claude-gui/image-history.json');
  assert.match(src, /slice\(0, MAX_HISTORY\)/, 't6: 写盘处按上限裁尾');
  assert.match(src, /'\/image\/history'/, 't6: GET /image/history 端点在位');
}

// ───────────── 7. 前端源码:草稿 / 轮询 / 恢复 / 自适应高度 / 放大 ─────────────
{
  const src = readFileSync(join(REPO, 'client/src/components/ImagePanel.jsx'), 'utf8');
  assert.match(src, /cgui-image-prompt-draft/, 't7: 提示词草稿键在位');
  assert.match(src, /localStorage\.setItem\(PROMPT_DRAFT_KEY/, 't7: 输入即写草稿');
  assert.match(src, /localStorage\.getItem\(PROMPT_DRAFT_KEY/, 't7: 挂载时恢复草稿');
  assert.ok(!/setPrompt\(''\)|setPromptDraft\(''\)/.test(src), 't7: 生成成功不清空提示词(用户要求保留)');
  assert.match(src, /\/api\/image\/history/, 't7: 读持久化历史');
  assert.match(src, /clearInterval/, 't7: 卸载/终态时清轮询 interval(只停轮询,不停后台任务)');
  assert.match(src, /jobId/, 't7: 生成走 jobId 形态');
  assert.match(src, /恢复/, 't7:「恢复」按钮在位');
  assert.match(src, /onClick=\{\(\) => setPromptDraft\(h\.prompt/, 't7:「恢复」把该条提示词填回输入框(并同步草稿)');
  assert.match(src, /应用重启|interrupted/, 't7: interrupted 条目如实显示');
  // 并行:生成按钮不因已有任务在跑而禁用(只挡请求发出那一瞬的双击)
  const canGenLine = src.split('\n').find((l) => l.includes('const canGenerate ='));
  assert.ok(canGenLine, 't7: 找得到 canGenerate 定义');
  assert.match(canGenLine, /!submitting/, 't7: 只用 submitting 防双击');
  assert.ok(!/hasRunning|\bbusy\b/.test(canGenLine), `t7:「生成」不许被"有任务在跑"禁用(实际:${canGenLine.trim()})`);
  // 双 tab + 任务图块
  assert.match(src, /'生图'/, 't7:「生图」tab 在位');
  assert.match(src, /任务列表/, 't7:「任务列表」tab 在位');
  assert.match(src, /useState\('gen'\)/, 't7: tab 是前端局部态(默认停在生图页)');
  assert.match(src, /生成中 · \$\{elapsedSec\(h\)\}s/, 't7: running 图块显示已耗时');
  assert.match(src, /animate-spin[\s\S]{0,200}elapsedSec/, 't7: running 图块转圈在位');
  assert.match(src, /text-error[^>]*>\{h\.error/, 't7: error/interrupted 的报错文字渲染在图块内部');
  // 「在文件夹中显示」:平台中性文案 + 复用既有 reveal 端点
  assert.match(src, /在文件夹中显示/, 't7: reveal 按钮用平台中性文案');
  assert.ok(!src.includes('在访达中显示'), 't7: 不写死 macOS 措辞');
  assert.match(src, /reveal\(h\.file\)/, 't7: 任务条目可在文件夹中显示');
  assert.match(src, /\/api\/image\/reveal/, 't7: 复用既有 reveal 端点');
  // 网格 / 列表视图切换,选择存 localStorage
  assert.match(src, /cgui-image-tasklist-view/, 't7: 视图选择的 localStorage 键在位');
  assert.match(src, /\['grid', '网格'\], \['list', '列表'\]/, 't7: 网格/列表切换钮在位');
  assert.match(src, /localStorage\.setItem\(TASK_VIEW_KEY/, 't7: 切换后写盘(重开保留)');
  assert.match(src, /taskView === 'grid' \? 'grid grid-cols-2/, 't7: 网格式一行两块');
  // 预览区不再显示提示词全文
  assert.ok(!/>\{current\.prompt\}</.test(src), 't7: 预览区去掉提示词全文行(长提示词顶爆界面)');
  // 自适应高度:截断式调高 + 依赖 prompt 的 effect(挂载恢复草稿、点「恢复」回填都会跑到)
  assert.match(src, /Math\.min\(el\.scrollHeight, 240\)/, 't7: 提示词框按内容调高,上限 240px');
  assert.match(src, /el\.style\.height = 'auto'/, 't7: 调高前先归零(否则只增不减)');
  assert.match(src, /useEffect\(\(\) => \{ fitPrompt\(\); \}, \[prompt/, 't7: 挂载与内容变化都触发调高');
  // 全屏放大:复用既有 ImageLightbox
  assert.match(src, /import \{ ImageLightbox \}/, 't7: 复用现有 ImageLightbox 组件');
  assert.match(src, /<ImageLightbox/, 't7: Lightbox 渲染点在位');
  assert.ok((src.match(/setZoom\(/g) || []).length >= 3, 't7: 预览图与历史缩略图都能点开(含 onClose 置 null)');
}

console.log('✓ check-r51-image-jobs: 任务化(秒回 jobId)+ 历史 100 条落盘 + 启动清障 + 安全链路整体搬移 + 前端恢复/自适应/放大 全部通过');
