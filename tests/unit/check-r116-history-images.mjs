#!/usr/bin/env node
// r116 接口层:读历史 GET /api/sessions/:sessionId/messages 时,工具结果 result 的 content / images 形状。
// 依据只有 .devflow/BRIEF-r116.md(R1–R4、R6)与 .devflow/INTERFACE-r116.md §A,没看实现。
//
//   · 内容块数组 → content = 文字块按原顺序用 \n 连接(不含图片数据、不含 JSON 原文);
//     含图片块时多一个 images:[{mime,data}](Anthropic 形态 / MCP 直传形态都要认,缺类型记 image/png)。
//   · 字符串结果原样;不含图片的结果不出现 images 键;isError、workflowRun 与现有一致。
//
// 真 server/routes/sessions.js 挂在裸 express 上,HOME 指到临时目录(不碰真 ~/.claude);
// 端口只在 6900–6999 里挑空闲的(硬规:6700–6999,6677/6689/6710 不碰)。
// Run: node tests/unit/check-r116-history-images.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = mkdtempSync(join(tmpdir(), 'cgui-r116-history-'));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows 上 homedir() 读 %USERPROFILE%

// ── 小的合法 PNG(真能解码;每张尺寸/颜色不同,数据互不相同)──────────────────
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
const png = (w, h, [r, g, b]) => {
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([r, g, b], y * row + 1 + x * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]).toString('base64');
};
const IMG_A = png(4, 3, [220, 30, 30]);
const IMG_B = png(5, 3, [30, 200, 30]);
const IMG_C = png(6, 3, [30, 30, 220]);
const IMG_D = png(7, 3, [200, 200, 30]);
const IMG_E = png(8, 3, [30, 200, 200]);
const BIG = randomBytes(300_000).toString('base64'); // 40 万字符:"数十万字符编码"的大截图

// ── 内容块的两种图片写法 ───────────────────────────────────────────────────
const text = (t) => ({ type: 'text', text: t });
const anthImg = (data, media_type = 'image/png') =>
  ({ type: 'image', source: media_type ? { type: 'base64', media_type, data } : { type: 'base64', data } });
const mcpImg = (data, mimeType) => (mimeType ? { type: 'image', mimeType, data } : { type: 'image', data });

// ── 夹具会话:每个场景一份独立会话文件 ─────────────────────────────────────
const HASH = '-tmp-r116-history-fixture';
const PROJ = join(home, '.claude', 'projects', HASH);
mkdirSync(PROJ, { recursive: true });
const CU = 'mcp__ccgui-computer-use__screenshot';
let seq = 0;
const T = (n) => `2026-09-15T08:00:${String(n).padStart(2, '0')}.000Z`;

/** calls: [{ id, name, input?, block?(tool_result 块,缺省 = 不写结果), toolUseResult? }] */
const sessionRows = (sid, calls) => {
  seq += 1;
  const base = { sessionId: sid, cwd: '/tmp/r116-ws', isSidechain: false, userType: 'external', version: '2.1.267' };
  const rows = [
    { ...base, type: 'user', uuid: `u1-${seq}`, parentUuid: null, timestamp: T(0), message: { role: 'user', content: '帮我截一张屏' } },
    { ...base, type: 'assistant', uuid: `a1-${seq}`, parentUuid: `u1-${seq}`, timestamp: T(1),
      message: { id: `msg_r116_${seq}_1`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input || {} })),
        stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
  const results = calls.filter((c) => c.block);
  if (results.length) {
    rows.push({ ...base, type: 'user', uuid: `u2-${seq}`, parentUuid: `a1-${seq}`, timestamp: T(2),
      ...(results[0].toolUseResult !== undefined ? { toolUseResult: results[0].toolUseResult } : {}),
      message: { role: 'user', content: results.map((c) => ({ type: 'tool_result', tool_use_id: c.id, ...c.block })) } });
  }
  rows.push({ ...base, type: 'assistant', uuid: `a2-${seq}`, parentUuid: `u2-${seq}`, timestamp: T(3),
    message: { id: `msg_r116_${seq}_2`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [text('看完了')], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } });
  return rows;
};
const writeJsonl = (file, rows) => writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const SID = {};
const fixture = (key, calls) => {
  SID[key] = `r116000${String(Object.keys(SID).length + 1).padStart(2, '0')}-0000-4000-8000-000000000116`;
  writeJsonl(join(PROJ, `${SID[key]}.jsonl`), sessionRows(SID[key], calls));
};

