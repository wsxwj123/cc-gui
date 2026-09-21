// R28:官方侧辅助查询(订阅额度 / 官方模型目录)统一走「CLI 自己的能力」。
//
// 【为什么不沿用旧实现】旧 /api/subscription-usage 自己读钥匙串里的订阅 token、自己拼
// curl 请求、还冒充 `User-Agent: claude-code/<ver>` —— 合同明确禁止这三件事
// (「GET不允许直接读订阅token、拼OAuth HTTP或冒充CLI User-Agent」)。现在改为:起一个
// **空消息** 的 SDK 会话,向 CLI 发它自己的控制请求(CLI 自己拿自己的凭证做事),
// GUI 全程不接触任何凭证。
//
// 【为什么没有用户消息也安全】prompt 是一个「永远不吐消息」的 AsyncIterable,CLI 起来后
// 只等控制请求;persistSession:false 不落任何会话 jsonl,cwd 隔离在系统临时目录,
// `skipBehaviors:true` 让 /usage 控制不去扫本机最近七天的转写正文。
//
// 控制方法带 EXPERIMENTAL 后缀的按 SDK 自己的警告只当"实验通道":失败一律转成稳定 code
// 上抛,绝不猜数字。
import { query } from '@anthropic-ai/claude-agent-sdk';
import { cleanChildEnv } from '../routes/chat.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { resolveSdkClaude } from './claude-resolver.js';

export const CLI_TIMEOUT_MS = 15_000;

// 合同里可见的稳定 code 集合(超额部分不上抛,统一落到 CLI_UNAVAILABLE)。
export const CLI_CODES = [
  'CLI_UNAVAILABLE', 'CLI_CAPABILITY_UNAVAILABLE', 'CLI_RESPONSE_INVALID',
  'CLI_RATE_LIMITED', 'NOT_SUBSCRIBED', 'CLI_TIMEOUT',
  'NOT_LOGGED_IN', // r122:CLI 未登录(与 NOT_SUBSCRIBED 区分,见 routes/subscription-usage.js)
];

function cliError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// 隔离工作目录:存在性保证在读取时同步建好(spawn 的 cwd 不存在 = CLI 起不来)。
export const CLI_CWD = join(tmpdir(), 'cgui-official-query');
function cliCwd() {
  try { mkdirSync(CLI_CWD, { recursive: true }); } catch {}
  return CLI_CWD;
}

/**
 * 空消息:控制通道不需要、也不该带任何用户消息。
 * **流必须永不结束** —— 生成器一收尾,SDK 就当作"输入没了"让 CLI 结束这次会话,随后到达
 * 的控制请求全变成 "Query closed before response received"(实测:会结束的空生成器只有在
 * 同一 tick 内发控制请求才侥幸成功,加一个 microtask 就稳定失败)。这里挂一个永不 resolve
 * 的等待,CLI 一直等输入,控制请求随时可发;用完由 withOfficialCli 的 close() 收尾。
 */
function emptyPrompt() {
  return (async function* () { await new Promise(() => {}); })();
}

/** CLI 侧异常 → 合同 code。顺序:sdk 未装/二进制缺失 → 不可用;超时;限流;方法不支持。 */
export function classifyCliError(e) {
  const code = e?.code;
  if (code && CLI_CODES.includes(code)) return code;
  const msg = String(e?.message || e || '');
  if (/native cli binary|not found|ENOENT|spawn|executable/i.test(msg)) return 'CLI_UNAVAILABLE';
  if (/timed? ?out|超时/i.test(msg) || code === 'ABORT_ERR') return 'CLI_TIMEOUT';
  if (/rate.?limit|429|too many requests/i.test(msg)) return 'CLI_RATE_LIMITED';
  if (/unknown (control )?(request|method|subtype)|not supported|unsupported|no such method/i.test(msg)) {
    return 'CLI_CAPABILITY_UNAVAILABLE';
  }
  if (/json|parse|unexpected token|response/i.test(msg)) return 'CLI_RESPONSE_INVALID';
  return 'CLI_UNAVAILABLE';
}

