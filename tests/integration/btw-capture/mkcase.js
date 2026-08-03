// 造一条主会话 jsonl,用来复现「主会话尾部形态 → CLI --resume 时注入什么」。
// 用法:node mkcase.js <configDir> <projectCwd> <case>,打印新建会话的 sessionId。
// case 六种尾部形态,覆盖旁问串台的全部诱因:
//   clean                  以 assistant end_turn 正常收尾
//   dangling_user          末尾是没人应答的用户消息(CLI 会补 "Continue from where you left off.")
//   dangling_tooluse       末尾是没有 tool_result 的 tool_use
//   dangling_toolresult    末尾是没有后续 assistant 的 tool_result(Bash)
//   dangling_toolresult_err 同上,写类工具(Edit)
//   interrupted            末尾是 "[Request interrupted by user]"
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const CFG = process.argv[2];              // config dir (CLAUDE_CONFIG_DIR)
const CWD = process.argv[3];              // fake project cwd
const CASE = process.argv[4];
const enc = CWD.replace(/[^a-zA-Z0-9]/g, '-');
const dir = path.join(CFG, 'projects', enc);
fs.mkdirSync(dir, { recursive: true });
const sid = crypto.randomUUID();
const base = (uuid, parent, ts) => ({ parentUuid: parent, isSidechain: false, userType: 'external', cwd: CWD, sessionId: sid, version: '2.1.220', gitBranch: '', timestamp: ts, uuid });
const rows = [];
const u1 = crypto.randomUUID(), a1 = crypto.randomUUID(), u2 = crypto.randomUUID(), a2 = crypto.randomUUID(), u3 = crypto.randomUUID();
const T = (i) => new Date(Date.now() - (100 - i) * 1000).toISOString();
rows.push({ ...base(u1, null, T(1)), type: 'user', message: { role: 'user', content: 'MAINTASK: Refactor the widget parser in src/parser.py so it handles nested brackets. Do it now, step by step.' } });
rows.push({ ...base(a1, u1, T(2)), type: 'assistant', requestId: 'req_1', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'I will start by reading src/parser.py.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } } });
if (CASE === 'clean') { /* ends on assistant end_turn */ }
if (CASE === 'dangling_user') {
  rows.push({ ...base(u2, a1, T(3)), type: 'user', message: { role: 'user', content: 'MAINTASK-CONT: keep going, finish the nested bracket support and run the tests.' } });
}
if (CASE === 'dangling_tooluse') {
  rows.push({ ...base(u2, a1, T(3)), type: 'user', message: { role: 'user', content: 'MAINTASK-CONT: keep going, finish the nested bracket support and run the tests.' } });
  rows.push({ ...base(a2, u2, T(4)), type: 'assistant', requestId: 'req_2', message: { id: 'm2', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'toolu_mock1', name: 'Bash', input: { command: 'pytest -q', description: 'run tests' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } } });
}
if (CASE === 'interrupted') {
  rows.push({ ...base(u2, a1, T(3)), type: 'user', message: { role: 'user', content: 'MAINTASK-CONT: keep going, finish the nested bracket support and run the tests.' } });
  rows.push({ ...base(a2, u2, T(4)), type: 'assistant', requestId: 'req_2', message: { id: 'm2', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Working on it, first I will' }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } } });
  rows.push({ ...base(u3, a2, T(5)), type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } });
}
if (CASE === 'dangling_toolresult') {
  rows.push({ ...base(u2, a1, T(3)), type: 'user', message: { role: 'user', content: 'MAINTASK-CONT: keep going, finish the nested bracket support and run the tests.' } });
  rows.push({ ...base(a2, u2, T(4)), type: 'assistant', requestId: 'req_2', message: { id: 'm2', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'toolu_mock1', name: 'Bash', input: { command: 'pytest -q', description: 'run tests' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } } });
  rows.push({ ...base(u3, a2, T(5)), type: 'user', toolUseResult: { stdout: '3 failed', stderr: '', interrupted: false }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mock1', content: '3 failed, 10 passed', is_error: false }] } });
}
if (CASE === 'dangling_toolresult_err') {
  rows.push({ ...base(u2, a1, T(3)), type: 'user', message: { role: 'user', content: 'MAINTASK-CONT: keep going, finish the nested bracket support and run the tests.' } });
  rows.push({ ...base(a2, u2, T(4)), type: 'assistant', requestId: 'req_2', message: { id: 'm2', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'toolu_mock1', name: 'Edit', input: { file_path: '/tmp/x.py', old_string: 'a', new_string: 'b' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } } });
  rows.push({ ...base(u3, a2, T(5)), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mock1', content: 'File edited', is_error: false }] } });
}
fs.writeFileSync(path.join(dir, sid + '.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(sid);