const STR_TEXT = '第一行输出\n  第二行(缩进) ✓ 🙂\n';
const JSONISH = JSON.stringify([text('这是 Bash 打印出来的字符串'), anthImg(IMG_A)]);
const LAUNCH = 'Workflow launched in background. Task ID: w1zi6gd0p\n'
  + 'Transcript dir: /Users/x/.claude/projects/-tmp-r116/aaaa-bbbb/subagents/workflows/wf_631a4c46-1d3';

fixture('anth', [{ id: 'toolu_anth', name: CU, block: { content: [text('截图完成:1 张'), anthImg(IMG_A)] } }]);
fixture('mcp', [{ id: 'toolu_mcp', name: CU, block: { content: [mcpImg(IMG_B, 'image/jpeg'), text('MCP 直传的截图')] } }]);
fixture('mixed', [{ id: 'toolu_mixed', name: CU,
  block: { content: [text('第一段'), anthImg(IMG_C, 'image/png'), text('第二段'), mcpImg(IMG_D, 'image/webp')] } }]);
fixture('anthNoMime', [{ id: 'toolu_anth_nomime', name: CU, block: { content: [text('无类型'), anthImg(IMG_E, null)] } }]);
fixture('mcpNoMime', [{ id: 'toolu_mcp_nomime', name: CU, block: { content: [text('无类型'), mcpImg(IMG_E)] } }]);
fixture('imgOnly', [{ id: 'toolu_imgonly', name: CU, block: { content: [anthImg(IMG_A)] } }]);
fixture('textOnly', [{ id: 'toolu_textonly', name: 'mcp__docs__lookup', block: { content: [text('R116 第一行'), text('R116 第二行 ✓')] } }]);
fixture('emptyArr', [{ id: 'toolu_emptyarr', name: 'mcp__docs__lookup', block: { content: [] } }]);
fixture('otherBlock', [{ id: 'toolu_other', name: 'mcp__docs__lookup',
  block: { content: [text('只留文字'), { type: 'resource_link', uri: 'file:///tmp/r116.txt', name: 'r116.txt' }] } }]);
fixture('str', [{ id: 'toolu_str', name: 'Bash', input: { command: 'printf …' }, block: { content: STR_TEXT, is_error: false } }]);
fixture('jsonish', [{ id: 'toolu_jsonish', name: 'Bash', input: { command: 'cat blocks.json' }, block: { content: JSONISH, is_error: false } }]);
fixture('big', [{ id: 'toolu_big', name: CU, block: { content: [text('大图截好了'), anthImg(BIG)] } }]);
fixture('errImg', [{ id: 'toolu_errimg', name: CU, block: { content: [text('截图部分失败'), anthImg(IMG_A)], is_error: true } }]);
fixture('errStr', [{ id: 'toolu_errstr', name: 'Bash', block: { content: 'command not found', is_error: true } }]);
fixture('workflow', [{ id: 'toolu_wf', name: 'Workflow', input: { script: 'x' }, block: { content: [text(LAUNCH)], is_error: false } }]);
fixture('twoTools', [
  { id: 'toolu_two_shot', name: CU, block: { content: [text('截图完成'), anthImg(IMG_A)] } },
  { id: 'toolu_two_bash', name: 'Bash', input: { command: 'echo hi' }, block: { content: 'hi\n', is_error: false } },
]);
fixture('noResult', [{ id: 'toolu_noresult', name: CU }]);
// 真落盘形态:MCP 工具的结果行上 CLI 还会带一份 toolUseResult 副本(与 message 里的块数组相同)
fixture('diskShape', [{ id: 'toolu_disk', name: CU, toolUseResult: [text('截图完成(真落盘形态)'), anthImg(IMG_B)],
  block: { content: [text('截图完成(真落盘形态)'), anthImg(IMG_B)] } }]);

