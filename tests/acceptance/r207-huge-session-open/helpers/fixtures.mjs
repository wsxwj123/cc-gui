// r207 接口测试的会话夹具生成器。行内容、形状照接口文件「名词与量法」。只写文件,不 import 产品代码。
// 所有写出的文件 / 目录都登记在 FixtureSet 里,收尾按文件名逐个 unlink(不递归删目录)。
import fs from 'node:fs';
import path from 'node:path';
import { uuid, encodeProjectDir } from './kit.mjs';

const T0 = Date.parse('2026-10-01T08:00:00.000Z');
const iso = (n) => new Date(T0 + n * 1000).toISOString();
export const USAGE = (i = 10, o = 5) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

/** 约 bytes 字节、含中文 / 双引号 / 换行的文字。 */
export function filler(bytes, seed) {
  let s = '';
  let n = 0;
  while (Buffer.byteLength(s) < bytes) { s += `${seed}第${n}段「引用"内容"」填充文字\n`; n += 1; }
  return s;
}
export const chars = (n, seed) => { let s = ''; let i = 0; while (s.length < n) { s += `${seed}句${i}。`; i += 1; } return s.slice(0, n); };

export class FixtureSet {
  constructor() { this.files = []; this.dirs = []; }
  mkdir(d) { fs.mkdirSync(d, { recursive: true }); this.dirs.push(d); return d; }
  open(file) { this.files.push(file); return fs.openSync(file, 'w'); }
  write(file, text) { this.files.push(file); fs.writeFileSync(file, text); }
  /** 按文件名逐个删(不写递归删除),再按深度从深到浅删空目录。 */
  cleanup() {
    if (process.env.R207_KEEP) return;
    for (const f of this.files) { try { fs.unlinkSync(f); } catch { /* 已删 */ } }
    for (const d of [...new Set(this.dirs)].sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(d); } catch { /* 非空或已删 */ } }
    this.files = []; this.dirs = [];
  }
}

export function newWorkspace(inst, name) {
  const cwd = inst.makeWorkspace(name);
  return { cwd, projectHash: encodeProjectDir(cwd) };
}
export const projectDir = (inst, hash) => path.join(inst.home, '.claude', 'projects', hash);

// ---------- 普通记录(用户 / 助手记录的第一个键不是 type,和真实命令行一样) ----------
export const userLine = ({ sid, cwd, n, parent, text, uid }) => JSON.stringify({
  parentUuid: parent, isSidechain: false, promptId: `p-${uid}`, type: 'user', message: { role: 'user', content: text }, uuid: uid, timestamp: iso(n), sessionId: sid, cwd,
});
export const toolResultLine = ({ sid, cwd, n, parent, toolId, body, uid, sidechain = false, withToolUseResult = true }) => JSON.stringify({
  parentUuid: parent, isSidechain: sidechain, promptId: `p-${uid}`, type: 'user',
  message: { role: 'user', content: [{ tool_use_id: toolId, type: 'tool_result', content: body }] },
  uuid: uid, timestamp: iso(n), sessionId: sid, cwd, ...(withToolUseResult ? { toolUseResult: { stdout: body, stderr: '' } } : {}),
});
export const assistantLine = ({ sid, n, parent, content, msgId, uid, stop = 'end_turn', usage = USAGE(), sidechain = false }) => JSON.stringify({
  parentUuid: parent, isSidechain: sidechain,
  message: { id: msgId, type: 'message', role: 'assistant', model: 'r207-model', content, stop_reason: stop, usage },
  type: 'assistant', uuid: uid, timestamp: iso(n), sessionId: sid,
});

