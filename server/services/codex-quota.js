// D-3:本机 codex 的**只读**额度通道。OpenAI 官方没有"读自己用量"的公开接口,但本机
// ChatGPT 应用自带的 codex 是个 app-server,能通过 stdio JSON-RPC 报出**该账户**的
// 额度窗口(account/rateLimits/read)。
//
// 三条铁律(INTERFACE §10.4 + PLAN §10.12③):
//   ① **只读** —— 只调 account/rateLimits/read,不跑任何会产生费用/用量的动作;
//   ② **随用随退** —— 拿到结果(或 15s 超时)立刻 SIGKILL,不常驻、不重试、不缓存进程;
//   ③ **不碰凭证** —— 不读 ~/.codex/auth.json、不读 token,连存在性判断都不做:
//      "没登录"由 codex 自己的错误信息告诉我们(见下),不需要先偷看文件。
//
// 本文件的协议细节全部来自**真跑一次**的实测(V-D4,2026-09-12):
//   握手:`initialize`(带 capabilities.experimentalApi)——**不过这一步任何请求都回
//   `{error:{code:-32600,message:"Not initialized"}}`;`initialized` 通知与 experimentalApi
//   实测都不是必需,但按协议声明。
//   响应:`{id, result:{rateLimits:{...}, rateLimitsByLimitId:{...}, rateLimitResetCredits,
//   accountId}}`(**没有 jsonrpc 字段**);字段是 **camelCase** —— `primary/secondary` 各是
//   `RateLimitWindow{usedPercent, windowDurationMins, resetsAt}`,`limitId`/`limitName`/
//   `planType` 在桶上。⚠️ 二进制里的结构体符号名是 snake_case(`used_percent`),照那个写
//   会**永远解析不出**(这正是"未实测不得写解析"要防的)。
//   未登录:`{error:{code:-32600,message:"codex account authentication required to read
//   rate limits"}}`(用空 CODEX_HOME 实测)。错误信封是 `{id, error:{code,message}}`。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const CODEX_TIMEOUT_MS = 15_000;
const APP_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex';
// 鉴权类错误 → ④b「未登录」。只认这一串里的关键词,其它一律当"通道失败"(④c)——
// 把 ⑤ 的解析失败误报成"没登录"会让用户去白折腾登录。
const AUTH_ERROR_RE = /authenticat|not logged in|unauthoriz|login required/i;

/** codex 可执行文件查找顺序(定死):CODEX_BIN → ChatGPT 应用内置 → PATH。都不在 = null。 */
export function findCodexBin() {
  const cands = [];
  const env = String(process.env.CODEX_BIN || '').trim();
  if (env) cands.push(env);
  cands.push(APP_BIN);
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of String(process.env.PATH || '').split(sep)) {
    if (!dir) continue;
    for (const ext of exts) cands.push(join(dir, `codex${ext}`));
  }
  for (const p of cands) {
    try { if (existsSync(p)) return p; } catch { /* 不可读的目录跳过 */ }
  }
  return null;
}

/**
 * spawn `codex app-server` 跑一次 JSON-RPC 读额度。
 * @returns {Promise<{ok:true, result:object} | {ok:false, code:'not-logged-in'|'failed'}>}
 *   **不抛**(spawn 失败 / 超时 / 启动即退 / 非 JSON 输出都归 failed)。
 */
export function readCodexRateLimits(bin, { timeoutMs = CODEX_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // stdio 三条都显式给:继承会被 Tauri 的"无 console"环境拖死(项目既有教训);
      // stderr 直接丢 —— 它是 codex 自己的日志,没必要读,更没必要落盘。
      child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch { resolve({ ok: false, code: 'failed' }); return; }

    let settled = false;
    let buf = '';
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 随用随退:先关 stdin(礼貌)再 SIGKILL(保证),两条都吞异常 —— 进程可能已经没了。
      try { child.stdin.end(); } catch { /* 已关闭 */ }
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve(out);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'failed' }), timeoutMs);

    child.on('error', () => finish({ ok: false, code: 'failed' }));
    child.on('exit', () => finish({ ok: false, code: 'failed' })); // 没等到 id:2 就退了
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // 不是 JSON 的行(app-server 的通知之外)直接跳
        if (msg.id === 1) {
          // initialize 应答到手才发后续:实测未 initialize 时任何请求都回 "Not initialized"。
          try {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: null })}\n`);
          } catch { finish({ ok: false, code: 'failed' }); }
        } else if (msg.id === 2) {
          if (msg.error) {
            const text = String(msg.error.message || '');
            finish({ ok: false, code: AUTH_ERROR_RE.test(text) ? 'not-logged-in' : 'failed' });
          } else {
            finish({ ok: true, result: msg.result });
          }
        }
      }
    });

    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'claude-gui', title: 'Claude GUI', version: '1.0.0' },
          capabilities: { experimentalApi: true },
        },
      })}\n`);
    } catch { finish({ ok: false, code: 'failed' }); }
  });
}
