#!/usr/bin/env node
// 单测:r82 生图接入异步任务制(apimart / Midjourney 形态)。
// Run: node tests/unit/check-r82-image-async.mjs
//
// 核心牙:
//  ① fixture 用【真机实测的上游原件】逐字读,不手编理想化 JSON —— 这两个文件是本轮唯一的
//    形态依据(url 是数组、一次 4 张单图)。原件出自 .devflow/mj-{submit,result}.json
//    (该目录 gitignored),按字节复制到 tests/fixtures/ 才能在干净检出里跑。
//  ② 终态只认 completed / failed / cancelled,其余(pending / submitted / 未知值)一律
//    继续轮询:白名单枚举非终态的话,上游加一档新状态就会被当失败判死。
//  ③ 只认 http(s) 的图片链接 —— 这个值随后要交给下载分支去请求。
//  ④ pollTask 的安全口径与既有外联一致:redirect:'manual' + readCapped + 走 provider 代理;
//    且它必须定义在 runImageJob 【之前】(check-r51 用 runImageJob→router 的源码切片数
//    安全锚点,pollTask 落进切片里会把那条锁的语义搞错)。
//  ⑤ 同步三协议零回归:openai / gemini / chat 的产物逐字不变,extractImage 不认 mj。
//
// 全程不打真实网络:pollTask 的 fetch / sleep / now 全部注入。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须在 import 路由前改 HOME:真实 ~/.claude-gui 一个字节不碰(红线)。
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-r82-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
mkdirSync(join(TMP_HOME, '.claude-gui'), { recursive: true });

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = 'sk-r82-stored-secret-abcdef123456';

// ── 真机实测原件(逐字复制自 .devflow/mj-{submit,result}.json) ──
const SUBMIT = JSON.parse(readFileSync(join(REPO, 'tests', 'fixtures', 'mj-submit.sample.json'), 'utf8'));
const RESULT = JSON.parse(readFileSync(join(REPO, 'tests', 'fixtures', 'mj-result.sample.json'), 'utf8'));
const TASK_ID = 'task_01M1EJFES1WXQMW1Q4T2PDZKXT';

const {
  IMAGE_PROTOCOLS, buildImageRequest, extractImage,
  extractTaskId, buildTaskPollRequest, extractTaskState,
} = await import('../../server/utils/image-protocols.js');

