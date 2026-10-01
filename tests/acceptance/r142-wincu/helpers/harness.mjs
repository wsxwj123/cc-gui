// r142-wincu 的实例/端口/HTTP 层。
//
// 端口政策(与既有套件**故意不同**):本套件用 7200-7299。
// 2026-10-01 起另一个代理在 fix/r140-crosstalk 上跑 Playwright,占着 6700-6999;
// 用户实例 6677 / 6689 任何时候都硬拒。杀进程只按记录下来的 pid。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const worktree = path.resolve(process.env.WORKTREE || path.join(suiteDir, '..', '..', '..'));
export const artifacts = path.join(suiteDir, '.artifacts');
export const PORT_RANGE = [7200, 7299];
export const FORBIDDEN = [6677, 6689];

export class EnvironmentBlocked extends Error {
  constructor(msg) { super(`ENVIRONMENT_BLOCKED: ${msg}`); this.name = 'EnvironmentBlocked'; }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requirePort(envName, label) {
  const port = Number(process.env[envName] || 0);
  if (!port) throw new EnvironmentBlocked(`${envName} 未设置(用本套件的 run-isolated.sh 跑,它负责挑空闲端口)`);
  if (FORBIDDEN.includes(port)) throw new EnvironmentBlocked(`端口 ${port} 是用户正在用的实例,硬拒`);
  if (port < PORT_RANGE[0] || port > PORT_RANGE[1]) {
    throw new EnvironmentBlocked(`端口 ${port} 不在本套件保留段 ${PORT_RANGE[0]}-${PORT_RANGE[1]}(${label};6700-6999 归 r140 的套件)`);
  }
  return port;
}
/** 平台:套件按平台跑两遍(win32 / darwin),期望值由 /status.platform 决定,不靠猜。 */
export const platform = () => process.env.CGUI_TEST_PLATFORM || 'win32';
export const apiBase = () => `http://127.0.0.1:${requirePort('CGUI_TEST_API_PORT', 'API 实例')}`;
export const uiBase = () => {
  const base = process.env.CGUI_TEST_UI_BASE;
  if (!base) throw new EnvironmentBlocked('CGUI_TEST_UI_BASE 未设置(UI 用例要跑在 dev server 上,见 run-isolated.sh)');
  requirePort('CGUI_TEST_UI_PORT', 'UI dev server');
  return base;
};

/** 公开 HTTP 面:状态码 + JSON body,起不来/超时就 ENVIRONMENT_BLOCKED。 */
export async function api(pathname, { method = 'GET', body, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase()}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  } catch (error) {
    throw new EnvironmentBlocked(`请求 ${method} ${pathname} 失败:${error.message}(隔离实例还活着吗?)`);
  } finally { clearTimeout(timer); }
}

/** 轮询直到 fn() 为真;返回最后一次结果。 */
export async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do { last = await fn(); if (last) return last; await sleep(intervalMs); } while (Date.now() < deadline);
  return last;
}
