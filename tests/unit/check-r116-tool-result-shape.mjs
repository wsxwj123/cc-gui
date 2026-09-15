#!/usr/bin/env node
// r116 接口层(精简版,8 条):读历史 GET /api/sessions/:sessionId/messages 时工具结果 result 的 content / images。
// 依据只有 .devflow/BRIEF-r116.md(R1–R4、R6)与 .devflow/INTERFACE-r116.md §A,没看实现。
// 真 server/routes/sessions.js 挂在裸 express 上;HOME = 临时目录(不碰真 ~/.claude);端口 6900–6999。
// Run: node tests/unit/check-r116-tool-result-shape.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = mkdtempSync(join(tmpdir(), 'cgui-r116-shape-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

// 小的合法 base64(内容互不相同即可);大图 = 40 万字符
const b64 = (s) => Buffer.from(s).toString('base64');
const IMG_A = b64('r116-image-A');
const IMG_B = b64('r116-image-B');
const IMG_C = b64('r116-image-C');
const IMG_D = b64('r116-image-D');
const BIG = randomBytes(300_000).toString('base64');

const text = (t) => ({ type: 'text', text: t });
const anthImg = (data, media_type) => ({ type: 'image', source: media_type ? { type: 'base64', media_type, data } : { type: 'base64', data } });
const mcpImg = (data, mimeType) => (mimeType ? { type: 'image', mimeType, data } : { type: 'image', data });

const JSONISH = JSON.stringify([text('像块数组的字符串'), anthImg(IMG_A, 'image/png')]) + '\n  第二行 ✓🙂';
const LAUNCH = 'Workflow launched in background. Task ID: w1zi6gd0p\n'
  + 'Transcript dir: /Users/x/.claude/projects/-tmp-r116/aaaa-bbbb/subagents/workflows/wf_631a4c46-1d3';
const CU = 'mcp__ccgui-computer-use__screenshot';

