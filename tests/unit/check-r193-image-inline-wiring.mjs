// r193 第 3 步:开关接口(GET / PUT /api/prefs/image-inline)、「改不改写」三层判断、并入时推给命令行的内容与回执分开。
// 不起服务:直接取 prefs 路由上登记的处理函数,用假的 req / res 调;偏好文件写在临时 HOME 里。
// 运行:node tests/unit/check-r193-image-inline-wiring.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 模块加载时按家目录算偏好路径:先把 HOME 指到临时目录再 import
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r193-wiring-')));
const HOME = join(TMP, 'home');
const GUI_DIR = join(HOME, '.claude-gui');
const PREFS = join(GUI_DIR, 'prefs.json');
mkdirSync(join(HOME, '.claude', 'projects'), { recursive: true });
mkdirSync(GUI_DIR, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';

const prefsMod = await import('../../server/routes/prefs.js');
const { imageInlineAllowed } = await import('../../server/utils/image-attach-inline.js');
const { acceptSteer, planTurnContent, handleSteerPost } = await import('../../server/routes/chat.js');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`ok ${passed} ${name}`); }
  catch (err) { failures.push(name); console.log(`FAIL ${name}\n${err.stack}`); }
}

function handlerFor(method, path) {
  const layer = prefsMod.default.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `路由 ${method.toUpperCase()} ${path} 存在`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
async function call(method, body) {
  const res = {
    statusCode: 200, payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(p) { this.payload = p; return this; },
  };
  await handlerFor(method, '/prefs/image-inline')({ body }, res);
  return { status: res.statusCode, body: res.payload };
}
const readPrefsFile = () => (existsSync(PREFS) ? readFileSync(PREFS, 'utf8') : null);

await check('读取:文件不存在 / 键缺失 / 坏 JSON / 非布尔值 → 默认开;明确 false → 关', () => {
  rmSync(PREFS, { force: true });
  assert.equal(prefsMod.readImageInlineSync(), true, '文件不存在');
  writeFileSync(PREFS, JSON.stringify({ other: 1 }));
  assert.equal(prefsMod.readImageInlineSync(), true, '键缺失');
  writeFileSync(PREFS, '{ not json');
  assert.equal(prefsMod.readImageInlineSync(), true, '坏 JSON');
  writeFileSync(PREFS, JSON.stringify({ imageInline: 'false' }));
  assert.equal(prefsMod.readImageInlineSync(), true, '字符串 "false" 不算关');
  writeFileSync(PREFS, JSON.stringify({ imageInline: false }));
  assert.equal(prefsMod.readImageInlineSync(), false, '明确 false');
  rmSync(PREFS, { force: true });
});

await check('GET 默认 { enabled: true }', async () => {
  const r = await call('get', undefined);
  assert.deepEqual(r, { status: 200, body: { enabled: true } });
});

await check('PUT 关 → 落盘、GET 读到 false;再开 → true;其它键保留', async () => {
  writeFileSync(PREFS, JSON.stringify({ keepMe: 'x' }));
  const off = await call('put', { enabled: false });
  assert.deepEqual(off, { status: 200, body: { ok: true, enabled: false } });
  assert.deepEqual((await call('get')).body, { enabled: false });
  assert.equal(prefsMod.readImageInlineSync(), false, '同步读取立刻生效');
  assert.equal(JSON.parse(readPrefsFile()).keepMe, 'x');
  const on = await call('put', { enabled: true });
  assert.deepEqual(on, { status: 200, body: { ok: true, enabled: true } });
  assert.deepEqual((await call('get')).body, { enabled: true });
});

await check('PUT 不合规 → 400 INVALID_INPUT,文件逐字不变', async () => {
  await call('put', { enabled: false });
  const before = readPrefsFile();
  for (const body of [{ enabled: 'yes' }, { enabled: 1 }, {}, [], null, 'true', [{ enabled: true }]]) {
    const r = await call('put', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.ok, false);
    assert.equal(r.body.code, 'INVALID_INPUT');
    assert.equal(readPrefsFile(), before, '设置不变');
  }
  assert.deepEqual((await call('get')).body, { enabled: false });
});

await check('三层判断:环境变量 0 优先、开关关、无视觉,各自短路', () => {
  const calls = [];
  const pref = (v) => () => { calls.push('pref'); return v; };
  const vision = (v) => () => { calls.push('vision'); return v; };
  assert.equal(imageInlineAllowed({ envValue: '0', readPref: pref(true), noVision: vision(false) }), false);
  assert.deepEqual(calls, [], '环境变量关时不读偏好、不查能力');
  assert.equal(imageInlineAllowed({ envValue: ' 0 ', readPref: pref(true), noVision: vision(false) }), false);
  calls.length = 0;
  assert.equal(imageInlineAllowed({ envValue: undefined, readPref: pref(false), noVision: vision(false) }), false);
  assert.deepEqual(calls, ['pref'], '开关关时不查能力');
  calls.length = 0;
  assert.equal(imageInlineAllowed({ envValue: '1', readPref: pref(true), noVision: vision(true) }), false);
  assert.deepEqual(calls, ['pref', 'vision']);
  for (const envValue of [undefined, '', '1', 'true']) {
    assert.equal(imageInlineAllowed({ envValue, readPref: pref(true), noVision: vision(false) }), true, `env=${envValue}`);
  }
});

await check('并入:推给命令行的是改写后的内容,回执按原字符串记与比对', () => {
  const pushed = [];
  const slot = { sessionId: 's-1', idle: false, closing: false, pumpEnded: false, exitCode: null, input: { push: (m) => { pushed.push(m); return true; } } };
  const procs = new Map([[101, slot]]);
  const text = 'T\n\n附件:\n@/x/a.png';
  const arr = [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }];
  const r = acceptSteer(procs, { sessionId: 's-1', uuid: 'steer-r193', content: text, pushContent: arr });
  assert.deepEqual(r, { status: 200, body: { ok: true, accepted: true, duplicate: false, pid: '101' } });
  assert.equal(pushed[0].message.content, arr);
  assert.equal(slot.steerReceipts.get('steer-r193'), text);
  const dup = acceptSteer(procs, { sessionId: 's-1', uuid: 'steer-r193', content: text, pushContent: arr });
  assert.equal(dup.body.duplicate, true, '同一标识、同一原文 → 去重');
  assert.equal(pushed.length, 1);
  // 不带 pushContent 时与改动前相同
  acceptSteer(procs, { sessionId: 's-1', uuid: 'steer-plain', content: 'plain' });
  assert.equal(pushed[1].message.content, 'plain');
  // 回合已结束(组装期间收尾)→ 照常 409
  slot.idle = true;
  const late = acceptSteer(procs, { sessionId: 's-1', uuid: 'steer-late', content: text, pushContent: arr });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'no-active-turn');
});

