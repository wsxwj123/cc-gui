// 单测:r17-① 的旁路提取**绝不能拖垮代理转发**。
// 起一个本地假上游(127.0.0.1:6703,唯一允许的测试端口;不打任何真实 API),把
// anthropic-proxy 指过去,发一条真实形态的 /v1/messages,断言:
//   ① 请求原样转发到上游、响应原样回来(旁路不改 body、不吞状态);
//   ② 同时经既有 broadcast 发出 context-injection,且字节里不含正文。
//
// 变异哨兵(实际验证过):把 reportContextInjection 首行改成 `throw new Error('boom')`
// → 本文件仍全绿(转发不受影响),check-context-injection.mjs 的 t9 转红。
import assert from 'node:assert/strict';
import http from 'node:http';
import { setAnthropicUpstream, startAnthropicProxy } from '../../server/services/anthropic-proxy.js';
import { clients } from '../../server/broadcast.js';

const UPSTREAM_PORT = 6703;
const SID = '11112222-3333-4444-5555-666677778888';
const SECRET = 'SECRET-donny-private-note-9f3a';
const rem = (s) => `<system-reminder>\n${s}\n</system-reminder>\n`;

const REQ = {
  model: 'claude-sonnet-4-6',
  metadata: { user_id: JSON.stringify({ device_id: 'd', account_uuid: '', session_id: SID }) },
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: rem(`As you answer the user's questions, you can use the following context:\n# claudeMd\n${SECRET}`) },
      { type: 'text', text: rem(`The following skills are available for use with the Skill tool:\n\n- dataviz: ${SECRET}`) },
      { type: 'text', text: rem('<total_tokens>15000000 tokens left</total_tokens>') },
      { type: 'text', text: 'say ok' },
    ],
  }],
};

let n = 0;
const eq = (a, b, m) => { n += 1; assert.equal(a, b, m); };
const ok = (c, m) => { n += 1; assert.ok(c, m); };

let received = null;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received = Buffer.concat(chunks).toString('utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', id: 'msg_fake', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }));
  });
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

setAnthropicUpstream({ baseURL: `http://127.0.0.1:${UPSTREAM_PORT}`, authToken: 'fake-test-token' });
const port = await startAnthropicProxy(0);
ok(port > 0, 'proxy 起在临时端口');

const sent = [];
const fake = { readyState: 1, send: (m) => sent.push(m) };
clients.add(fake);

const resp = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(REQ),
});
const out = await resp.json();

// ① 转发链路完好
eq(resp.status, 200, '① 代理照常回 200');
eq(out.content[0].text, 'ok', '① 上游响应原样回到客户端');
ok(received, '① 上游确实收到了请求');
eq(JSON.parse(received).metadata.user_id, REQ.metadata.user_id, '① 旁路不得改动转发出去的 body');
eq(JSON.parse(received).messages[0].content.length, 4, '① 转发的 content 块数不变');

// ② 旁路广播到位,且不含正文
eq(sent.length, 1, '② 广播了一条');
const msg = JSON.parse(sent[0]);
eq(msg.type, 'context-injection', '② 广播类型');
eq(msg.sessionId, SID, '② sessionId 来自 metadata.user_id');
eq(msg.items.length, 2, '② claude-md + skills(预算块被忽略、用户消息不算)');
ok(!sent[0].includes(SECRET), '②【红线】广播字节里不含正文');
ok(!sent[0].includes('dataviz'), '②【红线】广播字节里不含 skill 名');

clients.delete(fake);
upstream.close();
console.log(`context-injection-proxy: ${n} assertions OK`);
process.exit(0);
