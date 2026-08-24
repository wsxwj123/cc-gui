#!/usr/bin/env node
// 单测:r40 皮肤加载链取证插桩 —— 最小 DOM shim + fake sendBeacon 真跑 loadT2/activateSkin
// (非 grep),钉死:
//   t1 正常 T2 流的完整步序(exact deepEqual —— 少一步/顺序变即红)+ 每步载荷字段;
//   t2 总开关关闭 → loadT2:abort(reason:disabled),环境行只发一次;
//   t3 黑名单拒载 → validator-done(ok:false) + abort(reason:script_rejected + hits);
//   t4 上报通道自身炸掉(sendBeacon 抛 + fetch 抛)不影响功能(取证不许影响功能);
//   t5 activateSkin 的 activate:start(tier/source/gen);
//   t6 SkinPanel 失败原因映射(t2FailureText 纯函数抽出真跑)+ 调用点在位;
//   t7 冻结现场分型三探针(rAF 首帧 / 5s×6 心跳 / pointerdown 捕获)的上报载荷;
//   t8 探针清理:disposeT2 同步清 + 30s 窗口到点自动清(不留残余定时器/监听)。
// 「先发再做」的取证价值全靠步序:每步都在对应动作【之前】发出,下一步同步卡死时
// 日志停在哪一步 = 凶手在哪一步。故 t1 用 exact 序列而非子集断言。
// 变异哨兵(实际验证过红):skins.js 删掉 loadT2:validator-enter 一步 → t1 红。
// Run: node tests/unit/check-r40-skin-trace.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── 最小 DOM shim(import skins.js 之前就位;与 check-skin-t2-chain.mjs 同形) ──
const head = { children: [], appendChild(n) { this.children.push(n); n._attached = true; } };
const de = {
  attrs: { 'data-theme': 'light' },
  getAttributeNames() { return Object.keys(this.attrs); },
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
  setAttribute(k, v) { this.attrs[k] = String(v); },
  removeAttribute(k) { delete this.attrs[k]; },
  style: { zoom: '1.25', setProperty() {}, removeProperty() {} },
};
const fakeDocument = {
  head,
  documentElement: de,
  createElement(tag) {
    return {
      tagName: tag, attrs: {}, textContent: '', _attached: false, src: '',
      setAttribute(k, v) { this.attrs[k] = String(v); },
      remove() { this._attached = false; head.children = head.children.filter((x) => x !== this); },
    };
  },
  querySelectorAll(sel) {
    if (sel === '[data-cgui-skin-style]') return head.children.filter((n) => 'data-cgui-skin-style' in n.attrs);
    return [];
  },
};
globalThis.document = fakeDocument;
globalThis.window = globalThis;
globalThis.innerWidth = 1440;
globalThis.innerHeight = 900;
// 监听器记录面(探针 3 的 pointerdown 注册/摘除要断言)
const listeners = [];
globalThis.addEventListener = (type, fn, opts) => { listeners.push({ type, fn, opts }); };
globalThis.removeEventListener = (type, fn) => {
  const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
  if (i >= 0) listeners.splice(i, 1);
};
globalThis.dispatchEvent = () => {};
// fake timer / rAF:探针用的是真 setInterval(5s)+setTimeout(30s),不换成假的会
// 把 node 事件循环吊住 30 秒;换假的同时也让「第 N 拍」「30s 兜底」可控可断言。
const timers = { intervals: [], timeouts: [] };
globalThis.setInterval = (fn, ms) => { const h = { fn, ms, cleared: false }; timers.intervals.push(h); return h; };
globalThis.clearInterval = (h) => { if (h) h.cleared = true; };
globalThis.setTimeout = (fn, ms) => { const h = { fn, ms, cleared: false }; timers.timeouts.push(h); return h; };
globalThis.clearTimeout = (h) => { if (h) h.cleared = true; };
const rafs = [];
globalThis.requestAnimationFrame = (cb) => { rafs.push(cb); return rafs.length; };
globalThis.cancelAnimationFrame = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const lsMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
  setItem: (k, v) => lsMap.set(k, String(v)),
  removeItem: (k) => lsMap.delete(k),
};
let blobSeq = 0;
URL.createObjectURL = () => `blob:test-${++blobSeq}`;
URL.revokeObjectURL = () => {};

