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
//  ⑥【DoS 上限】上游说几张就是几张:不在拍平循环里 break 掉,去重的 includes 就是 O(n²)——
//    实测 10 万条链接(响应体仅 3.6MB)把单进程后端同步冻住 30 秒,且发生在任何下载之前。
//  ⑦ 源码断言只能证明"写了",t10 端到端证明"跑得起来":提交→轮询→4 张全落盘(含同秒
//    撞名加序号)、轮询期间写进度、轮询中取消要立刻落地且归还并发名额。
//
// 全程不打真实网络:pollTask 的 fetch / sleep / now 全部注入;t10 的上游与图片链接
// 都指向本机假服务(临时口),真实 ~/.claude-gui 与真实网络一个都不碰。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须在 import 路由前改 HOME:真实 ~/.claude-gui 一个字节不碰(红线)。
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cgui-r82-home-'));
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'cgui-r82-save-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
// 只为让 t10 的端到端在秒级跑完(产品默认仍是 5s;下调口有 200ms 地板,填更小也是 200)。
// 必须在 import 路由之前设。
process.env.CGUI_IMAGE_TASK_POLL_INTERVAL_MS = '200';
mkdirSync(join(TMP_HOME, '.claude-gui'), { recursive: true });

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = 'sk-r82-stored-secret-abcdef123456';

// ── 真机实测原件(逐字复制自 .devflow/mj-{submit,result}.json) ──
const SUBMIT = JSON.parse(readFileSync(join(REPO, 'tests', 'fixtures', 'mj-submit.sample.json'), 'utf8'));
const RESULT = JSON.parse(readFileSync(join(REPO, 'tests', 'fixtures', 'mj-result.sample.json'), 'utf8'));
const TASK_ID = 'task_01M1EJFES1WXQMW1Q4T2PDZKXT';

