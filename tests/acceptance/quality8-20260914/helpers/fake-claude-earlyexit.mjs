#!/usr/bin/env node
// Q8-13 用的最小假 claude CLI:只造"进程在吐出第一条 stream-json 之前就退出"的现场。
// 模式由 $CGUI_FAKE_CLAUDE_DIR/mode 文件决定:
//   exit(默认):stderr 写一行可辨认的启动失败原因,退出码 7,stdout 一个字节都不写
//   hang       :25 秒内不吐任何东西(制造真正的"初始化超时"),之后正常 init + result
// --version / --help 探测立刻答完(否则 CLI 探测会拖到超时)。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) { console.log('2.1.257 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options] [command] [prompt]'); process.exit(0); }
if (argv[0] === 'mcp' || argv[0] === 'plugin' || argv[0] === 'config') { console.log('[]'); process.exit(0); } // 后台探测类子命令:立刻答完,不留 25s 的孤儿

let mode = 'exit';
try { mode = fs.readFileSync(path.join(CTL, 'mode'), 'utf8').trim() || 'exit'; } catch { /* 默认 exit */ }
try { fs.appendFileSync(path.join(CTL, 'spawns.log'), `${JSON.stringify({ at: Date.now(), mode, argv })}\n`); } catch { /* 忽略 */ }

if (mode === 'exit') {
  process.stderr.write('Q8_FAKE_BOOT_FAILURE: settings.json is invalid (fake CLI, exit 7)\n');
  process.exit(7);
}

// hang:先沉默 25s,再走一遍最小回合,最后自行退出(不留孤儿)
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const sid = argOf('--session-id') || argOf('--resume') || crypto.randomUUID();
setTimeout(() => {
  out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), model: 'claude-sonnet-4-6', tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: 'ok', duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  setTimeout(() => process.exit(0), 500);
}, 25_000);
process.stdin.resume();