// 子代理转写(同一个历史接口读 agent id):子代理里调电脑操控截图也要按同一契约给图
const PARENT = 'r1160099-0000-4000-8000-000000000116';
const AGENT = 'agent-r116aaaa0000bbbb';
const subDir = join(PROJ, PARENT, 'subagents');
mkdirSync(subDir, { recursive: true });
writeJsonl(join(subDir, `${AGENT}.jsonl`), [
  { type: 'user', uuid: 'su1', timestamp: T(0), message: { role: 'user', content: '子代理:截一张屏' } },
  { type: 'assistant', uuid: 'sa1', timestamp: T(1), message: { id: 'msg_sub_1', model: 'm', content: [{ type: 'tool_use', id: 'toolu_sub_shot', name: CU, input: {} }] } },
  { type: 'user', uuid: 'su2', timestamp: T(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sub_shot', content: [text('子代理截图完成'), anthImg(IMG_C)] }] } },
  { type: 'assistant', uuid: 'sa2', timestamp: T(3), message: { id: 'msg_sub_2', model: 'm', content: [text('SUB_DONE')] } },
]);
writeFileSync(join(subDir, `${AGENT}.meta.json`), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_parent_task' }), 'utf8');

// ── 真路由:裸 express 挂 server/routes/sessions.js ─────────────────────────
const express = (await import('express')).default;
const { default: sessionRoutes } = await import(`${root}/server/routes/sessions.js`);
const app = express();
app.use(express.json());
app.use('/api', sessionRoutes);
const listenIn = async (from, to) => {
  for (let port = from; port <= to; port++) {
    if ([6677, 6689, 6710].includes(port)) continue;
    const srv = await new Promise((resolve) => {
      const s = app.listen(port, '127.0.0.1');
      s.once('listening', () => resolve(s));
      s.once('error', () => resolve(null));
    });
    if (srv) return srv;
  }
  throw new Error(`${from}–${to} 没有空闲端口`);
};
const server = await listenIn(6900, 6999);
const base = `http://127.0.0.1:${server.address().port}`;

const cache = new Map();
const history = async (sid) => {
  if (!cache.has(sid)) {
    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(sid)}/messages?projectHash=${encodeURIComponent(HASH)}`);
    assert.equal(res.status, 200, `读历史 ${sid} 应 200,实得 ${res.status}`);
    cache.set(sid, await res.json());
  }
  return cache.get(sid);
};
/** 按工具调用 id 取 result(找不到这个工具调用 = 夹具没被读出来,直接报)。 */
const resultOf = async (sid, toolId) => {
  const body = await history(sid);
  const tc = (body.messages || []).flatMap((m) => m.toolCalls || []).find((t) => t.id === toolId);
  assert.ok(tc, `历史里找不到工具调用 ${toolId}`);
  return tc.result;
};
const brief = (v) => { const s = JSON.stringify(v); return s && s.length > 160 ? `${s.slice(0, 160)}…(共 ${s.length} 字符)` : s; };

let failed = 0;
let passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  // 每行截到 300 字符:大截图用例失败时 assert 的差异行里是整段 40 万字符编码,不截会刷屏
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').slice(0, 4).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l)).join('\n      ')}`); }
};

console.log('\nR1 文字 + 图片(Anthropic 形态)');
await check('R116-A01 [文字,图片] → content 恰为文字本身(不含图片编码与 JSON 原文)', async () => {
  const r = await resultOf(SID.anth, 'toolu_anth');
  assert.equal(r.content, '截图完成:1 张', `content 实得 ${brief(r.content)}`);
});
await check('R116-A02 [文字,图片] → images = [{mime:"image/png", data:<不带 data: 前缀的原文>}]', async () => {
  const r = await resultOf(SID.anth, 'toolu_anth');
  assert.deepEqual(r.images, [{ mime: 'image/png', data: IMG_A }], `images 实得 ${brief(r.images)}`);
});
await check('R116-A03 带图结果的键集合 = 普通结果的键 + images(其余字段不增不减)', async () => {
  const r = await resultOf(SID.anth, 'toolu_anth');
  assert.deepEqual(Object.keys(r).sort(), ['content', 'images', 'isError', 'toolUseId'], `键实得 ${Object.keys(r).sort()}`);
  assert.equal(r.toolUseId, 'toolu_anth');
  assert.equal(r.isError, false);
});

console.log('\nR2 MCP 直传形态 / 混排 / 缺图片类型');
await check('R116-A04 MCP 直传 {type:image,mimeType,data} → images = [{mime:"image/jpeg", data}]', async () => {
  const r = await resultOf(SID.mcp, 'toolu_mcp');
  assert.deepEqual(r.images, [{ mime: 'image/jpeg', data: IMG_B }], `images 实得 ${brief(r.images)}`);
});
await check('R116-A05 MCP 直传 [图片,文字] → content 恰为文字', async () => {
  const r = await resultOf(SID.mcp, 'toolu_mcp');
  assert.equal(r.content, 'MCP 直传的截图', `content 实得 ${brief(r.content)}`);
});
await check('R116-A06 [文字A,图,文字B,图] → content = "文字A\\n文字B"(按原顺序换行连接)', async () => {
  const r = await resultOf(SID.mixed, 'toolu_mixed');
  assert.equal(r.content, '第一段\n第二段', `content 实得 ${brief(r.content)}`);
});
await check('R116-A07 两种写法混排的两张图按原顺序给出,各带自己的类型', async () => {
  const r = await resultOf(SID.mixed, 'toolu_mixed');
  assert.deepEqual(r.images, [{ mime: 'image/png', data: IMG_C }, { mime: 'image/webp', data: IMG_D }], `images 实得 ${brief(r.images)}`);
});
await check('R116-A08 Anthropic 形态缺 media_type → mime 记为 image/png', async () => {
  const r = await resultOf(SID.anthNoMime, 'toolu_anth_nomime');
  assert.deepEqual(r.images, [{ mime: 'image/png', data: IMG_E }], `images 实得 ${brief(r.images)}`);
});
await check('R116-A09 MCP 形态缺 mimeType → mime 记为 image/png', async () => {
  const r = await resultOf(SID.mcpNoMime, 'toolu_mcp_nomime');
  assert.deepEqual(r.images, [{ mime: 'image/png', data: IMG_E }], `images 实得 ${brief(r.images)}`);
});
await check('R116-A10 只有图片块(没有文字块)→ content 为空串', async () => {
  const r = await resultOf(SID.imgOnly, 'toolu_imgonly');
  assert.equal(r.content, '', `content 实得 ${brief(r.content)}`);
});
await check('R116-A11 只有图片块 → images 恰好 1 张且数据原样', async () => {
  const r = await resultOf(SID.imgOnly, 'toolu_imgonly');
  assert.deepEqual(r.images, [{ mime: 'image/png', data: IMG_A }], `images 实得 ${brief(r.images)}`);
});

console.log('\nR3 只有文字块的数组');
await check('R116-A12 [文字,文字] → content = "R116 第一行\\nR116 第二行 ✓"(不是 JSON 原文)', async () => {
  const r = await resultOf(SID.textOnly, 'toolu_textonly');
  assert.equal(r.content, 'R116 第一行\nR116 第二行 ✓', `content 实得 ${brief(r.content)}`);
});
await check('R116-A13 纯文字数组不出现 images 键', async () => {
  const r = await resultOf(SID.textOnly, 'toolu_textonly');
  assert.equal('images' in r, false, `不该有 images,实得 ${brief(r.images)}`);
});
await check('R116-A14 空数组 [] → content 为空串,且没有 images 键', async () => {
  const r = await resultOf(SID.emptyArr, 'toolu_emptyarr');
  assert.equal(r.content, '', `content 实得 ${brief(r.content)}`);
  assert.equal('images' in r, false);
});
await check('R116-A15 文字块 + 其它类型块 → 只留文字,不出现 JSON 原文,也没有 images 键', async () => {
  const r = await resultOf(SID.otherBlock, 'toolu_other');
  assert.equal(r.content, '只留文字', `content 实得 ${brief(r.content)}`);
  assert.equal('images' in r, false);
});

console.log('\nR4 字符串结果原样(反向守卫)');
await check('R116-A16 字符串结果原样不变(换行/缩进/emoji 一个字不动)', async () => {
  const r = await resultOf(SID.str, 'toolu_str');
  assert.equal(r.content, STR_TEXT, `content 实得 ${brief(r.content)}`);
});
await check('R116-A17 字符串结果的键集合仍是 {toolUseId,content,isError}(不多出 images)', async () => {
  const r = await resultOf(SID.str, 'toolu_str');
  assert.deepEqual(Object.keys(r).sort(), ['content', 'isError', 'toolUseId'], `键实得 ${Object.keys(r).sort()}`);
});
await check('R116-A18 字符串内容恰好长得像"块数组 JSON"也原样返回,不被当成图片解析', async () => {
  const r = await resultOf(SID.jsonish, 'toolu_jsonish');
  assert.equal(r.content, JSONISH, `content 实得 ${brief(r.content)}`);
  assert.equal('images' in r, false, '字符串结果不许长出 images');
});

console.log('\nR6 大截图(40 万字符编码)');
await check('R116-A19 大截图结果的 content 只有文字,不含一个字符的编码', async () => {
  const r = await resultOf(SID.big, 'toolu_big');
  assert.ok(r.content === '大图截好了', `content 实得 ${brief(r.content)}`);
});
await check('R116-A20 大截图的 images[0].data 完整给出(不截断、不加前缀)', async () => {
  const r = await resultOf(SID.big, 'toolu_big');
  assert.ok(Array.isArray(r.images) && r.images.length === 1, `images 实得 ${brief(r.images)}`);
  assert.equal(r.images[0].mime, 'image/png');
  assert.equal(r.images[0].data.length, BIG.length, `data 长度 ${r.images[0].data.length} ≠ 原文 ${BIG.length}`);
  assert.equal(r.images[0].data === BIG, true, 'data 与原文不一致');
});

console.log('\nisError / workflowRun / 多工具 / 无结果(与现有一致)');
await check('R116-A21 出错的带图结果:isError 仍为 true', async () => {
  const r = await resultOf(SID.errImg, 'toolu_errimg');
  assert.equal(r.isError, true, `isError 实得 ${brief(r.isError)}`);
});
await check('R116-A22 出错的字符串结果:isError=true、content 原样(反向守卫)', async () => {
  const r = await resultOf(SID.errStr, 'toolu_errstr');
  assert.equal(r.isError, true);
  assert.equal(r.content, 'command not found');
  assert.equal('images' in r, false);
});
await check('R116-A23 工作流结果(纯文字块数组)的 workflowRun 照旧识别出 runId/taskId(反向守卫)', async () => {
  const r = await resultOf(SID.workflow, 'toolu_wf');
  assert.equal(r.workflowRun?.runId, 'wf_631a4c46-1d3', `workflowRun 实得 ${brief(r.workflowRun)}`);
  assert.equal(r.workflowRun.taskId, 'w1zi6gd0p');
});
await check('R116-A24 工作流结果(纯文字块数组)的 content = 那段文字本身', async () => {
  const r = await resultOf(SID.workflow, 'toolu_wf');
  assert.equal(r.content, LAUNCH, `content 实得 ${brief(r.content)}`);
});
await check('R116-A25 工作流结果没有 images 键', async () => {
  const r = await resultOf(SID.workflow, 'toolu_wf');
  assert.equal('images' in r, false);
});
await check('R116-A26 同一回合两个工具:截图那个带 1 张图', async () => {
  const shot = await resultOf(SID.twoTools, 'toolu_two_shot');
  assert.deepEqual(shot.images, [{ mime: 'image/png', data: IMG_A }], `images 实得 ${brief(shot.images)}`);
});
await check('R116-A27 同一回合两个工具:Bash 那个不沾图、content 原样(反向守卫)', async () => {
  const bash = await resultOf(SID.twoTools, 'toolu_two_bash');
  assert.equal('images' in bash, false, `Bash 结果不该有 images,实得 ${brief(bash.images)}`);
  assert.equal(bash.content, 'hi\n');
});
await check('R116-A28 没有结果的工具调用 result 仍为 null(反向守卫)', async () => {
  const r = await resultOf(SID.noResult, 'toolu_noresult');
  assert.equal(r, null, `result 实得 ${brief(r)}`);
});

console.log('\n真落盘形态 / 子代理历史');
await check('R116-A29 结果行同时带 toolUseResult 副本(真 CLI 落盘形态)→ content 为文字、images 1 张', async () => {
  const r = await resultOf(SID.diskShape, 'toolu_disk');
  assert.equal(r.content, '截图完成(真落盘形态)', `content 实得 ${brief(r.content)}`);
  assert.deepEqual(r.images, [{ mime: 'image/png', data: IMG_B }], `images 实得 ${brief(r.images)}`);
});
await check('R116-A30 子代理历史(同一接口读 agent id)里的截图结果同样给 content 文字 + images', async () => {
  const r = await resultOf(AGENT, 'toolu_sub_shot');
  assert.equal(r.content, '子代理截图完成', `content 实得 ${brief(r.content)}`);
  assert.deepEqual(r.images, [{ mime: 'image/png', data: IMG_C }], `images 实得 ${brief(r.images)}`);
});

server.close();
try { rmSync(home, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
console.log(`\n通过 ${passed} / 失败 ${failed}`);
console.log(failed ? `FAIL check-r116-history-images(${failed} 条红)` : 'PASS check-r116-history-images');
process.exit(failed ? 1 : 0);
