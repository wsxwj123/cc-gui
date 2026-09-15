// cu-grant-ui-20260913 的实例/守卫/HTTP 层。铁规(与其它验收套件同口径):
//   · 端口只用保留测试段 6700-6999,硬拒用户正在用的 6677 / 6689;
//   · 杀进程只按**记录下来的 pid**(process.kill),没有 `pkill -f` 那类按名字杀的写法;
//   · 观测只用公开面:HTTP 状态码/响应体、DOM(data-testid/role/公开文案)、grants.json、MCP stdio 回执;
//   · 环境不成立就报 ENVIRONMENT_BLOCKED(用用例的 name 看得见),绝不静默跳过。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const worktree = path.resolve(process.env.WORKTREE || path.join(suiteDir, '..', '..', '..'));
export const artifacts = path.join(suiteDir, '.artifacts');
export const logsDir = path.join(artifacts, 'logs');
export const serverEntry = path.join(worktree, 'server', 'index.js');

export class EnvironmentBlocked extends Error {
  constructor(msg) { super(`ENVIRONMENT_BLOCKED: ${msg}`); this.name = 'EnvironmentBlocked'; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 缺 flag = ENVIRONMENT_BLOCKED(明说缺哪个、为什么需要它),不静默跳过。 */
export function requireFlag(flag, why) {
  if (process.env[flag] !== '1') throw new EnvironmentBlocked(`${flag}=1 是必须的:${why}`);
}

function requirePort(envName, label) {
  const port = Number(process.env[envName] || 0);
  if (!port) throw new EnvironmentBlocked(`${envName} 未设置(用本套件的 run-isolated.sh 跑,它负责挑空闲端口)`);
  if (port === 6677 || port === 6689) throw new EnvironmentBlocked(`端口 ${port} 是用户实例,拒用`);
  if (port < 6700 || port > 6999) throw new EnvironmentBlocked(`端口 ${port} 不在保留测试段 6700-6999(${label})`);
  return port;
}

export const apiBase = () => `http://127.0.0.1:${requirePort('CGUI_TEST_API_PORT', 'API 实例')}`;
export const uiBase = () => {
  const base = process.env.CGUI_TEST_UI_BASE;
  if (!base) throw new EnvironmentBlocked('CGUI_TEST_UI_BASE 未设置(UI 用例要跑在 dev server 上,见 run-isolated.sh --ui)');
  requirePort('CGUI_TEST_UI_PORT', 'UI dev server');
  return base.replace(/\/$/, '');
};

/** 一次 HTTP 请求:状态码 + 解析后的 JSON(非 JSON 时 body=null,text 仍可断言)。 */
export async function api(pathname, { base, method = 'GET', body, headers, timeoutMs = 30_000 } = {}) {
  const res = await fetch(`${base || apiBase()}${pathname}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 非 JSON 也是有效观测 */ }
  return { status: res.status, body: parsed, text };
}

// ───────────────────────── 隔离实例 ─────────────────────────

function ensureHomePrereqs(home) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-gui'), { recursive: true });
  const net = path.join(home, '.claude-gui', 'network.json');
  // 钉成回环:公开版首启会自愈成 0.0.0.0 + 随机密码(写盘 + 可能占用真实端口)
  if (!fs.existsSync(net)) fs.writeFileSync(net, JSON.stringify({ host: '127.0.0.1' }));
}

/** TCP 监听者 pid(端口可能被别的代理/别的套件占着 —— 那台机器上会有人答 /api/health)。 */
function listenerPids(port) {
  const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  return String(out.stdout || '').split('\n').map((l) => Number(l.trim())).filter(Boolean);
}

export async function waitHealthy(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch { /* 还没起来 */ }
    await sleep(150);
  }
  return false;
}

/**
 * 起一个隔离实例。home 默认指到本套件的 .artifacts(绝不碰用户的 ~/.claude、~/.claude-gui);
 * entry/extraEnv 供"坏 helper / 无运行时"那组用例换成受控的副本。
 */
export async function startInstance({ home, port, label = 'instance', entry = serverEntry, extraEnv = {}, cwd } = {}) {
  const p = port || requirePort('CGUI_TEST_API_PORT', 'API 实例');
  if (!home) throw new EnvironmentBlocked('startInstance 需要显式 home');
  ensureHomePrereqs(home);
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `${label}.log`);
  const log = fs.openSync(logPath, 'a');
  const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: String(p), CGUI_DISABLE_FILE_WATCHER: '1', ...extraEnv };
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_')) delete env[k]; // 别把宿主 provider 配置带进去
  let exited = false;
  const proc = spawn(process.execPath, [entry], { cwd: cwd || path.dirname(entry), env, stdio: ['ignore', log, log] });
  proc.on('exit', () => { exited = true; });
  fs.writeSync(log, `\n=== spawn pid=${proc.pid} port=${p} home=${home} label=${label} ${new Date().toISOString()} ===\n`);
  const healthy = await waitHealthy(p, 30_000);
  if (!healthy || exited) {
    try { process.kill(proc.pid, 'SIGKILL'); } catch { /* 已经退了 */ }
    throw new EnvironmentBlocked(`实例起不来(端口 ${p},HOME ${home},进程 ${exited ? '已退出(端口多半被占)' : '没在超时内就绪'});看 ${logPath}`);
  }
  // 端口上答话的必须【就是刚起的这个 pid】:这台机器上并行跑着别的套件,它们也会挑 6700+ 的端口,
  // 只看 /api/health 200 会把别人的实例当成自己的(实测踩过一次:请求全打给了别人的实例)。
  const listeners = listenerPids(p);
  if (!listeners.includes(proc.pid)) {
    try { process.kill(proc.pid, 'SIGKILL'); } catch { /* 已经退了 */ }
    throw new EnvironmentBlocked(`端口 ${p} 上的听众不是刚起的实例(本进程 pid ${proc.pid},实际听众 ${listeners.join(',') || '无'})—— 端口被别人占了,换一个端口重跑`);
  }
  return { pid: proc.pid, port: p, home, label, logPath, base: `http://127.0.0.1:${p}` };
}

/** 只按 pid 杀:先 SIGTERM,4 秒不退再 SIGKILL。 */
export async function stopInstance(inst) {
  if (!inst?.pid) return;
  try { process.kill(inst.pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try { process.kill(inst.pid, 0); } catch { return; }
    await sleep(100);
  }
  try { process.kill(inst.pid, 'SIGKILL'); } catch { /* 已经退了 */ }
  await sleep(200);
}
