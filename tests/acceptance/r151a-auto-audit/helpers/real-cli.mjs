// r151a:直接驱动本机真实 claude CLI 的最小宿主(说 stream-json 控制协议,与 GUI 用的 SDK 同一条管道)。
// 只用于端到端链路验证;所有模型请求都打到本地假接口(ANTHROPIC_BASE_URL 由调用方给),HOME / 配置目录全是临时目录。
// 不经过 GUI:GUI 在本机隔离实例里会把第三方 provider 指到用户机器上常驻的代理守护进程(127.0.0.1:8799),
// 真 CLI 绝不能走那条路(会打到用户真实的 provider)。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const REAL_CLI_CANDIDATES = [
  process.env.R151A_REAL_CLAUDE,
  path.join(os.userInfo().homedir, '.npm-global', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
].filter(Boolean);
export const realCliPath = () => REAL_CLI_CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;

/**
 * 跑一回合。返回 { lines, permissionRequests, exitCode, timedOut }。
 * onCanUseTool(req) → { behavior:'allow' } | { behavior:'deny', message } ;不给 = 一律拒绝(测试里"不该走到询问"的情形会被看见)。
 */
export async function runRealCli({ root, baseURL, env = {}, prompt, permissionMode = 'auto', model = 'r151-main', onCanUseTool, timeoutMs = 90_000, logFile, extraArgs = ['--include-partial-messages'] }) {
  const cli = realCliPath();
  if (!cli) throw new Error('本机没有真实 claude CLI');
  const home = path.join(root, 'home');
  const cfg = path.join(root, 'cfg');
  const cwd = path.join(root, 'work');
  for (const d of [home, cfg, cwd]) fs.mkdirSync(d, { recursive: true });
  const childEnv = {
    PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: cfg, TMPDIR: path.join(root, 'tmp'), LANG: 'en_US.UTF-8',
    ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_AUTH_TOKEN: 'dummy-r151-token', ANTHROPIC_MODEL: model,
    DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1',
    ...env,
  };
  fs.mkdirSync(childEnv.TMPDIR, { recursive: true });
  const args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    '--permission-prompt-tool', 'stdio', '--permission-mode', permissionMode, '--model', model, '--setting-sources', 'user,project,local', ...extraArgs];
  const child = spawn(cli, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const permissionRequests = [];
  const log = (o) => { if (logFile) { try { fs.appendFileSync(logFile, `${JSON.stringify(o)}\n`); } catch { /* */ } } };
  const send = (o) => { try { child.stdin.write(`${JSON.stringify(o)}\n`); } catch { /* 已关 */ } };
  let buf = '';
  let stderr = '';
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
  child.stderr.on('data', (d) => { stderr += String(d); });
  child.stdout.on('data', async (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      lines.push(o); log(o);
      if (o.type === 'control_request' && o.request && o.request.subtype === 'can_use_tool') {
        permissionRequests.push(o.request);
        const decision = onCanUseTool ? await onCanUseTool(o.request) : { behavior: 'deny', message: 'r151a host: no handler' };
        const response = decision.behavior === 'allow' ? { behavior: 'allow', updatedInput: o.request.input } : { behavior: 'deny', message: decision.message || 'denied by r151a host' };
        send({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response } });
      } else if (o.type === 'control_request') {
        send({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      }
      if (o.type === 'result') { try { child.stdin.end(); } catch { /* */ } }
    }
  });
  child.on('exit', (code) => { clearTimeout(timer); resolveDone(code); });
  send({ type: 'control_request', request_id: 'r151a-init', request: { subtype: 'initialize' } });
  send({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' });
  const exitCode = await done;
  return { lines, permissionRequests, exitCode, timedOut, stderr: stderr.slice(-4000) };
}
