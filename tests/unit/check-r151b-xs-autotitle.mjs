#!/usr/bin/env node
// r151b 缺陷修复:点卡片处理跨会话消息(handleSend 带 opts.xsClaim → 请求体带 xsMessageId)不触发自动标题;
// 普通发送照常触发。现象:没有标题的会话(第三方 provider 常见)处理完一条转发消息,标题变成"（跨会话消息）"。
// 白盒:真 import 判定函数 xsAutoTitlePrompt;从 App.jsx 源码取出 autoTitlePrompt 的定义、每一处
// POST /api/chat/title 的触发条件与 firstUser 表达式,代入真实判定结果求值(不抄写 App 里的条件)。
// node tests/unit/check-r151b-xs-autotitle.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 浏览器全局的最小替身(xsession.js → sessionStore 顶层要 localStorage) ──
{
  const mem = new Map();
  globalThis.localStorage = {
    get length() { return mem.size; }, key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); }, clear: () => mem.clear(),
  };
  if (!globalThis.window) globalThis.window = globalThis;
  if (!globalThis.addEventListener) { globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {}; }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENT_SRC = join(ROOT, 'client', 'src');
const { xsAutoTitlePrompt, xsChatFields, XS_PROMPT_PLACEHOLDER } = await import('../../client/src/utils/xsession.js');

const SID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const MID = '11111111-0000-4000-8000-000000000001';
const TOKEN = 'cccccccc-0000-4000-8000-00000000000c';
const CLAIM = { messageId: MID, token: TOKEN, sessionId: SID };
const CARD_OPTS = { hiddenUserMessage: true, xsClaim: CLAIM }; // utils/xsession.js 点【处理】实际传给 handleSend 的 opts
const USER_TEXT = '帮我看看登录页为什么白屏';

// ── 1. 判定函数本身 ──
{
  assert.equal(typeof xsAutoTitlePrompt, 'function', 'utils/xsession.js 导出 xsAutoTitlePrompt');
  assert.equal(xsChatFields(CARD_OPTS)?.xsMessageId, MID, '前提:点卡片这条请求体带 xsMessageId');
  assert.equal(xsAutoTitlePrompt(XS_PROMPT_PLACEHOLDER, CARD_OPTS), '', '点卡片发送:占位文字不当标题素材');
  // 错误自动重发({...opts, xxxRetry})与排队回放(next.opts)都透传 xsClaim → 照样不用
  for (const extra of [{ oneMRetry: true }, { signatureRetry: true }, { freshRetry: true }]) {
    assert.equal(xsAutoTitlePrompt(XS_PROMPT_PLACEHOLDER, { ...CARD_OPTS, ...extra }), '', `重发 ${Object.keys(extra)[0]}`);
  }
  assert.equal(xsAutoTitlePrompt(XS_PROMPT_PLACEHOLDER, { xsClaim: CLAIM }), '', '不靠 hiddenUserMessage 判定');
  // 认领字段残缺:请求体不带 xsMessageId,但 prompt 仍是占位
  assert.equal(xsChatFields({ xsClaim: { messageId: MID } }), null);
  assert.equal(xsAutoTitlePrompt(XS_PROMPT_PLACEHOLDER, { hiddenUserMessage: true, xsClaim: { messageId: MID } }), '');
  // 普通发送(含别的隐藏消息):原样返回,行为与改动前相同
  for (const opts of [undefined, {}, { meta: { displayText: USER_TEXT } }, { steer: true }, { reattachPid: 4321 },
    { hiddenUserMessage: true, appendSystemPrompt: 'x' }, { xsClaim: null }]) {
    assert.equal(xsAutoTitlePrompt(USER_TEXT, opts), USER_TEXT, `普通发送 opts=${JSON.stringify(opts)}`);
  }
  console.log('✓ xsAutoTitlePrompt:带 xsClaim(请求体带 xsMessageId)返回空,其余原样返回 prompt');
}

// ── 2. 前端所有自动标题触发都经同一个判定 ──
const rel = (f) => f.slice(ROOT.length + 1).split('\\').join('/');
const srcFiles = readdirSync(CLIENT_SRC, { recursive: true })
  .filter((f) => /\.(m?js|jsx)$/.test(f))
  .map((f) => join(CLIENT_SRC, f));