// ── fake beacon(取证收集面;node 的 navigator 是只读 getter,须 defineProperty) ──
let beacons = [];      // { url, blob }
let beaconMode = 'ok'; // ok | throw
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    userAgent: 'FakeUA/1.0 (r40 forensics)',
    sendBeacon(url, blob) {
      if (beaconMode === 'throw') throw new Error('beacon boom');
      beacons.push({ url, blob });
      return true;
    },
  },
});
// 上报体是 Blob(必须 application/json,否则 express.json 不解析 → 服务端 400 丢证据);
// 步点细节必须落在 stack 字段 —— client-log 路由只持久化 ts/iso/kind/message/stack/url,
// 顶层多写的字段会被服务端丢掉(实跑该路由核实过)。断言时把 stack 摊平回顶层。
const readTrace = async () => Promise.all(beacons.map(async ({ url, blob }) => {
  assert.equal(url, '/api/client-log', '上报目标 = 既有 client-log 端点');
  assert.equal(blob.type, 'application/json', 'Blob 带 application/json(否则服务端不解析)');
  const row = JSON.parse(await blob.text());
  assert.equal(row.kind, 'skin-trace', '每行带 kind:skin-trace');
  assert.equal(typeof row.stack, 'string', '细节走 stack 字段(服务端只留这几个字段)');
  return { ...row, ...JSON.parse(row.stack) };
}));
const reset = () => { beacons = []; };

const { loadT2, disposeT2, activateSkin, setDevSkinsEnabled, getSkinState } =
  await import('../../client/src/utils/skins.js');

const PROBE_BEATS = 6; // 与 skins.js 的心跳拍数同口径

const manifest = {
  format: 'cgui-skin/1', name: 'r40 夹具', tier: 2,
  skin_css: 'skin.css', client_js: 'client.js', a11y_css: 'a11y.css',
  light: { vars: { '--color-accent': '#0B8A2D' } },
  dark: { vars: { '--color-accent': '#39FF14' } },
};
const texts = {
  'skin.css': '[data-cgui="topbar"] { border-bottom: 1px solid var(--color-accent) !important; }',
  'client.js': "window.__cguiSkinDispose = () => {};",
  'a11y.css': '[data-cgui="send-btn"]:focus-visible { outline: 2px solid var(--color-accent) !important; }',
};

// ── t1 正常流:完整步序 + 每步载荷 ──
{
  setDevSkinsEnabled(true);
  reset();
  const r = await loadT2('sk-1', manifest, texts);
  assert.equal(r.loaded, true, 't1: 正常载入(插桩不改行为)');
  const rows = await readTrace();
  assert.deepEqual(rows.map((x) => x.message), [
    'skin:env',
    'loadT2:enter',
    'loadT2:disposed',
    'loadT2:texts-ready',
    'loadT2:validator-enter',
    'loadT2:validator-done',
    'loadT2:styles-appended',
    'loadT2:script-appended',
    'loadT2:done',
  ], 't1: 步序逐字钉死(先发再做——少一步即定位失真,哨兵锚)');

  const [env, enter, , ready, , vdone, styled] = rows;
  assert.equal(env.ua, 'FakeUA/1.0 (r40 forensics)', 't1: 环境行 UA');
  assert.equal(env.w, 1440, 't1: 环境行 innerWidth');
  assert.equal(env.h, 900, 't1: 环境行 innerHeight');
  assert.equal(env.zoom, '1.25', 't1: 环境行 html.style.zoom');
  assert.equal(env.theme, 'light', 't1: 环境行 data-theme');
  assert.equal(enter.devEnabled, true, 't1: enter 带总开关态');
  assert.equal(enter.id, 'sk-1', 't1: 每步带 id');
  assert.equal(ready.cssLen, texts['skin.css'].length, 't1: texts-ready 带 skin.css 长度');
  assert.equal(ready.a11yLen, texts['a11y.css'].length, 't1: texts-ready 带 a11y.css 长度');
  assert.equal(ready.jsLen, texts['client.js'].length, 't1: texts-ready 带 client.js 长度');
  assert.equal(typeof vdone.ms, 'number', 't1: validator-done 带耗时 ms');
  assert.equal(vdone.ok, true, 't1: validator-done 带 ok');
  assert.equal(styled.n, 2, 't1: styles-appended 带节点数');
  // 代际:enter 如实带调用方传入值(直调 = null,尚未自领),自领后每步同一代号
  assert.equal(enter.gen, null, 't1: enter 带调用方传入的 gen(直调 = 未领代)');
  const gens = new Set(rows.slice(2).map((x) => x.gen));
  assert.equal(gens.size, 1, 't1: 自领代后每步同一代号');
  assert.equal(typeof [...gens][0], 'number', 't1: 代号是数字');
}

// ── t2 总开关关闭 → abort(disabled);环境行一次性(不再重发) ──
{
  setDevSkinsEnabled(false);
  reset();
  const before = head.children.length; // 门控早退在 disposeT2 之前,现场应原样不动
  const r = await loadT2('sk-1', manifest, texts);
  assert.deepEqual(r, { loaded: false, reason: 'disabled' }, 't2: 门控行为不变');
  const rows = await readTrace();
  assert.deepEqual(rows.map((x) => x.message), ['loadT2:enter', 'loadT2:abort'], 't2: 早退前发 abort');
  assert.equal(rows[0].devEnabled, false, 't2: enter 如实带 devEnabled:false');
  assert.equal(rows[1].reason, 'disabled', 't2: abort 带 reason');
  assert.ok(!rows.some((x) => x.message === 'skin:env'), 't2: 环境行一次性(不随每步重发)');
  assert.equal(head.children.length, before, 't2: 门控早退零副作用(行为不变)');
}

