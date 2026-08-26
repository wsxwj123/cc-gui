#!/usr/bin/env node
// r63:openai 协议中转下视觉模型收不到图片。GUI 发图真实形态(BUGREPORT-r63 transcript
// 取证)是「`@路径` 文本 → 模型调 Read → 图片在 tool_result content 的 image block 里」,
// 而 openai-proxy 的 tool_result 分支把 content 无条件拍平成文本(image block 无 .text
// → 空串)→ 图片在任何配置下都到不了上游;r37 只修了 GUI 链路走不到的顶层 image 分支。
// 同因配套:剥图判定曾只读模块级 upstream.model(provider 切换时刻的 models[0]),与
// 会话实际模型(顶栏切换 → --model → body.model)脱钩,误判方向双向都有。
// 哨兵:S1 tool_result 分支改回拍平 → t1/t2/t5/t7/t9 红;
//       S2 判定忽略请求 model 参数(回读 upstream.model)→ t4/t5/t6/t9 红;
//       S3 noVision 时 tool_result 内图片不剥(原样转发)→ t4 红;
//       S4 前端黄条判据 revert 回 /deepseek/i.test(providerHint||baseUrl) 或删
//          openai 协议门控/绕开 attachmentNoVision 内联重写 → t10 红(实测过红)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// 命名空间 import:buildOpenAIRequest 的导出(仅为可单测)缺失时在 t9 给行为级报错,
// 不让 import 语法错掩盖 t1-t8 的真实红绿(与 check-openai-proxy-thinking.mjs 同手法)。
import * as proxy from '../../server/services/openai-proxy.js';

const { setOpenAIUpstream, upstreamNoVision, anthropicToOpenAIMessages } = proxy;

const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUFBQQ==' } };
const DATA_URL = 'data:image/png;base64,QUFBQQ==';
// GUI 附件链路真实形态:@绝对路径 → Read tool_use → tool_result 内嵌 image
const readTurn = (trContent) => ([
  { role: 'user', content: '看图\n\n附件:\n@/tmp/cgui-attachments/x.png' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/tmp/cgui-attachments/x.png' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: trContent }] },
]);
const imgParts = (out) => out.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p?.type === 'image_url') : []));

