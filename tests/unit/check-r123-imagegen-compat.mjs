#!/usr/bin/env node
// r123【单测】生图接任意中转站(用户 2026-09-21):任务形态表 / 状态词表 / 取图候选 / 同源校验 /
// 基址规范化 / 最终请求地址预览 / 报错分层十类 / chat images 与 media_type 补读。
// 全部是零 IO 纯函数,直接 import 真函数;端到端形态由 tests/acceptance/r123-imagegen 用假上游验。
// Run: node tests/unit/check-r123-imagegen-compat.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  detectTaskShape, extractGenericTaskState, normalizeTaskStatus, isSameOrigin,
  TASK_SUCCESS_WORDS, TASK_FAILED_WORDS, TASK_CANCELLED_WORDS, TASK_PROGRESS_WORDS, MAX_TASK_IMAGES,
  normalizeImageBaseURL, previewImageRequestURL, imageRequestURL, hasVersionSegment, suggestBaseURL, collapseDoubleV1,
  classifyImageError, looksLikeHtml, looksLikeDoubleV1, IMAGE_ERROR_KINDS,
  buildImageRequest, extractImage, extractImages,
} from '../../server/utils/image-protocols.js';
import { upstreamExcerpt } from '../../server/utils/image-errors.js';

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); n += 1; };
const deq = (a, b, m) => { assert.deepEqual(a, b, m); n += 1; };

const BASE = 'http://127.0.0.1:6800/x/v1';
const SUBMIT = `${BASE}/images/generations`;
const CTX = { submitUrl: SUBMIT, baseURL: BASE };

// ───────────── 1. 形态识别(含防误判) ─────────────
{
  deq(detectTaskShape({ id: 'tsk_img_1', object: 'generation.task', status: 'queued' }, CTX),
    { shape: 'openai-video', taskId: 'tsk_img_1', pollUrl: `${SUBMIT}/tsk_img_1` }, 't1: 视频式(object 含 task)→ 提交地址 + /{id}');
  deq(detectTaskShape({ id: 'v-2', status: 'pending' }, CTX),
    { shape: 'openai-video', taskId: 'v-2', pollUrl: `${SUBMIT}/v-2` }, 't1: 视频式(status 属进行中词表,没有 object)');
  deq(detectTaskShape({ task_id: 't-1', status: 'submitted' }, CTX),
    { shape: 'task-id', taskId: 't-1', pollUrl: `${SUBMIT}/t-1` }, 't1: 顶层 task_id');
  deq(detectTaskShape({ data: { task_id: 't-2' } }, CTX).pollUrl, `${SUBMIT}/t-2`, 't1: data.task_id');
  deq(detectTaskShape({ output: { task_id: 't-3', task_status: 'PENDING' } }, CTX).pollUrl, `${SUBMIT}/t-3`, 't1: output.task_id(DashScope)');
  deq(detectTaskShape({ id: 'p-1', polling_url: `${BASE}/poll/p-1` }, CTX),
    { shape: 'polling-url', taskId: 'p-1', pollUrl: `${BASE}/poll/p-1` }, 't1: 同源 polling_url 优先于视频式');
  const cross = detectTaskShape({ id: 'p-2', polling_url: 'http://127.0.0.1:6901/steal' }, CTX);
  eq(cross.shape, 'polling-url', 't1: 跨源 polling_url 仍认出是这一形态');
  ok(/不同源/.test(cross.error) && /拒绝/.test(cross.error), `t1【安全】:跨源 polling_url 带 error(实际 ${cross.error})`);
  ok(/6901/.test(cross.error) && /6800/.test(cross.error), 't1: error 里说清两边的 origin');
  ok(detectTaskShape({ id: 'p-3', polling_url: 'ftp://127.0.0.1:6800/x' }, CTX).error, 't1: 非 http(s) 的 polling_url 也拒');
  ok(detectTaskShape({ id: 'p-4', polling_url: 'https://127.0.0.1:6800/x' }, CTX).error, 't1: 协议不同(https vs http)不算同源');
  deq(detectTaskShape({ code: 200, data: [{ status: 'submitted', task_id: 'task_1' }] }, CTX),
    { shape: 'apimart', taskId: 'task_1', pollUrl: `${BASE}/tasks/task_1` }, 't1: apimart 形态优先级最高,轮询 {base}/tasks/{id}');
  // 防误判
  eq(detectTaskShape({ created: 1, data: [{ url: 'http://h/a.png' }] }, CTX), null, 't1【防误判】:同步形态不是任务');
  eq(detectTaskShape({ id: 'x', object: 'list', data: [] }, CTX), null, 't1【防误判】:有 id 但 object 不含 task、无进行中状态 → 不是任务');
  eq(detectTaskShape({ id: 'x', status: 'completed' }, CTX), null, 't1【防误判】:id + 终态词也不当任务(同步响应常带 id)');
  eq(detectTaskShape({ id: 'x', status: 'whatever' }, CTX), null, 't1【防误判】:未知状态词不触发轮询(轮询阶段才"未知当进行中")');
  eq(detectTaskShape(null, CTX), null, 't1: null 安全');
  eq(detectTaskShape([{ task_id: 't' }], CTX), null, 't1: 顶层数组不是任务');
  eq(detectTaskShape({ task_id: 't/1' }, CTX).pollUrl, `${SUBMIT}/t%2F1`, 't1: 任务号进路径前编码(r26-J5 同款)');
  eq(detectTaskShape({ id: 42, object: 'task' }, CTX).taskId, '42', 't1: 数字 id 也认');
  eq(detectTaskShape({ task_id: 't-9' }, { baseURL: BASE }), null, 't1: 没有提交地址时 task_id 形态无从轮询 → null');
}

