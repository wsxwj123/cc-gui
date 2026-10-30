#!/usr/bin/env node
// r151v 缺陷修复:隐藏发送(工具重做后的"继续"、点卡片处理跨会话消息、队列里的隐藏条目,以及它们的自动重发)
// 不再拿去起会话自动标题;用户手打的消息照旧。现象:没有模型标题的会话(第三方 provider 常见)做一次"工具重做",
// 回合结束时自动标题把隐藏消息 `<cgui-tool-retry tool="X">继续</cgui-tool-retry>` 原文当首条用户消息发给
// POST /api/chat/title,会话标题被改成与用户无关的内容。
// 为什么白盒:两处触发(拿到会话 id 时、回合结束时)长在 App.jsx 的 handleSend 闭包里,跑起来要整套 React +
// 流式后端;而两处的触发条件与请求体 firstUser 都只读 handleSend 开头算一次的 autoTitlePrompt。所以真 import
// 判定函数 xsAutoTitlePrompt,从 App.jsx 源码取出 autoTitlePrompt 的定义、两处 fetch('/api/chat/title') 外层 if 的
// 条件原文与 firstUser 表达式,代入真实判定结果求值(不在测试里抄写 App 的条件)。
// 编号对应 r151v 接口文件:1–8 行为清单,9–11 白盒钉住项。每条独立判,一条失败不中断其余;
// 锚点找不到 / 次数不对 / 区间越界 / 括号不配对都按失败报出,不静默跳过。
// node tests/unit/check-r151v-hidden-autotitle.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const { xsAutoTitlePrompt, XS_PROMPT_PLACEHOLDER } = await import('../../client/src/utils/xsession.js');
const app = readFileSync(join(ROOT, 'client', 'src', 'App.jsx'), 'utf8');

// ── 素材 ──
const SID = 'aaaaaaaa-0000-4000-8000-00000000000b';
const USER_TEXT = '帮我看看登录页为什么白屏';
const RETRY_TEXT = '<cgui-tool-retry tool="Bash">继续</cgui-tool-retry>'; // 工具重做(第 11 条钉住:调用点产出的就是这句)
const RETRY_CONTINUE_TEXT = '<cgui-tool-retry>换个方式继续</cgui-tool-retry>'; // 带续跑指令的工具重做
const TOOL_RETRY_OPTS = { appendSystemPrompt: '…', hiddenUserMessage: true }; // 工具重做调用点给 resendReplacing 的 opts
const QUEUE_HIDDEN_TEXT = '按批准的计划继续执行';
const QUEUE_HIDDEN_OPTS = { hiddenUserMessage: true }; // 队列隐藏条目出队:q.opts || (q.hidden ? { hiddenUserMessage: true } : {})
const RETRY_MARKS = [{ oneMRetry: true }, { signatureRetry: true }, { freshRetry: true }, { autoRetry: true }, { busyRequeued: true }]; // 各类自动重发 { ...opts, 标记 }
const CARD_OPTS = { hiddenUserMessage: true, xsProcess: { messageId: '11111111-0000-4000-8000-000000000001', sessionId: SID } }; // 点卡片处理
const TYPED_OPTS = [ // 用户手打
  {},
  { meta: { attachments: [{ name: 'shot.png', type: 'image/png' }], displayText: USER_TEXT } },
  { steer: true }, { fromComposer: true }, { forceSend: true }, { hiddenUserMessage: false },
];

