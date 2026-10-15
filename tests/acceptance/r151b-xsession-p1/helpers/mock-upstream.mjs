#!/usr/bin/env node
// r151b 本地假模型接口(从 r151a 同名文件复制;改动:车道名以 real 开头的是真 CLI 专用车道,见下方 realLane)。
// 原说明:只监听 127.0.0.1,零成本,不连外网。思路来自调研期的 mock.mjs,这里是自包含重写。
// 用法: node mock-upstream.mjs <port> <dir>
//
// 「车道」:请求路径以 /lane/<名字>/ 开头时,剥掉这段前缀,控制文件与日志都按车道分开:
//   <dir>/lanes/<名字>/ctl.json        行为控制(每个请求重读,测试随时改)
//   <dir>/lanes/<名字>/requests.jsonl  收到的每个请求(一行一条:方法、路径、种类、请求体)
// 没有车道前缀的请求归到车道 "_root"。不同 provider 用不同车道 = 互不干扰。
//
// 同时说两种协议:
//   Anthropic:  POST …/v1/messages(含 count_tokens)          GET …/v1/models
//   OpenAI:     POST …/chat/completions(…/v1/chat/completions)  GET …/models
// ctl.json 字段(都可省):
//   models:      ["id", …] | "http500" | "empty" | "hang"      模型列表接口的行为(默认 ["r151-chat","r151-reasoner"])
//   classifier:  "allow" | "block" | "garbage" | "http500" | "hang" | "empty"   审核请求(消息里带 <transcript>)怎么答
//   blockReason: 拦下时给的原因(默认 "R151 mock: writes outside the working directory")
//   main:        { tools: [{name, input}], text }  主回合:按已收到的 tool_result 个数依次发工具调用,发完给 text
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [port, dir] = process.argv.slice(2);
if (!port || !dir) { console.error('用法: node mock-upstream.mjs <port> <dir>'); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });
let seq = 0;

const laneDir = (lane) => { const d = path.join(dir, 'lanes', lane); fs.mkdirSync(d, { recursive: true }); return d; };
const ctlOf = (lane) => { try { return JSON.parse(fs.readFileSync(path.join(laneDir(lane), 'ctl.json'), 'utf8')); } catch { return {}; } };
const DEFAULT_MODELS = ['r151-chat', 'r151-reasoner'];

function json(res, status, obj) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

/** 模拟真实上游对 stop 的处理:输出在第一个命中的停止串之前截断(停止串本身不输出)。 */
function applyStop(text, stop) {
  const list = Array.isArray(stop) ? stop : (typeof stop === 'string' ? [stop] : []);
  let cut = -1; let hit = null;
  for (const s of list) {
    if (typeof s !== 'string' || !s) continue;
    const i = text.indexOf(s);
    if (i >= 0 && (cut < 0 || i < cut)) { cut = i; hit = s; }
  }
  return cut >= 0 ? { text: text.slice(0, cut), hit } : { text, hit: null };
}

function classifierText(ctl, sysStr) {
  const mode = ctl.classifier || 'allow';
  const sev = sysStr.includes('<severity>');
  if (mode === 'garbage') return 'I think this is probably fine, maybe.';
  if (mode === 'empty') return '';
  if (mode === 'block') {
    return sev ? '<severity>90</severity><category>Data Exfiltration</category>'
      : `<block>yes</block><reason>${ctl.blockReason || 'R151 mock: writes outside the working directory'}</reason>`;
  }
  return sev ? '<severity>5</severity>' : '<block>no</block>';
}