// ── t3 黑名单拒载 → validator-done(ok:false) + abort(script_rejected + hits) ──
{
  setDevSkinsEnabled(true);
  reset();
  const r = await loadT2('sk-bad', { tier: 2 }, { 'client.js': 'fetch("/steal")' });
  assert.equal(r.loaded, false, 't3: 拒载行为不变');
  assert.equal(r.reason, 'script_rejected', 't3: reason 不变');
  const rows = await readTrace();
  assert.deepEqual(rows.map((x) => x.message), [
    'loadT2:enter', 'loadT2:disposed', 'loadT2:texts-ready',
    'loadT2:validator-enter', 'loadT2:validator-done', 'loadT2:abort',
  ], 't3: 拒载步序');
  const vdone = rows[4];
  const abort = rows[5];
  assert.equal(vdone.ok, false, 't3: validator-done ok:false');
  assert.ok(Array.isArray(vdone.hits) && vdone.hits.length > 0, 't3: validator-done 带 hits');
  assert.equal(abort.reason, 'script_rejected', 't3: abort 带 reason');
  assert.deepEqual(abort.hits, r.hits, 't3: abort 的 hits 与返回值一致');
  assert.equal(head.children.length, 0, 't3: 拒载零注入(行为不变)');
}

// ── t4 上报通道自身炸掉不影响功能(sendBeacon 抛 + fetch 兜底也抛) ──
{
  const realFetch = globalThis.fetch;
  beaconMode = 'throw';
  globalThis.fetch = () => { throw new Error('fetch boom'); };
  reset();
  const r = await loadT2('sk-2', manifest, texts);
  assert.equal(r.loaded, true, 't4: 取证链路抛异常被吞,功能照常载入');
  assert.equal(head.children.filter((n) => n.tagName === 'style').length, 2, 't4: 样式节点照常注入');
  assert.equal(head.children.filter((n) => n.tagName === 'script').length, 1, 't4: 脚本节点照常注入');
  assert.equal(beacons.length, 0, 't4: 上报确未送达(异常路径)');
  beaconMode = 'ok';
  globalThis.fetch = realFetch;
}

// ── t5 activateSkin:activate:start 带 tier/source/gen ──
{
  reset();
  await activateSkin({ id: 'sk-3', name: 'r40 夹具', source: 'builtin', manifest, t2Texts: texts }, { tryOn: true });
  const rows = await readTrace();
  assert.equal(rows[0].message, 'activate:start', 't5: 激活第一步 = activate:start');
  assert.equal(rows[0].id, 'sk-3', 't5: 带皮肤 id');
  assert.equal(rows[0].tier, 2, 't5: 带 tier');
  assert.equal(rows[0].source, 'builtin', 't5: 带 source');
  assert.equal(rows[0].tryOn, true, 't5: 带试穿标记');
  assert.equal(typeof rows[0].gen, 'number', 't5: 带代际 gen');
  assert.ok(rows.some((x) => x.message === 'loadT2:done'), 't5: 续接 T2 装载步序');
  assert.equal(rows.filter((x) => x.message === 'loadT2:enter')[0].gen, rows[0].gen, 't5: 代际贯穿 activate→loadT2');
  assert.equal(getSkinState().id, 'sk-3', 't5: 激活行为不变');
  setDevSkinsEnabled(false);
}