const sendOf = (prompt, opts) => ({ prompt, opts, label: `${JSON.stringify(prompt)} opts=${JSON.stringify(opts)}` });
// 第 1、2 条:调用点给的 opts,以及 resendReplacing 追加 forceSend 后 handleSend 实收的 opts
const ITEM1 = [sendOf(RETRY_TEXT, TOOL_RETRY_OPTS), sendOf(RETRY_TEXT, { ...TOOL_RETRY_OPTS, forceSend: true })];
const ITEM2 = [sendOf(RETRY_CONTINUE_TEXT, TOOL_RETRY_OPTS), sendOf(RETRY_CONTINUE_TEXT, { ...TOOL_RETRY_OPTS, forceSend: true })];
const ITEM3 = [sendOf(QUEUE_HIDDEN_TEXT, QUEUE_HIDDEN_OPTS)];
const ITEM4 = [];
for (const [text, base] of [[QUEUE_HIDDEN_TEXT, QUEUE_HIDDEN_OPTS], [RETRY_TEXT, TOOL_RETRY_OPTS]]) {
  for (const mark of [...RETRY_MARKS, { forceSend: true }]) ITEM4.push(sendOf(text, { ...base, ...mark }));
  for (const mark of RETRY_MARKS) ITEM4.push(sendOf(text, { ...base, forceSend: true, ...mark })); // 经 resendReplacing 后再被自动重发
}
const ITEM7 = [sendOf(XS_PROMPT_PLACEHOLDER, CARD_OPTS), sendOf(XS_PROMPT_PLACEHOLDER, { xsProcess: CARD_OPTS.xsProcess }),
  sendOf(XS_PROMPT_PLACEHOLDER, { ...CARD_OPTS, signatureRetry: true })];

// ── 检查收集:每条独立判,失败只记下、不中断其余 ──
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(true);
    console.log(`✓ ${name}`);
  } catch (err) {
    results.push(false);
    const kind = err?.code === 'ERR_ASSERTION' ? '断言失败' : err?.anchor ? '锚点失败' : (err?.name || 'Error');
    console.log(`✗ ${name}\n    ${kind}:${String(err?.message ?? err).split('\n')[0]}`);
  }
}
function fail(kind, detail) { // kind:找不到 / 次数不对 / 区间越界 / 括号不配对 / 前置缺失
  const err = new Error(`【${kind}】${detail}`);
  err.anchor = true;
  throw err;
}
const S = {}; // 从源码取出的片段;取不到就留空,依赖它的检查报"前置缺失"
function need(...keys) {
  const missing = keys.filter((k) => S[k] === undefined);
  if (missing.length) fail('前置缺失', `${missing.join('、')} 没取到(见上面失败的第 9–10 条),本条无法求值`);
  return S;
}

// ── 读源码的小工具 ──
const lineOf = (idx) => app.slice(0, idx).split('\n').length;
const indexesOf = (text, needle) => {
  const out = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
};
const evalExpr = (expr, env) => new Function(...Object.keys(env), `"use strict";\nreturn (\n${expr}\n);`)(...Object.values(env));