// ---------- Anthropic 协议 ----------
function anthReply(res, body, blocks, stopReason = 'end_turn', stopSequence = null) {
  const model = body.model;
  const base = { id: `msg_r151_${seq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  if (body.stream !== true) return json(res, 200, { ...base, content: blocks, stop_reason: stopReason, stop_sequence: stopSequence, usage: { input_tokens: 10, output_tokens: 5 } });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  ev('message_start', { type: 'message_start', message: base });
  blocks.forEach((b, i) => {
    if (b.type === 'text') {
      ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } });
    } else {
      ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    ev('content_block_stop', { type: 'content_block_stop', index: i });
  });
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: stopSequence }, usage: { output_tokens: 5 } });
  ev('message_stop', { type: 'message_stop' });
  res.end();
}

// ---------- OpenAI 协议 ----------
function oaReply(res, body, { text = '', toolCalls = [] }) {
  const model = body.model;
  const { text: outText } = applyStop(text, body.stop);
  const finish = toolCalls.length ? 'tool_calls' : 'stop';
  const calls = toolCalls.map((t, i) => ({ index: i, id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input) } }));
  if (body.stream !== true) {
    return json(res, 200, { id: `chatcmpl_r151_${seq}`, object: 'chat.completion', created: 1790000000, model,
      choices: [{ index: 0, message: { role: 'assistant', content: outText, ...(calls.length ? { tool_calls: calls.map(({ index, ...c }) => c) } : {}) }, finish_reason: finish }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (delta, finishReason = null, extra = {}) => res.write(`data: ${JSON.stringify({ id: `chatcmpl_r151_${seq}`, object: 'chat.completion.chunk', created: 1790000000, model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })}\n\n`);
  chunk({ role: 'assistant', content: '' });
  if (outText) chunk({ content: outText });
  if (calls.length) chunk({ tool_calls: calls });
  chunk({}, finish);
  if (body.stream_options && body.stream_options.include_usage) res.write(`data: ${JSON.stringify({ id: `chatcmpl_r151_${seq}`, object: 'chat.completion.chunk', created: 1790000000, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    seq += 1;
    let url = req.url || '/';
    let lane = '_root';
    const m = /^\/lane\/([A-Za-z0-9_.-]+)(\/.*)?$/.exec(url.split('?')[0]);
    if (m) { lane = m[1]; url = m[2] || '/'; }
    const ctl = ctlOf(lane);
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { __unparsed: raw.slice(0, 2000) }; }
    const msgStr = JSON.stringify(body.messages || []);
    const sysStr = typeof body.system === 'string' ? body.system : JSON.stringify(body.system || '');
    const isClassifier = msgStr.includes('<transcript>') || sysStr.includes('<transcript>');
    const p = url.split('?')[0];
    const kind = p.endsWith('/models') ? 'models'
      : p.endsWith('/count_tokens') ? 'count_tokens'
        : p.endsWith('/chat/completions') ? (isClassifier ? 'oa-classifier' : 'oa-main')
          : p.endsWith('/messages') ? (isClassifier ? 'classifier' : (Array.isArray(body.tools) && body.tools.length ? 'main' : 'side'))
            : 'other';
    if (!lane.startsWith('real')) try {
      fs.appendFileSync(path.join(laneDir(lane), 'requests.jsonl'), `${JSON.stringify({ n: seq, at: Date.now(), method: req.method, path: p, kind, auth: Boolean(req.headers.authorization || req.headers['x-api-key']), body, raw })}\n`);
    } catch { /* 日志写不进不影响应答 */ }

    if (kind === 'models') {
      const mode = ctl.models === undefined ? DEFAULT_MODELS : ctl.models;
      if (mode === 'hang') return undefined;
      if (mode === 'http500') return json(res, 500, { error: { type: 'api_error', message: 'R151 mock models 500' } });
      const ids = mode === 'empty' ? [] : (Array.isArray(mode) ? mode : DEFAULT_MODELS);
      return json(res, 200, { object: 'list', data: ids.map((id) => ({ id, type: 'model', object: 'model', display_name: id })), has_more: false });
    }
    if (kind === 'count_tokens') return json(res, 200, { input_tokens: 100 });
    if (kind === 'other') return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'R151 mock: not found' } });
    if (lane.startsWith('real')) return realLane(res, body, ctl, lane, kind, p);

    const mode = ctl.classifier || 'allow';
    if ((kind === 'classifier' || kind === 'oa-classifier')) {
      if (mode === 'hang') return undefined;
      if (mode === 'http500') return json(res, 500, { type: 'error', error: { type: 'api_error', message: 'R151 mock classifier 500' } });
    }
    if (kind === 'classifier') {
      const full = classifierText(ctl, sysStr);
      const { text, hit } = applyStop(full, body.stop_sequences);
      return anthReply(res, body, [{ type: 'text', text }], hit ? 'stop_sequence' : 'end_turn', hit);
    }
    if (kind === 'oa-classifier') return oaReply(res, body, { text: classifierText(ctl, sysStr) });

    const spec = ctl.main || {};
    const tools = Array.isArray(spec.tools) ? spec.tools : [];
    const nRes = (msgStr.match(/"type":"tool_result"/g) || []).length + (msgStr.match(/"role":"tool"/g) || []).length;
    if (kind === 'main' || kind === 'side') {
      if (kind === 'main' && nRes < tools.length) {
        const t = tools[nRes];
        return anthReply(res, body, [{ type: 'tool_use', id: `toolu_r151_${seq}`, name: t.name, input: t.input }], 'tool_use');
      }
      return anthReply(res, body, [{ type: 'text', text: kind === 'main' ? (spec.text || 'R151-DONE') : 'ok' }]);
    }
    // oa-main
    if (Array.isArray(body.tools) && body.tools.length && nRes < tools.length) {
      const t = tools[nRes];
      return oaReply(res, body, { toolCalls: [{ id: `call_r151_${seq}`, name: t.name, input: t.input }] });
    }
    return oaReply(res, body, { text: spec.text || 'R151-DONE' });
  });
}).listen(Number(port), '127.0.0.1', () => console.log(`[r151a] 假模型接口就绪 127.0.0.1:${port} pid ${process.pid}`));