let failure = null;
try {
  // ───────────── 1. fixture 自检:形态假设写死在这里,原件变了立刻炸 ─────────────
  {
    assert.equal(SUBMIT.data[0].task_id, TASK_ID, 't1: 提交原件里的 task_id');
    assert.equal(SUBMIT.data[0].status, 'submitted', 't1: 提交即 submitted(非终态)');
    assert.equal(RESULT.data.status, 'completed', 't1: 结果原件是 completed');
    assert.ok(Array.isArray(RESULT.data.result.images[0].url), 't1【形态红线】:url 是数组不是字符串');
    assert.equal(RESULT.data.result.images[0].url.length, 4, 't1: MJ 一次 4 张独立单图');
  }

  // ───────────── 2. 协议枚举与 mj 请求组装 ─────────────
  {
    assert.deepEqual(IMAGE_PROTOCOLS, ['openai', 'gemini', 'chat', 'mj'], 't2: mj 只在尾部追加');

    const mj = buildImageRequest(
      { protocol: 'mj', baseURL: 'https://api.apimart.ai/v1/', apiKey: KEY, model: 'midjourney', size: '16:9' },
      '一只猫',
    );
    assert.equal(mj.url, 'https://api.apimart.ai/v1/midjourney/generations', 't2: mj 专用端点(尾斜杠已归一)');
    assert.equal(mj.headers.Authorization, `Bearer ${KEY}`, 't2: mj 走 Bearer');
    assert.equal(mj.headers['Content-Type'], 'application/json', 't2: mj 是 JSON 请求');
    assert.deepEqual(mj.body, { prompt: '一只猫' }, 't2【本轮口径】:body 只有 prompt —— 不传 model、不传 size');
    assert.equal(mj.form, null, 't2: mj 不是 multipart');
    assert.equal(mj.altHeaders, null, 't2: mj 无认证回落');

    // 参考图当前版本不下发(UI 已就此给出说明):带 refs 与不带 refs 的请求逐字相同。
    const withRefs = buildImageRequest(
      { protocol: 'mj', baseURL: 'https://api.apimart.ai/v1', apiKey: KEY, model: 'midjourney' },
      '一只猫',
      [{ name: 'a.png', mime: 'image/png', base64: 'AAAA' }],
    );
    assert.deepEqual(withRefs.body, { prompt: '一只猫' }, 't2【参考图忽略】:mj 分支不发参考图字段');

    // extra 是与其余三协议同一个逃生口:未实测的字段(speed / version / image_urls…)由用户自填。
    const extra = buildImageRequest(
      { protocol: 'mj', baseURL: 'https://api.apimart.ai/v1', apiKey: KEY, model: 'midjourney', extra: { speed: 'fast' } },
      'p',
    );
    assert.deepEqual(extra.body, { prompt: 'p', speed: 'fast' }, 't2: extra 原样并入(与三协议同口径)');

    // 前置校验沿用既有那三条(未知协议 / 空 baseURL / 空提示词)。
    assert.throws(() => buildImageRequest({ protocol: 'mjx', baseURL: 'https://a.co/v1', apiKey: KEY, model: 'm' }, 'p'),
      /未知协议/, 't2: 未知协议仍抛');
    assert.throws(() => buildImageRequest({ protocol: 'mj', baseURL: 'https://a.co/v1', apiKey: KEY, model: 'm' }, '  '),
      /提示词不能为空/, 't2: mj 同样要求非空提示词');

    // 零回归:三种同步协议的产物与 r82 之前逐字一致(端点 / body 形态)。
    const oa = buildImageRequest({ protocol: 'openai', baseURL: 'https://a.co/v1', apiKey: KEY, model: 'gpt-image-2' }, 'p');
    assert.equal(oa.url, 'https://a.co/v1/images/generations', 't2【零回归】:openai 端点不变');
    assert.deepEqual(oa.body, { model: 'gpt-image-2', prompt: 'p', n: 1 }, 't2【零回归】:openai body 不变');
    const ge = buildImageRequest({ protocol: 'gemini', baseURL: 'https://a.co/v1', apiKey: KEY, model: 'm' }, 'p');
    assert.equal(ge.url, 'https://a.co/v1/models/m:generateContent', 't2【零回归】:gemini 端点不变');
    const ch = buildImageRequest({ protocol: 'chat', baseURL: 'https://a.co/v1', apiKey: KEY, model: 'm' }, 'p');
    assert.equal(ch.url, 'https://a.co/v1/chat/completions', 't2【零回归】:chat 端点不变');
    assert.equal(ch.body.messages[0].content, 'p', 't2【零回归】:chat 无参考图时 content 仍是纯字符串');
  }

  // ───────────── 3. extractTaskId ─────────────
  {
    assert.equal(extractTaskId(SUBMIT), TASK_ID, 't3: 认真机提交原件');
    assert.equal(extractTaskId({ code: 200, data: [{ task_id: '  t1  ' }] }), 't1', 't3: 去首尾空白');
    for (const [bad, why] of [
      [null, 'null'],
      [undefined, 'undefined'],
      [{}, '空对象'],
      [{ data: {} }, 'data 不是数组'],
      [{ data: [] }, 'data 空数组'],
      [{ data: [{}] }, '没有 task_id'],
      [{ data: [{ task_id: '' }] }, 'task_id 空串'],
      [{ data: [{ task_id: '   ' }] }, 'task_id 全空白'],
      [{ data: [{ task_id: 123 }] }, 'task_id 不是字符串'],
      // 同步出图的响应绝不能被当成任务:openai 的 b64 / url 形态里没有 task_id。
      [{ data: [{ b64_json: 'AAAA' }] }, 'openai 同步 b64 响应'],
      [{ data: [{ url: 'https://x/y.png' }] }, 'openai 同步 url 响应'],
    ]) {
      assert.equal(extractTaskId(bad), null, `t3: ${why} → null`);
    }
  }

  // ───────────── 4. buildTaskPollRequest ─────────────
  {
    const q = buildTaskPollRequest('https://api.apimart.ai/v1/', KEY, TASK_ID);
    assert.equal(q.url, `https://api.apimart.ai/v1/tasks/${TASK_ID}`, 't4: GET {base}/tasks/{id}(尾斜杠已归一)');
    assert.deepEqual(q.headers, { Authorization: `Bearer ${KEY}` }, 't4: 鉴权与提交同口径');
    // taskId 来自上游 → 进 path 必须编码,否则 '/' 会改变实际请求的路径段(同 gemini 的 model)。
    assert.equal(buildTaskPollRequest('https://a.co/v1', KEY, '../../admin').url,
      'https://a.co/v1/tasks/..%2F..%2Fadmin', 't4【路径注入】:id 进 path 前编码');
    assert.equal(buildTaskPollRequest('https://a.co/v1', KEY, 'a b#c').url,
      'https://a.co/v1/tasks/a%20b%23c', 't4: 空格与 # 同样编码');
    assert.equal(buildTaskPollRequest('https://a.co/v1', null, 'x').headers.Authorization, 'Bearer ',
      't4: 无密钥时头仍成形(不抛)');
    assert.throws(() => buildTaskPollRequest('', KEY, 'x'), /baseURL 未配置/, 't4: 空 baseURL 抛');
    assert.throws(() => buildTaskPollRequest('https://a.co/v1', KEY, ''), /任务 id 为空/, 't4: 空 id 抛');
    assert.throws(() => buildTaskPollRequest('https://a.co/v1', KEY, null), /任务 id 为空/, 't4: null id 抛');
  }

  // ───────────── 5. extractTaskState:三态 + 4-url 拍平 + 非法输入 ─────────────
  {
    // ① completed:真机原件 → 4 个 url 拍平,顺序与原件一致。
    const done = extractTaskState(RESULT);
    assert.equal(done.status, 'completed', 't5: completed');
    assert.equal(done.progress, 100, 't5: progress 100');
    assert.equal(done.urls.length, 4, 't5【4-url 拍平】:result.images[].url[] 全部取出');
    assert.deepEqual(done.urls, RESULT.data.result.images[0].url, 't5: 顺序与原件一致');

    // 多条 images 也要跨条拍平(单模型回一条,别的模型可能回多条)。
    const multi = extractTaskState({
      data: {
        status: 'completed',
        result: { images: [{ url: ['https://a/1.png', 'https://a/2.png'] }, { url: ['https://a/3.png'] }] },
      },
    });
    assert.deepEqual(multi.urls, ['https://a/1.png', 'https://a/2.png', 'https://a/3.png'], 't5: 跨 images 条目拍平');

    // url 退化成字符串的形态也认(文档写数组,别的模型页写过单值)。
    assert.deepEqual(extractTaskState({ data: { status: 'completed', result: { images: [{ url: 'https://a/1.png' }] } } }).urls,
      ['https://a/1.png'], 't5: url 是字符串时也认');
    // 重复链接去重(同一张图重复下载没有意义)。
    assert.deepEqual(extractTaskState({ data: { status: 'completed', result: { images: [{ url: ['https://a/1.png', 'https://a/1.png'] }] } } }).urls,
      ['https://a/1.png'], 't5: 重复 url 去重');

    // ② 非 http(s) 一律丢:这个值随后要交给下载分支去请求。
    const dirty = extractTaskState({
      data: {
        status: 'completed',
        result: {
          images: [{
            url: [
              'https://ok.example/a.png', 'http://ok.example/b.png',
              'file:///etc/passwd', 'data:image/png;base64,AAAA', 'ftp://x/y.png',
              '/relative/c.png', '', null, 42, { url: 'https://nested' },
            ],
          }],
        },
      },
    });
    assert.deepEqual(dirty.urls, ['https://ok.example/a.png', 'http://ok.example/b.png'],
      't5【只认 http(s)】:file/data/ftp/相对路径/非字符串全丢');

    // ③ failed:cost 0、无 result.images(真机形态),错误原因三种落点都认。
    assert.deepEqual(extractTaskState({ data: { id: 'x', status: 'failed', cost: 0, progress: 0 } }),
      { status: 'failed', progress: 0, urls: [], message: '' }, 't5: failed 无原因时 message 为空串');
    assert.equal(extractTaskState({ data: { status: 'failed', error: { message: 'Banned prompt detected' } } }).message,
      'Banned prompt detected', 't5: 取 data.error.message');
    assert.equal(extractTaskState({ data: { status: 'failed' }, error: { message: '顶层 error' } }).message,
      '顶层 error', 't5: 顶层 error.message 兜底');
    assert.equal(extractTaskState({ data: { status: 'failed', fail_reason: 'Task timeout' } }).message,
      'Task timeout', 't5: MJ 的 fail_reason 兜底');
    // cancelled 也是终态,归到 failed(界面上都是"没出图")。
    assert.equal(extractTaskState({ data: { status: 'cancelled' } }).status, 'failed', 't5: cancelled 归 failed');
    assert.equal(extractTaskState({ data: { status: 'FAILED' } }).status, 'failed', 't5: 状态大小写不敏感');

    // ④ 非终态一律 processing(含未知值),且不带出半成品 url。
    for (const s of ['processing', 'pending', 'submitted', 'queued', 'SOMETHING_NEW', '', undefined]) {
      const st = extractTaskState({ data: { status: s, progress: 30 } });
      assert.equal(st.status, 'processing', `t5【非终态即继续】:status=${s}`);
    }
    assert.deepEqual(extractTaskState({ data: { status: 'processing', result: { images: [{ url: ['https://a/half.png'] }] } } }).urls,
      [], 't5: 未完成时不提前交出 url');
    // completed 但没有可用链接 → urls 空(由路由层给"完成但没图"的文案)。
    assert.deepEqual(extractTaskState({ data: { status: 'completed', result: { images: [] } } }).urls, [],
      't5: completed 无图时 urls 为空');

    // ⑤ progress:取不到是 null(不是 0),越界夹紧,非数值忽略。
    assert.equal(extractTaskState({ data: { status: 'processing' } }).progress, null, 't5: 无 progress → null');
    assert.equal(extractTaskState({ data: { status: 'processing', progress: null } }).progress, null, 't5: progress null → null');
    assert.equal(extractTaskState({ data: { status: 'processing', progress: '99%' } }).progress, null, 't5: 非数值 → null');
    assert.equal(extractTaskState({ data: { status: 'processing', progress: 0 } }).progress, 0, 't5: 0 是有效进度');
    assert.equal(extractTaskState({ data: { status: 'processing', progress: 150 } }).progress, 100, 't5: 上越界夹到 100');
    assert.equal(extractTaskState({ data: { status: 'processing', progress: -5 } }).progress, 0, 't5: 下越界夹到 0');
    assert.equal(extractTaskState({ data: { status: 'processing', progress: 66.6 } }).progress, 67, 't5: 小数取整');

    // ⑥ 非法输入不抛(上游可以回任何东西)。
    for (const bad of [null, undefined, {}, { data: null }, { data: [] }, 'x', 42, [1, 2]]) {
      const st = extractTaskState(bad);
      assert.equal(st.status, 'processing', `t5: 垃圾输入当非终态(${JSON.stringify(bad)})`);
      assert.deepEqual(st.urls, [], 't5: 垃圾输入不产出 url');
    }
    assert.deepEqual(extractTaskState({ data: { status: 'completed', result: { images: 'not-an-array' } } }).urls, [],
      't5: images 不是数组也不抛');
  }

  // ───────────── 6. extractImage 不认 mj(取图归轮询,协议层不掺和) ─────────────
  {
    assert.equal(extractImage('mj', SUBMIT), null, 't6: extractImage(mj) 恒 null');
    assert.equal(extractImage('mj', RESULT), null, 't6: 结果原件也不走 extractImage');
    // 零回归:三协议取图逐字不变。
    assert.deepEqual(extractImage('openai', { data: [{ b64_json: 'AAAA' }] }), { mime: 'image/png', base64: 'AAAA' },
      't6【零回归】:openai b64 分支不变');
    assert.deepEqual(extractImage('openai', { data: [{ url: 'https://a/b.png' }] }), { mime: '', url: 'https://a/b.png' },
      't6【零回归】:openai url 分支不变');
    assert.deepEqual(extractImage('gemini', { candidates: [{ content: { parts: [{ inline_data: { data: 'BBBB', mime_type: 'image/webp' } }] } }] }),
      { mime: 'image/webp', base64: 'BBBB' }, 't6【零回归】:gemini snake_case 仍认');
    assert.deepEqual(extractImage('chat', { choices: [{ message: { content: '![](https://a/b.png)' } }] }),
      { mime: '', url: 'https://a/b.png' }, 't6【零回归】:chat markdown 仍认');
    // 任务制响应打进 openai 协议:取不到图 → 由路由层转去试 extractTaskId(不是直接判死)。
    assert.equal(extractImage('openai', SUBMIT), null, 't6: 任务制提交响应在 openai 协议下取不到图');
  }
} catch (e) {
  failure = e;
} finally {
  rmSync(TMP_HOME, { recursive: true, force: true });
}
if (failure) throw failure;

console.log('✓ check-r82-image-async: mj 组装 + 任务三态/4-url 拍平 + 同步三协议零回归 全部通过');