// ---------- 元数据行(第一个键就是 type,值不是 user / assistant / system / attachment) ----------
export const META_KINDS = ['api-request', 'api-request-blob', 'api-request-shape', 'last-prompt', 'custom-title', 'mode', 'bridge-session', 'queue-operation', 'cost-state', 'tools-used'];
export function metaLine(kind, sid, i, { blobText, reqText, queueText } = {}) {
  const ts = iso(i);
  switch (kind) {
    case 'api-request': return JSON.stringify({ type: 'api-request', sessionId: sid, id: `req-${i}`, timestamp: ts, model: 'r207-model', messages: [{ role: 'user', content: reqText || chars(2048, 'req') }] });
    case 'api-request-blob': return JSON.stringify({ type: 'api-request-blob', sessionId: sid, hash: `h${i}`, message: { role: 'user', content: Array.from({ length: 25 }, (_, k) => ({ type: 'text', text: blobText || filler(4000, `b${k}`) })) } });
    case 'api-request-shape': return JSON.stringify({ type: 'api-request-shape', sessionId: sid, shapeHash: `s${i}`, timestamp: ts });
    case 'last-prompt': return JSON.stringify({ type: 'last-prompt', lastPrompt: `上一条提示 ${i}`, leafUuid: `leaf-${i}`, sessionId: sid });
    case 'custom-title': return JSON.stringify({ type: 'custom-title', customTitle: `标题 ${i}`, sessionId: sid });
    case 'mode': return JSON.stringify({ type: 'mode', mode: 'default', sessionId: sid });
    case 'bridge-session': return JSON.stringify({ type: 'bridge-session', sessionId: sid, bridgeSessionId: `br-${i}`, lastSequenceNum: 3 });
    case 'queue-operation': return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, sessionId: sid, content: queueText || chars(3000, 'q') });
    case 'cost-state': return JSON.stringify({ type: 'cost-state', sessionId: sid, totalCostUSD: 0.1, totalAPIDuration: 100 });
    case 'tools-used': return JSON.stringify({ type: 'tools-used', tools: ['Bash'], sessionId: sid });
    default: throw new Error(`未知元数据种类 ${kind}`);
  }
}

// ---------- 行为 1:P / M ----------
/** 一轮 4 行(用户提问 / 助手 thinking + Bash / 只含工具结果 / 助手正文)。 */
function hugeTurn(sid, cwd, i, shared) {
  const base = i * 4;
  const toolId = `toolu_P${i}`;
  return [
    userLine({ sid, cwd, n: base, parent: i ? `${sid}-t${i - 1}` : null, text: `P-${i} 请执行一条命令`, uid: `${sid}-u${i}` }),
    assistantLine({ sid, n: base + 1, parent: `${sid}-u${i}`, msgId: `msg_P_${i}_a`, uid: `${sid}-a${i}`, stop: 'tool_use',
      content: [{ type: 'thinking', thinking: shared.think }, { type: 'tool_use', id: toolId, name: 'Bash', input: { command: `echo ${i}` } }] }),
    toolResultLine({ sid, cwd, n: base + 2, parent: `${sid}-a${i}`, toolId, body: shared.result, uid: `${sid}-r${i}` }),
    assistantLine({ sid, n: base + 3, parent: `${sid}-r${i}`, msgId: `msg_P_${i}_b`, uid: `${sid}-t${i}`, content: [{ type: 'text', text: shared.text }] }),
  ];
}
/** 写 P(metaEvery=false)或 M(metaEvery=true:每轮之后插 10 条元数据行,约 120KB)。P、M 的会话行内容一字不差(包括 sessionId)。 */
export function writeHuge(fx, inst, ws, { sid, contentSid, turns, withMeta }) {
  const dir = fx.mkdir(projectDir(inst, ws.projectHash));
  const shared = { think: filler(2048, 'think'), result: filler(30_000, 'out'), text: chars(500, '正文') };
  const blobText = filler(4000, 'blob');
  const file = path.join(dir, `${sid}.jsonl`);
  const fd = fx.open(file);
  try {
    for (let i = 0; i < turns; i += 1) {
      let chunk = hugeTurn(contentSid, ws.cwd, i, shared).join('\n') + '\n';
      if (withMeta) chunk += META_KINDS.map((k) => metaLine(k, contentSid, i, { blobText })).join('\n') + '\n';
      fs.writeSync(fd, chunk);
    }
  } finally { fs.closeSync(fd); }
  return { sid, file, size: fs.statSync(file).size };
}