// ───────────── 2. 状态词表 ─────────────
{
  for (const w of TASK_SUCCESS_WORDS) eq(normalizeTaskStatus(w), 'completed', `t2: ${w} → completed`);
  for (const w of TASK_FAILED_WORDS) eq(normalizeTaskStatus(w), 'failed', `t2: ${w} → failed`);
  for (const w of TASK_CANCELLED_WORDS) eq(normalizeTaskStatus(w), 'cancelled', `t2: ${w} → cancelled`);
  for (const w of TASK_PROGRESS_WORDS) eq(normalizeTaskStatus(w), 'processing', `t2: ${w} → processing`);
  deq(TASK_SUCCESS_WORDS, ['completed', 'succeeded', 'success', 'ready', 'done', 'finished'], 't2: 成功词表 = BRIEF R1-2');
  deq(TASK_CANCELLED_WORDS, ['cancelled', 'canceled'], 't2: 取消词表含美式拼写');
  eq(normalizeTaskStatus('Ready'), 'completed', 't2: 大小写不敏感');
  eq(normalizeTaskStatus('SUCCEEDED'), 'completed', 't2: DashScope 大写');
  eq(normalizeTaskStatus('xyz'), 'processing', 't2: 未知值当进行中(不判死)');
  eq(normalizeTaskStatus(undefined), 'processing', 't2: 缺失当进行中');
}

