#!/usr/bin/env node
// 批K K2:输入预测"时有时无"。建议由 SDK 在 result 之后【另起一次模型调用】生成,
// 官方缓存命中约 1-2s,第三方中转/大上下文经常更久。修前两处让它无声消失:
//   ① 关流等待窗只有 3s(子代理窗是 4s,两套时限),到点 finalize→done→res.end();
//   ② 之后到达的建议进 deliverLine 时已无监听 → 落 earlyLines → 下条消息清空,全程零日志。
// 修法:窗口统一 4s;窗外才到的走全局 WS 兜底(prompt-suggestion-bg),与 SSE 同一个
// store map 落点(按 sessionId,内容相等去重);兜底也送不出去才 warn。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const chat = readFileSync(join(root, 'server/routes/chat.js'), 'utf8');
const ws = readFileSync(join(root, 'client/src/hooks/useWebSocket.js'), 'utf8');
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');

// ── 1. 关流等待窗:建议窗与子代理窗同为 4s(不再是两套时限)──────────
{
  const m = chat.match(/const delay = ([^;]+);/);
  assert.ok(m, 'chat.js 必须仍有 result 分支的 const delay = ...');
  assert.equal(m[1].trim(), '(slot.turnSubagentSeen || suggestOn) ? 4000 : 0',
    '建议窗必须与子代理窗同为 4000(3000 太短,建议要另起一次模型调用才生成)');
  // finalize 本体是停止链路红线,只许改 delay 数值表达式
  assert.ok(/closeTimer = setTimeout\(\(\) => finalize\(\), delay\)/.test(chat),
    'result 分支仍须是 setTimeout(finalize, delay),不得改写 finalize 时序');
}

// ── 2. WS 兜底:无 SSE 监听时改走全局广播,送不出去才 warn ─────────────
{
  const i = chat.indexOf('function deliverLine(slot, line)');
  assert.ok(i > 0, 'deliverLine 必须还在');
  const body = chat.slice(i, chat.indexOf('\n}', chat.indexOf('prompt_suggestion', i)) + 2);
  // 必须在"无监听"的 else 分支里(与 task-notification-bg 同一位置),SSE 在线时不双发
  const elseIdx = body.indexOf('slot.earlyLines.push(line)');
  const sugIdx = body.indexOf("line.includes('prompt_suggestion')");
  assert.ok(elseIdx > 0 && sugIdx > elseIdx,
    '建议兜底必须在无监听分支内(SSE 在线走监听分支,不能双发)');
  assert.ok(/type: 'prompt-suggestion-bg'/.test(body), '兜底广播类型须为 prompt-suggestion-bg');
  assert.ok(/sessionId: slot\.sessionId/.test(body.slice(sugIdx)), '兜底必须带 sessionId 供前端入位');
  assert.ok(/console\.warn\(`\[chat\] prompt_suggestion 丢弃/.test(body),
    '兜底也无客户端时必须记一行 warn(真丢弃点)');
  assert.ok(/clients\].some\(\(c\) => c\.readyState === 1\)/.test(body),
    'warn 必须以"无在线 WS 客户端"为条件,正常路径不加噪音');
}

// ── 3. 前端:WS 兜底与 SSE 落到同一个 store 入口 ───────────────────────
{
  assert.ok(/case 'prompt-suggestion-bg':/.test(ws), 'useWebSocket 必须处理 prompt-suggestion-bg');
  const seg = ws.slice(ws.indexOf("case 'prompt-suggestion-bg':"), ws.indexOf("case 'prompt-suggestion-bg':") + 700);
  assert.ok(/setPromptSuggestionFor\(data\.sessionId, data\.suggestion\)/.test(seg),
    'WS 兜底须按 sessionId 入位到与 SSE 同一 store 入口');
  assert.ok(/setPromptSuggestionFor\(streamSid \|\| streamOwnerKeyRef\.current, sTxt\)/.test(app),
    'SSE 分支须写同一个 store 入口(不再是组件 useState)');
  assert.ok(!/setPromptSuggestion\(/.test(app),
    '组件内 useState 的 setPromptSuggestion 必须全部撤掉(切窗格即丢是本 bug 的另一半)');
  assert.ok(/clearPromptSuggestion\(sessionQueueKey, selectedSession\?\.sessionId\)/.test(app),
    '发新回合 / 手动关掉只清本会话的两个 key');
}

// ── 4. 真 store 行为:按 sid 隔离 + 内容相等去重 ───────────────────────
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.window = globalThis;
globalThis.document = { addEventListener() {}, removeEventListener() {} };
const { useStore } = await import('../../client/src/stores/sessionStore.js');
const st = () => useStore.getState();

st().setPromptSuggestionFor('sid-A', '继续跑测试');
st().setPromptSuggestionFor('sid-B', '看下日志');
assert.equal(st().promptSuggestionBySid['sid-A'], '继续跑测试');
assert.equal(st().promptSuggestionBySid['sid-B'], '看下日志', '两个会话各存各的,不互相覆盖');

// 同一条建议 SSE + WS 双路径到达:第二次不产生新对象(免多余渲染,也就无所谓谁先到)
const before = st().promptSuggestionBySid;
st().setPromptSuggestionFor('sid-A', '继续跑测试');
assert.equal(st().promptSuggestionBySid, before, '内容相等的重复入位必须是 no-op');

// 空文本 / 无 sid 不入位
st().setPromptSuggestionFor('sid-C', '   ');
st().setPromptSuggestionFor('', '有内容但没归属');
assert.ok(!('sid-C' in st().promptSuggestionBySid), '空白建议不入位');
assert.equal(st().promptSuggestionBySid, before, '无效入位不改引用');

// 清除只清点名的 key(draft-key 与真 sid 一起清),别的会话不受影响
st().setPromptSuggestionFor('draft-hash1', '草稿期的建议');
st().clearPromptSuggestion('sid-A', 'draft-hash1');
assert.ok(!('sid-A' in st().promptSuggestionBySid) && !('draft-hash1' in st().promptSuggestionBySid),
  '点名的两个 key 都清掉');
assert.equal(st().promptSuggestionBySid['sid-B'], '看下日志', '别的会话的建议不许被连坐清掉');

const after = st().promptSuggestionBySid;
st().clearPromptSuggestion('sid-nonexistent');
assert.equal(st().promptSuggestionBySid, after, '清一个不存在的 key 不改引用');

console.log('✓ check-prompt-suggestion: 等待窗 + WS 兜底 + 按会话隔离全过');
