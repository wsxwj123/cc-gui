#!/usr/bin/env node
// 直播子代理金额(2026-09-13)验收用的最小假 claude CLI:只说 stream-json,不碰实现内部。
// 只为造出那一格现场 ——「子代理已经跑完、回合还在进行中」:
//
//   发一条消息后:init → 一条带 Task tool_use 的 assistant → system/task_started
//                 → 【等遥控文件 go】
//   go 出现时   :写子代理转写(agent-<task_id>.jsonl + .meta.json)→ system/task_notification
//                 → 【等遥控文件 finish】
//   finish 出现 :tool_result → result(回合结束)
//
// 遥控目录 = $CGUI_FAKE_CLAUDE_DIR。文件中途不出现,回合就一直不结束 —— 正是要断言的窗口。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

// 版本/帮助探测要立刻答完并退出:留着挂住会把 --help 探测拖到超时。
if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }

const sid = argOf('--session-id') || argOf('--resume') || crypto.randomUUID();
const cwd = process.cwd();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const projDir = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[/\\]/g, '-'));
const transcript = path.join(projDir, `${sid}.jsonl`);
const append = (line) => {
  try { fs.mkdirSync(projDir, { recursive: true }); fs.appendFileSync(transcript, JSON.stringify(line) + '\n'); } catch { /* 忽略 */ }
};
const stamp = () => new Date().toISOString();

// 转写文件名与 task_id 同名(服务端的 taskId 直连路径),tool_use.id = 卡片键 = 归属键。
const TASK_ID = 'a1b2c3d4e5f60718';
const TOOL_USE_ID = 'toolu_live_subcost_e2e_1';
const MODEL = 'claude-sonnet-4-6';
// 100k input × $3/MTok = $0.30 → 展示 ¥2.16(不算 output/cache,期望值好对账)
const SUB_USAGE = { input_tokens: 100000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const MAIN_USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

const waitFor = async (f) => { while (!fs.existsSync(path.join(CTL, f))) await sleep(60); };

async function turn(userText) {
  const uUuid = crypto.randomUUID();
  append({ type: 'summary', summary: String(userText || '').slice(0, 40) || '新会话', leafUuid: uUuid });
  append({
    type: 'user', uuid: uUuid, parentUuid: null, sessionId: sid, cwd, timestamp: stamp(),
    message: { role: 'user', content: [{ type: 'text', text: userText }] },
  });
  out({
    type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL,
    tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID(),
  });

  // 派一个前台子代理:卡片由这条 tool_use 建出来
  const msgId = 'msg_' + crypto.randomBytes(8).toString('hex');
  const taskInput = { subagent_type: 'fixer', description: 'LIVE-E2E 子代理', prompt: '写点东西' };
  const toolUseBlock = { type: 'tool_use', id: TOOL_USE_ID, name: 'Task', input: taskInput };
  out({
    type: 'assistant', session_id: sid, uuid: crypto.randomUUID(),
    message: { id: msgId, role: 'assistant', model: MODEL, type: 'message', content: [toolUseBlock], stop_reason: 'tool_use', usage: MAIN_USAGE },
  });
  append({
    ...{ isSidechain: false, userType: 'external', cwd, sessionId: sid, version: '2.1.227' },
    type: 'assistant', uuid: crypto.randomUUID(), parentUuid: uUuid, timestamp: stamp(),
    message: { id: msgId, role: 'assistant', model: MODEL, type: 'message', content: [toolUseBlock], stop_reason: 'tool_use', usage: MAIN_USAGE },
  });
  out({
    type: 'system', subtype: 'task_started', task_id: TASK_ID, tool_use_id: TOOL_USE_ID,
    subagent_type: 'fixer', description: taskInput.description, uuid: crypto.randomUUID(),
  });

  // ① 子代理"还在跑":啥时候跑完由测试决定
  await waitFor('go');

  const subDir = path.join(projDir, sid, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, `agent-${TASK_ID}.meta.json`),
    JSON.stringify({ toolUseId: TOOL_USE_ID, agentType: 'fixer' }));
  fs.writeFileSync(path.join(subDir, `agent-${TASK_ID}.jsonl`), JSON.stringify({
    type: 'assistant', uuid: crypto.randomUUID(), timestamp: stamp(),
    message: { id: 'sub_msg_1', role: 'assistant', model: MODEL, content: [{ type: 'text', text: '子代理干完了' }], usage: SUB_USAGE },
  }) + '\n');
  await sleep(120);   // 转写先落盘,再发自报(与真 CLI 一致:文件实时增量写)

  out({
    type: 'system', subtype: 'task_notification', task_id: TASK_ID, tool_use_id: TOOL_USE_ID,
    status: 'completed', summary: '子代理干完了', uuid: crypto.randomUUID(),
  });

  // ② 回合仍未结束 —— 金额必须在这段窗口里就出现
  await waitFor('finish');

  out({
    type: 'user', session_id: sid, uuid: crypto.randomUUID(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content: '子代理干完了' }] },
  });
  out({
    type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(),
    result: 'ok', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: MAIN_USAGE,
  });
}

if (!fs.existsSync(CTL)) { try { fs.mkdirSync(CTL, { recursive: true }); } catch { /* 忽略 */ } }
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