// 一个夹具会话:一条助手消息发起全部工具调用,每个结果一行 user(与真 CLI 并行调用的落盘一致)
const CALLS = [
  { id: 'toolu_anth', name: CU, content: [text('截图完成:1 张'), anthImg(IMG_A, 'image/png')] },
  { id: 'toolu_mcp', name: CU, content: [mcpImg(IMG_B, 'image/jpeg'), text('MCP 直传的截图')] },
  { id: 'toolu_mixed', name: CU, content: [text('第一段'), anthImg(IMG_C), text('第二段'), mcpImg(IMG_D, 'image/webp')] },
  { id: 'toolu_text', name: 'mcp__docs__lookup', content: [text('R116 第一行'), text('R116 第二行 ✓')] },
  { id: 'toolu_str', name: 'Bash', content: JSONISH, is_error: true },
  { id: 'toolu_big', name: CU, content: [text('大图截好了'), anthImg(BIG, 'image/png')] },
  { id: 'toolu_wf', name: 'Workflow', content: [text(LAUNCH)] },
];
const HASH = '-tmp-r116-shape-fixture';
const SID = 'a1160099-0000-4000-8000-000000000116';
const PROJ = join(home, '.claude', 'projects', HASH);
mkdirSync(PROJ, { recursive: true });
const base = { sessionId: SID, cwd: '/tmp/r116-shape', isSidechain: false, userType: 'external', version: '2.1.267' };
const ts = (n) => `2026-09-15T08:00:${String(n).padStart(2, '0')}.000Z`;
const usage = { input_tokens: 10, output_tokens: 5 };
const rows = [
  { ...base, type: 'user', uuid: 'u0', parentUuid: null, timestamp: ts(0), message: { role: 'user', content: '帮我截一张屏' } },
  { ...base, type: 'assistant', uuid: 'a0', parentUuid: 'u0', timestamp: ts(1), message: { id: 'msg_r116_1', type: 'message', role: 'assistant',
    model: 'claude-sonnet-4-6', content: CALLS.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: {} })), stop_reason: 'tool_use', usage } },
  ...CALLS.map((c, i) => ({ ...base, type: 'user', uuid: `r${i}`, parentUuid: i ? `r${i - 1}` : 'a0', timestamp: ts(2 + i),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: c.id, content: c.content, ...(c.is_error ? { is_error: true } : {}) }] } })),
  { ...base, type: 'assistant', uuid: 'a1', parentUuid: `r${CALLS.length - 1}`, timestamp: ts(20), message: { id: 'msg_r116_2', type: 'message',
    role: 'assistant', model: 'claude-sonnet-4-6', content: [text('看完了')], stop_reason: 'end_turn', usage } },
];
writeFileSync(join(PROJ, `${SID}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

const express = (await import('express')).default;
const { default: sessionRoutes } = await import(`${root}/server/routes/sessions.js`);
const app = express();
app.use(express.json());
app.use('/api', sessionRoutes);
let server = null;
for (let port = 6900; port <= 6999 && !server; port++) {
  server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1');
    s.once('listening', () => resolve(s));
    s.once('error', () => resolve(null));
  });
}
if (!server) throw new Error('6900–6999 没有空闲端口');
const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${SID}/messages?projectHash=${encodeURIComponent(HASH)}`);
const body = res.status === 200 ? await res.json() : null;
server.close();

const brief = (v) => { const s = JSON.stringify(v); return s && s.length > 160 ? `${s.slice(0, 160)}…(共 ${s.length} 字符)` : s; };
const resultOf = (id) => {
  assert.ok(body, `读历史应 200,实得 ${res.status}`);
  const tc = (body.messages || []).flatMap((m) => m.toolCalls || []).find((t) => t.id === id);
  assert.ok(tc && tc.result, `历史里找不到工具调用 ${id} 或它没有 result`);
  return tc.result;
};

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String(e?.message || e).split('\n').slice(0, 3).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l)).join('\n      ')}`); }
};

check('U1 [R1] Anthropic 形态 [文字,图片] → content 恰为文字本身(无图片编码、无 JSON 原文)', () => {
  const r = resultOf('toolu_anth');
  assert.equal(r.content, '截图完成:1 张', `content 实得 ${brief(r.content)}`);
});
check('U2 [R1/R2] Anthropic 形态 → images = [{mime:"image/png", data:原文}]', () => {
  const r = resultOf('toolu_anth');
  assert.deepEqual(r.images, [{ mime: 'image/png', data: IMG_A }], `images 实得 ${brief(r.images)}`);
});
check('U3 [R2] MCP 直传形态 {mimeType,data} → images = [{mime:"image/jpeg", data:原文}]', () => {
  const r = resultOf('toolu_mcp');
  assert.deepEqual(r.images, [{ mime: 'image/jpeg', data: IMG_B }], `images 实得 ${brief(r.images)}`);
});
check('U4 [R2] 两种写法混排的两张图按原顺序给出,缺类型的记 image/png', () => {
  const r = resultOf('toolu_mixed');
  assert.deepEqual(r.images, [{ mime: 'image/png', data: IMG_C }, { mime: 'image/webp', data: IMG_D }], `images 实得 ${brief(r.images)}`);
});
check('U5 [R3] 纯文字块数组 → content = 两段文字用 \\n 连接,且没有 images 键', () => {
  const r = resultOf('toolu_text');
  assert.equal(r.content, 'R116 第一行\nR116 第二行 ✓', `content 实得 ${brief(r.content)}`);
  assert.equal('images' in r, false, `不该有 images,实得 ${brief(r.images)}`);
});
check('U6 [R4 反向] 字符串结果(长得像块数组 JSON、出错)原样返回:content 一字不改、isError=true、没有 images 键', () => {
  const r = resultOf('toolu_str');
  assert.equal(r.content, JSONISH, `content 实得 ${brief(r.content)}`);
  assert.equal(r.isError, true, `isError 实得 ${brief(r.isError)}`);
  assert.equal('images' in r, false, `字符串结果不许长出 images,实得 ${brief(r.images)}`);
});
check('U7 [R6] 大截图(40 万字符编码)→ content 只有文字,images[0].data 与原文逐字一致', () => {
  const r = resultOf('toolu_big');
  assert.equal(r.content, '大图截好了', `content 实得 ${brief(r.content)}`);
  assert.ok(Array.isArray(r.images) && r.images.length === 1 && r.images[0].data === BIG && r.images[0].mime === 'image/png',
    `images 实得 ${brief(r.images && r.images.map((i) => ({ mime: i.mime, len: i.data?.length })))}`);
});
check('U8 [约束 反向] 工作流结果(纯文字块数组)的 workflowRun 照旧识别出 runId / taskId', () => {
  const r = resultOf('toolu_wf');
  assert.equal(r.workflowRun?.runId, 'wf_631a4c46-1d3', `workflowRun 实得 ${brief(r.workflowRun)}`);
  assert.equal(r.workflowRun?.taskId, 'w1zi6gd0p', `workflowRun 实得 ${brief(r.workflowRun)}`);
});

console.log(failed ? `FAIL check-r116-tool-result-shape(${failed} 条红)` : 'PASS check-r116-tool-result-shape');
process.exit(failed ? 1 : 0);
