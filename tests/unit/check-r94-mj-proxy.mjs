#!/usr/bin/env node
// r94-A:midjourney-proxy 第二协议的协议层(INTERFACE §4.1–§4.5)+ image-protocols 转出与
// 既有回归锁(§4.6)+ apimart 带参考图形态(§4.7)+ 动作构造第五参数(§4.8)。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/INTERFACE-r94.md 写,不看实现。
// 断言名带 INTERFACE 编号(§4.x / R* / M*)。
//
// 核心牙:
//  ① baseURL 规范化必须【连末尾 /mj 一起剥】—— 用户按 README 抄的地址就是 https://host/mj,
//    不剥就会打到 /mj/mj/submit/imagine(M23)。
//  ② 双鉴权头:proxy 原版认 mj-api-secret,经 one-api/new-api 代理时认 Bearer,同时发才能跨站(M24)。
//  ③ 无 customId 的 reroll 不许拼 change 请求(原版能收但本轮不放行)—— 必须抛中文错(M25)。
//  ④ cost/creditsCost 恒 null 不许写 0:0 会在账单里显示成"这单免费"(M21)。
//  ⑤ 未知 status 判 processing 不判 failed:proxy 的状态机会加新值,判死会让在跑的任务被标失败(M20)。
//
// 零网络、零真实配置:纯函数直接 import,不发任何请求。
// Run: node tests/unit/check-r94-mj-proxy.mjs
import assert from 'node:assert/strict';