// ── t1(主修哨兵,修前必红):视觉模型下 tool_result 内 image 必须以 image_url 到达 ──
setOpenAIUpstream({ baseURL: 'https://relay.example.com/v1', apiKey: 'test-key', model: 'deepseek-v4-flash-vision-exp' });
{
  const out = anthropicToOpenAIMessages(readTurn([IMG]), null);
  const tool = out.find((m) => m.role === 'tool');
  assert.ok(tool, 't1: tool 消息仍存在');
  assert.equal(typeof tool.content, 'string', 't1: OpenAI 协议 role:tool 的 content 必须是字符串');
  assert.notEqual(tool.content.trim(), '', 't1: tool content 不为空(修前拍平成空串=模型以为 Read 无返回)');
  const imgs = imgParts(out);
  assert.equal(imgs.length, 1, 't1: 图片须以 image_url 到达上游(修前丢失)');
  assert.equal(imgs[0].image_url.url, DATA_URL, 't1: base64 → data URL 形态');
  // 顺序:assistant.tool_calls 后必须紧跟 tool 消息(严格端点配对约束),图挂其后的 user 消息
  const iAsst = out.findIndex((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
  assert.equal(out[iAsst + 1]?.role, 'tool', 't1: tool_calls 与 tool 消息保持紧邻(不被图片打断)');
  const iUserImg = out.findIndex((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url'));
  assert.ok(iUserImg > iAsst + 1, 't1: 图片以 user 多模态消息挂在 tool 消息之后');
}

// ── t2:tool_result 混合 text+image —— 文字保留 + 图到达 ──
{
  const out = anthropicToOpenAIMessages(readTurn([{ type: 'text', text: 'meta info' }, IMG]), null);
  const tool = out.find((m) => m.role === 'tool');
  assert.ok(tool.content.includes('meta info'), 't2: tool_result 内原有文字保留');
  assert.equal(imgParts(out).length, 1, 't2: 混合形态下图片也到达');
}

// ── t3:tool_result 为纯字符串 —— 既有行为一字不变 ──
{
  const out = anthropicToOpenAIMessages(readTurn('plain result'), null);
  const tool = out.find((m) => m.role === 'tool');
  assert.equal(tool.content, 'plain result', 't3: 字符串 content 原样透传');
  assert.equal(imgParts(out).length, 0, 't3: 无图不注入');
  assert.equal(out.length, 3, 't3: 不多发消息(user/assistant/tool 各一)');
}

// ── t4(剥图方向,杀 S2/S3):请求模型无视觉 → 即使 upstream.model 是识图模型也剥 ──
{
  // upstream.model 停在识图模型(如用户先选 vision-exp 完成过一次切换),会话实际用非识图模型
  setOpenAIUpstream({ baseURL: 'https://relay.example.com/v1', apiKey: 'test-key', model: 'deepseek-v4-flash-vision-exp' });
  const out = anthropicToOpenAIMessages(readTurn([IMG]), null, 'deepseek-v4-flash');
  assert.equal(imgParts(out).length, 0, 't4: 无视觉模型不得转发 image_url(上游会 400)');
  const tool = out.find((m) => m.role === 'tool');
  assert.ok(tool.content.includes('[图片已忽略'), 't4: 剥除后保留占位文本(与顶层分支同一句)');
}

// ── t5(放行方向,修前必红,杀 S2):upstream.model 停在 models[0](非识图),
//    会话实际选了识图模型 → 按请求 model 放行 ──
{
  setOpenAIUpstream({ baseURL: 'https://relay.example.com/v1', apiKey: 'test-key', model: 'deepseek-v4-flash' });
  const out = anthropicToOpenAIMessages(readTurn([IMG]), null, 'deepseek-v4-flash-vision-exp');
  assert.equal(imgParts(out).length, 1, 't5: 判定须按本次请求的 model,不受切换时刻 models[0] 影响');
}

// ── t6:upstreamNoVision 请求模型优先、缺失回落 upstream.model(旧调用零参不变) ──
{
  setOpenAIUpstream({ baseURL: 'https://relay.example.com/v1', apiKey: 'test-key', model: 'deepseek-v4-flash' });
  assert.equal(upstreamNoVision(), true, 't6: 零参调用回落 upstream.model(旧行为不变)');
  assert.equal(upstreamNoVision('deepseek-v4-flash-vision-exp'), false, 't6: 请求模型优先于 upstream.model');
  assert.equal(upstreamNoVision(''), true, 't6: 空串视为缺失,回落 upstream.model');
  assert.equal(upstreamNoVision(), true, 't6: 缓存按 model 分 key,不被上一次请求模型污染');
}

// ── t7:tool_result 内 url 形态 image 同样转换 ──
{
  setOpenAIUpstream({ baseURL: 'https://relay.example.com/v1', apiKey: 'test-key', model: 'deepseek-v4-flash-vision-exp' });
  const out = anthropicToOpenAIMessages(
    readTurn([{ type: 'image', source: { type: 'url', url: 'https://img.example.com/a.png' } }]), null);
  const imgs = imgParts(out);
  assert.equal(imgs.length, 1, 't7: url 形态图片到达');
  assert.equal(imgs[0].image_url.url, 'https://img.example.com/a.png', 't7: url 原样透传');
}

// ── t8:顶层 image 分支既有行为不变(r37 修的那条路) ──
{
  const shapeB = [{ role: 'user', content: [{ type: 'text', text: '看图' }, IMG] }];
  setOpenAIUpstream({ baseURL: 'https://relay.example.com/v1', apiKey: 'test-key', model: 'deepseek-v4-flash-vision-exp' });
  const ok = anthropicToOpenAIMessages(shapeB, null);
  assert.equal(imgParts(ok).length, 1, 't8: 视觉模型下顶层 image 照常转 image_url');
  const strip = anthropicToOpenAIMessages(shapeB, null, 'deepseek-v4-flash');
  assert.equal(imgParts(strip).length, 0, 't8: 无视觉模型下顶层 image 照常剥除');
  assert.ok(JSON.stringify(strip).includes('[图片已忽略'), 't8: 顶层剥除占位文本不变');
}

// ── t9(接线哨兵):buildOpenAIRequest 必须把 body.model 传进判定/转换链 ──
{
  assert.equal(typeof proxy.buildOpenAIRequest, 'function',
    't9: buildOpenAIRequest 需导出(仅为可单测),现有导出:' + Object.keys(proxy).join(', '));
  const { buildOpenAIRequest } = proxy;
  setOpenAIUpstream({ baseURL: 'https://relay.example.com/v1', apiKey: 'test-key', model: 'deepseek-v4-flash' });
  const req = buildOpenAIRequest({ model: 'deepseek-v4-flash-vision-exp', messages: readTurn([IMG]), stream: false, max_tokens: 100 });
  assert.equal(imgParts(req.messages).length, 1, 't9: 经完整请求构造,body.model 生效放行图片');
  const req2 = buildOpenAIRequest({ model: 'deepseek-v4-flash', messages: readTurn([IMG]), stream: false, max_tokens: 100 });
  assert.equal(imgParts(req2.messages).length, 0, 't9: body.model 无视觉 → 剥除');
}

setOpenAIUpstream(null); // 收尾:不污染同进程后续测试

// ── t10(前端黄条判据,修法3):四方向纯函数 + ChatInput 接线源级断言 ──
// 旧判据 /deepseek/i.test(providerHint||baseUrl) 双向皆错:openai 协议下 baseUrl 是
// 回环代理恒不命中(真剥图不提示),anthropic 协议 api.deepseek.com/anthropic 恒命中
// (透传不剥图却误报)。判据抽为 attachmentNoVision 纯函数;源断言防"绕开纯函数
// 内联重写/整体 revert"(源级断言先例:check-1m-toggle.mjs)。
{
  const { attachmentNoVision } = await import('../../server/utils/vision-capability.js');
  assert.equal(attachmentNoVision('openai', 'deepseek-v4-flash'), true,
    't10: openai 协议 + 表判无视觉 → 提示(旧判据 baseUrl=回环恒不命中,此方向漏报)');
  assert.equal(attachmentNoVision('anthropic', 'deepseek-v4-flash'), false,
    't10: anthropic 协议透传不剥图 → 不提示(旧判据对 api.deepseek.com 误报)');
  assert.equal(attachmentNoVision('openai', 'deepseek-v4-flash-vision-exp'), false,
    't10: openai 协议 + 识图模型 → 不提示');
  assert.equal(attachmentNoVision('openai', 'totally-unknown-9'), false,
    't10: 查无记录(null)不误报');
  assert.equal(attachmentNoVision(undefined, 'deepseek-v4-flash'), false,
    't10: protocol 缺失(provider 未加载)不提示');

  const src = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes('attachmentNoVision('),
    't10: ChatInput 黄条必须经 attachmentNoVision 判定(绕开纯函数内联重写 → 红)');
  assert.ok(!src.includes('/deepseek/i'),
    't10: ChatInput 不得残留旧判据 /deepseek/i 正则(revert 回 providerHint/baseUrl 判 → 红)');
}

console.log('check-r63-vision-toolresult: all passed');