function withTimeout(promise, ms, abort) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { abort.abort(); } catch {}
      reject(cliError('CLI_TIMEOUT', `官方 CLI 控制查询超时(${ms}ms)`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * 起一个空消息 SDK 会话 → 跑 fn(query) → 无论成败都关掉进程。
 * 返回 {ok:true, value} 或 {ok:false, code, message}(message 是可读短句,不含堆栈)。
 */
export async function withOfficialCli(fn, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
  const abort = new AbortController();
  let q = null;
  try {
    const options = {
      prompt: emptyPrompt(),
      options: {
        // 隔离 cwd:不落进任何项目目录,也不让 CLI 读到项目级配置。
        // 【必须同步建目录】spawn 的 cwd 不存在 → CLI 直接起不来(同一个坑在 compact-segment
        // 踩过:异步 mkdir 未 await 就 spawn,首次必失败,第二次才成)。建在 cwd 字段处,
        // 不给调用方留"忘了建"的机会。
        cwd: cliCwd(),
        // plan 档 = CLI 只读档;控制查询不执行任何工具。
        permissionMode: 'plan',
        persistSession: false,
        mcpServers: {},
        strictMcpConfig: true,
        abortController: abort,
        // 与主聊天同一份干净 env:宿主继承来的 ANTHROPIC_*/CLAUDE_CODE_* 会把 CLI 带进
        // 别的会话/别的 provider(实测:带宿主 env 起不来,"ProcessTransport is not ready")。
        // 让 CLI 按它自己的 settings.json + 本地登录态决定认证来源。
        env: cleanChildEnv(),
      },
    };
    // 与主聊天同口径:能用真 claude 可执行文件就用(它带用户实际登录态),否则回落 SDK 自带 CLI。
    const exe = resolveSdkClaude();
    if (exe) options.options.pathToClaudeCodeExecutable = exe;
    q = query(options);
    const value = await withTimeout(Promise.resolve().then(() => fn(q)), timeoutMs, abort);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, code: classifyCliError(e), message: String(e?.message || e).slice(0, 200) };
  } finally {
    // 15 秒超时/异常都要结束这次辅助控制过程(合同:超时结束其辅助控制过程)。
    try { q?.close(); } catch {}
  }
}

/**
 * 账户范围标记:**不含 email / 凭据**。scopeId 只放账户身份的短哈希(同一账户同值、换账户即变),
 * authKind 只放归类后的取值(把 SDK 的 tokenSource 字段名本身也挡在外面 —— 合同禁止
 * accountScope 里出现 token 字样)。
 */
export function accountScopeOf(info) {
  const email = typeof info?.email === 'string' ? info.email.trim().toLowerCase() : '';
  const raw = info?.tokenSource;
  const authKind = raw === 'ANTHROPIC_API_KEY' ? 'api-key'
    : raw === 'apiKeyHelper' ? 'api-key-helper'
      : raw === '/login managed key' ? 'console-managed-key'
        : raw === 'none' ? 'oauth-or-none'
          : typeof raw === 'string' && raw ? 'other' : 'unknown';
  return {
    kind: 'official-cli',
    scopeId: email ? `acct-${simpleHash(email)}` : 'unidentified',
    authKind,
    subscription: typeof info?.subscriptionType === 'string' ? info.subscriptionType : null,
  };
}

function simpleHash(text) {
  // FNV-1a 32bit ×2 段:只需"同一账户同值、换账户即变",不是安全哈希。
  let h1 = 0x811c9dc5; let h2 = 0x1000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x01000193) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

/**
 * 读官方订阅额度(CLI 控制通道)。
 * 返回 {ok:true, value:{scope, subscriptionType, rateLimitsAvailable, rateLimits, fetchedAt}}
 * 或 {ok:false, code, message}。
 */
export async function readOfficialUsage({ timeoutMs = CLI_TIMEOUT_MS } = {}) {
  const res = await withOfficialCli(async (q) => {
    const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    if (!usage || typeof usage !== 'object' || !('rate_limits_available' in usage)) {
      throw cliError('CLI_RESPONSE_INVALID', 'CLI 用量响应缺少 rate_limits_available 字段');
    }
    // 账户身份只用于范围标记;拿不到就标 unidentified(不阻塞额度本身)。
    const account = await q.accountInfo().catch(() => null);
    return { usage, account };
  }, { timeoutMs });
  if (!res.ok) return res;
  return {
    ok: true,
    value: {
      scope: accountScopeOf(res.value.account),
      subscriptionType: res.value.usage.subscription_type ?? null,
      rateLimitsAvailable: res.value.usage.rate_limits_available === true,
      rateLimits: res.value.usage.rate_limits || null,
    },
  };
}

/**
 * 读官方模型目录(CLI 支持的模型清单,ModelInfo 的 value/resolvedModel)。
 * 返回 {ok:true, value:{scope, models:[{value,resolvedModel,...}], fetchedAt}} 或 {ok:false,...}
 */
export async function readOfficialModels({ timeoutMs = CLI_TIMEOUT_MS } = {}) {
  const res = await withOfficialCli(async (q) => {
    const models = await q.supportedModels();
    if (!Array.isArray(models)) throw cliError('CLI_RESPONSE_INVALID', 'CLI 模型目录响应不是数组');
    const account = await q.accountInfo().catch(() => null);
    return { models, account };
  }, { timeoutMs });
  if (!res.ok) return res;
  const models = res.value.models
    .filter((m) => m && typeof m.value === 'string' && m.value)
    .map((m) => ({
      value: m.value,
      resolvedModel: typeof m.resolvedModel === 'string' ? m.resolvedModel : null,
      displayName: typeof m.displayName === 'string' ? m.displayName : m.value,
      aliased: typeof m.resolvedModel === 'string' && m.resolvedModel !== m.value,
    }));
  return { ok: true, value: { scope: accountScopeOf(res.value.account), models } };
}

export { simpleHash };
