// r171 写入进程:打开命名管道(会阻塞到后端来读),之后每 300ms 写一行合法的会话记录,一直不结束。
// 管道另一头关闭后,下一次写入会抛 EPIPE;本进程把状态落到状态文件里,供测试读取,然后退出。
// 用法:node fifo-writer.mjs <管道路径> <状态文件> <会话id> <工作区目录>
import fs from 'node:fs';

const [fifoPath, statePath, sid, cwd] = process.argv.slice(2);
const state = { opened: false, openedAt: null, writes: 0, error: null, errorAt: null };

function saveState() {
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath);
}

saveState();
const fd = fs.openSync(fifoPath, 'w'); // 阻塞到后端打开管道读端
state.opened = true;
state.openedAt = Date.now();
saveState();

const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.296', gitBranch: '' };
const t0 = Date.parse('2026-10-01T08:00:00.000Z');
let index = 0;

function nextLine() {
  const i = index;
  index += 1;
  const isUser = i % 2 === 0;
  const record = isUser
    ? { ...base, type: 'user', uuid: `${sid}-w${i}`, parentUuid: i ? `${sid}-w${i - 1}` : null, timestamp: new Date(t0 + i * 1000).toISOString(), message: { role: 'user', content: `R171-STUCK-${i}` } }
    : {
        ...base, type: 'assistant', uuid: `${sid}-w${i}`, parentUuid: `${sid}-w${i - 1}`, timestamp: new Date(t0 + i * 1000).toISOString(),
        requestId: `req_stuck_${i}`,
        message: {
          id: `msg_stuck_${i}`, type: 'message', role: 'assistant', model: 'r171-chat',
          content: [{ type: 'text', text: `R171-STUCK-${i}` }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      };
  return `${JSON.stringify(record)}\n`;
}

const timer = setInterval(() => {
  try {
    fs.writeSync(fd, nextLine());
    state.writes += 1;
    saveState();
  } catch (e) {
    state.error = e && e.code ? e.code : String(e);
    state.errorAt = Date.now();
    saveState();
    clearInterval(timer);
    try { fs.closeSync(fd); } catch { /* 已断 */ }
    process.exit(0);
  }
}, 300);
