// 旁问截包用的假 Anthropic 端点。把 CLI 发出的每一个请求体原样落盘,再回一段最小的
// SSE 应答让 CLI 正常收尾。用途见同目录 README.md;手动工具,不进单测跑批。
// 落盘目录取 $OUT,默认 <tmpdir>/btw-capture —— 绝不写进仓库工作区。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = process.env.OUT || path.join(os.tmpdir(), 'btw-capture');
fs.mkdirSync(OUT, { recursive: true });
console.log('capture dir: ' + OUT);

let n = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const file = `capture-${process.env.CASE || 'x'}-${++n}.json`;
    fs.writeFileSync(path.join(OUT, file), body);
    fs.appendFileSync(path.join(OUT, 'requests.log'),
      `${new Date().toISOString()} ${req.method} ${req.url} len=${body.length} -> ${file}\n`);
    // /v1/messages/count_tokens 要的是普通 JSON,不是 SSE。
    if (req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 100 }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
    ev('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'MOCK_OK' } });
    ev('content_block_stop', { type: 'content_block_stop', index: 0 });
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    ev('message_stop', { type: 'message_stop' });
    res.end();
  });
});
server.listen(8931, '127.0.0.1', () => console.log('mock listening 127.0.0.1:8931'));