let PASS = 0;
let FAILS = 0;
const failed = [];
function check(name, fn) {
  try {
    fn();
    PASS++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    FAILS++;
    failed.push(name);
    const msg = String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ');
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}
const isCn = (s) => typeof s === 'string' && /[一-龥]/.test(s);

console.log('\n[A] §4.1–§4.5 midjourney-proxy 协议层');

let PR = null;
let PRERR = '';
try {
  PR = await import('../../server/utils/image-protocols.js');
} catch (e) {
  PRERR = String((e && e.message) || e);
}
check('A0 image-protocols.js 可 import', () => assert.ok(PR, `import 失败:${PRERR}`));

// §7.5 的 G7 提到 server/utils/mj-proxy.js:proxy 五函数可能落在那儿再由 image-protocols 转出。
// 两个落点都取一遍,以先找到的为准 —— 契约只要求"能拿到且与 buildImageRequest 的分支逐字相同"。
let MJP = null;
try { MJP = await import('../../server/utils/mj-proxy.js'); } catch { MJP = null; }
const pick = (name) => PR?.[name] || MJP?.[name];

const buildProxyImagineRequest = pick('buildProxyImagineRequest');
const extractProxySubmitId = pick('extractProxySubmitId');
const buildProxyPollRequest = pick('buildProxyPollRequest');
const extractProxyTaskState = pick('extractProxyTaskState');
const buildProxyActionRequest = pick('buildProxyActionRequest');
const buildImageRequest = PR?.buildImageRequest;
const buildMjActionRequest = PR?.buildMjActionRequest;

const KEY = 'sk-r94-proxy-secret-abcdef';
const CFG = { protocol: 'mj-proxy', baseURL: 'https://proxy.example.com', apiKey: KEY, model: 'midjourney' };
const B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const imgRef = (over = {}) => ({ role: 'image', name: 'a.png', mime: 'image/png', base64: B64, ...over });

// ══════════════════════════════════════════════════════════════════════════
// §4.1 buildProxyImagineRequest
// ══════════════════════════════════════════════════════════════════════════
check('§4.1 buildProxyImagineRequest 已导出且是函数', () => {
  assert.equal(typeof buildProxyImagineRequest, 'function');
});
check('§4.1 url = 规范化 baseURL + /mj/submit/imagine', () => {
  assert.strictEqual(buildProxyImagineRequest(CFG, 'cat', []).url, 'https://proxy.example.com/mj/submit/imagine');
});
check('M23/§4.1 baseURL 规范化:末尾斜杠与末尾 /mj 都剥掉(三种写法同一个 url)', () => {
  const urls = ['https://proxy.example.com', 'https://proxy.example.com/', 'https://proxy.example.com/mj',
    'https://proxy.example.com/mj/'].map((baseURL) => buildProxyImagineRequest({ ...CFG, baseURL }, 'cat', []).url);
  assert.deepEqual(urls, Array(4).fill('https://proxy.example.com/mj/submit/imagine'),
    `四种写法必须归一(实得 ${JSON.stringify(urls)})`);
});
check('M24/§4.1 headers 同时含 mj-api-secret、Bearer 与 Content-Type', () => {
  const h = buildProxyImagineRequest(CFG, 'cat', []).headers;
  assert.strictEqual(h['mj-api-secret'], KEY, 'proxy 原版认这个头');
  assert.strictEqual(h.Authorization, `Bearer ${KEY}`, 'one-api/new-api 代理时认 Bearer');
  assert.strictEqual(h['Content-Type'], 'application/json');
});
check('§4.1 body.prompt 含编译后的 flags(--ar 与 --v)', () => {
  const b = buildProxyImagineRequest({ ...CFG, size: '16:9', mjVersion: '7' }, 'cat', []).body;
  assert.ok(b.prompt.includes('--ar 16:9'), `prompt 应含 --ar 16:9(实得 ${JSON.stringify(b.prompt)})`);
  assert.ok(b.prompt.includes('--v 7'), `prompt 应含 --v 7(实得 ${JSON.stringify(b.prompt)})`);
});
check('§4.1 无 refs / 速度 / 版本时 body 键集合恰为 [prompt]', () => {
  assert.deepEqual(Object.keys(buildProxyImagineRequest(CFG, 'cat', []).body), ['prompt']);
});
check('§4.1 mjSpeed fast / turbo 走 accountFilter.modes;空串时无该键', () => {
  assert.deepEqual(buildProxyImagineRequest({ ...CFG, mjSpeed: 'fast' }, 'cat', []).body.accountFilter, { modes: ['FAST'] });
  assert.deepEqual(buildProxyImagineRequest({ ...CFG, mjSpeed: 'turbo' }, 'cat', []).body.accountFilter, { modes: ['TURBO'] });
  assert.ok(!('accountFilter' in buildProxyImagineRequest({ ...CFG, mjSpeed: '' }, 'cat', []).body), '空速度不发该键');
});
check('§4.1 mjVersion niji7 / niji6 发 botType NIJI_JOURNEY,其余版本无该键', () => {
  for (const v of ['niji7', 'niji6']) {
    assert.strictEqual(buildProxyImagineRequest({ ...CFG, mjVersion: v }, 'cat', []).body.botType, 'NIJI_JOURNEY', `version=${v}`);
  }
  for (const v of ['7', '8.2', '6.1', '']) {
    assert.ok(!('botType' in buildProxyImagineRequest({ ...CFG, mjVersion: v }, 'cat', []).body), `version=${v} 不该发 botType`);
  }
});
check('§4.1 role image 的 refs 编成 base64Array,顺序与入参一致、mime 小写', () => {
  const refs = [imgRef({ name: 'a.png' }), imgRef({ name: 'b.jpg', mime: 'IMAGE/JPEG' })];
  const b = buildProxyImagineRequest(CFG, 'cat', refs).body;
  assert.ok(Array.isArray(b.base64Array), `base64Array 应是数组(实得 ${typeof b.base64Array})`);
  assert.equal(b.base64Array.length, 2);
  assert.ok(b.base64Array[0].startsWith('data:image/png;base64,'), `第一张前缀(实得 ${String(b.base64Array[0]).slice(0, 30)})`);
  assert.ok(b.base64Array[1].startsWith('data:image/jpeg;base64,'), 'mime 必须小写');
  assert.strictEqual(b.base64Array[0].slice('data:image/png;base64,'.length), B64, 'dataURI 里是该图的 base64');
});
check('§4.1 role image 且 kind 为 url:抛中文 Error(该协议不支持 URL 垫图)', () => {
  assert.throws(() => buildProxyImagineRequest(CFG, 'cat', [{ role: 'image', kind: 'url', url: 'https://x/a.png' }]),
    (e) => isCn(e.message), 'URL 垫图必须当场抛中文错,不许静默丢');
});
check('§4.1 refs 为空 / null 时无 base64Array 键', () => {
  assert.ok(!('base64Array' in buildProxyImagineRequest(CFG, 'cat', []).body));
  assert.ok(!('base64Array' in buildProxyImagineRequest(CFG, 'cat', null).body));
});
check('§4.1 form 与 altHeaders 恒 null', () => {
  const r = buildProxyImagineRequest(CFG, 'cat', [imgRef()]);
  assert.strictEqual(r.form, null);
  assert.strictEqual(r.altHeaders, null);
});
check('§4.1 baseURL 空 或 prompt 空 → 抛中文 Error', () => {
  assert.throws(() => buildProxyImagineRequest({ ...CFG, baseURL: '' }, 'cat', []), (e) => isCn(e.message), '空 baseURL');
  assert.throws(() => buildProxyImagineRequest(CFG, '', []), (e) => isCn(e.message), '空 prompt');
  assert.throws(() => buildProxyImagineRequest(CFG, '   ', []), (e) => isCn(e.message), '纯空白 prompt');
});

// ══════════════════════════════════════════════════════════════════════════
// §4.2 extractProxySubmitId
// ══════════════════════════════════════════════════════════════════════════
check('§4.2 extractProxySubmitId 已导出且是函数', () => {
  assert.equal(typeof extractProxySubmitId, 'function');
});
check('§4.2 code 1 / 21 / 22 都算受理,取 result 当 taskId', () => {
  for (const code of [1, 21, 22]) {
    assert.deepEqual(extractProxySubmitId({ code, result: '17xx' }), { taskId: '17xx', error: null }, `code=${code}`);
  }
});
check('§4.2 code 24(敏感词)与 23(队列已满)→ taskId null、error 含上游原文', () => {
  const a = extractProxySubmitId({ code: 24, description: '含敏感词' });
  assert.strictEqual(a.taskId, null);
  assert.ok(a.error && a.error.includes('含敏感词'), `error 要带原文(实得 ${JSON.stringify(a.error)})`);
  const b = extractProxySubmitId({ code: 23, description: '队列已满' });
  assert.strictEqual(b.taskId, null);
  assert.ok(b.error && b.error.includes('队列已满'));
});
check('§4.2 空 result / 空对象 / null / 字符串 / result 非串 → taskId null 且 error 非空', () => {
  for (const bad of [{ code: 1, result: '' }, {}, null, 'x', { result: 42 }]) {
    const r = extractProxySubmitId(bad);
    assert.strictEqual(r.taskId, null, `输入 ${JSON.stringify(bad) ?? String(bad)} 不该给出 taskId`);
    assert.ok(typeof r.error === 'string' && r.error.length > 0, `输入 ${JSON.stringify(bad) ?? String(bad)} 必须给人话`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// §4.3 buildProxyPollRequest
// ══════════════════════════════════════════════════════════════════════════
check('§4.3 buildProxyPollRequest 已导出且是函数', () => {
  assert.equal(typeof buildProxyPollRequest, 'function');
});
check('§4.3 url = 规范化 baseURL + /mj/task/{id}/fetch', () => {
  assert.strictEqual(buildProxyPollRequest('https://proxy.example.com/mj/', KEY, '1712').url,
    'https://proxy.example.com/mj/task/1712/fetch');
});
check('M22/§4.3 taskId 必须编码(含斜杠 / 空格的 id 不许原样拼进路径)', () => {
  const withSlash = buildProxyPollRequest('https://proxy.example.com', KEY, 'a/b').url;
  assert.ok(withSlash.includes(encodeURIComponent('a/b')), `实得 ${withSlash}`);
  assert.ok(!withSlash.includes('/task/a/b/'), '未编码的斜杠会改变路径层级');
  const withSpace = buildProxyPollRequest('https://proxy.example.com', KEY, 'a b').url;
  assert.ok(withSpace.includes(encodeURIComponent('a b')), `实得 ${withSpace}`);
});
check('M24/§4.3 双鉴权头', () => {
  const h = buildProxyPollRequest('https://proxy.example.com', KEY, '1712').headers;
  assert.strictEqual(h['mj-api-secret'], KEY);
  assert.strictEqual(h.Authorization, `Bearer ${KEY}`);
});
check('§4.3 baseURL 空 或 taskId 空 → 抛中文 Error', () => {
  assert.throws(() => buildProxyPollRequest('', KEY, '1712'), (e) => isCn(e.message));
  assert.throws(() => buildProxyPollRequest('https://proxy.example.com', KEY, ''), (e) => isCn(e.message));
  assert.throws(() => buildProxyPollRequest('https://proxy.example.com', KEY, '   '), (e) => isCn(e.message));
});

// ══════════════════════════════════════════════════════════════════════════
// §4.4 extractProxyTaskState
// ══════════════════════════════════════════════════════════════════════════
check('§4.4 extractProxyTaskState 已导出且是函数', () => {
  assert.equal(typeof extractProxyTaskState, 'function');
});
check('§4.4 SUCCESS:completed / 100 / urls 单元素 / buttons 透传', () => {
  const s = extractProxyTaskState({
    status: 'SUCCESS', progress: '100%', imageUrl: 'https://x/a.png',
    buttons: [{ customId: 'MJ::JOB::upsample::1::h', label: 'U1' }],
  });
  assert.strictEqual(s.status, 'completed');
  assert.strictEqual(s.progress, 100);
  assert.deepEqual(s.urls, ['https://x/a.png']);
  assert.equal(s.buttons.length, 1);
  assert.strictEqual(s.buttons[0].customId, 'MJ::JOB::upsample::1::h');
});
check('§4.4 IN_PROGRESS:processing / 37 / urls 空', () => {
  const s = extractProxyTaskState({ status: 'IN_PROGRESS', progress: '37%' });
  assert.strictEqual(s.status, 'processing');
  assert.strictEqual(s.progress, 37);
  assert.deepEqual(s.urls, []);
});
check('M20/§4.4 NOT_START / SUBMITTED / MODAL / 未知状态 / 空对象一律 processing(不判 failed)', () => {
  for (const st of ['NOT_START', 'SUBMITTED', 'MODAL', '什么鬼']) {
    assert.strictEqual(extractProxyTaskState({ status: st }).status, 'processing', `status=${st}`);
  }
  assert.strictEqual(extractProxyTaskState({}).status, 'processing', '空对象');
});
check('§4.4 FAILURE:failed / message 含 failReason 原文 / urls 空', () => {
  const s = extractProxyTaskState({ status: 'FAILURE', failReason: 'Banned prompt detected' });
  assert.strictEqual(s.status, 'failed');
  assert.ok(String(s.message || '').includes('Banned prompt detected'), `message 要带原文(实得 ${JSON.stringify(s.message)})`);
  assert.deepEqual(s.urls, []);
});
check('§4.4 progress 解析:空/缺省/非数字 → null;负数钳 0;超 100 钳 100', () => {
  assert.strictEqual(extractProxyTaskState({ status: 'IN_PROGRESS', progress: '' }).progress, null);
  assert.strictEqual(extractProxyTaskState({ status: 'IN_PROGRESS' }).progress, null);
  assert.strictEqual(extractProxyTaskState({ status: 'IN_PROGRESS', progress: 'abc' }).progress, null);
  assert.strictEqual(extractProxyTaskState({ status: 'IN_PROGRESS', progress: '-5%' }).progress, 0);
  assert.strictEqual(extractProxyTaskState({ status: 'IN_PROGRESS', progress: '250%' }).progress, 100);
});
check('§4.4 imageUrl 非 http(s) 或空串 → urls 空数组', () => {
  for (const u of ['ftp://x/a.png', '']) {
    assert.deepEqual(extractProxyTaskState({ status: 'SUCCESS', imageUrl: u }).urls, [], `imageUrl=${JSON.stringify(u)}`);
  }
});
check('§4.4 SUCCESS 无 buttons 字段时 buttons 深等于空数组(不是 undefined)', () => {
  const s = extractProxyTaskState({ status: 'SUCCESS', imageUrl: 'https://x/a.png' });
  assert.deepEqual(s.buttons, []);
});
check('M21/§4.4 cost 与 creditsCost 恒 null(不许写 0:0 会在账单里显示成"这单免费")', () => {
  for (const d of [{ status: 'SUCCESS', imageUrl: 'https://x/a.png' }, { status: 'FAILURE' }, {}, null]) {
    const s = extractProxyTaskState(d);
    assert.strictEqual(s.cost, null, `cost 必须 null(输入 ${JSON.stringify(d)})`);
    assert.strictEqual(s.creditsCost, null, `creditsCost 必须 null(输入 ${JSON.stringify(d)})`);
  }
});
check('G10/§4.4 返回对象恰含 7 个键(status/progress/urls/message/cost/creditsCost/buttons)', () => {
  const probes = [
    { status: 'SUCCESS', progress: '100%', imageUrl: 'https://x/a.png', buttons: [] },
    { status: 'IN_PROGRESS', progress: '37%' }, { status: 'FAILURE', failReason: 'boom' }, {}, null,
  ];
  for (const d of probes) {
    const got = Object.keys(extractProxyTaskState(d)).sort();
    assert.deepEqual(got, ['buttons', 'cost', 'creditsCost', 'message', 'progress', 'status', 'urls'],
      `键集必须恰好这 7 个(输入 ${JSON.stringify(d)},实得 ${JSON.stringify(got)})`);
  }
});
check('G10/§4.4 各键类型:status 小写英文四选一、message 无则空串(不是 null)、urls 与 buttons 恒数组', () => {
  const OK = new Set(['processing', 'completed', 'failed', 'cancelled']);
  for (const d of [{ status: 'SUCCESS', imageUrl: 'https://x/a.png' }, { status: 'IN_PROGRESS' },
    { status: 'FAILURE', failReason: 'boom' }, {}, null, 'x']) {
    const s = extractProxyTaskState(d);
    assert.ok(OK.has(s.status), `status 越界:${JSON.stringify(s.status)}`);
    assert.equal(typeof s.message, 'string', `message 必须是字符串(输入 ${JSON.stringify(d)})`);
    assert.ok(Array.isArray(s.urls), 'urls 恒数组');
    assert.ok(Array.isArray(s.buttons), 'buttons 恒数组');
    assert.ok(s.progress === null || Number.isInteger(s.progress), `progress 必须是整数或 null(实得 ${s.progress})`);
  }
  assert.strictEqual(extractProxyTaskState({ status: 'SUCCESS', imageUrl: 'https://x/a.png' }).message, '',
    '成功时 message 是空串,不是 null');
});
check('§4.4 null / 字符串 / 数字入参 → processing 且不抛错', () => {
  for (const bad of [null, 'x', 42]) {
    assert.strictEqual(extractProxyTaskState(bad).status, 'processing', `输入 ${String(bad)}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// §4.5 buildProxyActionRequest
// ══════════════════════════════════════════════════════════════════════════
check('§4.5 buildProxyActionRequest 已导出且是函数', () => {
  assert.equal(typeof buildProxyActionRequest, 'function');
});
check('§4.5 带 customId:打 /mj/submit/action,body 深等于 {taskId, customId}', () => {
  const r = buildProxyActionRequest(CFG, { taskId: 't1', customId: 'MJ::JOB::upsample::2::h', kind: 'pick', index: 2 });
  assert.ok(r.url.endsWith('/mj/submit/action'), `实得 ${r.url}`);
  assert.deepEqual(r.body, { taskId: 't1', customId: 'MJ::JOB::upsample::2::h' });
});
check('§4.5 无 customId + kind pick + index 2:打 /mj/submit/change,body {taskId, action:UPSCALE, index}', () => {
  const r = buildProxyActionRequest(CFG, { taskId: 't1', kind: 'pick', index: 2 });
  assert.ok(r.url.endsWith('/mj/submit/change'), `实得 ${r.url}`);
  assert.deepEqual(r.body, { taskId: 't1', action: 'UPSCALE', index: 2 });
});
check('§4.5 无 customId + kind variation + index 3:action VARIATION', () => {
  assert.deepEqual(buildProxyActionRequest(CFG, { taskId: 't1', kind: 'variation', index: 3 }).body,
    { taskId: 't1', action: 'VARIATION', index: 3 });
});
check('M25/§4.5 无 customId 的 reroll → 抛中文 Error', () => {
  assert.throws(() => buildProxyActionRequest(CFG, { taskId: 't1', kind: 'reroll', index: 1 }), (e) => isCn(e.message));
});
check('§4.5 无 customId 的 upscale/zoom/pan/inpaint → 抛中文 Error 且文案含「不支持」', () => {
  for (const kind of ['upscale', 'zoom', 'pan', 'inpaint']) {
    assert.throws(() => buildProxyActionRequest(CFG, { taskId: 't1', kind, index: 1 }),
      (e) => isCn(e.message) && e.message.includes('不支持'), `kind=${kind}`);
  }
});
check('§4.5 index 越界(0 / 5 / 2.5 / NaN)且无 customId → 抛中文 Error', () => {
  for (const index of [0, 5, 2.5, NaN, -1, null, undefined]) {
    assert.throws(() => buildProxyActionRequest(CFG, { taskId: 't1', kind: 'pick', index }),
      (e) => isCn(e.message), `index=${String(index)}`);
  }
});
check('§4.5 taskId 空 或 baseURL 空 → 抛中文 Error', () => {
  assert.throws(() => buildProxyActionRequest(CFG, { taskId: '', kind: 'pick', index: 1 }), (e) => isCn(e.message));
  assert.throws(() => buildProxyActionRequest({ ...CFG, baseURL: '' }, { taskId: 't', kind: 'pick', index: 1 }), (e) => isCn(e.message));
});
check('M24/§4.5 headers 双鉴权头 + Content-Type', () => {
  const h = buildProxyActionRequest(CFG, { taskId: 't1', customId: 'MJ::JOB::upsample::1::h' }).headers;
  assert.strictEqual(h['mj-api-secret'], KEY);
  assert.strictEqual(h.Authorization, `Bearer ${KEY}`);
  assert.strictEqual(h['Content-Type'], 'application/json');
});

// ══════════════════════════════════════════════════════════════════════════
// §4.6 image-protocols 转出与既有回归
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §4.6 转出与既有回归');

check('R4/§4.6 IMAGE_PROTOCOLS 深等于五元数组(mj-proxy 只在尾部追加)', () => {
  assert.deepEqual(PR?.IMAGE_PROTOCOLS, ['openai', 'gemini', 'chat', 'mj', 'mj-proxy']);
});
check('M17/§4.6 MJ_ACTIONS 仍深等于 [upscale, variation](冻结)', () => {
  assert.deepEqual(PR?.MJ_ACTIONS, ['upscale', 'variation']);
});
check('§4.6 MJ_VERSIONS / MJ_SPEEDS / MJ_ACTION_INDEX_MAX 与本轮之前逐字相同', () => {
  assert.deepEqual(PR?.MJ_VERSIONS, ['8.2', '8.1', '7', '6.1', '5.2', '5.1', 'niji7', 'niji6']);
  assert.deepEqual(PR?.MJ_SPEEDS, ['relax', 'fast', 'turbo']);
  assert.strictEqual(PR?.MJ_ACTION_INDEX_MAX, 4);
});
check('§4.6 buildImageRequest 的 mj-proxy 分支与 buildProxyImagineRequest 逐字相同', () => {
  const cfg = { ...CFG, size: '16:9', mjVersion: 'niji7', mjSpeed: 'fast' };
  const refs = [imgRef()];
  assert.deepEqual(buildImageRequest(cfg, 'cat', refs), buildProxyImagineRequest(cfg, 'cat', refs));
});
check('§4.6 回归锁一:新字段对 openai / gemini / chat 零影响(refs 空与非空各一组)', () => {
  const noise = { mjVersion: 'niji7', mjSpeed: 'turbo', mjParams: { stylize: 250 }, mjRefMode: 'inline' };
  const refs = [{ name: 'a.png', mime: 'image/png', base64: B64 }];
  for (const protocol of ['openai', 'gemini', 'chat']) {
    const base = { protocol, baseURL: 'https://up.example.com/v1', apiKey: 'k', model: 'gpt-image-2', size: '1024x1024' };
    assert.deepEqual(buildImageRequest({ ...base, ...noise }, 'cat'), buildImageRequest(base, 'cat'),
      `${protocol}(无 refs)不该受新字段影响`);
    assert.deepEqual(buildImageRequest({ ...base, ...noise }, 'cat', refs), buildImageRequest(base, 'cat', refs),
      `${protocol}(带 refs)不该受新字段影响`);
  }
});
check('§4.6 回归锁二:mj 且 mjParams 缺省、refs 空时,body 仍在五键内且不含 nsfw_check', () => {
  const b = buildImageRequest({ protocol: 'mj', baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'midjourney', size: '16:9', mjVersion: 'niji7', mjSpeed: 'fast' }, '一只猫').body;
  assert.deepEqual(b, { prompt: '一只猫', size: '16:9', niji: true, version: '7', speed: 'fast' });
});
check('M55/§4.6 mj 的 body 任何情况下都不出现 nsfw_check', () => {
  const cases = [
    { protocol: 'mj', baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'midjourney', nsfwCheck: true },
    { protocol: 'mj', baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'midjourney', nsfwCheck: true, dialect: 'apimart', size: '16:9' },
  ];
  for (const cfg of cases) {
    const b = buildImageRequest(cfg, 'cat').body;
    assert.ok(!('nsfw_check' in b), `不该有 nsfw_check(实得 ${JSON.stringify(Object.keys(b))})`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// §4.7 apimart(protocol mj)带参考图的请求形态
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §4.7 apimart 带参考图');

const MJ = { protocol: 'mj', baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'midjourney' };
const urlRef = (url, over = {}) => ({ role: 'image', kind: 'url', url, ...over });

check('§4.7 url 仍是 {base}/midjourney/generations', () => {
  assert.strictEqual(buildImageRequest(MJ, 'cat', [urlRef('https://x/a.png')]).url,
    'https://api.example.com/v1/midjourney/generations');
});
check('M26/§4.7 image_urls 是【字符串数组】,顺序与 role image 的条目顺序一致', () => {
  const b = buildImageRequest(MJ, 'cat', [urlRef('https://x/a.png'), urlRef('https://x/b.png')]).body;
  assert.deepEqual(b.image_urls, ['https://x/a.png', 'https://x/b.png'], '不许发成对象数组');
});
check('M27/§4.7 没有 role image 的 refs 时【无 image_urls 键】(不发空数组)', () => {
  const b1 = buildImageRequest(MJ, 'cat', []).body;
  assert.ok(!('image_urls' in b1), '空 refs 不该有该键');
  const b2 = buildImageRequest(MJ, 'cat', [{ role: 'sref', kind: 'url', url: 'https://x/s.png' }]).body;
  assert.ok(!('image_urls' in b2), '只有非 image role 时也不该有该键');
});
check('§4.7 image_urls 元素不超过 MAX_REFS(6)', () => {
  const refs = Array.from({ length: 6 }, (_, i) => urlRef(`https://x/${i}.png`));
  assert.equal(buildImageRequest(MJ, 'cat', refs).body.image_urls.length, 6);
});
check('M29/§4.7 mjRefMode 为 upload 或 url 时,role image 的 ref 没有 url 字段 → 抛中文 Error(不静默忽略、不自行上传)', () => {
  const localForms = [
    { role: 'image', name: 'a.png', mime: 'image/png', base64: B64 },
    { role: 'image', kind: 'upload', dataURI: `data:image/png;base64,${B64}` },
    { role: 'image', kind: 'history', file: '/tmp/a.png' },
  ];
  for (const mode of ['upload', 'url']) {
    for (const ref of localForms) {
      assert.throws(() => buildImageRequest({ ...MJ, mjRefMode: mode }, 'cat', [ref]),
        (e) => isCn(e.message), `mode=${mode} ref=${JSON.stringify(Object.keys(ref))} 必须抛中文错`);
    }
  }
});
check('R11/§4.7 mjRefMode 为 inline 时,{name,mime,base64} 形态编成 dataURI 进 image_urls', () => {
  const b = buildImageRequest({ ...MJ, mjRefMode: 'inline' }, 'cat',
    [{ role: 'image', name: 'a.png', mime: 'IMAGE/PNG', base64: B64 }]).body;
  assert.equal(b.image_urls.length, 1);
  assert.ok(b.image_urls[0].startsWith('data:image/png;base64,'), `mime 要小写(实得 ${String(b.image_urls[0]).slice(0, 30)})`);
  assert.strictEqual(b.image_urls[0].slice('data:image/png;base64,'.length), B64);
});
check('§4.7 mjRefMode 为 inline 但该 ref 只有 url 时:URL 原样进 image_urls', () => {
  const b = buildImageRequest({ ...MJ, mjRefMode: 'inline' }, 'cat', [urlRef('https://x/a.png')]).body;
  assert.deepEqual(b.image_urls, ['https://x/a.png']);
});
check('M28/§4.7 --iw 取 role image 的【第一条】ref 的 weight', () => {
  const b = buildImageRequest({ ...MJ, mjVersion: '7' }, 'cat',
    [urlRef('https://x/a.png', { weight: 1 }), urlRef('https://x/b.png', { weight: 3 })]).body;
  assert.ok(b.prompt.includes('--iw 1'), `应取第一条的 weight=1(实得 ${JSON.stringify(b.prompt)})`);
  assert.ok(!b.prompt.includes('--iw 3'), '不许取最后一条');
});
check('§4.7 无垫图或无 weight 时不产出 --iw', () => {
  assert.ok(!buildImageRequest(MJ, 'cat', []).body.prompt.includes('--iw'), '无垫图');
  assert.ok(!buildImageRequest(MJ, 'cat', [urlRef('https://x/a.png')]).body.prompt.includes('--iw'), '无 weight');
});
check('§4.7 cref / oref / sref 的 URL 进 flags 不进 body,权重映射到 --cw/--ow/--sw', () => {
  const c = buildImageRequest({ ...MJ, mjVersion: '6.1' }, 'cat',
    [{ role: 'cref', kind: 'url', url: 'https://x/c.png', weight: 50 }]).body;
  assert.ok(c.prompt.includes('--cref https://x/c.png'), `实得 ${JSON.stringify(c.prompt)}`);
  assert.ok(c.prompt.includes('--cw 50'), `实得 ${JSON.stringify(c.prompt)}`);
  assert.ok(!('image_urls' in c), 'cref 不该进 image_urls');
  const o = buildImageRequest({ ...MJ, mjVersion: '7' }, 'cat',
    [{ role: 'oref', kind: 'url', url: 'https://x/o.png', weight: 200 }]).body;
  assert.ok(o.prompt.includes('--oref https://x/o.png') && o.prompt.includes('--ow 200'), `实得 ${JSON.stringify(o.prompt)}`);
  const s = buildImageRequest({ ...MJ, mjVersion: '7' }, 'cat',
    [{ role: 'sref', kind: 'url', url: 'https://x/s.png', weight: 300 }]).body;
  assert.ok(s.prompt.includes('--sref https://x/s.png') && s.prompt.includes('--sw 300'), `实得 ${JSON.stringify(s.prompt)}`);
});
check('§4.7 body 其余键仍是 size / version / niji / speed 四键既有规则', () => {
  const b = buildImageRequest({ ...MJ, size: '16:9', mjVersion: 'niji7', mjSpeed: 'fast' }, 'cat',
    [urlRef('https://x/a.png')]).body;
  assert.strictEqual(b.size, '16:9');
  assert.strictEqual(b.version, '7');
  assert.strictEqual(b.niji, true);
  assert.strictEqual(b.speed, 'fast');
});

// ══════════════════════════════════════════════════════════════════════════
// §4.8 buildMjActionRequest 第五参数
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] §4.8 apimart 动作构造(第五参数 customId)');

const ACFG = { protocol: 'mj', baseURL: 'https://api.example.com/v1', apiKey: 'sk-a', mjSpeed: 'fast' };
check('M18/§4.8 四参形态逐字不变:upscale / variation 的 url 与 body', () => {
  const up = buildMjActionRequest(ACFG, 'upscale', 2, 'task_01ABC');
  assert.strictEqual(up.url, 'https://api.example.com/v1/midjourney/generations/upscale');
  assert.deepEqual(up.body, { task_id: 'task_01ABC', index: 2, speed: 'fast' });
  const va = buildMjActionRequest({ ...ACFG, mjSpeed: '' }, 'variation', 1, 't');
  assert.strictEqual(va.url, 'https://api.example.com/v1/midjourney/generations/variation');
  assert.deepEqual(va.body, { task_id: 't', index: 1 });
});
check('M19/§4.8 传 customId 时:同一端点,body 深等于 {task_id, custom_id}(+speed),【无 index 键】', () => {
  const r = buildMjActionRequest(ACFG, 'upscale', 2, 't', 'MJ::JOB::upsample_v7_2x_subtle::1::h');
  assert.strictEqual(r.url, 'https://api.example.com/v1/midjourney/generations/upscale');
  assert.deepEqual(r.body, { task_id: 't', custom_id: 'MJ::JOB::upsample_v7_2x_subtle::1::h', speed: 'fast' });
  assert.ok(!('index' in r.body), 'customId 形态不许再塞 index(上游 custom_id 优先,塞了是噪声)');
});
check('M19/§4.8 variation + customId:打 variation 端点,body 无 index', () => {
  const r = buildMjActionRequest({ ...ACFG, mjSpeed: '' }, 'variation', 1, 't', 'MJ::JOB::variation::2::h');
  assert.strictEqual(r.url, 'https://api.example.com/v1/midjourney/generations/variation');
  assert.deepEqual(r.body, { task_id: 't', custom_id: 'MJ::JOB::variation::2::h' });
});
check('§4.8 第五参数为空串 / null / undefined:退回四参形态(带 index)', () => {
  for (const empty of ['', null, undefined]) {
    assert.deepEqual(buildMjActionRequest({ ...ACFG, mjSpeed: '' }, 'upscale', 2, 't', empty).body,
      { task_id: 't', index: 2 }, `第五参数=${String(empty)}`);
  }
});
check('§4.8 四条既有错误文案逐字不变', () => {
  assert.throws(() => buildMjActionRequest(ACFG, 'reroll', 1, 't'), /未知的 Midjourney 操作/);
  assert.throws(() => buildMjActionRequest(ACFG, 'upscale', 0, 't'), /只能对第 1–4 张/);
  assert.throws(() => buildMjActionRequest(ACFG, 'upscale', 1, '   '), /缺少上游任务号/);
  assert.throws(() => buildMjActionRequest({ ...ACFG, baseURL: '' }, 'upscale', 1, 't'), /baseURL 未配置/);
});
check('§4.8 index 越界但传了合法 customId → 不抛错(customId 形态不看 index)', () => {
  const r = buildMjActionRequest(ACFG, 'upscale', 99, 't', 'MJ::JOB::upsample_v7_2x_subtle::1::h');
  assert.deepEqual(r.body, { task_id: 't', custom_id: 'MJ::JOB::upsample_v7_2x_subtle::1::h', speed: 'fast' });
});
check('§4.8 customId 非字符串 / 含换行 → 抛中文 Error', () => {
  for (const bad of [42, {}, ['x'], 'MJ::JOB::upsample::1::h\nX']) {
    assert.throws(() => buildMjActionRequest(ACFG, 'upscale', 1, 't', bad),
      (e) => isCn(e.message), `customId=${JSON.stringify(bad)}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n—— check-r94-mj-proxy: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
console.log('✓ check-r94-mj-proxy: proxy 四函数 + 转出与回归锁 + apimart 参考图形态 + 动作第五参数 全绿');
