#!/usr/bin/env node
// 假 claude CLI。**只**用于浏览器验收测试:让"回合开始 / 边写边发 / 回合结束"可控,
// 从而能测排队、流式渲染、状态存活。它不碰 CC-GUI 的任何实现,只说 stream-json。
//
// 遥控信号(目录由 CGUI_FAKE_CLAUDE_DIR 指定,测试往里放文件):
//   script.txt  本回合模型要"写"出来的正文(可含 ```cgui-ui 围栏)
//   hold        存在时:正文写完后**不结束回合**(会话保持忙),删掉才收尾
//   started     本文件被调起过一次就会写(用来把"实现没接上"和"断言失败"分开)
//
// 协议形态刻意"多发一点":partial 事件与整条 assistant 快照都发,
// 免得因为 CC-GUI 只认其中一种就整批测试失败。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

if (argv.includes('--version') || argv.includes('-v')) { console.log('2.1.227 (fake)'); process.exit(0); }

const sid = argOf('--session-id') || argOf('--resume') || crypto.randomUUID();
const cwd = process.cwd();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { fs.mkdirSync(CTL, { recursive: true }); fs.writeFileSync(path.join(CTL, 'started'), String(Date.now())); } catch { /* 忽略 */ }

const projDir = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[/\\]/g, '-'));
const transcript = path.join(projDir, `${sid}.jsonl`);
function append(line) {
  try { fs.mkdirSync(projDir, { recursive: true }); fs.appendFileSync(transcript, JSON.stringify(line) + '\n'); } catch { /* 忽略 */ }
}
const stamp = () => new Date().toISOString();

async function turn(userText) {
  const uUuid = crypto.randomUUID();
  append({ type: 'user', uuid: uUuid, parentUuid: null, sessionId: sid, cwd, timestamp: stamp(),
    message: { role: 'user', content: [{ type: 'text', text: userText }] } });

  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: 'claude-sonnet-4-6',
    tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });

  let text = 'ok';
  try { text = fs.readFileSync(path.join(CTL, 'script.txt'), 'utf8'); } catch { /* 用默认 */ }

  const msgId = 'msg_' + crypto.randomBytes(8).toString('hex');
  out({ type: 'stream_event', session_id: sid, uuid: crypto.randomUUID(),
    event: { type: 'message_start', message: { id: msgId, role: 'assistant', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 10, output_tokens: 0 } } } });
  out({ type: 'stream_event', session_id: sid, uuid: crypto.randomUUID(),
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });

  // 逐块吐字:让"流式期"是真的流式(每块之间留出渲染时间)
  const CH = 40;
  let acc = '';
  for (let i = 0; i < text.length; i += CH) {
    const piece = text.slice(i, i + CH);
    acc += piece;
    out({ type: 'stream_event', session_id: sid, uuid: crypto.randomUUID(),
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
    out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null,
      message: { id: msgId, role: 'assistant', model: 'claude-sonnet-4-6', type: 'message',
        content: [{ type: 'text', text: acc }], stop_reason: null, usage: { input_tokens: 10, output_tokens: i / CH } } });
    await sleep(60);
  }
  out({ type: 'stream_event', session_id: sid, uuid: crypto.randomUUID(), event: { type: 'content_block_stop', index: 0 } });

  // 工具结果卡片 / 子代理结果:测"只读面"的围栏用(tools.json 由测试放进遥控目录)
  let tools = [];
  try { tools = JSON.parse(fs.readFileSync(path.join(CTL, 'tools.json'), 'utf8')); } catch { /* 没有就不发 */ }
  for (const t of tools) {
    const tuid = 'toolu_' + crypto.randomBytes(8).toString('hex');
    out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(),
      message: { id: msgId, role: 'assistant', type: 'message', model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', id: tuid, name: t.name || 'Task', input: t.input || {} }], stop_reason: 'tool_use' } });
    append({ ...{ isSidechain: false, userType: 'external', cwd, sessionId: sid, version: '2.1.227' },
      type: 'assistant', uuid: crypto.randomUUID(), parentUuid: uUuid, timestamp: stamp(),
      message: { id: msgId, role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', id: tuid, name: t.name || 'Task', input: t.input || {} }] } });
    await sleep(80);
    out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tuid, content: t.result || '' }] } });
    append({ ...{ isSidechain: false, userType: 'external', cwd, sessionId: sid, version: '2.1.227' },
      type: 'user', uuid: crypto.randomUUID(), parentUuid: uUuid, timestamp: stamp(),
      toolUseResult: t.result || '',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tuid, content: t.result || '' }] } });
    await sleep(80);
  }

  // hold:回合不结束,会话保持"忙"
  while (fs.existsSync(path.join(CTL, 'hold'))) await sleep(80);

  out({ type: 'stream_event', session_id: sid, uuid: crypto.randomUUID(),
    event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: text.length } } });
  append({ type: 'assistant', uuid: crypto.randomUUID(), parentUuid: uUuid, sessionId: sid, cwd, timestamp: stamp(),
    message: { id: msgId, role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(),
    result: text, duration_ms: 100, num_turns: 1, total_cost_usd: 0,
    usage: { input_tokens: 10, output_tokens: text.length, cache_read_input_tokens: 0 } });
}

const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
if (printArg && !argv.includes('--input-format')) { await turn(printArg); process.exit(0); }

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  let msg; try { msg = JSON.parse(line); } catch { continue; }
  if (msg.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } }); continue; }
  if (msg.type !== 'user') continue;
  const c = msg.message && msg.message.content;
  const txt = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : '');
  await turn(txt);
}
process.exit(0);