await check('接入点(源码):两处写入标准输入用改写后的内容,成功应答展开 imageAttachFields,并入先组装后判忙', () => {
  const src = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  assert.equal((src.match(/content: String\(turnPrompt\)/g) || []).length, 0);
  assert.equal((src.match(/role: 'user', content: turnContent \}/g) || []).length, 2);
  assert.equal((src.match(/\.\.\.imageAttachFields \}\);/g) || []).length, 2);
  // 两条路径都是「同步判断 → 只有要读图才 await」,不读图时没有让出点
  assert.equal((src.match(/\.read \? await readTurnImages\(/g) || []).length, 2, '两处都是条件等待');
  assert.equal((src.match(/await prepareTurnContent|await planTurnContent/g) || []).length, 0, '没有无条件的等待');
  const steer = src.slice(src.indexOf('export async function handleSteerPost('));
  const prep = steer.indexOf('await readTurnImages(');
  const accept = steer.indexOf('acceptSteer(');
  assert.ok(prep > 0 && accept > prep, '先组装,后 acceptSteer');
});

await check('并入处理器兜底:意外异常且没应答过 → 500 steer-acceptance-unknown;已应答过不再写;正常路径不变', async () => {
  const mkRes = () => ({
    statusCode: 200, payload: undefined, headersSent: false, writes: 0,
    status(code) { this.statusCode = code; return this; },
    json(p) { this.writes += 1; this.payload = p; this.headersSent = true; return this; },
  });
  const body = { sessionId: 's-2', uuid: 'steer-b2', content: '并入一句' };
  // 进程表一遍历就抛 → 走兜底
  const exploding = { [Symbol.iterator]() { throw new Error('boom'); }, values() { throw new Error('boom'); } };
  const r1 = mkRes();
  await handleSteerPost({ body }, r1, exploding);
  assert.equal(r1.statusCode, 500);
  assert.deepEqual(r1.payload, { ok: false, code: 'steer-acceptance-unknown', error: '并入结果无法确认' });
  // 已经发出过应答之后才抛 → 不再写第二次,也不把异常抛给调用方
  const r2 = mkRes();
  r2.status = function status() { throw new Error('late'); };
  r2.headersSent = true;
  await handleSteerPost({ body }, r2, new Map());
  assert.equal(r2.writes, 0);
  // 应答本身写不出 → 处理器仍正常返回(不变成没人处理的拒绝)
  const r3 = mkRes();
  r3.json = () => { throw new Error('socket gone'); };
  await handleSteerPost({ body }, r3, exploding);
  // 正常路径:参数不合规 400;没有回合 409;有忙回合 200 且没有 imageAttach(纯文字)
  const r4 = mkRes();
  await handleSteerPost({ body: { sessionId: 's-2' } }, r4, new Map());
  assert.equal(r4.statusCode, 400);
  const r5 = mkRes();
  await handleSteerPost({ body }, r5, new Map());
  assert.equal(r5.statusCode, 409);
  const pushed = [];
  const busy = new Map([[202, { sessionId: 's-2', idle: false, closing: false, pumpEnded: false, exitCode: null, input: { push: (m) => { pushed.push(m); return true; } } }]]);
  const r6 = mkRes();
  await handleSteerPost({ body }, r6, busy);
  assert.deepEqual(r6.payload, { ok: true, accepted: true, duplicate: false, pid: '202' });
  assert.equal(pushed[0].message.content, '并入一句');
});

