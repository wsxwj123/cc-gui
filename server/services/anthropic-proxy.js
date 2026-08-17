// Embedded Anthropic passthrough proxy.
//
// Why: when the user is logged into a Claude subscription, the `claude` CLI
// attaches that subscription's OAuth token (keychain `claudeAiOauth`) to EVERY
// request and it takes precedence over the `ANTHROPIC_AUTH_TOKEN` a third-party
// provider sets in settings.json. So a deepseek/mimo/anthropic-relay provider
// gets the WRONG token (the subscription one) and dies with 401 — even though
// its own key is perfectly valid. Logging out fixes it but then the subscription
// itself is unusable.
//
// This loopback proxy breaks the conflict: point ANTHROPIC_BASE_URL at it, and
// it DROPS whatever auth the CLI sends (the poisoned OAuth token) and injects the
// real provider token before forwarding upstream. Pure passthrough — the body is
// already in Anthropic wire format, so unlike openai-proxy nothing is translated.
//
// Bound to 127.0.0.1 only — no auth, never exposed.

import http from 'node:http';
import { normalizeContextOverflow } from './openai-proxy.js';

// Fixed loopback port (distinct from openai-proxy's 8788) so the URL written into
// settings.json survives watchdog restarts. Ephemeral fallback if it's taken.
export const ANTHROPIC_PROXY_PORT = 8789;

// Mutable upstream — set when an Anthropic-format third-party provider activates.
// { baseURL: 'https://api.deepseek.com/anthropic', authToken: 'sk-...' }
let upstream = null;
let server = null;
let boundPort = 0;

export function setAnthropicUpstream(next) {
  upstream = next && next.baseURL && next.authToken
    ? { baseURL: String(next.baseURL).replace(/\/+$/, ''), authToken: String(next.authToken) }
    : null;
  return upstream;
}