// ───────────── 3. 取图候选 / 实付 / 失败原因 ─────────────
{
  const st = (body) => extractGenericTaskState(body);
  eq(st({ status: 'completed', result: { data: [{ url: 'http://h/a.png' }] } }).urls[0], 'http://h/a.png', 't3: result.data[].url');
  deq(st({ status: 'completed', result: { data: [{ b64_json: 'AA==' }] } }).b64, [{ mime: 'image/png', base64: 'AA==' }], 't3: result.data[].b64_json → base64 落盘链');
  deq(st({ status: 'completed', result: { data: [{ b64_json: 'AA==', media_type: 'image/webp' }] } }).b64[0].mime, 'image/webp', 't3: b64 配 media_type');
  eq(st({ status: 'completed', data: { result: { images: [{ url: ['http://h/1.png', 'http://h/2.png'] }] } } }).urls.length, 2, 't3: data.result.images[].url[](apimart 形)');
  eq(st({ status: 'completed', output: { results: [{ url: 'http://h/o.png' }] } }).urls[0], 'http://h/o.png', 't3: output.results[].url');
  eq(st({ status: 'Ready', result: { sample: 'http://h/s.png' } }).urls[0], 'http://h/s.png', 't3: result.sample');
  eq(st({ status: 'done', result: { url: 'http://h/r.png' } }).urls[0], 'http://h/r.png', 't3: result.url');
  eq(st({ status: 'completed', url: 'http://h/top.png' }).urls[0], 'http://h/top.png', 't3: 顶层 url');
  eq(st({ status: 'completed', data: { status: 'completed', url: 'http://h/d.png' } }).urls[0], 'http://h/d.png', 't3: data.url');
  eq(st({ status: 'completed', data: [{ url: 'http://h/arr.png' }] }).urls[0], 'http://h/arr.png', 't3: 终态才回同步形态 data[] 也认');
  deq(st({ status: 'completed', result: { url: 'ftp://h/x', sample: 'file:///etc/passwd' } }).urls, [], 't3【安全】:只认 http(s) 链接');
  eq(st({ status: 'completed', url: 'http://h/a.png', result: { url: 'http://h/a.png' } }).urls.length, 1, 't3: 去重');
  const many = st({ status: 'completed', result: { data: Array.from({ length: MAX_TASK_IMAGES + 5 }, (_, i) => ({ url: `http://h/${i}.png` })) } });
  eq(many.urls.length, MAX_TASK_IMAGES, 't3: 张数上限');
  deq(st({ status: 'processing', result: { data: [{ url: 'http://h/a.png' }] } }).urls, [], 't3: 非终态不取图');
  eq(st({ status: 'completed', billing: { cost_usd: '0.04', credits: '4' } }).cost, 0.04, 't3: 实付字符串 → 数值(ToAPIs billing.cost_usd)');
  eq(st({ status: 'completed', billing: { cost_usd: '0.04', credits: '4' } }).creditsCost, 4, 't3: billing.credits 字符串 → 数值');
  eq(st({ status: 'completed', cost: 0.5 }).cost, 0.5, 't3: 顶层 cost 数字');
  eq(st({ status: 'completed', billing: { cost_usd: 'n/a' } }).cost, null, 't3: 非数字字符串 → null(不显示,不当 0)');
  eq(st({ status: 'completed' }).cost, null, 't3: 取不到 → null');
  const failed = st({ status: 'failed', error: { message: 'render exploded' } });
  eq(failed.status, 'failed', 't3: failed');
  eq(failed.message, 'render exploded', 't3: 失败原因 error.message');
  eq(st({ status: 'failed', fail_reason: 'banned' }).message, 'banned', 't3: 失败原因 fail_reason');
  eq(st({ status: 'failed', error: 'plain text' }).message, 'plain text', 't3: error 是字符串也认');
  eq(st({ status: 'canceled' }).status, 'cancelled', 't3: 美式 canceled → cancelled');
  eq(st({ status: 'in_progress', progress: 50 }).progress, 50, 't3: 进度');
  eq(st({ status: 'in_progress' }).progress, null, 't3: 无进度 → null(不是 0)');
  eq(st(null).status, 'processing', 't3: null 安全');
}

// ───────────── 4. 同源校验 ─────────────
{
  ok(isSameOrigin('http://127.0.0.1:6800/a', 'http://127.0.0.1:6800/b/c'), 't4: 同协议同主机同端口 = 同源');
  ok(!isSameOrigin('http://127.0.0.1:6800/a', 'http://127.0.0.1:6901/a'), 't4: 端口不同');
  ok(!isSameOrigin('http://127.0.0.1:6800/a', 'https://127.0.0.1:6800/a'), 't4: 协议不同');
  ok(!isSameOrigin('http://localhost:6800/a', 'http://127.0.0.1:6800/a'), 't4: localhost 与 127.0.0.1 按字面不同(轮询地址不放宽)');
  ok(!isSameOrigin('not a url', 'http://127.0.0.1:6800'), 't4: 解析不了 → false');
  ok(isSameOrigin('https://a.example.com', 'https://a.example.com:443/v1'), 't4: 默认端口归一');
}