// ---------- 行为 2 / 3:带子代理的会话 ----------
const agentCallId = (tag, turn, k) => `toolu_${tag}_A${turn}_${k}`;
/** 75 轮主文件:每轮 用户提问 / 助手(2 次 Agent 调用)/ 两条各含一个工具结果的用户记录 / 助手正文。返回 150 个调用 id(按出现顺序)。 */
export function writeAgentMain(fx, inst, ws, { sid, tag, turns = 75 }) {
  const dir = fx.mkdir(projectDir(inst, ws.projectHash));
  const lines = []; const callIds = [];
  for (let i = 0; i < turns; i += 1) {
    const b = i * 5;
    const ids = [agentCallId(tag, i, 0), agentCallId(tag, i, 1)];
    callIds.push(...ids);
    lines.push(userLine({ sid, cwd: ws.cwd, n: b, parent: i ? `${sid}-t${i - 1}` : null, text: `${tag}-${i} 请派子代理`, uid: `${sid}-u${i}` }));
    lines.push(assistantLine({ sid, n: b + 1, parent: `${sid}-u${i}`, msgId: `msg_${tag}_${i}_a`, uid: `${sid}-a${i}`, stop: 'tool_use',
      content: ids.map((id, k) => ({ type: 'tool_use', id, name: 'Agent', input: { prompt: `子任务 ${i}-${k}` } })) }));
    ids.forEach((id, k) => lines.push(toolResultLine({ sid, cwd: ws.cwd, n: b + 2 + k, parent: `${sid}-a${i}`, toolId: id, body: `子代理 ${i}-${k} 的结果`, uid: `${sid}-r${i}-${k}` })));
    lines.push(assistantLine({ sid, n: b + 4, parent: `${sid}-r${i}-1`, msgId: `msg_${tag}_${i}_b`, uid: `${sid}-t${i}`, content: [{ type: 'text', text: `${tag}-${i} 完成` }] }));
  }
  const file = path.join(dir, `${sid}.jsonl`);
  fx.write(file, lines.join('\n') + '\n');
  return { file, callIds };
}
/** 一个约 1MB 的转写:30 条只含工具结果的用户记录(每条约 30KB)+ 20 条助手记录(各 input 10 / output 5,message.id 互不相同)。 */
function subagentText(sid, cwd, agentId, result) {
  const out = [];
  let n = 0; let prev = null;
  out.push(userLine({ sid, cwd, n: n++, parent: null, text: `子代理 ${agentId} 的任务`, uid: `${agentId}-u` }).replace('"isSidechain":false', '"isSidechain":true'));
  for (let j = 0; j < 20; j += 1) {
    const toolIds = j < 10 ? [`${agentId}-t${j}a`, `${agentId}-t${j}b`] : [`${agentId}-t${j}a`];
    out.push(assistantLine({ sid, n: n++, parent: prev, msgId: `msg_${agentId}_${j}`, uid: `${agentId}-a${j}`, stop: 'tool_use', sidechain: true,
      content: toolIds.map((id) => ({ type: 'tool_use', id, name: 'Bash', input: { command: `echo ${id}` } })) }));
    toolIds.forEach((id, k) => { out.push(toolResultLine({ sid, cwd, n: n++, parent: `${agentId}-a${j}`, toolId: id, body: result, uid: `${agentId}-r${j}${k}`, sidechain: true })); });
    prev = `${agentId}-a${j}`;
  }
  return out.join('\n') + '\n';
}
export function writeSubagents(fx, inst, ws, { sid, callIds, tag }) {
  const subDir = fx.mkdir(path.join(projectDir(inst, ws.projectHash), sid, 'subagents'));
  const result = filler(30_000, 'sub');
  const files = [];
  callIds.forEach((toolUseId, idx) => {
    const agentId = `a${tag}${String(idx).padStart(4, '0')}`;
    const f = path.join(subDir, `agent-${agentId}.jsonl`);
    fx.write(f, subagentText(sid, ws.cwd, agentId, result));
    fx.write(path.join(subDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', toolUseId }));
    files.push(f);
  });
  return { subDir, files };
}
/** 往转写末尾追加 1 条新的助手记录。 */
export function appendSubagentAssistant(file, { sid, msgId, input, output }) {
  fs.appendFileSync(file, assistantLine({ sid, n: 9999, parent: null, msgId, uid: `${msgId}-uid`, content: [{ type: 'text', text: '追加的一条' }], usage: USAGE(input, output), sidechain: true }) + '\n');
}

// ---------- 行为 4:K / K′ ----------
/** K 的各行:{ text, eol }。 */
export function buildK(sid, cwd) {
  const e = [];
  let n = 0; let prev = null; let idc = 0;
  const nid = () => `${sid}-k${idc++}`;
  const push = (text, eol = '\n') => e.push({ text, eol });
  const U = (text) => { const uid = nid(); push(userLine({ sid, cwd, n: n++, parent: prev, text, uid })); prev = uid; return uid; };
  const A = (content, stop = 'end_turn') => { const uid = nid(); push(assistantLine({ sid, n: n++, parent: prev, msgId: `msg_K_${n}`, uid, content, stop })); prev = uid; return uid; };
  for (let q = 1; q <= 3; q += 1) { U(`K-问${q} 普通问题`); A([{ type: 'text', text: `K-答${q} 普通回答` }]); }
  U('K-问4 要用工具');
  A([{ type: 'thinking', thinking: 'K-思考 先看一下' }, { type: 'tool_use', id: 'toolu_K1', name: 'Bash', input: { command: 'echo K1' } }, { type: 'tool_use', id: 'toolu_K2', name: 'Bash', input: { command: 'echo K2' } }], 'tool_use');
  push(toolResultLine({ sid, cwd, n: n++, parent: prev, toolId: 'toolu_K1', body: 'K1-结果', uid: nid() }), '\r\n');
  push(toolResultLine({ sid, cwd, n: n++, parent: prev, toolId: 'toolu_K2', body: 'K2-结果', uid: nid() }), '\r\n');
  A([{ type: 'text', text: 'K-答4 工具跑完了' }]);
  push(JSON.stringify({ parentUuid: prev, isSidechain: false, type: 'user', isCompactSummary: true, message: { role: 'user', content: 'K-压缩摘要 之前聊了几个问题' }, uuid: nid(), timestamp: iso(n++), sessionId: sid, cwd }), '\r\n');
  push(JSON.stringify({ parentUuid: prev, isSidechain: false, type: 'user', message: { role: 'user', content: '<task-notification><task-id>t1</task-id><status>completed</status><summary>完成</summary></task-notification>' }, uuid: nid(), timestamp: iso(n++), sessionId: sid, cwd }));
  push(JSON.stringify({ parentUuid: prev, isSidechain: false, attachment: { type: 'goal_status', met: false, sentinel: true, condition: '测试目标' }, type: 'attachment', uuid: nid(), timestamp: iso(n++) }));
  push(JSON.stringify({ parentUuid: prev, isSidechain: false, attachment: { type: 'queued_command', prompt: '并入的消息', commandMode: 'prompt', source_uuid: `${sid}-k${n}-src` }, type: 'attachment', uuid: nid(), timestamp: iso(n++) }));
  push(JSON.stringify({ parentUuid: prev, isSidechain: false, type: 'system', subtype: 'model_refusal_fallback', originalModel: 'a', fallbackModel: 'b', uuid: nid(), timestamp: iso(n++) }));
  push(JSON.stringify({ type: 'user', parentUuid: prev, isSidechain: false, message: { role: 'user', content: 'K-问5 type 打头的提问' }, uuid: nid(), timestamp: iso(n++), sessionId: sid, cwd }));
  push('{"parentUuid":"broken","isSidechain":false,"type":"user","message":{"role":"user","content":"坏 JSON 半截', '\r\n');
  push('     ');
  push(JSON.stringify({ type: 'assistant', parentUuid: prev, isSidechain: false, message: { id: 'msg_K_typefirst', type: 'message', role: 'assistant', model: 'r207-model', content: [{ type: 'text', text: 'K-答5 type 打头的回答' }], stop_reason: 'end_turn', usage: USAGE() }, uuid: nid(), timestamp: iso(n++), sessionId: sid }), '');
  return e;
}
export const joinLines = (entries) => entries.map((x) => x.text + x.eol).join('');
/** K′:K 的每两行之间插入 1–3 条元数据行(种类轮换),K 自己的行与换行一字不改。 */
export function buildKPrime(entries, sid) {
  const out = []; let r = 0;
  entries.forEach((x, i) => {
    out.push(x);
    if (i === entries.length - 1) return;
    // 上一行末尾没有换行(只可能是最后一行)不会在这里出现;K 里 eol 为 '' 的只有最后一行
    const cnt = (i % 3) + 1;
    for (let c = 0; c < cnt; c += 1) { out.push({ text: metaLine(META_KINDS[r % META_KINDS.length], sid, i * 10 + c), eol: '\n' }); r += 1; }
  });
  return out;
}

// ---------- 行为 5:Q ----------
/** 150 轮问答 = 300 条消息;消息 k 的文字含 Q207-MSG-<3 位下标>-;其间每条记录后插 1 条元数据行。 */
export function buildQ(sid, cwd) {
  const lines = []; let prev = null; let r = 0;
  for (let k = 0; k < 300; k += 1) {
    const tag = `Q207-MSG-${String(k).padStart(3, '0')}-`;
    const uid = `${sid}-q${k}`;
    lines.push(k % 2 === 0
      ? userLine({ sid, cwd, n: k, parent: prev, text: `${tag}提问`, uid })
      : assistantLine({ sid, n: k, parent: prev, msgId: `msg_Q_${k}`, uid, content: [{ type: 'text', text: `${tag}回答` }] }));
    prev = uid;
    lines.push(metaLine(META_KINDS[r % META_KINDS.length], sid, k)); r += 1;
  }
  return lines.join('\n') + '\n';
}
export { uuid };
