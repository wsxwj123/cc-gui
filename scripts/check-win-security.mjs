// 校验:①safeModelArg 白名单挡 cmd.exe 参数注入;②DANGEROUS_BASH 认 Windows 危险命令。
import { safeModelArg } from '../server/routes/chat.js';
import { isDangerousCommand } from '../client/src/hooks/useWebSocket.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

// safeModelArg:合法模型名放行、注入串拒绝(返回空 → 调用方不传 --model)
ok(safeModelArg('claude-sonnet-4-6') === 'claude-sonnet-4-6', '正常模型名应放行');
ok(safeModelArg('claude-opus-4-8[1m]') === 'claude-opus-4-8[1m]', '带[1m]后缀应放行');
ok(safeModelArg('anthropic/claude-3') === 'anthropic/claude-3', '带斜杠provider前缀应放行');
ok(safeModelArg('x&calc') === '', '注入 x&calc 应拒绝');
ok(safeModelArg('a|whoami') === '', '注入 a|whoami 应拒绝');
ok(safeModelArg('a>b') === '', '注入 a>b 应拒绝');
ok(safeModelArg('a b') === '', '含空格应拒绝(参数应无空格)');
ok(safeModelArg('') === '', '空应返回空');
ok(safeModelArg(null) === '', 'null 应返回空');

// DANGEROUS_BASH:Windows 原生危险命令应命中
const danger = (cmd) => isDangerousCommand({ toolName: 'Bash', toolInput: { command: cmd } });
ok(danger('del /s /q C:\\proj'), 'del /s /q 应判危险');
ok(danger('rd /s /q foo'), 'rd /s 应判危险');
ok(danger('rmdir /s bar'), 'rmdir /s 应判危险');
ok(danger('Remove-Item -Recurse -Force .\\x'), 'Remove-Item -Recurse 应判危险');
ok(danger('format c:'), 'format c: 应判危险');
ok(danger('rm -rf /tmp/x'), 'rm -rf 仍判危险(POSIX 回归)');
// 不误伤
ok(!danger('echo delete'), 'echo delete 不应误判');
ok(!danger('git status'), 'git status 不应误判');

console.log(`check-win-security: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