export function getAnthropicProxyPort() {
  return boundPort;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Bug #5+#7:Claude Code CLI 在调用 Skill / WebSearch 等"context-modifying"工具
// 时,把 skill body / 搜索结果用 `isMeta=true` 的 user 消息塞进下一轮 system
// context,**而不发对应的 anthropic tool_result content block**。
// 对真正实现 anthropic spec 的端点没问题(Claude 官方/MiMo 透传),但 DeepSeek
// 的 anthropic 兼容端点内部转 openai 时严格检查 tool_call_id 配对 → 报 400
// "An assistant message with 'tool_calls' must be followed by tool messages
// responding to each 'tool_call_id'".
//
// 修法:扫 messages,任何 assistant.tool_use 缺对应 tool_result,补一条空的
// tool_result(content="" 或"(no result returned)"),让请求结构合法。补的内容
// 不影响模型理解 — CLI 已经把真实 result(skill body)注入 system context,模型
// 看得见。
function normalizeMessagesForCompat(body) {
  let parsed;
  try { parsed = JSON.parse(body.toString('utf-8')); } catch { return body; }
  if (!parsed || !Array.isArray(parsed.messages)) return body;

  const msgs = parsed.messages;
  let patched = 0;

  // r9-fix: 丢弃空 text 块。CLI 取消/中断回合时会在 jsonl 里留下
  // assistant(text:"") 的空轮(bf36c461 第 1239 行实测:user 收到
  // task-notification 后回复被取消,留下一条 content 只含空 text 的
  // assistant)。Kimi 的 anthropic 兼容端点看到 text:"" 就报 400
  // "text content is empty"。修法:过滤掉所有空 text 块;若某条消息因此
  // content 清空(纯空 text、无工具块),整条消息删掉——空消息对模型无语义,
  // 留在这里只会被新 provider 拒收。非 text 块(工具/图像)一律保留,不影响
  // tool_use↔tool_result 配对。
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || !Array.isArray(m.content)) continue;
    const orig = m.content;
    const kept = orig.filter((c) => !(c && typeof c === 'object' && c.type === 'text' && (!c.text || String(c.text).trim() === '')));
    if (kept.length === orig.length) continue;
    if (kept.length === 0) { msgs.splice(i, 1); patched++; }
    else { m.content = kept; patched++; }
  }

  // r9-fix: 跨协议 provider 切换时,历史里的 document 块(CLI 读 PDF/文档注入的
  // isMeta context)会被原样发给新 provider。DeepSeek 等 OpenAI 兼容端点对
  // document 块做 base64 解码没问题,但 Kimi 的 anthropic 兼容端点不认
  // document 块 → 400 "Invalid request Error"(真机复现:opencode/deepseek 会话
  // 切到 Kimi 必 400)。修法:把 document 块就地降级成 text 块,保留标题说明,
  // 不丢内容(模型仍能看到文件名/来源),结构上回到纯 text/tool 类型。
  let strippedDocs = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || !Array.isArray(m.content)) continue;
    const out = [];
    for (const c of m.content) {
      if (!c || typeof c !== 'object' || c.type !== 'document') { out.push(c); continue; }
      const src = c.source;
      const title = c.title || (src && src.file_name) || 'document';
      const media = (src && src.media_type) || 'unknown';
      // base64 数据不转发(Kimi 用不上,还占请求体),只留一句占位让模型知道
      // 这里原本有个文档。真实内容在会话历史/本地文件里,CLI 的 context 已带。
      out.push({ type: 'text', text: `[document attachment: ${title} (${media}) — content omitted]` });
      strippedDocs++;
    }
    m.content = out;
  }
  if (strippedDocs > 0) patched += strippedDocs;

  // r9-fix: 合并相邻的连续 user 消息。CLI 在 OpenAI 协议(如 opencode/deepseek)
  // 下读 PDF 时,会把同一轮 Read 工具的"tool_result"和"document"输出拆成两条
  // 相邻 user 消息(resume 后仍是两条)。Kimi 的 anthropic 兼容端点对
  // "tool_result 后紧跟另一条 user"做严格配对校验 → 400 "Invalid request Error"。
  // Anthropic 规范允许连续 user 消息,合并无副作用;Kimi 需要它们合成一条。
  for (let i = msgs.length - 1; i > 0; i--) {
    if (msgs[i]?.role !== 'user' || msgs[i-1]?.role !== 'user') continue;
    const a = msgs[i-1].content, b = msgs[i].content;
    const aArr = Array.isArray(a), bArr = Array.isArray(b);
    if (!aArr || !bArr) continue; // 只合并数组形式的(block 消息)
    msgs[i-1].content = [...a, ...b];
    msgs.splice(i, 1);
    patched++;
  }
  // r9-fix: 合并相邻的**纯 tool_use** assistant 消息。真实历史里 CLI 会把一轮里的
  // 多个工具调用拆成多条 assistant 消息(各含一个 tool_use),例如:
  //   assistant(tool_use A) → assistant(tool_use B) → user(result A | result B)
  // Kimi 的 anthropic 兼容端点转 OpenAI 时,要求每条 assistant(tool_calls) 的
  // 结果紧跟其后 → 两个独立 assistant tool_use 会让第一个的结果错位 → 400
  // "an assistant message with 'tool_calls' must be followed by tool messages
  // responding to each 'tool_call_id'".修法:把相邻的纯 tool_use assistant 消息
  // 合并成一条(Anthropic 规范允许单条 assistant 含多个 tool_use;实测 Kimi
  // 接受单 assistant 多 tool_use + 合并 user)。只合并**不含 text 块**的 assistant,
  // 避免把带正文的轮次捏在一起。
  for (let i = msgs.length - 1; i > 0; i--) {
    const cur = msgs[i], prev = msgs[i-1];
    if (cur?.role !== 'assistant' || prev?.role !== 'assistant') continue;
    const cArr = Array.isArray(cur.content), pArr = Array.isArray(prev.content);
    if (!cArr || !pArr) continue;
    const curTools = cArr.filter((b) => b?.type === 'tool_use');
    const curText = cArr.filter((b) => b?.type === 'text');
    const prevTools = pArr.filter((b) => b?.type === 'tool_use');
    const prevText = pArr.filter((b) => b?.type === 'text');
    // 两条都必须"只有 tool_use,没有 text"(纯调用轮)
    if (curTools.length === 0 || curText.length > 0) continue;
    if (prevTools.length === 0 || prevText.length > 0) continue;
    prev.content = [...prevTools, ...curTools];
    msgs.splice(i, 1);
    patched++;
  }
  // r9-fix: 修复"文本 user 夹在 tool_use 和它的 tool_result 之间"的结构。
  // 真实历史里会看到:assistant(tool_use) → user(纯文本"继续") → user(tool_result)。
  // Anthropic 官方允许,但 Kimi 的 anthropic 兼容端点转 OpenAI 时要求 tool 消息
  // 必须紧跟 tool_calls 消息 → 中间插文本就报 400
  // "an assistant message with 'tool_calls' must be followed by tool messages
  // responding to each 'tool_call_id'".修法:把挡在 tool_use 与其 tool_result 之间的
  // 纯文本 user 消息**挪到** tool_result 之后,保持配对相邻。文本内容不丢,
  // 只是位置后移(模型仍看得到)。
  // ⚠️ 触发条件必须极保守:只有当 tool_use 的**下一条**就是纯文本 user(不含
  // tool_result 的 text/string),且再往后的纯文本 user 之后紧跟着含对应
  // tool_result 的 user 时才挪。中间一旦出现 assistant 或含 tool_result 的 user
  // 就立即停 —— 绝不跨过任何 assistant 消息,否则会把别的 tool_use 一起挪走
  // (真机踩过:assistant(tool_use A) → assistant(tool_use B) → user(result A)
  // 的结构被误当成"夹文本",把 tool_use B 挪到错误位置,结构全乱)。
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m?.role !== 'assistant') continue;
    const toolIds = (Array.isArray(m.content) ? m.content : [])
      .filter((c) => c?.type === 'tool_use' && c.id).map((c) => c.id);
    if (toolIds.length === 0) continue;
    // 下一条必须是非 tool_result 的纯文本 user,否则不处理
    const next = msgs[i + 1];
    if (next?.role !== 'user') continue;
    if (Array.isArray(next.content) && next.content.some((c) => c?.type === 'tool_result')) continue;
    if (Array.isArray(next.content) && next.content.some((c) => c?.type === 'tool_use')) continue;
    // 收集从 i+1 起的连续纯文本 user(允许 string 或纯 text 数组)
    const textBlocks = [];
    let j = i + 1;
    while (j < msgs.length) {
      const cand = msgs[j];
      if (cand?.role !== 'user') break;
      const blocks = Array.isArray(cand.content) ? cand.content : [];
      if (blocks.some((c) => c?.type === 'tool_result')) {
        // 这条是含 tool_result 的 user —— 若它含我们的 tool_result,把前面收的文本挪到它后
        if (textBlocks.length > 0 && blocks.some((c) => c?.type === 'tool_result' && toolIds.includes(c.tool_use_id))) {
          msgs.splice(i + 1, textBlocks.length);            // 摘掉纯文本块
          const targetIdx = i + 1;                           // tool_result 所在 user 现在的位置
          msgs.splice(targetIdx + 1, 0, ...textBlocks);      // 插到它之后
          patched += textBlocks.length;
        }
        break;
      }
      const isPureText = typeof cand.content === 'string'
        || (Array.isArray(cand.content) && cand.content.length > 0 && cand.content.every((c) => c?.type === 'text'));
      if (!isPureText) break;
      textBlocks.push(cand);
      j++;
    }
  }

  // 补丁前先收集全部"真实存在的 tool_result id"——在**任意**后续消息里能找到的
  // tool_result 都不算缺失,补丁绝不能给它们插假的(真机踩过:assistant(tool_use A)
  // → assistant(tool_use B) → user(result A) 的结构里,把 A 的 tool_result 在更后面
  // 存在却被当"缺失"提前插假补丁 → Kimi 报 "tool call id Agent:0 is not found")。
  const realResultIds = new Set();
  for (const mm of msgs) {
    if (mm?.role !== 'user' || !Array.isArray(mm.content)) continue;
    for (const c of mm.content) {
      if (c?.type === 'tool_result' && c.tool_use_id) realResultIds.add(c.tool_use_id);
    }
  }

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m?.role !== 'assistant') continue;
    const toolUses = Array.isArray(m.content)
      ? m.content.filter((c) => c?.type === 'tool_use' && c.id)
      : [];
    if (toolUses.length === 0) continue;

    // 找下一条 user message,看它的 content 是不是包含 tool_result for 每个 id
    const next = msgs[i + 1];
    const nextResults = (next?.role === 'user' && Array.isArray(next.content))
      ? new Set(next.content.filter((c) => c?.type === 'tool_result' && c.tool_use_id).map((c) => c.tool_use_id))
      : new Set();
    const missing = toolUses.filter((tu) => !nextResults.has(tu.id) && !realResultIds.has(tu.id));
    if (missing.length === 0) continue;

    // 补 tool_result:就近合并到下一条 user(如果它已经是 user 的话),否则插入新 user
    const stubs = missing.map((tu) => ({
      type: 'tool_result',
      tool_use_id: tu.id,
      content: '(tool result fed via system context)',
    }));
    if (next?.role === 'user') {
      next.content = Array.isArray(next.content) ? [...stubs, ...next.content] : stubs.concat([{ type: 'text', text: String(next.content || '') }]);
    } else {
      msgs.splice(i + 1, 0, { role: 'user', content: stubs });
    }
    patched += missing.length;
  }

  if (patched === 0) return body;
  if (process.env.CGUI_PROXY_DEBUG) {
    process.stderr.write(`[anthropic-proxy] patched ${patched} missing tool_result(s)\n`);
  }
  return Buffer.from(JSON.stringify(parsed));
}