// ───────────── 5. 基址规范化 / /v数字 段 / 建议基址 ─────────────
{
  eq(normalizeImageBaseURL('https://api.example.com/v1/images/generations/'), 'https://api.example.com/v1', 't5: 剥 /images/generations 与末尾斜杠');
  eq(normalizeImageBaseURL(' https://api.example.com/v1/ '), 'https://api.example.com/v1', 't5: trim + 末尾斜杠');
  eq(normalizeImageBaseURL('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1', 't5: 剥 /chat/completions');
  eq(normalizeImageBaseURL('https://api.example.com/v1/images/edits'), 'https://api.example.com/v1', 't5: 剥 /images/edits');
  eq(normalizeImageBaseURL('https://api.example.com/v1/Images/Generations'), 'https://api.example.com/v1', 't5: 大小写不敏感');
  eq(normalizeImageBaseURL('https://api.example.com'), 'https://api.example.com', 't5【反向】:不自动补 /v1');
  eq(normalizeImageBaseURL('https://api.example.com/v1'), 'https://api.example.com/v1', 't5【反向】:已规范的不动');
  eq(normalizeImageBaseURL('https://api.example.com/images/generations-x'), 'https://api.example.com/images/generations-x', 't5【反向】:只剥完整尾段');
  eq(normalizeImageBaseURL(undefined), '', 't5: 非字符串 → 空串');
  ok(hasVersionSegment('https://api.example.com/v1'), 't5: /v1 是版本段');
  ok(hasVersionSegment('https://api.example.com/v1beta'), 't5: /v1beta 是版本段');
  ok(hasVersionSegment('https://api.example.com/v2/x'), 't5: 中间的 /v2 也是');
  ok(!hasVersionSegment('https://v2.example.com'), 't5【反向】:主机名里的 v2 不算');
  ok(!hasVersionSegment('https://api.example.com/version1'), 't5【反向】:/version1 不算');
  ok(!hasVersionSegment('https://api.example.com'), 't5【反向】:没有路径');
  eq(suggestBaseURL('http://127.0.0.1:6800/b1a'), 'http://127.0.0.1:6800/b1a/v1', 't5: 建议基址补 /v1');
  eq(suggestBaseURL('http://127.0.0.1:6800/b1a/v1/'), 'http://127.0.0.1:6800/b1a/v1', 't5: 已有 /v1 只去斜杠');
  eq(collapseDoubleV1('http://h/b2/v1/v1'), 'http://h/b2/v1', 't5: /v1/v1 收成 /v1');
  eq(collapseDoubleV1('http://h/b2/v1'), 'http://h/b2/v1', 't5: 没写重不动');
}

// ───────────── 6. 最终请求地址预览 = buildImageRequest 真正打的地址 ─────────────
{
  eq(previewImageRequestURL('openai', 'https://api.example.com/v1', 'm'), 'https://api.example.com/v1/images/generations', 't6: openai');
  eq(previewImageRequestURL('chat', 'https://api.example.com/v1/', 'm'), 'https://api.example.com/v1/chat/completions', 't6: chat(末尾斜杠去掉)');
  eq(previewImageRequestURL('gemini', 'https://g.example.com/v1beta', 'gemini-2.5-flash-image'), 'https://g.example.com/v1beta/models/gemini-2.5-flash-image:generateContent', 't6: gemini');
  eq(previewImageRequestURL('gemini', 'https://g.example.com/v1beta', 'models/a b'), 'https://g.example.com/v1beta/models/a%20b:generateContent', 't6: gemini 剥 models/ 前缀并编码');
  eq(previewImageRequestURL('mj', 'https://api.apimart.ai/v1', 'midjourney'), 'https://api.apimart.ai/v1/midjourney/generations', 't6: mj');
  eq(previewImageRequestURL('mj-proxy', 'https://mj.example.com/mj', ''), 'https://mj.example.com/mj/submit/imagine', 't6: mj-proxy 去掉末尾 /mj 再拼');
  eq(previewImageRequestURL('openai', '', 'm'), '', 't6: 基址为空 → 空串(表单不显示半截路径)');
  eq(imageRequestURL('openai', 'https://api.example.com/v1', 'm', { edits: true }), 'https://api.example.com/v1/images/edits', 't6: edits 形态');
  const cfg = { baseURL: 'https://r.example.com/v1/', apiKey: 'k', model: 'models/foo/bar baz', size: '' };
  for (const protocol of ['openai', 'gemini', 'chat']) {
    eq(buildImageRequest({ ...cfg, protocol }, 'p').url, previewImageRequestURL(protocol, cfg.baseURL, cfg.model), `t6【同源】:${protocol} 预览 = 真实请求地址`);
  }
  eq(buildImageRequest({ ...cfg, protocol: 'mj', size: '1:1' }, 'p').url, previewImageRequestURL('mj', cfg.baseURL, cfg.model), 't6【同源】:mj 预览 = 真实请求地址');
  eq(buildImageRequest({ ...cfg, protocol: 'mj-proxy', baseURL: 'https://mj.example.com/mj', size: '1:1' }, 'p').url, previewImageRequestURL('mj-proxy', 'https://mj.example.com/mj', ''), 't6【同源】:mj-proxy 预览 = 真实请求地址');
}

// ───────────── 7. 报错分层十类 ─────────────
{
  deq(IMAGE_ERROR_KINDS, ['base-url', 'auth', 'balance', 'rate-limit', 'moderation', 'task-failed', 'timeout', 'no-image', 'network', 'other'], 't7: 十类枚举');
  const kind = (e) => classifyImageError(e).kind;
  const html = classifyImageError({ phase: 'html', status: 200, contentType: 'text/html', url: 'http://h/b1a/images/generations', baseURL: 'http://h/b1a' });
  eq(html.kind, 'base-url', 't7: HTML → base-url');
  ok(/网站页面/.test(html.summary), 't7: summary 说清打到了网站页面');
  ok(/\/v1/.test(html.action) && html.action.includes('http://h/b1a/images/generations') && html.action.includes('http://h/b1a/v1'), `t7: action 给当前地址与建议基址(实际 ${html.action})`);
  eq(kind({ status: 200, contentType: 'application/json', bodyHead: '<!doctype html><html>' }), 'base-url', 't7: content-type 是 json 但正文以 < 开头也算网页');
  const dv = classifyImageError({ status: 404, bodyHead: '{"error":{"message":"Invalid URL (POST /v1/v1/images/generations)"}}', baseURL: 'http://h/b2/v1/v1' });
  eq(dv.kind, 'base-url', 't7: /v1/v1 404 → base-url');
  ok(/写重/.test(dv.summary) && dv.action.includes('http://h/b2/v1（'), `t7: 说「写重」并给去掉一层后的建议(实际 ${dv.action})`);
  eq(kind({ status: 404, bodyHead: '{"error":{"message":"Invalid URL (POST /v1/images/foo)"}}' }), 'other', 't7【反向】:404 但不是 /v1/v1/ → other');
  eq(kind({ status: 401 }), 'auth', 't7: 401'); eq(kind({ status: 403 }), 'auth', 't7: 403');
  eq(kind({ status: 402 }), 'balance', 't7: 402');
  eq(kind({ status: 400, bodyHead: '{"error":{"message":"insufficient balance"}}' }), 'balance', 't7: insufficient');
  eq(kind({ status: 400, bodyHead: '余额不足' }), 'balance', 't7: 余额');
  eq(kind({ status: 400, bodyHead: 'You exceeded your current quota' }), 'balance', 't7: quota');
  eq(kind({ status: 429, bodyHead: 'Too many requests' }), 'rate-limit', 't7: 429');
  eq(kind({ status: 429, bodyHead: 'You exceeded your current quota, please check your plan and billing' }), 'balance', 't7: 429 + quota 正文按余额归类(OpenAI 的配额用尽也回 429)');
  eq(kind({ status: 400, bodyHead: '{"error":{"code":"content_policy_violation"}}' }), 'moderation', 't7: content_policy');
  eq(kind({ status: 400, bodyHead: 'blocked by safety system' }), 'moderation', 't7: safety');
  eq(kind({ status: 400, bodyHead: '提示词包含敏感内容' }), 'moderation', 't7: 敏感');
  eq(kind({ phase: 'task-failed', status: 200, message: '上游任务失败：x' }), 'task-failed', 't7: 任务失败');
  eq(kind({ phase: 'task-cancelled', status: 200, message: '上游任务已取消' }), 'task-failed', 't7: 上游取消归任务失败类');
  eq(kind({ phase: 'timeout', message: '生成超时（120 秒），上游没有返回' }), 'timeout', 't7: 超时');
  eq(kind({ phase: 'no-image', status: 200, bodyHead: '{"created":1,"data":[]}' }), 'no-image', 't7: 没有图片');
  eq(kind({ phase: 'network', status: null, message: '连接上游失败：fetch failed — ECONNREFUSED' }), 'network', 't7: 网络');
  eq(kind({ status: 500, bodyHead: '{"error":{"message":"internal"}}' }), 'other', 't7: 500 → other');
  eq(kind({ status: 200, bodyHead: 'garbage', phase: 'not-json', message: '上游响应不是 JSON：garbage' }), 'other', 't7: 非 JSON 非网页 → other');
  // 阶段优先级:图片下载那次请求的 content-type / 状态不套「网页 = 缺 /v1」与鉴权规则
  eq(kind({ phase: 'download', status: 200, contentType: 'text/html', message: '上游返回的链接不是图片（Content-Type: text/html）' }), 'network', 't7【优先级】:下载到 HTML 不是基址问题');
  eq(kind({ phase: 'download', status: 403, message: '下载生成的图片失败：HTTP 403' }), 'network', 't7【优先级】:图床 403 不是密钥问题');
  const rej = classifyImageError({ phase: 'image-url-rejected', url: 'http://127.0.0.1:6999/a.png', message: 'http 图片链接只接受与提供方基址同源（同主机同端口）的回环地址，其它情况请使用 https 公网链接' });
  eq(rej.kind, 'network', 't7: 链接被拒 → network');
  ok(rej.summary.startsWith('拒绝下载该链接') && /同源/.test(rej.summary), `t7: 说真实规则(实际 ${rej.summary})`);
  eq(kind({ phase: 'polling-url-cross-origin', message: '不同源' }), 'other', 't7: 跨源 polling_url → other');
  // summary / action 形态
  for (const e of [{ status: 401 }, { status: 402 }, { status: 429 }, { phase: 'timeout' }, { phase: 'network' }, { status: 500 }, { phase: 'no-image' }]) {
    const c = classifyImageError(e);
    ok(c.summary && c.action, `t7: ${JSON.stringify(e)} 的 summary 与 action 都非空`);
  }
  const auth = classifyImageError({ status: 401, bodyHead: '{"error":{"message":"Incorrect API key provided: sk-***"}}' });
  ok(auth.summary.includes('Incorrect API key provided: sk-***'), `t7: 鉴权类 summary 带上游原话(已脱敏)(实际 ${auth.summary})`);
  eq(upstreamExcerpt('{"error":{"message":"a  b\n c"}}'), 'a b c', 't7: 摘录压空白');
  eq(upstreamExcerpt('{"error":{"message":"half').length > 0, true, 't7: 半截 JSON 也能兜出 message');
  eq(upstreamExcerpt('plain text body'), 'plain text body', 't7: 纯文本原样');
  eq(upstreamExcerpt('{"foo":1}'), '', 't7: JSON 里没有可读字段 → 空');
  eq(upstreamExcerpt('x'.repeat(500)).length, 160, 't7: 摘录 ≤160 字');
  ok(looksLikeHtml('text/html; charset=utf-8', '') && looksLikeHtml('', '  <!doctype html>') && !looksLikeHtml('application/json', '{"a":1}'), 't7: looksLikeHtml 两个判据');
  ok(looksLikeDoubleV1(404, 'Invalid URL (POST /v1/v1/images/generations)') && !looksLikeDoubleV1(200, 'Invalid URL /v1/v1/'), 't7: looksLikeDoubleV1 要 404');
}

// ───────────── 8. chat images / media_type 补读 ─────────────
{
  const png = 'iVBORw0KGgo=';
  deq(extractImage('chat', { choices: [{ message: { content: '', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] } }] }),
    { mime: 'image/png', base64: png }, 't8: message.images[].image_url.url 的 data URL');
  deq(extractImage('chat', { choices: [{ message: { content: '', images: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1:6800/__img/a.png' } }] } }] }),
    { mime: '', url: 'http://127.0.0.1:6800/__img/a.png' }, 't8: http 链接交给下载分支');
  deq(extractImage('chat', { choices: [{ message: { content: '', images: [{ url: 'https://h/a.png' }] } }] }), { mime: '', url: 'https://h/a.png' }, 't8: {url} 简写形态');
  deq(extractImage('chat', { choices: [{ message: { content: `![x](https://h/c.png)`, images: [{ image_url: { url: 'ftp://nope' } }] } }] }), { mime: '', url: 'https://h/c.png' }, 't8: images 里没有可用项时回落正文规则');
  eq(extractImage('chat', { choices: [{ message: { content: '', images: [] } }] }), null, 't8: 都没有 → null');
  eq(extractImages('chat', { choices: [{ message: { content: '', images: [{ image_url: { url: 'https://h/1.png' } }, { image_url: { url: 'https://h/2.png' } }] } }] }).length, 1, 't8: chat 仍按单张包数组(既有语义)');
  deq(extractImage('openai', { data: [{ b64_json: 'AA==', media_type: 'image/webp' }] }), { mime: 'image/webp', base64: 'AA==' }, 't8: media_type=webp');
  deq(extractImage('openai', { data: [{ b64_json: 'AA==', media_type: 'image/png' }] }), { mime: 'image/png', base64: 'AA==' }, 't8【反向】:media_type=png 仍 png');
  deq(extractImage('openai', { data: [{ b64_json: 'AA==' }] }), { mime: 'image/png', base64: 'AA==' }, 't8【反向】:没有 media_type 与升级前一致');
  deq(extractImage('openai', { data: [{ b64_json: 'AA==', output_format: 'jpeg' }] }), { mime: 'image/jpeg', base64: 'AA==' }, 't8【反向】:output_format 仍生效');
  deq(extractImage('openai', { data: [{ b64_json: 'AA==', media_type: 'text/html', output_format: 'webp' }] }), { mime: 'image/webp', base64: 'AA==' }, 't8: 非 image/* 的 media_type 忽略,回落 output_format');
  deq(extractImage('openai', { data: [{ b64_json: 'AA==', media_type: 'image/webp', output_format: 'png' }] }), { mime: 'image/webp', base64: 'AA==' }, 't8: media_type 优先于 output_format');
}

// ───────────── 9. 路由接线的源码锚(跨源 polling_url 必须在 pollTask 之前判死;失败条目带 errorInfo) ─────────────
{
  const src = readFileSync(new URL('../../server/routes/image.js', import.meta.url), 'utf8');
  const runner = src.slice(src.indexOf('async function runImageJob'), src.indexOf("router.post('/image/generate'"));
  const iGuard = runner.indexOf('generic?.error');
  const iPoll = runner.indexOf('const polled = await pollTask(');
  ok(iGuard > 0 && iPoll > iGuard, 't9【安全】:跨源 polling_url 的判死在 pollTask 调用之前(不发请求)');
  ok(/parse: extractGenericTaskState/.test(runner), 't9: 通用形态注入 parse');
  ok(/extractImages\(provider\.protocol, data\)/.test(runner) && runner.indexOf('extractImages(provider.protocol, data)') < runner.indexOf('extractTaskId(data)'), 't9: 同步取图仍先于任务形态');
  ok(/errorInfo: \{/.test(runner) && /bodyHead = redact\(redact\(info\.bodyHead\)\.slice\(0, 300\)\)/.test(runner), 't9: errorInfo 落条目,bodyHead 截 300 字后再脱敏一次');
  ok(/normalizeImageBaseURL\(baseURL\)/.test(src), 't9: 保存时过 normalizeImageBaseURL');
  ok(/同源（同主机同端口）的回环地址/.test(runner), 't9【R6】:图片链接被拒的文案说真实规则');
  const panel = readFileSync(new URL('../../client/src/components/ImagePanel.jsx', import.meta.url), 'utf8');
  ok(/data-testid="image-final-url"/.test(panel) && /data-testid="image-add-v1"/.test(panel), 't9: 表单预览与一键补 /v1 的锚点');
  ok(/data-testid="image-error-detail"/.test(panel) && !/<details[^>]*\bopen\b/.test(panel), 't9: 诊断详情默认收起');
  ok(/data-testid="image-preview-shot"/.test(panel) && /cgui-image-dismissed-preview/.test(panel), 't9: 预览锚点与清空记号的 localStorage 键');
  ok(/localStorage\.getItem\(DISMISSED_PREVIEW_KEY\)/.test(panel) && /localStorage\.removeItem\(DISMISSED_PREVIEW_KEY\)/.test(panel), 't9: 记号读 / 空串移除');
}

console.log(`PASS check-r123-imagegen-compat (${n} assertions)`);