// k 指向开引号,返回收引号下标;-1 = 没收尾。模板串里的 ${…} 按代码配对跳过。
function skipString(text, k) {
  const quote = text[k];
  for (let i = k + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') { i += 1; continue; }
    if (c === quote) return i;
    if (quote === '`' && c === '$' && text[i + 1] === '{') { i = matchClose(text, i + 1); if (i < 0) return -1; continue; }
    if (quote !== '`' && c === '\n') return -1;
  }
  return -1;
}
// open 指向 ( { [,返回配对收尾的下标;-1 = 不配对。跳过字符串、模板串与注释。
// 不识别正则字面量:被扫描的 if 块里有 .replace(/\[1m\]/i, '') 这类正则,其中的 [ ] 恰好成对,不影响配对;
// 将来混进含不成对括号或引号的正则,会报不配对而不是静默错位。
function matchClose(text, open) {
  const closer = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let k = open; k < text.length; k += 1) {
    const c = text[k];
    if (c === '"' || c === "'" || c === '`') { k = skipString(text, k); if (k < 0) return -1; continue; }
    if (c === '/' && text[k + 1] === '/') { k = text.indexOf('\n', k); if (k < 0) return -1; continue; }
    if (c === '/' && text[k + 1] === '*') { k = text.indexOf('*/', k + 2); if (k < 0) return -1; k += 1; continue; }
    if (closer[c]) stack.push(closer[c]);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return k;
    }
  }
  return -1;
}
// open 指向调用的左括号:按顶层逗号切出实参原文(去掉末尾逗号留下的空段)
function callArgs(text, open) {
  const close = matchClose(text, open);
  if (close < 0) fail('括号不配对', `第 ${lineOf(open)} 行的调用括号`);
  const args = [];
  let from = open + 1;
  for (let k = open + 1; k < close; k += 1) {
    const c = text[k];
    if (c === '"' || c === "'" || c === '`') k = skipString(text, k);
    else if (c === '/' && text[k + 1] === '/') k = text.indexOf('\n', k);
    else if (c === '/' && text[k + 1] === '*') k = text.indexOf('*/', k + 2) + 1;
    else if (c === '(' || c === '{' || c === '[') k = matchClose(text, k);
    else if (c === ',') { args.push(text.slice(from, k)); from = k + 1; }
  }
  args.push(text.slice(from, close));
  return args.map((a) => a.trim()).filter(Boolean);
}
// useCallback 定义的区间:函数体内各行至少 4 格缩进,函数头之后第一行"2 格缩进 + }"必须是 "  }, [依赖…]" 收尾
function callbackSpan(head, name) {
  const heads = indexesOf(app, head);
  if (heads.length !== 1) fail('次数不对', `${name} 的函数头应恰好 1 处,实际 ${heads.length} 处`);
  const start = heads[0];
  const nl = app.indexOf('\n  }', start);
  if (nl < 0) fail('找不到', `${name} 的收尾行(2 格缩进的 "}")`);
  const endLine = app.slice(nl + 1, app.indexOf('\n', nl + 1));
  if (!/^ {2}\}, \[/.test(endLine)) fail('找不到', `${name} 收尾应是 "  }, [依赖…]",第 ${lineOf(nl + 1)} 行实际是 ${JSON.stringify(endLine.slice(0, 60))}`);
  const nextCb = app.indexOf('= useCallback(', start + head.length);
  if (nextCb >= 0 && nextCb < nl) fail('区间越界', `${name} 收尾(第 ${lineOf(nl + 1)} 行)之前就出现了下一个 useCallback(第 ${lineOf(nextCb)} 行)`);
  return { start, end: nl + 1 };
}

// ── 代入求值:变量名取自源码(会话 id 变量、状态变量),会话处于"还没起过标题"的前提 ──
const freshState = (patch = {}) => ({ customTitles: {}, autoTitles: {}, modelBySession: {}, currentModel: '', ...patch });
const hiddenOf = (opts) => new Function('opts', `"use strict";\n${need('destructure').destructure}\nreturn hiddenUserMessage;`)(opts);
const envFor = (site, s, state) => ({
  prompt: s.prompt, opts: s.opts,
  hiddenUserMessage: hiddenOf(s.opts),
  autoTitlePrompt: evalExpr(need('defExpr').defExpr, { xsAutoTitlePrompt, prompt: s.prompt, opts: s.opts }),
  titleAttempted: new Set(),
  [site.sidVar]: SID, [site.stVar]: state || freshState(),
});
const fires = (site, s, state) => Boolean(evalExpr(site.cond, envFor(site, s, state)));
const firstUserOf = (site, s, state) => evalExpr(site.firstUser, envFor(site, s, state));
function expectNoTitle(sites, sends, state) {
  for (const site of sites) {
    for (const s of sends) {
      if (fires(site, s, state)) assert.fail(`${site.label}:${s.label} 不应发起自动标题,实际会发起(firstUser=${JSON.stringify(firstUserOf(site, s, state))})`);
    }
  }
}

// ══ 第 9 条:钉住两处触发 ══
const HS_HEAD = 'const handleSend = useCallback(async (prompt, opts = {}) => {';
check('9 钉住:handleSend 定位(函数头恰好 1 处;收尾是 2 格缩进的 "}, [依赖]",早于下一个 useCallback)', () => {
  const { start, end } = callbackSpan(HS_HEAD, 'handleSend');
  S.hs = start;
  S.he = end;
});