const {
  IMAGE_PROTOCOLS, buildImageRequest, extractImage,
  extractTaskId, buildTaskPollRequest, extractTaskState, MAX_TASK_IMAGES,
} = await import('../../server/utils/image-protocols.js');
// 路由层的轮询状态机(import 真函数,fetch / sleep / now 全部注入,绝不打真实网络)。
const { pollTask } = await import('../../server/routes/image.js');

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
    // r84 口径变更:size 改为下发(文档 imagine.md 的 size 就是宽高比 --ar,不是像素),
    // 仍然【不传 model】(该路由自动注入)。size / version / speed 的完整断言在
    // tests/unit/check-r84-mj-actions.mjs,这里只锁"不传 model"这一条 r82 结论。
    assert.deepEqual(mj.body, { prompt: '一只猫', size: '16:9' }, 't2:body 不含 model(r84 起 size 随请求下发)');
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
    // cancelled 同样是终态,但【与 failed 分开】—— 上游主动取消不是失败,措辞得如实。
    assert.equal(extractTaskState({ data: { status: 'cancelled' } }).status, 'cancelled', 't5: cancelled 独立成一档');
    assert.deepEqual(extractTaskState({ data: { status: 'cancelled', result: { images: [{ url: ['https://a/1.png'] }] } } }).urls,
      [], 't5: cancelled 是终态,不交出 url');
    assert.equal(extractTaskState({ data: { status: 'FAILED' } }).status, 'failed', 't5: 状态大小写不敏感');
    assert.equal(extractTaskState({ data: { status: 'CANCELLED' } }).status, 'cancelled', 't5: cancelled 也大小写不敏感');

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

    // ⑥【DoS 上限】上游说几张就是几张 —— 不封死的话去重的 includes 退化成 O(n²):
    // 实测 10 万条链接(响应体仅 3.6MB,远在 MAX_RESPONSE_BYTES 之内)让单进程后端同步
    // 冻住 30 秒,这发生在任何下载【之前】,现有的体积闸与下载闸一个都拦不住;拿到之后
    // 还要逐张下载。上限必须在拍平循环里 break —— 事后 slice 时 O(n²) 已经跑完了。
    {
      assert.equal(MAX_TASK_IMAGES, 16, 't5: 上限 16(MJ 实测 4 张的四倍余量)');
      const big = {
        data: {
          status: 'completed',
          progress: 100,
          result: { images: [{ url: Array.from({ length: 100_000 }, (_, i) => `https://a.example/${i}.png`) }] },
        },
      };
      const t0 = process.hrtime.bigint();
      const st = extractTaskState(big);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.equal(st.urls.length, MAX_TASK_IMAGES, `t5【上限】:10 万条只取 ${MAX_TASK_IMAGES} 条(实际 ${st.urls.length})`);
      assert.deepEqual(st.urls[0], 'https://a.example/0.png', 't5: 取的是最前面那些');
      assert.deepEqual(st.urls[15], 'https://a.example/15.png', 't5: 恰好截到上限');
      // 上界放得很宽(真实修后实测 0.2ms):只要不是 O(n²) 就必然远在 1s 之内,
      // 卡太紧会在慢机器上 flaky,卡这么松仍能把 30 秒那种退化钉死。
      assert.ok(ms < 1000, `t5【不许 O(n²)】:10 万条必须毫秒级返回(实际 ${ms.toFixed(1)}ms —— 事后 slice 就会退化成秒级)`);
      // 跨 images 条目累计也要封死(不是每条各给 16 张)。
      const spread = extractTaskState({
        data: {
          status: 'completed',
          result: {
            images: Array.from({ length: 50 }, (_, g) => ({ url: Array.from({ length: 50 }, (_, i) => `https://a.example/${g}-${i}.png`) })),
          },
        },
      });
      assert.equal(spread.urls.length, MAX_TASK_IMAGES, 't5【上限】:2500 条分散在 50 组里也只取 16 条');
    }

    // ⑦ 非法输入不抛(上游可以回任何东西)。
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

  // ───────────── 7. pollTask:注入 fetch / sleep / now 的确定性轮询 ─────────────
  {
    const PROVIDER = { baseURL: 'https://api.apimart.ai/v1', apiKey: KEY, proxyUrl: '' };
    // 假响应:只实现 pollTask + readCapped 真正用到的那几个面
    // (status / ok / headers.get('content-length') / body 可异步迭代 / body.cancel)。
    const reply = (status, bodyObj, raw) => {
      const text = raw !== undefined ? raw : JSON.stringify(bodyObj);
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: new Map(), // get('content-length') → undefined,走流式限量读那条路
        body: {
          cancel: async () => {},
          async* [Symbol.asyncIterator]() { yield Buffer.from(text, 'utf8'); },
        },
      };
    };
    const progressing = (p) => ({ code: 200, data: { id: TASK_ID, status: 'processing', progress: p } });

    // 每次调用按脚本回一条;记录收到的 url / options,供形态断言用。
    function scriptedFetch(script) {
      const calls = [];
      const fn = async (url, opts) => {
        calls.push({ url, opts });
        const next = script[Math.min(calls.length - 1, script.length - 1)];
        if (typeof next === 'function') return next();
        return next;
      };
      fn.calls = calls;
      return fn;
    }
    // 注入的 sleep:不真睡,只记账(并如实转达 signal —— 取消要能穿透等待)。
    function fakeSleep() {
      const seen = [];
      const fn = async (ms, signal) => { seen.push({ ms, aborted: !!signal?.aborted, hasSignal: !!signal }); };
      fn.seen = seen;
      return fn;
    }
    // 注入的时钟:每次调用推进固定步长,用来把 15 分钟上限压进几次迭代。
    const stepClock = (stepMs) => { let t = 0; return () => (t += stepMs); };

    // ① completed:processing ×2 → completed,拿到 4 个 url;progress 只在变化时上报。
    {
      const ac = new AbortController();
      const seenProgress = [];
      const doFetch = scriptedFetch([reply(200, progressing(0)), reply(200, progressing(0)), reply(200, progressing(99)), reply(200, RESULT)]);
      const sleep = fakeSleep();
      const out = await pollTask(
        { taskId: TASK_ID, provider: PROVIDER, signal: ac.signal, onProgress: (p) => seenProgress.push(p) },
        { fetch: doFetch, sleep, now: () => 0 },
      );
      assert.deepEqual(out.urls, RESULT.data.result.images[0].url, 't7【completed】:拿到真机原件里的 4 个 url');
      assert.equal(out.error, undefined, 't7: 成功路径不带 error');
      assert.equal(doFetch.calls.length, 4, 't7: 非终态继续轮询,终态就停');
      assert.deepEqual(seenProgress, [0, 99, 100], 't7【进度去重】:同一个进度值不重复上报');
      // 请求形态:GET {base}/tasks/{id} + Bearer + redirect:'manual'(带密钥不跟随 3xx)。
      assert.equal(doFetch.calls[0].url, `https://api.apimart.ai/v1/tasks/${TASK_ID}`, 't7: 轮询端点');
      assert.equal(doFetch.calls[0].opts.headers.Authorization, `Bearer ${KEY}`, 't7: 轮询带鉴权');
      assert.equal(doFetch.calls[0].opts.redirect, 'manual', "t7【安全】:轮询同样 redirect:'manual'");
      assert.ok(doFetch.calls[0].opts.signal, 't7: 轮询挂了 signal(可取消/单次超时)');
      // 先等再查:第一次 fetch 之前必须已经等过一轮(提交那一刻不可能出图)。
      assert.equal(sleep.seen.length, 4, 't7: 每轮各等一次');
      // 本进程把间隔下调到 30ms 只为让 t10 秒级跑完;"默认 5s"这条锁在 t8 的源码断言里。
      assert.equal(sleep.seen[0].ms, Number(process.env.CGUI_IMAGE_TASK_POLL_INTERVAL_MS),
        't7: 每轮等的是配置的轮询间隔');
      assert.ok(sleep.seen[0].hasSignal, 't7【可中断等待】:sleep 收到 signal,取消不必等满 5s');
    }

    // ② failed:上游给了原因就带上,没给也要有人话。
    {
      const ac = new AbortController();
      const out = await pollTask(
        { taskId: TASK_ID, provider: PROVIDER, signal: ac.signal },
        {
          fetch: scriptedFetch([reply(200, { data: { status: 'failed', progress: 0, error: { message: 'Banned prompt detected' } } })]),
          sleep: fakeSleep(),
          now: () => 0,
        },
      );
      assert.equal(out.urls, undefined, 't7【failed】:不产出 url');
      assert.match(out.error, /上游任务失败/, 't7: 失败文案');
      assert.match(out.error, /Banned prompt detected/, 't7: 带上上游给的原因');

      const noWhy = await pollTask(
        { taskId: TASK_ID, provider: PROVIDER, signal: new AbortController().signal },
        { fetch: scriptedFetch([reply(200, { data: { status: 'failed' } })]), sleep: fakeSleep(), now: () => 0 },
      );
      assert.match(noWhy.error, /上游未给出原因/, 't7: 上游不说原因时也有人话');

      // 上游主动取消也停,但不许说成"失败"(常见于敏感词拦截后的自动退款)。
      const cx = await pollTask(
        { taskId: TASK_ID, provider: PROVIDER, signal: new AbortController().signal },
        {
          fetch: scriptedFetch([reply(200, { data: { status: 'cancelled', fail_reason: 'Banned prompt detected' } })]),
          sleep: fakeSleep(),
          now: () => 0,
        },
      );
      assert.match(cx.error, /上游任务已取消/, 't7【文案】:cancelled 如实说"已取消"');
      assert.ok(!/失败/.test(cx.error), `t7: 不许把取消说成失败(实际 ${cx.error})`);
      assert.match(cx.error, /Banned prompt detected/, 't7: 取消原因照样带上');
    }

    // ⑤ 上游谎报张数:pollTask 交给下载分支的链接数必须已经被封死在上限之内。
    {
      const many = {
        code: 200,
        data: {
          status: 'completed',
          result: { images: [{ url: Array.from({ length: 5000 }, (_, i) => `https://a.example/${i}.png`) }] },
        },
      };
      const out = await pollTask(
        { taskId: TASK_ID, provider: PROVIDER, signal: new AbortController().signal },
        { fetch: scriptedFetch([reply(200, many)]), sleep: fakeSleep(), now: () => 0 },
      );
      assert.equal(out.urls.length, MAX_TASK_IMAGES,
        `t7【上限贯通】:5000 条到 pollTask 出口只剩 ${MAX_TASK_IMAGES} 条(实际 ${out.urls.length})`);
    }

    // ③ 超时:到 15 分钟上限判死,文案要说明平台侧可能仍在跑(否则用户以为白花钱)。
    {
      const doFetch = scriptedFetch([reply(200, progressing(10))]);
      const out = await pollTask(
        { taskId: TASK_ID, provider: PROVIDER, signal: new AbortController().signal },
        { fetch: doFetch, sleep: fakeSleep(), now: stepClock(10 * 60 * 1000) },
      );
      // 时钟:deadline = 10min + 15min = 25min;第 1 轮 20min 继续,第 2 轮 30min 超限。
      assert.equal(doFetch.calls.length, 1, 't7【超时】:到点就不再发查询');
      assert.match(out.error, /超时/, 't7: 超时文案');
      assert.match(out.error, /15 分钟/, 't7: 说清本地上限是 15 分钟');
      assert.match(out.error, /平台侧任务可能仍在生成/, 't7: 说明上游可能还在跑(别让用户以为没了)');
    }

    // ④ 取消:等待被打断后立刻回 cancelled,不再发查询、也不写 error 文案。
    {
      const ac = new AbortController();
      ac.abort();
      const doFetch = scriptedFetch([reply(200, RESULT)]);
      const out = await pollTask(
        { taskId: TASK_ID, provider: PROVIDER, signal: ac.signal },
        { fetch: doFetch, sleep: fakeSleep(), now: () => 0 },
      );
      assert.deepEqual(out, { cancelled: true }, 't7【取消】:回 cancelled,不带 error');
      assert.equal(doFetch.calls.length, 0, 't7: 取消后一次查询都不发');
    }
    // 取消发生在查询途中(fetch 抛 AbortError)同样落 cancelled,不当成网络抖动继续轮。
    {
      const ac = new AbortController();
      let n = 0;
      const doFetch = async () => { n += 1; ac.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
      const out = await pollTask(
        { taskId: TASK_ID, provider: PROVIDER, signal: ac.signal },
        { fetch: doFetch, sleep: async () => {}, now: () => 0 },
      );
      assert.deepEqual(out, { cancelled: true }, 't7: 查询途中被取消也落 cancelled');
      assert.equal(n, 1, 't7: 不再重试');
    }

    // ⑥ 抖动不判死 / 确定性错误判死。
    {
      // 5xx、429、网络异常各一次后成功 —— 任务在上游照跑,单次查不到不该毙掉整个任务。
      const doFetch = scriptedFetch([
        reply(502, { error: 'bad gateway' }),
        reply(429, { error: 'slow down' }),
        () => { throw new Error('fetch failed'); },
        reply(200, RESULT),
      ]);
      const out = await pollTask(
        { taskId: TASK_ID, provider: PROVIDER, signal: new AbortController().signal },
        { fetch: doFetch, sleep: fakeSleep(), now: () => 0 },
      );
      assert.equal(out.urls?.length, 4, 't7【抖动不判死】:5xx/429/网络异常后仍能拿到结果');
      assert.equal(doFetch.calls.length, 4, 't7: 三次抖动都重试了');

      // 4xx(id 不存在 / 鉴权变了)是确定性错误 → 立刻判死,不空转 15 分钟。
      const dead = await pollTask(
        { taskId: TASK_ID, provider: PROVIDER, signal: new AbortController().signal },
        { fetch: scriptedFetch([reply(404, { message: 'task not found' })]), sleep: fakeSleep(), now: () => 0 },
      );
      assert.match(dead.error, /HTTP 404/, 't7【4xx 判死】:带上状态码');
      assert.match(dead.error, /task not found/, 't7: 带上上游原文');

      // 非 JSON(中转站回 HTML 错误页)同样判死,不空转。
      const notJson = await pollTask(
        { taskId: TASK_ID, provider: PROVIDER, signal: new AbortController().signal },
        { fetch: scriptedFetch([reply(200, null, '<html>502</html>')]), sleep: fakeSleep(), now: () => 0 },
      );
      assert.match(notJson.error, /不是 JSON/, 't7: 非 JSON 判死');

      // 3xx:带着密钥不跟随(与生成 POST / 图片下载同口径)。
      const redir = await pollTask(
        { taskId: TASK_ID, provider: PROVIDER, signal: new AbortController().signal },
        { fetch: scriptedFetch([reply(302, {})]), sleep: fakeSleep(), now: () => 0 },
      );
      assert.match(redir.error, /重定向/, 't7【安全】:3xx 拒绝跟随');
      assert.match(redir.error, /已拒绝跟随/, 't7: 说明理由');

      // completed 但没有可用链接 → 明说,不是静默成功也不是"没找到图片"。
      const empty = await pollTask(
        { taskId: TASK_ID, provider: PROVIDER, signal: new AbortController().signal },
        { fetch: scriptedFetch([reply(200, { data: { status: 'completed', result: { images: [] } } })]), sleep: fakeSleep(), now: () => 0 },
      );
      assert.match(empty.error, /已完成但没有返回可用的图片链接/, 't7: 完成但无图有专门文案');
    }

    // ⑦ 密钥绝不外泄:上游把 Authorization 回显进错误正文时必须被剥掉。
    {
      const leak = await pollTask(
        { taskId: TASK_ID, provider: PROVIDER, signal: new AbortController().signal },
        {
          fetch: scriptedFetch([reply(401, { message: `invalid key Bearer ${KEY}` })]),
          sleep: fakeSleep(),
          now: () => 0,
        },
      );
      assert.ok(!leak.error.includes(KEY), `t7【密钥不外泄】:错误文案里不得出现明文密钥(实际 ${leak.error})`);
      assert.match(leak.error, /\*\*\*/, 't7: 已被 redactKey 打码');
    }

    // ⑧ 入参非法不抛,回可读错误(taskId 空 / baseURL 空)。
    {
      for (const [bad, why] of [[{ baseURL: '', apiKey: KEY }, '空 baseURL'], [null, 'taskId 空']]) {
        const out = await pollTask(
          { taskId: bad === null ? '' : TASK_ID, provider: bad || PROVIDER, signal: new AbortController().signal },
          { fetch: scriptedFetch([reply(200, RESULT)]), sleep: fakeSleep(), now: () => 0 },
        );
        assert.match(out.error, /无法构造任务查询请求/, `t7: ${why} → 可读错误而不是抛栈`);
      }
    }
  }

  // ───────────── 8. 源码锁:接线位置与既有安全链路 ─────────────
  {
    const src = readFileSync(join(REPO, 'server/routes/image.js'), 'utf8');
    const runnerStart = src.indexOf('async function runImageJob');
    const pollStart = src.indexOf('export async function pollTask');
    assert.ok(pollStart > 0 && runnerStart > 0, 't8: pollTask 与 runImageJob 都在');
    // check-r51 的锚点锁按 runImageJob→router 的源码切片计数,pollTask 落进切片里会把
    // "既有链路一行未动"这条锁的语义搞错 —— 位置本身就是契约。
    assert.ok(pollStart < runnerStart, 't8【位置契约】:pollTask 必须定义在 runImageJob 之前');

    const poll = src.slice(pollStart, runnerStart);
    assert.match(poll, /redirect: 'manual'/, "t8: 轮询带 redirect:'manual'");
    assert.match(poll, /readCapped\(/, 't8: 轮询响应限量读');
    assert.match(poll, /redactKey\(/, 't8: 轮询错误透传前剥密钥');
    assert.match(poll, /\.\.\.proxy/, 't8: 轮询走 provider 自己的代理');
    assert.match(poll, /AbortSignal\.any\(\[signal/, 't8: 轮询可被取消,且单次查询有超时');
    assert.match(src, /TASK_POLL_DEADLINE_MS = 15 \* 60 \* 1000/, 't8: 15 分钟本地上限写在常量里');
    assert.match(src, /TASK_POLL_INTERVAL_MS = Math\.max\(200, Number\(process\.env\.CGUI_IMAGE_TASK_POLL_INTERVAL_MS\) \|\| 5_000\)/,
      't8: 5s 轮询间隔写在常量里,下调口有 200ms 地板(0.1 这类小正数会变成紧轮询打上游)');
    assert.match(poll, /st\.status === 'failed' \|\| st\.status === 'cancelled'/, 't8: 两种终态都停,但措辞分开');
    assert.match(poll, /上游任务已取消/, 't8【文案】:上游主动取消不说成"失败"');

    const runner = src.slice(runnerStart, src.indexOf("router.post('/image/generate'", runnerStart));
    // 顺序契约:先试同步取图,取不到才试任务制 —— 反过来会让同步响应绕道轮询。
    assert.ok(runner.indexOf('extractImage(provider.protocol, data)') < runner.indexOf('extractTaskId(data)'),
      't8【顺序】:extractImage 先于 extractTaskId');
    assert.match(runner, /if \(polled\.cancelled\) return;/, 't8: 轮询期间被取消不覆写状态');
    assert.match(runner, /pickedList = polled\.urls\.map/, 't8: 多张图逐张走既有下载分支');
    assert.match(runner, /for \(const picked of pickedList\)/, 't8: 下载/落盘对多图循环执行');
    assert.match(runner, /files\.length > 1 \? \{ files \}/, 't8: 单图任务不写 files 字段(与 r82 前逐字一致)');
    // 既有安全链路锚点数不变(check-r51 同款判据,这里再钉一次:轮询没把它们冲淡)。
    const count = (s, re) => (s.match(re) || []).length;
    assert.equal(count(runner, /redirect: 'manual'/g), 2, 't8: runner 内仍是两处 redirect(生成 POST + 下载)');
    assert.equal(count(runner, /await assertPublicBaseURL\(/g), 1, 't8: 下载链接的 SSRF 复检仍在 runner 内');
    assert.equal(count(runner, /readCapped\(/g), 2, 't8: runner 内仍是两处限量读');

    // 上限必须是循环里的 break —— 事后 slice 时 O(n²) 的去重已经跑完了(30 秒冻结照旧)。
    const proto = readFileSync(join(REPO, 'server/utils/image-protocols.js'), 'utf8');
    assert.match(proto, /export const MAX_TASK_IMAGES = 16;/, 't8: 张数上限写成常量');
    assert.match(proto, /urls\.push\(u\);\s*\n\s*if \(urls\.length >= MAX_TASK_IMAGES\) break capped;/,
      't8【必须 break】:超限在拍平循环里断,不许改成事后 slice');
    assert.ok(!/\.slice\(0, MAX_TASK_IMAGES\)/.test(proto), 't8: 不许出现事后 slice 的写法');
  }

  // ───── 8b. 轮询间隔地板:环境变量填 0.1 也不许变成紧轮询(子进程实测,不是只看源码) ─────
  {
    const { execFileSync } = await import('node:child_process');
    // 子进程里把 env 设成 0.1,注入 sleep 观察真正等的毫秒数;fetch 一次就回终态,不打网络。
    const probe = `
      process.env.HOME = ${JSON.stringify(TMP_HOME)};
      process.env.USERPROFILE = ${JSON.stringify(TMP_HOME)};
      const { pollTask } = await import(${JSON.stringify(join(REPO, 'server/routes/image.js'))});
      let waited = null;
      await pollTask(
        { taskId: 't', provider: { baseURL: 'https://a.co/v1', apiKey: 'k', proxyUrl: '' }, signal: new AbortController().signal },
        {
          sleep: async (ms) => { waited = ms; },
          now: () => 0,
          fetch: async () => ({
            status: 200, ok: true, headers: new Map(), body: {
              cancel: async () => {},
              async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ data: { status: 'failed' } })); },
            },
          }),
        },
      );
      console.log(String(waited));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      env: { ...process.env, CGUI_IMAGE_TASK_POLL_INTERVAL_MS: '0.1' },
      encoding: 'utf8',
    }).trim();
    assert.equal(out, '200', `t8b【地板】:env 填 0.1 时实际仍等 200ms(实际 ${out}ms —— 紧轮询会把用户自己的中转站打崩)`);
  }

  // ───────────── 9. 前端源码:协议选项与三条"不说就会被误解"的文案 ─────────────
  {
    const src = readFileSync(join(REPO, 'client/src/components/ImagePanel.jsx'), 'utf8');
    const count = (re) => (src.match(re) || []).length;
    assert.match(src, /\{ id: 'mj', label: '[^']*midjourney\/generations[^']*' \}/, 't9: 协议下拉里有 mj 且标出端点');
    // 差异必须写出来 —— 不写的话用户会按同步协议的直觉填尺寸/参考图,然后"填了没生效"。
    assert.match(src, /form\.protocol === 'mj' &&/, 't9: mj 选中时才显示协议说明');
    // r84:尺寸改为下发(它是宽高比),文案随之改口径;"模型名不发送"这条结论不变。
    assert.match(src, /模型名不发送，由该路由自动注入/, 't9【文案】:说明模型名不下发');
    assert.match(src, /当前版本不支持参考图/, 't9【文案】:说明参考图不下发');
    assert.match(src, /每 5 秒查询一次任务状态/, 't9【文案】:说明轮询节奏');
    assert.match(src, /超过 15 分钟未出结果记为失败/, 't9【文案】:说明本地上限与平台侧仍在跑');
    assert.match(src, /selected\?\.protocol === 'mj' && refs\.length > 0/, 't9: 选了参考图又用 mj 时当场提示(不静默丢弃)');
    // 取消:上游仍在计费这件事必须出现在条目上(网格与列表两处都要)。
    assert.match(src, /const CANCEL_NOTE = '已停止等待（上游任务可能仍在生成并计费）'/, 't9: 取消说明写成常量');
    assert.equal(count(/CANCEL_NOTE/g), 3, 't9: 常量 1 处定义 + 网格/列表各 1 处渲染');
    // 进度与多图张数:两种视图都得有,否则切个视图信息就没了。
    assert.equal(count(/h\.progress == null \? '' : ` · \$\{h\.progress\}%`/g), 2, 't9: 进度在网格与列表都显示');
    assert.equal(count(/h\.files\?\.length > 1 \?/g), 2, 't9: 多图张数在网格与列表都显示');
    // 既有渲染不许被顺手改坏(check-r51 t7 的同款锚,这里再钉一次)。
    assert.match(src, /生成中 · \$\{elapsedSec\(h\)\}s/, 't9【零回归】:列表仍显示已耗时');
    assert.match(src, /text-error[^>]*>\{h\.error/, 't9【零回归】:报错文字仍渲染在图块内');
  }

  // ───── 10. 端到端:本机假上游跑完 提交→轮询→4 张全落盘,证明接线真的通 ─────
  // t8 的源码锁只能证明"写了",这一节证明"跑得起来":多图循环、撞名加序号、files 字段、
  // 进度写盘、取消后名额归还。绝不打真实网络 —— 上游与图片链接都指向这个本机假服务。
  {
    const express = (await import('express')).default;
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const app = express();
    app.use(express.json({ limit: '2mb' }));

    const seenSubmits = [];
    let pollCount = 0;
    // 提交:回真机原件的形态(data 是数组、只有 task_id)。
    app.post('/mj/v1/midjourney/generations', (req, res) => {
      seenSubmits.push({ body: req.body, auth: req.headers.authorization });
      res.json(SUBMIT);
    });
    // 轮询:前两次 processing(带进度),第三次 completed —— 4 个链接指回本机图片口。
    app.get('/mj/v1/tasks/:id', (req, res) => {
      pollCount += 1;
      if (req.params.id !== TASK_ID) return res.status(404).json({ message: 'task not found' });
      if (pollCount < 3) return res.json({ code: 200, data: { id: TASK_ID, status: 'processing', progress: pollCount * 30 } });
      return res.json({
        code: 200,
        data: {
          id: TASK_ID,
          status: 'completed',
          progress: 100,
          result: { images: [{ url: [0, 1, 2, 3].map((i) => `http://127.0.0.1:${server.address().port}/img/${i}.png`) }] },
        },
      });
    });
    // 永不完成的任务:用来验"取消不会把并发名额卡死"。
    app.post('/never/v1/midjourney/generations', (_req, res) => res.json({ code: 200, data: [{ task_id: 'task_never' }] }));
    app.get('/never/v1/tasks/:id', (_req, res) => res.json({ code: 200, data: { status: 'processing', progress: 1 } }));
    app.get('/img/:n.png', (_req, res) => res.type('image/png').send(PNG));
    app.use('/api', (await import('../../server/routes/image.js')).default);

    // 端口取 OS 临时口:写死会被同跑的用例抢,制造随机假红。
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

    const BASE = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, path, body) => {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON:留 text 给断言 */ }
      return { status: r.status, text, json };
    };
    const waitFor = async (fn, ms = 15000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const entryOf = async (id) => {
      const h = await api('GET', '/api/image/history');
      return (h.json?.history || []).find((e) => e.id === id) || null;
    };

    try {
      // ① 多图任务:一次落 4 个文件。
      const mk = await api('POST', '/api/image-providers', {
        name: 'MJ 假上游', protocol: 'mj', baseURL: `${BASE}/mj/v1`, apiKey: KEY, model: 'midjourney',
        size: '16:9', savePath: SAVE_DIR,
      });
      assert.equal(mk.status, 200, `t10: mj provider 建得起来(${mk.text})`);

      const sub = await api('POST', '/api/image/generate', { providerId: mk.json.id, prompt: '一只猫' });
      assert.equal(sub.status, 200, `t10: 提交受理(${sub.text})`);
      assert.ok(sub.json.jobId, 't10: 秒回 jobId(与既有任务化口径一致)');

      // 提交请求形态:prompt + size(r84 起 size 当宽高比下发),不带 model / n。
      const submitted = await waitFor(async () => (seenSubmits.length ? seenSubmits[0] : null), 5000);
      assert.ok(submitted, 't10: 上游收到了提交');
      assert.deepEqual(submitted.body, { prompt: '一只猫', size: '16:9' }, 't10【下发内容】:prompt + size,不带 model / n');
      assert.equal(submitted.auth, `Bearer ${KEY}`, 't10: 提交带鉴权');

      // 轮询期间:进度写进历史条目(状态仍是 running)。
      const sawProgress = await waitFor(async () => {
        const e = await entryOf(sub.json.jobId);
        return e && e.status === 'running' && typeof e.progress === 'number' ? e : null;
      }, 8000);
      assert.ok(sawProgress, 't10【进度】:轮询期间把 progress 写进条目');
      assert.equal(sawProgress.status, 'running', 't10: 写进度不改状态');

      const done = await waitFor(async () => {
        const e = await entryOf(sub.json.jobId);
        return e && e.status !== 'running' ? e : null;
      });
      assert.ok(done, 't10: 15s 内落终态');
      assert.equal(done.status, 'done', `t10【端到端】:多图任务必须成功(实际 ${done.status} / ${done.error})`);
      assert.equal(done.files?.length, 4, `t10【多图】:4 个链接落 4 个文件(实际 ${JSON.stringify(done.files)})`);
      assert.equal(done.file, done.files[0], 't10: file 仍指第一张(既有 UI 不用改)');
      assert.match(done.previewUrl, /\/api\/image\/preview\?file=/, 't10: previewUrl 指向第一张');
      assert.equal(done.bytes, PNG.length * 4, 't10: bytes 是 4 张之和');
      // 同一秒落 4 张同名图 → saveImage 的 wx + 序号必须让 4 张都活下来。
      const onDisk = readdirSync(SAVE_DIR).filter((f) => f.endsWith('.png'));
      assert.equal(onDisk.length, 4, `t10【撞名】:4 张全在磁盘上(实际 ${onDisk.join(',')})`);
      assert.equal(new Set(done.files).size, 4, 't10: 4 个路径互不相同');
      for (const f of done.files) assert.ok(existsSync(f), `t10: ${f} 真的在磁盘上`);

      // ② 取消一个永不完成的任务:条目落 cancelled,且并发名额归还(还能再发)。
      const nv = await api('POST', '/api/image-providers', {
        name: '永不完成', protocol: 'mj', baseURL: `${BASE}/never/v1`, apiKey: KEY, model: 'midjourney', savePath: SAVE_DIR,
      });
      const stuck = await api('POST', '/api/image/generate', { providerId: nv.json.id, prompt: '不会好' });
      assert.equal(stuck.status, 200, 't10: 卡住的任务也先受理');
      await waitFor(async () => {
        const e = await entryOf(stuck.json.jobId);
        return e && typeof e.progress === 'number' ? e : null;
      }, 5000);
      const t0 = Date.now();
      const cx = await api('POST', `/api/image/jobs/${stuck.json.jobId}/cancel`);
      assert.equal(cx.json?.ok, true, 't10: 取消端点受理');
      const cancelled = await waitFor(async () => {
        const e = await entryOf(stuck.json.jobId);
        return e?.status === 'cancelled' ? e : null;
      }, 5000);
      assert.ok(cancelled, 't10【取消】:轮询中的任务能被取消');
      assert.ok(Date.now() - t0 < 2000, `t10【可中断等待】:取消要立刻落地,不等满一轮(实际 ${Date.now() - t0}ms)`);
      assert.ok(!cancelled.error, 't10: 取消不写 error 文案(与 r54 口径一致)');

      // 名额归还:连开 3 个卡住的任务仍能受理(上限 3),说明取消掉的那个没占着不放。
      const again = await api('POST', '/api/image/generate', { providerId: nv.json.id, prompt: '再来' });
      assert.equal(again.status, 200, `t10【名额归还】:取消后还能发新任务(实际 ${again.status} ${again.text})`);
      await api('POST', `/api/image/jobs/${again.json.jobId}/cancel`);
    } finally {
      server.closeAllConnections?.();
      server.close();
      await new Promise((r) => server.once('close', r));
    }
  }
} catch (e) {
  failure = e;
} finally {
  for (const d of [TMP_HOME, SAVE_DIR]) rmSync(d, { recursive: true, force: true });
}
if (failure) throw failure;

console.log('✓ check-r82-image-async: mj 组装 + 任务三态/4-url 拍平 + 同步三协议零回归 全部通过');