async function handle(req, clientRes) {
  // 快照 upstream:整个请求生命周期只用这一份。否则回合在途(await fetch 前后)时
  // 用户切 provider 改了模块级 upstream → 同一请求可能被发到新 baseURL / 注入新 token。
  const up = upstream;
  if (!up) {
    clientRes.writeHead(503, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'anthropic upstream not configured' } }));
    return;
  }

  let body = (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')
    ? await readBody(req)
    : undefined;

  // 仅对 /v1/messages 做规范化(其他端点不动)
  if (body && req.url && req.url.includes('/v1/messages') && req.method === 'POST') {
    body = normalizeMessagesForCompat(body);
  }

  // Build a CLEAN header set. The CLI's incoming Authorization / x-api-key carries
  // the poisoned subscription OAuth token — we DROP it and inject the real provider
  // token instead. deepseek/mimo/anthropic relays accept either header shape, so we
  // send both (a server checks one and ignores the other).
  const headers = {
    'content-type': req.headers['content-type'] || 'application/json',
    'x-api-key': up.authToken,
    'authorization': `Bearer ${up.authToken}`,
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
  };
  if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
  if (req.headers['accept']) headers['accept'] = req.headers['accept'];

  const url = up.baseURL + req.url;

  let upstreamResp;
  // 连接超时:上游 TCP 连上却迟迟不吐响应头(错 baseURL/geo 卡/上游挂)时,无超时的 fetch
  // 会无限挂 → CLI 永久 "connecting" 无反馈(用户实报)。90s 到点 abort → 转 502。收到响应头
  // (fetch settle)即 clearTimeout,故正文流式不受影响(长回复不被切断)。
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 90000);
  try {
    // 不跟随重定向:上游 3xx 会把带 authToken 的请求引到任意主机(密钥外泄/SSRF)。
    // 3xx 状态按原逻辑透传回 CLI,由 CLI 报错。
    upstreamResp = await fetch(url, { method: req.method, headers, body, signal: ac.signal, redirect: 'manual' });
  } catch (err) {
    clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream fetch failed: ' + err.message } }));
    return;
  } finally {
    clearTimeout(timer);
  }

  // Mirror upstream status + content-type. Deliberately DON'T copy content-encoding:
  // fetch already decompressed the body, so re-advertising gzip would corrupt it.
  const ct = upstreamResp.headers.get('content-type') || 'application/json';

  // 唯一的非透传例外(auto-compact 修复):上游 400/413 的 JSON 错误体,若 error.message
  // 命中上下文超限特征,归一化为 CLI 可识别的 "prompt is too long: <原文>"(CLI 才会缩组
  // 重试摘要请求,第三方 auto-compact 不再杀回合)。只收 400/413:某些中转 429 限流文案
  // 含 "too many tokens",改写会让 CLI 误触发 compact 而非退避;其余状态码走下方流式透传,
  // 字节不变。非 JSON / 非超限 / SSE 均不动。缓冲设 256KB 上限:坏网关可能回 MB 级 HTML
  // 错误页,超限不解析,已缓冲部分+剩余流原样透传。
  if ((upstreamResp.status === 400 || upstreamResp.status === 413) && !/event-stream/i.test(ct) && upstreamResp.body) {
    const MAX_ERR_BODY = 256 * 1024;
    const chunks = [];
    let total = 0;
    let overflow = false;
    const reader = upstreamResp.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        total += value.byteLength;
        if (total > MAX_ERR_BODY) { overflow = true; break; }
      }
    } catch { /* 上游中断:把已收到的原样发回 */ }
    clientRes.writeHead(upstreamResp.status, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
    if (overflow) {
      for (const c of chunks) clientRes.write(c);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          clientRes.write(Buffer.from(value));
        }
      } catch { /* upstream aborted mid-stream */ }
      clientRes.end();
      return;
    }
    let out = Buffer.concat(chunks).toString('utf8');
    try {
      const j = JSON.parse(out);
      const m = j?.error?.message;
      if (typeof m === 'string') {
        const norm = normalizeContextOverflow(m);
        if (norm !== m) { j.error.message = norm; out = JSON.stringify(j); }
      }
    } catch { /* 非 JSON 错误体:原样透传 */ }
    clientRes.end(out);
    return;
  }

  clientRes.writeHead(upstreamResp.status, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });

  if (!upstreamResp.body) { clientRes.end(); return; }

  // Stream the (already Anthropic-shaped) response straight through, SSE included.
  try {
    const reader = upstreamResp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clientRes.write(Buffer.from(value));
    }
  } catch { /* upstream aborted mid-stream */ }
  clientRes.end();
}

export function startAnthropicProxy(port = ANTHROPIC_PROXY_PORT) {
  if (server) return Promise.resolve(boundPort);
  server = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.end(); } catch {} }); });
  return new Promise((resolve) => {
    const onErr = (err) => {
      if (err && err.code === 'EADDRINUSE' && port !== 0) {
        server.removeListener('error', onErr);
        server.listen(0, '127.0.0.1', () => { boundPort = server.address().port; resolve(boundPort); });
      } else {
        server = null; boundPort = 0; resolve(0);
      }
    };
    server.once('error', onErr);
    server.listen(port, '127.0.0.1', () => {
      boundPort = server.address().port;
      resolve(boundPort);
    });
  });
}