check('9 钉住:autoTitlePrompt 在 handleSend 开头只定义一次,定义就是 xsAutoTitlePrompt(prompt, opts)(取自 utils/xsession.js)', () => {
  need('hs', 'he');
  if (!/import\s*\{[^}]*\bxsAutoTitlePrompt\b[^}]*\}\s*from\s*['"]\.\/utils\/xsession(?:\.js)?['"]/.test(app)) fail('找不到', 'App.jsx 从 ./utils/xsession.js 导入 xsAutoTitlePrompt');
  const localDecls = app.match(/\b(?:function|const|let|var)\s+xsAutoTitlePrompt\b/g) || [];
  if (localDecls.length) fail('次数不对', `App.jsx 不应自己声明 xsAutoTitlePrompt(会遮住导入的那个),实际 ${localDecls.length} 处`);
  const body = app.slice(S.hs, S.he);
  const decls = [...body.matchAll(/\b(?:const|let|var)\s+autoTitlePrompt\b/g)];
  if (decls.length !== 1) fail('次数不对', `handleSend 里声明 autoTitlePrompt 应恰好 1 处,实际 ${decls.length} 处`);
  const writes = body.match(/\bautoTitlePrompt\s*=(?![=>])/g) || [];
  if (writes.length !== 1) fail('次数不对', `handleSend 里给 autoTitlePrompt 赋值应只有定义那 1 处,实际 ${writes.length} 处`);
  const defAt = S.hs + decls[0].index;
  const m = /^const autoTitlePrompt = ([^;\n]+);/.exec(app.slice(defAt));
  if (!m) fail('找不到', `第 ${lineOf(defAt)} 行不是单行的 "const autoTitlePrompt = …;"`);
  if (app.slice(app.lastIndexOf('\n', defAt) + 1, defAt) !== '    ') fail('区间越界', `第 ${lineOf(defAt)} 行的定义不在 handleSend 函数体顶层(应 4 格缩进)`);
  if (defAt - S.hs > 2500) fail('区间越界', `定义在第 ${lineOf(defAt)} 行,离 handleSend 函数头(第 ${lineOf(S.hs)} 行)太远,不在开头`);
  assert.equal(m[1].trim(), 'xsAutoTitlePrompt(prompt, opts)', `定义应是 xsAutoTitlePrompt(prompt, opts),实际是 ${m[1].trim()}`);
  S.defExpr = m[1];
  S.defAt = defAt;
});

