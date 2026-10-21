#!/usr/bin/env node
// r151q:从 r151c mock-p2.mjs 复制,只多两处:真 CLI 车道的请求记录多记 model;真 CLI 车道对审核请求(kind: classifier)答 <block>no</block>。
// r151c 本地假模型接口(只听 127.0.0.1,零成本,不连外网)。用法: node mock-p2.mjs <port> <dir>
// 与一期 mock-upstream.mjs 的"车道"约定相同(请求路径 /lane/<名字>/… → <dir>/lanes/<名字>/ctl.json 与 requests.jsonl),区别:
//   - 车道名以 real 开头的是真 CLI 车道。每个请求记一行:kind、toolNames(请求里带的工具名 = 会话工具表)、
//     userTexts(含 ctl.watch 标记的用户文字)、toolResults(本车道发出的工具调用 id 以 toolu_r151c_ 开头的结果,全文不截断)。
//   - ctl.scripts = { "<标记>": [{ name, input, waitFile? }, …] }:最近一条用户文字含该标记时,按本条之后已收到的工具结果个数
//     依次发工具调用;某步带 waitFile 时,发这一步之前先等 <dir>/<waitFile> 出现(最多 120 秒)。发完回 ctl.text。
//   - 其它车道:模型列表 / count_tokens / messages 一律给最简应答(审核请求答 allow)。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [port, dir] = process.argv.slice(2);
if (!port || !dir) { console.error('用法: node mock-p2.mjs <port> <dir>'); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });
let seq = 0;
const laneDir = (lane) => { const d = path.join(dir, 'lanes', lane); fs.mkdirSync(d, { recursive: true }); return d; };
const ctlOf = (lane) => { try { return JSON.parse(fs.readFileSync(path.join(laneDir(lane), 'ctl.json'), 'utf8')); } catch { return {}; } };
const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function anthReply(res, body, blocks, stopReason = 'end_turn') {
  const base = { id: `msg_r151c_${seq}`, type: 'message', role: 'assistant', model: body.model || 'r151-chat', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  if (body.stream !== true) return json(res, 200, { ...base, content: blocks, stop_reason: stopReason, usage: { input_tokens: 10, output_tokens: 5 } });
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
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
  ev('message_stop', { type: 'message_stop' });
  return res.end();
}

const textOf = (c) => (typeof c === 'string' ? c : (Array.isArray(c) ? c.map((x) => (x && x.text) || '').join('') : ''));

async function realLane(res, body, ctl, lane, kind, p) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const watch = Array.isArray(ctl.watch) ? ctl.watch : [];
  const userTexts = []; const toolResults = []; let lastUserText = ''; let lastUserIdx = -1;
  msgs.forEach((m, idx) => {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (Array.isArray(m.content) ? m.content : []);
    for (const b of blocks) {
      if (!b) continue;
      if (m.role === 'user' && b.type === 'text' && typeof b.text === 'string') {
        if (watch.some((w) => b.text.includes(w))) userTexts.push(b.text);
        if (!b.text.startsWith('<system-reminder>')) { lastUserText = b.text; lastUserIdx = idx; }
      }
      if (b.type === 'tool_result' && String(b.tool_use_id || '').startsWith('toolu_r151c_')) {
        toolResults.push({ id: b.tool_use_id, idx, text: textOf(b.content), is_error: Boolean(b.is_error) });
      }
    }
  });
  const toolNames = Array.isArray(body.tools) ? body.tools.map((t) => t && t.name).filter(Boolean) : [];
  try { fs.appendFileSync(path.join(laneDir(lane), 'requests.jsonl'), `${JSON.stringify({ n: seq, at: Date.now(), path: p, kind, model: body.model, hasTools: toolNames.length > 0, toolNames, userTexts, toolResults })}\n`); } catch { /* */ }
  const scripts = ctl.scripts && typeof ctl.scripts === 'object' ? ctl.scripts : {};
  // 一段文字含多个标记时(信封里来源名带着发送方首条提问的标记、正文里是下一跳的标记),取在文字里出现得最靠后的那个
  const key = Object.keys(scripts).filter((k) => lastUserText.includes(k))
    .sort((a, b) => lastUserText.lastIndexOf(b) - lastUserText.lastIndexOf(a))[0];
  if (kind === 'main' && key) {
    const steps = Array.isArray(scripts[key]) ? scripts[key] : [];
    const n = toolResults.filter((t) => t.idx > lastUserIdx).length;
    if (n < steps.length) {
      const st = steps[n];
      if (st.waitFile) { const t0 = Date.now(); while (!fs.existsSync(path.join(dir, st.waitFile)) && Date.now() - t0 < 120_000) await sleep(100); }
      return anthReply(res, body, [{ type: 'tool_use', id: `toolu_r151c_${seq}`, name: st.name, input: st.input || {} }], 'tool_use');
    }
  }
  return anthReply(res, body, [{ type: 'text', text: kind === 'main' ? (ctl.text || 'R151C-REAL-OK') : (kind === 'classifier' ? '<block>no</block>' : 'ok') }]);
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
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    const p = url.split('?')[0];
    const all = JSON.stringify(body.messages || []) + JSON.stringify(body.system || '');
    const kind = p.endsWith('/models') ? 'models' : p.endsWith('/count_tokens') ? 'count_tokens'
      : p.endsWith('/messages') ? (all.includes('<transcript>') ? 'classifier' : (Array.isArray(body.tools) && body.tools.length ? 'main' : 'side')) : 'other';
    if (kind === 'models') return json(res, 200, { object: 'list', data: ['r151-chat', 'r151-reasoner'].map((id) => ({ id, type: 'model', display_name: id })), has_more: false });
    if (kind === 'count_tokens') return json(res, 200, { input_tokens: 100 });
    if (kind === 'other') return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'R151C mock: not found' } });
    if (lane.startsWith('real')) return void realLane(res, body, ctl, lane, kind, p);
    try { fs.appendFileSync(path.join(laneDir(lane), 'requests.jsonl'), `${JSON.stringify({ n: seq, at: Date.now(), path: p, kind })}\n`); } catch { /* */ }
    if (kind === 'classifier') return anthReply(res, body, [{ type: 'text', text: all.includes('<severity>') ? '<severity>5</severity>' : '<block>no</block>' }]);
    return anthReply(res, body, [{ type: 'text', text: kind === 'main' ? 'R151C-DONE' : 'ok' }]);
  });
}).listen(Number(port), '127.0.0.1', () => console.log(`[r151c] 假模型接口就绪 127.0.0.1:${port} pid ${process.pid}`));