// ── t7 冻结现场分型三探针:装载完成后武装,各自如实上报 ──
{
  setDevSkinsEnabled(true);
  reset();
  timers.intervals.length = 0; timers.timeouts.length = 0; rafs.length = 0;
  const r = await loadT2('sk-4', manifest, texts);
  assert.equal(r.loaded, true, 't7: 正常载入');
  assert.equal(rafs.length, 1, 't7: ①渲染管线探针(rAF)已挂');
  const beat = timers.intervals.at(-1);
  const stop = timers.timeouts.at(-1);
  assert.equal(beat.ms, 6000, 't7: ②主线程心跳 6s 一拍(避开服务端 5s 同消息限流)');
  assert.equal(stop.ms, 30000, 't7: 30s 自动清理窗口');
  const pd = listeners.filter((l) => l.type === 'pointerdown');
  assert.equal(pd.length, 1, 't7: ③点击到达探针已挂');
  assert.equal(pd[0].opts?.capture, true, 't7: 捕获相位(遮罩截走前先记一笔)');

  reset(); // 只看探针发出的行
  rafs[0]();
  for (let i = 0; i < PROBE_BEATS + 1; i++) if (!beat.cleared) beat.fn();
  pd[0].fn({ clientX: 12, clientY: 34, target: { tagName: 'BUTTON' } });
  const rows = await readTrace();
  assert.equal(rows[0].message, 'post-load:first-frame', 't7: 首帧探针上报');
  assert.equal(rows[0].id, 'sk-4', 't7: 探针带皮肤 id');
  const beats = rows.filter((x) => x.message === 'post-load:heartbeat');
  assert.deepEqual(beats.map((x) => x.n), [1, 2, 3, 4, 5, 6], 't7: 心跳 6 拍(带拍号,便于识别限流丢行)');
  assert.equal(typeof beats[0].t, 'number', 't7: 心跳带时间戳');
  assert.equal(beat.cleared, true, 't7: 第 6 拍后自停(不无限心跳)');
  const click = rows.find((x) => x.message === 'post-load:pointerdown');
  assert.ok(click, 't7: 点击到达上报');
  assert.equal(click.x, 12, 't7: 带坐标 x');
  assert.equal(click.y, 34, 't7: 带坐标 y');
  assert.equal(click.target, 'BUTTON', 't7: 带命中元素标签');
}

// ── t8 探针清理:皮肤卸载同步清干净 + 30s 窗口到点自动清 ──
{
  reset();
  timers.intervals.length = 0; timers.timeouts.length = 0; rafs.length = 0;
  await loadT2('sk-5', manifest, texts);
  const beat = timers.intervals.at(-1);
  const stop = timers.timeouts.at(-1);
  assert.equal(listeners.filter((l) => l.type === 'pointerdown').length, 1, 't8: 卸载前监听在位');
  disposeT2();
  assert.equal(beat.cleared, true, 't8: 卸载后心跳已停');
  assert.equal(stop.cleared, true, 't8: 卸载后 30s 兜底定时器已清');
  assert.equal(listeners.filter((l) => l.type === 'pointerdown').length, 0, 't8: 卸载后 pointerdown 监听已摘');

  timers.intervals.length = 0; timers.timeouts.length = 0;
  await loadT2('sk-6', manifest, texts);
  const beat2 = timers.intervals.at(-1);
  timers.timeouts.at(-1).fn(); // 30s 到点
  assert.equal(beat2.cleared, true, 't8: 30s 窗口到点自动停心跳');
  assert.equal(listeners.filter((l) => l.type === 'pointerdown').length, 0, 't8: 30s 窗口到点摘监听');
  disposeT2();
  setDevSkinsEnabled(false);
}

// ── t6 SkinPanel 失败原因可见化:t2FailureText 纯函数抽出真跑 + 调用点在位 ──
{
  const src = readFileSync(new URL('../../client/src/components/SkinPanel.jsx', import.meta.url), 'utf8');
  const m = src.match(/function t2FailureText\(t2\) \{[\s\S]*?\n\}/);
  assert.ok(m, 't6: t2FailureText 存在(哨兵锚)');
  // eval 对象 = 本仓自己的源码里抽出的纯函数(无外部标识符),用于「真跑映射矩阵」而非
  // 纯 grep;与 check-r26-d9-d10-skinpanel.mjs 的 detectInlineKind 同一既有测试形态。
  const t2FailureText = eval(`(${m[0]})`);
  assert.equal(t2FailureText(null), null, 't6: 无结果不提示');
  assert.equal(t2FailureText({ loaded: true }), null, 't6: 成功不提示');
  assert.equal(t2FailureText({ loaded: false, reason: 'superseded' }), null, 't6: superseded 不提示(被后一次激活取代)');
  assert.match(t2FailureText({ loaded: false, reason: 'disabled' }), /开发者皮肤/, 't6: disabled → 指出需开启开关');
  const rejected = t2FailureText({ loaded: false, reason: 'script_rejected', hits: ['(?:^|[^\\w$])fetch\\s*\\('] });
  assert.match(rejected, /安全校验|禁止/, 't6: script_rejected → 说明未通过校验');
  assert.ok(rejected.includes('fetch'), 't6: script_rejected 带 hits 摘要');
  // 两处卡片(用户皮肤 SkinCard / 内置 BuiltinSkinCard)的 apply 都接住结果并上报
  assert.ok((src.match(/reportT2Failure\(/g) || []).length >= 3, 't6: 定义 + 两处卡片调用点在位');
  assert.match(src, /const \{ t2 \} = await activateSkin\(row, \{ tryOn \}\) \|\| \{\};/, 't6: 卡片接住 activateSkin 返回值');
}

console.log('check-r40-skin-trace: all passed');