const titleCallers = srcFiles.filter((f) => readFileSync(f, 'utf8').includes("fetch('/api/chat/title'"));
assert.deepEqual(titleCallers.map(rel), ['client/src/App.jsx'], '只有 App.jsx 请求 /api/chat/title');
const setterCallers = srcFiles.filter((f) => /\.setAutoTitle\(/.test(readFileSync(f, 'utf8')));
assert.deepEqual(setterCallers.map(rel), ['client/src/App.jsx'], '只有 App.jsx 调 setAutoTitle');

const app = readFileSync(join(CLIENT_SRC, 'App.jsx'), 'utf8');
const hsHead = 'const handleSend = useCallback(async (prompt, opts = {}) => {';
const hs = app.indexOf(hsHead);
assert.ok(hs > 0, '找到 handleSend');
const he = app.indexOf('= useCallback(', hs + hsHead.length); // 下一个 useCallback = handleSend 已结束
const def = app.slice(hs, hs + 2500).match(/const autoTitlePrompt = ([^;\n]+);/);
assert.ok(def, 'handleSend 开头定义 autoTitlePrompt');

const fetchIdx = [];
for (let i = app.indexOf("fetch('/api/chat/title'"); i >= 0; i = app.indexOf("fetch('/api/chat/title'", i + 1)) fetchIdx.push(i);
const setterIdx = [];
for (let i = app.indexOf('.setAutoTitle('); i >= 0; i = app.indexOf('.setAutoTitle(', i + 1)) setterIdx.push(i);
assert.ok(fetchIdx.length >= 1, '至少一处自动标题触发');
for (const s of setterIdx) assert.ok(fetchIdx.some((f) => f < s && s - f < 800), 'setAutoTitle 只在 /api/chat/title 的回调里');

const evalExpr = (expr, env) => new Function(...Object.keys(env), `"use strict"; return (${expr});`)(...Object.values(env));
const ifCondition = (at) => { // 包住这次 fetch 的 if (...) 的条件文本(括号配对)
  const start = app.lastIndexOf('if (', at) + 3;
  let depth = 0;
  for (let k = start; k < at; k += 1) {
    if (app[k] === '(') depth += 1;
    else if (app[k] === ')') { depth -= 1; if (depth === 0) return app.slice(start + 1, k); }
  }
  throw new Error('条件括号不配对');
};
const envFor = (prompt, opts) => {
  const st = { customTitles: {}, autoTitles: {}, modelBySession: {}, currentModel: '' };
  return {
    prompt, opts, hiddenUserMessage: opts.hiddenUserMessage || false, // 与 handleSend 解构默认值一致
    autoTitlePrompt: evalExpr(def[1], { xsAutoTitlePrompt, prompt, opts }),
    titleAttempted: new Set(), _st: st, st, _sid: SID, titleSid: SID,
  };
};

for (const at of fetchIdx) {
  const line = app.slice(0, at).split('\n').length;
  assert.ok(at > hs && (he < 0 || at < he), `第 ${line} 行的触发在 handleSend 里(autoTitlePrompt 的作用域)`);
  const cond = ifCondition(at);
  assert.match(cond, /\bautoTitlePrompt\b/, `第 ${line} 行触发条件读 autoTitlePrompt`);
  assert.doesNotMatch(cond, /\bprompt\b/, `第 ${line} 行触发条件不直接读 prompt`);
  const firstUser = app.slice(at, at + 800).match(/firstUser:\s*([^,]+),/);
  assert.ok(firstUser, `第 ${line} 行请求体有 firstUser`);

  const normal = envFor(USER_TEXT, {});
  assert.ok(evalExpr(cond, normal), `第 ${line} 行:普通发送照常触发`);
  assert.equal(evalExpr(firstUser[1], normal), USER_TEXT, `第 ${line} 行:普通发送 firstUser 就是用户写的话`);
  assert.ok(!evalExpr(cond, envFor(XS_PROMPT_PLACEHOLDER, CARD_OPTS)), `第 ${line} 行:点卡片处理不触发`);
  assert.ok(!evalExpr(cond, envFor(XS_PROMPT_PLACEHOLDER, { xsClaim: CLAIM })), `第 ${line} 行:去掉 hidden 也不触发`);
  assert.ok(!evalExpr(cond, envFor(XS_PROMPT_PLACEHOLDER, { ...CARD_OPTS, signatureRetry: true })), `第 ${line} 行:透传 opts 的重发不触发`);
}
console.log(`✓ App.jsx ${fetchIdx.length} 处自动标题触发都读同一个 autoTitlePrompt:点卡片不触发,普通发送照常`);

console.log('PASS check-r151b-xs-autotitle');
process.exit(0);