check("9 钉住:fetch('/api/chat/title') 在 App.jsx 恰好 2 处,都在 handleSend 里定义之后、各有包住它的 if;一处在拿到会话 id 时、一处在回合结束时", () => {
  need('hs', 'he', 'defAt');
  const ats = [...app.matchAll(/fetch\(\s*['"`]\/api\/chat\/title['"`]/g)].map((m) => m.index);
  if (ats.length !== 2) fail('次数不对', `应恰好 2 处,实际 ${ats.length} 处${ats.length ? `(第 ${ats.map(lineOf).join('、')} 行)` : ''}`);
  const sites = ats.map((at) => {
    const line = lineOf(at);
    if (!(at > S.defAt && at < S.he)) fail('区间越界', `第 ${line} 行不在 handleSend 里 autoTitlePrompt 定义之后(handleSend 第 ${lineOf(S.hs)}–${lineOf(S.he)} 行)`);
    const ifAt = app.lastIndexOf('if (', at);
    if (ifAt < S.defAt) fail('找不到', `第 ${line} 行之前(handleSend 里)的 if (`);
    const condClose = matchClose(app, ifAt + 3);
    if (condClose < 0) fail('括号不配对', `第 ${lineOf(ifAt)} 行 if 的条件括号`);
    if (condClose > at) fail('区间越界', `第 ${lineOf(ifAt)} 行 if 的条件括号收尾在第 ${line} 行 fetch 之后`);
    const brace = /^\s*\{/.exec(app.slice(condClose + 1));
    if (!brace) fail('找不到', `第 ${lineOf(ifAt)} 行 if 条件后面的块 {`);
    const blockClose = matchClose(app, condClose + brace[0].length);
    if (blockClose < 0) fail('括号不配对', `第 ${lineOf(ifAt)} 行 if 的块`);
    if (blockClose < at) fail('区间越界', `离第 ${line} 行 fetch 最近的 if(第 ${lineOf(ifAt)} 行)的块在 fetch 之前就收尾了,不是包住它的那个`);
    const cond = app.slice(ifAt + 4, condClose);
    const callClose = matchClose(app, app.indexOf('(', at));
    if (callClose < 0) fail('括号不配对', `第 ${line} 行 fetch 的调用括号`);
    const firstUsers = [...app.slice(at, callClose).matchAll(/\bfirstUser:\s*([^,}\n]+)/g)];
    if (firstUsers.length !== 1) fail('次数不对', `第 ${line} 行请求体里 firstUser 应恰好 1 个,实际 ${firstUsers.length} 个`);
    const sidVar = /\btitleAttempted\.has\((\w+)\)/.exec(cond)?.[1];
    if (!sidVar) fail('找不到', `第 ${line} 行触发条件里的 titleAttempted.has(<会话 id 变量>)`);
    const stVar = /\b(\w+)\.customTitles\[/.exec(cond)?.[1];
    if (!stVar) fail('找不到', `第 ${line} 行触发条件里的 <状态变量>.customTitles[…]`);
    const declAt = app.lastIndexOf(`const ${sidVar} = `, ifAt);
    if (declAt < S.defAt) fail('找不到', `第 ${line} 行之前 handleSend 里的 "const ${sidVar} = …"`);
    const init = app.slice(declAt + `const ${sidVar} = `.length, app.indexOf(';', declAt)).trim();
    return { at, line, cond, firstUser: firstUsers[0][1].trim(), sidVar, stVar, onSessionId: init === 'event.session_id' };
  });
  const sidSites = sites.filter((s) => s.onSessionId);
  if (sidSites.length !== 1) fail('次数不对', `会话 id 取自 event.session_id 的触发(拿到会话 id 时)应恰好 1 处,实际 ${sidSites.length} 处`);
  const endSite = sites.find((s) => !s.onSessionId);
  S.siteSid = { ...sidSites[0], label: `拿到会话 id 时(第 ${sidSites[0].line} 行)` };
  S.siteEnd = { ...endSite, label: `回合结束时(第 ${endSite.line} 行)` };
});

check('9 钉住:两处触发条件都读 autoTitlePrompt、不直接读 prompt;请求体 firstUser 都是 autoTitlePrompt', () => {
  const { siteSid, siteEnd } = need('siteSid', 'siteEnd');
  for (const site of [siteSid, siteEnd]) {
    assert.match(site.cond, /\bautoTitlePrompt\b/, `${site.label}:触发条件应读 autoTitlePrompt`);
    assert.doesNotMatch(site.cond, /\bprompt\b/, `${site.label}:触发条件不应直接读 prompt`);
    assert.equal(site.firstUser, 'autoTitlePrompt', `${site.label}:firstUser 应是 autoTitlePrompt,实际是 ${site.firstUser}`);
  }
});

// ══ 第 10 条:求值装置自检(防止环境没接对导致第 1–8 条空过) ══
check('10 求值装置:条件原文能在替身环境求值,其余前提满足时随 autoTitlePrompt 有无而变;hiddenUserMessage 取自 handleSend 解构原文', () => {
  const { siteSid, siteEnd, hs, defAt } = need('siteSid', 'siteEnd', 'hs', 'defAt');
  const m = /const \{[^}]*\bhiddenUserMessage\b[^}]*\} = opts;/.exec(app.slice(hs, defAt));
  if (!m) fail('找不到', 'handleSend 开头解构出 hiddenUserMessage 的 "const { … } = opts;"');
  S.destructure = m[0];
  assert.equal(hiddenOf({}), false, '解构默认值:不带 hiddenUserMessage 时应为 false');
  assert.equal(hiddenOf({ hiddenUserMessage: true }), true, '带 hiddenUserMessage: true 时应为 true');
  for (const site of [siteSid, siteEnd]) {
    const env = (autoTitlePrompt, extra = {}) => ({
      prompt: USER_TEXT, opts: {}, hiddenUserMessage: false, autoTitlePrompt, titleAttempted: new Set(),
      [site.sidVar]: SID, [site.stVar]: freshState(), ...extra,
    });
    assert.ok(evalExpr(site.cond, env(USER_TEXT)), `${site.label}:autoTitlePrompt 有内容、其余前提都满足时条件应成立`);
    assert.ok(!evalExpr(site.cond, env('')), `${site.label}:autoTitlePrompt 为空串时条件应不成立`);
    assert.ok(!evalExpr(site.cond, env(USER_TEXT, { titleAttempted: new Set([SID]) })), `${site.label}:本会话已尝试过时条件应不成立(会话 id 变量 ${site.sidVar} 没接上)`);
    assert.equal(evalExpr(site.firstUser, env(USER_TEXT)), USER_TEXT, `${site.label}:firstUser 表达式应求值为 autoTitlePrompt`);
  }
});

// ══ 第 11 条:前提钉住 ══
check('11 前提:工具重做调用点经 resendReplacing 发出,opts 带 hiddenUserMessage: true,文本与 opts 即第 1、2 条所用', () => {
  const calls = indexesOf(app, 'resendReplacing(').map((i) => ({ i, args: callArgs(app, i + 'resendReplacing'.length) }));
  const retryCalls = calls.filter((c) => c.args.length && c.args[0].includes('cgui-tool-retry'));
  if (!retryCalls.length) fail('找不到', `文本含 cgui-tool-retry 的 resendReplacing(…) 调用(resendReplacing 调用共 ${calls.length} 处)`);
  for (const { i, args } of retryCalls) {
    const line = lineOf(i);
    if (args.length !== 2) fail('次数不对', `第 ${line} 行 resendReplacing 实参应 2 个(文本、opts),实际 ${args.length} 个`);
    const textFor = (continuePrompt) => evalExpr(args[0], { opts: { continuePrompt }, toolCall: { name: 'Bash' } });
    assert.equal(textFor(undefined), RETRY_TEXT, `第 ${line} 行:不带续跑指令时文本应是 ${RETRY_TEXT}`);
    assert.equal(textFor('换个方式继续'), RETRY_CONTINUE_TEXT, `第 ${line} 行:带续跑指令时文本应是 ${RETRY_CONTINUE_TEXT}`);
    const sent = evalExpr(args[1], { appendSystemPrompt: TOOL_RETRY_OPTS.appendSystemPrompt });
    assert.equal(sent?.hiddenUserMessage, true, `第 ${line} 行:opts 应带 hiddenUserMessage: true`);
    assert.deepEqual(sent, TOOL_RETRY_OPTS, `第 ${line} 行:opts 应正是第 1 条所用的 { appendSystemPrompt, hiddenUserMessage: true }`);
  }
});

check('11 前提:resendReplacing 以 { ...opts, forceSend: true } 调 handleSendRef.current,文本与 opts 原样透传', () => {
  const RR_HEAD = 'const resendReplacing = useCallback((text, opts = {}) => {';
  const { start, end } = callbackSpan(RR_HEAD, 'resendReplacing');
  const bodyFrom = start + RR_HEAD.length;
  const body = app.slice(bodyFrom, end);
  const sendAts = indexesOf(body, 'handleSendRef.current');
  if (sendAts.length !== 1) fail('次数不对', `resendReplacing 里调 handleSendRef.current 应恰好 1 处,实际 ${sendAts.length} 处`);
  const callHead = /^handleSendRef\.current(\?\.)?\(/.exec(body.slice(sendAts[0]));
  if (!callHead) fail('找不到', 'resendReplacing 里的 handleSendRef.current?.(…) 调用');
  const args = callArgs(app, bodyFrom + sendAts[0] + callHead[0].length - 1);
  if (args.length !== 2) fail('次数不对', `handleSendRef.current 实参应 2 个,实际 ${args.length} 个`);
  assert.equal(evalExpr(args[0], { text: RETRY_TEXT }), RETRY_TEXT, '文本应原样透传');
  for (const opts of [TOOL_RETRY_OPTS, QUEUE_HIDDEN_OPTS]) {
    assert.deepEqual(evalExpr(args[1], { opts }), { ...opts, forceSend: true }, `opts=${JSON.stringify(opts)} 应原样透传、只追加 forceSend: true`);
  }
  const optsWrites = body.match(/\bopts(?:\.\w+|\[[^\]]*\])?\s*=(?![=>])/g) || [];
  if (optsWrites.length) fail('次数不对', `resendReplacing 里不应改写 opts,实际 ${optsWrites.length} 处:${optsWrites.join(' / ')}`);
});

check('11 前提:handleSendRef.current 只被赋成 handleSend(重发与队列回放都经它进 handleSend)', () => {
  const assigned = [...app.matchAll(/\bhandleSendRef\.current\s*=(?!=)\s*([^;\n]+)/g)].map((m) => m[1].trim());
  if (!assigned.length) fail('找不到', 'handleSendRef.current = … 的赋值');
  assert.deepEqual([...new Set(assigned)], ['handleSend'], `handleSendRef.current 只应被赋成 handleSend,实际:${assigned.join(' / ')}`);
});

// ══ 第 1–8 条:行为清单(两处条件原文 × 真实 xsAutoTitlePrompt) ══
const bothSitesTurnEndFirst = () => { const { siteEnd, siteSid } = need('siteEnd', 'siteSid'); return [siteEnd, siteSid]; };

check('1 复现:工具重做的隐藏消息 → 回合结束时不发起(拿到会话 id 那处同判)', () => {
  expectNoTitle(bothSitesTurnEndFirst(), ITEM1);
});
check('2 复现:带续跑指令的工具重做 → 回合结束时不发起(拿到会话 id 那处同判)', () => {
  expectNoTitle(bothSitesTurnEndFirst(), ITEM2);
});
check('3 复现:队列隐藏条目出队发送(opts 只有 hiddenUserMessage: true)→ 回合结束时不发起(拿到会话 id 那处同判)', () => {
  expectNoTitle(bothSitesTurnEndFirst(), ITEM3);
});
check('4 复现:隐藏发送的自动重发(+oneMRetry / signatureRetry / freshRetry / autoRetry / busyRequeued / forceSend)→ 回合结束时不发起(拿到会话 id 那处同判)', () => {
  expectNoTitle(bothSitesTurnEndFirst(), ITEM4);
});
check('5 回归:第 1–4 条的隐藏发送在拿到会话 id 那处也不发起', () => {
  expectNoTitle([need('siteSid').siteSid], [...ITEM1, ...ITEM2, ...ITEM3, ...ITEM4]);
});
check('6 回归:用户手打的消息(空 opts / 附件 meta / steer / fromComposer / forceSend / hiddenUserMessage: false)→ 两处照常发起,firstUser 是原文', () => {
  const { siteSid, siteEnd } = need('siteSid', 'siteEnd');
  for (const site of [siteSid, siteEnd]) {
    for (const opts of TYPED_OPTS) {
      const s = sendOf(USER_TEXT, opts);
      if (!fires(site, s)) assert.fail(`${site.label}:手打消息 ${s.label} 应发起自动标题,实际不发起`);
      assert.equal(firstUserOf(site, s), USER_TEXT, `${site.label}:手打消息 ${s.label} 的 firstUser 应是原文`);
    }
  }
});
check('7 回归:点卡片处理跨会话消息(带 xsProcess,有无 hiddenUserMessage)→ 两处都不发起', () => {
  const { siteSid, siteEnd } = need('siteSid', 'siteEnd');
  expectNoTitle([siteSid, siteEnd], ITEM7);
});
check('8 回归:会话已有自定义标题或自动标题 → 手打消息两处都不发起', () => {
  const { siteSid, siteEnd } = need('siteSid', 'siteEnd');
  const typed = TYPED_OPTS.map((opts) => sendOf(USER_TEXT, opts));
  expectNoTitle([siteSid, siteEnd], typed, freshState({ customTitles: { [SID]: '我起的标题' } }));
  expectNoTitle([siteSid, siteEnd], typed, freshState({ autoTitles: { [SID]: '已生成的标题' } }));
});

const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed) process.exit(1);
console.log('PASS check-r151v-hidden-autotitle');
process.exit(0);