await check('planTurnContent:不是斜杠命令且有图片候选才往下判断;不读图时原字符串、没有 imageAttach', () => {
  const T = 'T\n\n附件:\n@/up/a.png';
  const calls = [];
  const deps = (over = {}) => ({
    envValue: undefined,
    readPref: () => { calls.push('pref'); return true; },
    noVision: (m) => { calls.push(`vision:${m}`); return false; },
    ...over,
  });
  const getModel = () => { calls.push('model'); return 'm-1'; };
  const pass = (text) => ({ read: false, text, content: text, imageAttachFields: {} });
  for (const text of ['普通消息', 'T\n\n附件:\n@/up/a.txt', '/skill 看图\n\n附件:\n@/up/a.png', '  \n /cmd\n\n附件:\n@/up/a.png']) {
    calls.length = 0;
    assert.deepEqual(planTurnContent(text, getModel, deps()), pass(text), text);
    assert.deepEqual(calls, [], '不读偏好、不查模型');
  }
  calls.length = 0;
  assert.deepEqual(planTurnContent(T, getModel, deps()), { read: true, text: T });
  assert.deepEqual(calls, ['pref', 'model', 'vision:m-1']);
  assert.deepEqual(planTurnContent('看 a/b 这张\n\n附件:\n@/up/a.png', getModel, deps()).read, true, '正文中间有 / 照常读');
  assert.deepEqual(planTurnContent(T, getModel, deps({ envValue: '0' })), pass(T));
  assert.deepEqual(planTurnContent(T, getModel, deps({ readPref: () => false })), pass(T));
  assert.deepEqual(planTurnContent(T, getModel, deps({ noVision: () => true })), pass(T));
  // 判断里抛异常 → 原字符串
  assert.deepEqual(planTurnContent(T, getModel, deps({ readPref: () => { throw new Error('x'); } })), pass(T));
});

rmSync(TMP, { recursive: true, force: true }); // 只删本测试自建的临时目录
console.log(`check-r193-image-inline-wiring: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