// ---------- 真 CLI 车道 ----------
// 真 CLI 的请求里可能带运行环境的上下文,这里不落原文。每个请求只记:
//   userTexts:   user 消息里含 ctl.watch 任一标记的文字块(用来判断"某段文字有没有送到某个会话")
//   toolResults: 本车道发出的工具调用(id 以 toolu_r151b_ 开头)得到的结果文字(= 模型看到的工具结果)
// ctl.scripts = { "<标记>": [{ name, input }, …] }:最近一条用户文字含该标记时,按本条之后已收到的工具结果个数依次发工具调用,发完回 ctl.text。
function realLane(res, body, ctl, lane, kind, p) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const watch = Array.isArray(ctl.watch) ? ctl.watch : [];
  const userTexts = []; const toolResults = []; let lastUserText = ''; let lastUserIdx = -1;
  msgs.forEach((m, idx) => {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (Array.isArray(m.content) ? m.content : []);
    for (const b of blocks) {
      if (!b) continue;
      if (m.role === 'user' && b.type === 'text' && typeof b.text === 'string') {
        if (watch.some((w) => b.text.includes(w))) userTexts.push(b.text.slice(0, 4000));
        if (!b.text.startsWith('<system-reminder>')) { lastUserText = b.text; lastUserIdx = idx; }
      }
      if (b.type === 'tool_result' && String(b.tool_use_id || '').startsWith('toolu_r151b_')) {
        const text = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((c) => (c && c.text) || '').join('') : '');
        toolResults.push({ id: b.tool_use_id, idx, text: text.slice(0, 4000), is_error: Boolean(b.is_error) });
      }
    }
  });
  try { fs.appendFileSync(path.join(laneDir(lane), 'requests.jsonl'), JSON.stringify({ n: seq, at: Date.now(), path: p, kind, hasTools: Array.isArray(body.tools) && body.tools.length > 0, userTexts, toolResults }) + '\n'); } catch { /* */ }
  const scripts = ctl.scripts && typeof ctl.scripts === 'object' ? ctl.scripts : {};
  const key = Object.keys(scripts).find((k) => lastUserText.includes(k));
  if (kind === 'main' && key) {
    const steps = Array.isArray(scripts[key]) ? scripts[key] : [];
    const n = toolResults.filter((t) => t.idx > lastUserIdx).length;
    if (n < steps.length) return anthReply(res, body, [{ type: 'tool_use', id: `toolu_r151b_${seq}`, name: steps[n].name, input: steps[n].input || {} }], 'tool_use');
  }
  return anthReply(res, body, [{ type: 'text', text: kind === 'main' ? (ctl.text || 'R151B-REAL-OK') : 'ok' }]);
}
