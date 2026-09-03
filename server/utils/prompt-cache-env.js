// r89 前缀缓存 env:第三方 provider 下把「每轮变化的动态段」冻在原位,让请求前缀逐字稳定。
//
// 依据 .devflow/RESEARCH-r89-prompt-cache.md 的假上游实测(claude CLI 2.1.257):
//  · CLAUDE_CODE_CARVED_SLATE=1 打开 CLI 的静态系统提示快照灰度开关(函数 Rg());GUI 因为
//    composeAppendSystemPrompt 无条件带 append,还必须显式 --system-prompt-snapshot on 才
//    绕过 bHe() 的"有 append 就关快照"门控(两者缺一不可,由 chat.js 补另一半)。
//    实测冷启 + git 状态变化的共享前缀 12.9% → 99.25%,git 变化改以尾部追加的
//    "session context was re-read" 块补发。
//  · ENABLE_TOOL_SEARCH=false 关掉工具搜索:开启时 CLI 只前置装载少量工具,ToolSearch 中途
//    加载会把新工具插进 tools 数组中部并与既有条目换位(不是追加),断点落在 tools 里 →
//    其后的整段对话历史全部失配(实测 99.87% → 70.2%)。
//  · MCP_CONNECTION_NONBLOCKING=false 让 CLI 等所有 MCP server 连上再发首个请求(r90)。
//    默认非阻塞:启动慢的 server(>~2s)未就绪时首请求带占位工具 WaitForMcpServers 且缺
//    该 server 的工具,连上后占位删除、真工具追加 —— tools 数组在 ~80–85% 处两次变形,
//    每次冷启前两个请求各失配整段历史,静态快照管不住(实测)。代价:首条消息要等最慢的
//    MCP server 连上(上限 MCP_CONNECT_TIMEOUT_MS)。
//
// 三个键都必须写进 ~/.claude/settings.json 的 env:chat.js 的 stripHostClaudeEnv 会把子进程
// 继承的 CLAUDE_CODE_* / ENABLE_TOOL_SEARCH / MCP_CONNECTION_NONBLOCKING 整类删掉,写进程
// env 是写了个寂寞。
//
// settings.json 与终端 claude / bot 共用 —— 这三个键在终端里同样生效,不是 GUI 私有开关。

import { execFileSync } from 'node:child_process';
import { claudeExecSpec } from './claude-resolver.js';

export const SNAPSHOT_ENV_KEY = 'CLAUDE_CODE_CARVED_SLATE';
export const TOOL_SEARCH_ENV_KEY = 'ENABLE_TOOL_SEARCH';
export const MCP_NONBLOCKING_ENV_KEY = 'MCP_CONNECTION_NONBLOCKING';
export const PROMPT_CACHE_MODES = ['auto', 'on', 'off'];

export function normalizePromptCacheMode(mode) {
  return PROMPT_CACHE_MODES.includes(mode) ? mode : 'auto';
}

// 三态解析。'auto' = 按 provider 类别:第三方开、官方关(官方端点自己做前缀缓存且
// cache_control 显式断点有效,不需要这套;灰度开关行为可能随 CLI 版本变,少一处风险)。
export function resolvePromptCacheOn(mode, thirdParty) {
  const m = normalizePromptCacheMode(mode);
  if (m === 'on') return true;
  if (m === 'off') return false;
  return !!thirdParty;
}

// 原地改 env,返回新的备忘(memo)。memo 记录用户自己设的 ENABLE_TOOL_SEARCH 与
// MCP_CONNECTION_NONBLOCKING,关掉本功能 / 切回官方时按原值还回去,不把用户的选择冲掉。
//  memo 形态:{ toolSearch, mcpNonblocking }(值为 string | null,null = 该键原本不存在);
//  null/undefined = 无备忘。r89 只记 toolSearch 的旧备忘按缺键补记,不推翻已记的那一项。
// 返回值:新的 memo(on 时首次记账后保持不变;off 时清空为 null)。
export function applyPromptCacheEnv(env, on, memo) {
  const remembered = (memo && typeof memo === 'object') ? memo : null;
  if (on) {
    // 记账两道门,缺一不可:
    //  ① 已记过的键不重记:否则第二次切第三方会把我们自己写的 'false' 当成用户原值记下来。
    //  ② 键已经等于目标值就不记(r100):备忘丢了(prefs.json 被重置/换机拷了 settings.json)
    //     而键还在时,①拦不住 —— 启动重应用每次开机都跑,会把我们自己写的 'false' 记成
    //     "用户原值",用户日后在面板关掉本功能,"还原"出来的就是 false,永久残留。
    //     只在**真要改写这个键**时才记它的改写前值;两道门都不记 = 关闭时按"无原值"处理
    //     (删键、回 CLI 默认),不会把 false 焊死在 settings.json 里。
    const next = { ...(remembered || {}) };
    if (!('toolSearch' in next) && env[TOOL_SEARCH_ENV_KEY] !== 'false') {
      next.toolSearch = TOOL_SEARCH_ENV_KEY in env ? env[TOOL_SEARCH_ENV_KEY] : null;
    }
    if (!('mcpNonblocking' in next) && env[MCP_NONBLOCKING_ENV_KEY] !== 'false') {
      next.mcpNonblocking = MCP_NONBLOCKING_ENV_KEY in env ? env[MCP_NONBLOCKING_ENV_KEY] : null;
    }
    env[SNAPSHOT_ENV_KEY] = '1';
    env[TOOL_SEARCH_ENV_KEY] = 'false';
    env[MCP_NONBLOCKING_ENV_KEY] = 'false';
    return next;
  }
  delete env[SNAPSHOT_ENV_KEY];
  // 只在当前值仍是我们写的 'false' 时才还原:用户在第三方下手动把它改回 true,
  // 那是用户的选择,切回官方时不该被备忘覆盖。
  if (remembered && env[TOOL_SEARCH_ENV_KEY] === 'false') {
    if (remembered.toolSearch == null) delete env[TOOL_SEARCH_ENV_KEY];
    else env[TOOL_SEARCH_ENV_KEY] = remembered.toolSearch;
  }
  if (remembered && env[MCP_NONBLOCKING_ENV_KEY] === 'false') {
    if (remembered.mcpNonblocking == null) delete env[MCP_NONBLOCKING_ENV_KEY];
    else env[MCP_NONBLOCKING_ENV_KEY] = remembered.mcpNonblocking;
  }
  return null;
}

// 备忘是否有实质变化(决定要不要落 prefs.json)。键少,逐键比;两边都是 null/无 也算相等。
export function promptCacheMemoEquals(a, b) {
  if (!a !== !b) return false;
  return (a?.toolSearch ?? null) === (b?.toolSearch ?? null)
    && (a?.mcpNonblocking ?? null) === (b?.mcpNonblocking ?? null);
}

// ── CLI 能力探测 ─────────────────────────────────────────────────────────
// 老 CLI 收到不认识的 flag 会 `error: unknown option` 直接退进程(实测 2.1.252:
// `claude --system-prompt-snapshot on -p hi` 立刻报错退出),而对应的 env 键在老版本上
// 无害。所以 env 照写、flag 必须按版本门控,否则老 CLI 用户一切第三方就全线起不来。
//
// 判据用 `--help` 输出里有没有这个 flag(不能拿 `--flag --help` 试:help 会短路在
// 参数校验之前,老版本照样打出 Usage)。**按二进制路径缓存整份 help 文本**,同一个
// 二进制探多少个 flag 都只跑一次子进程;探测失败/超时一律按「不支持」处理 ——
// 少一半优化远好过让对话起不来。
// ponytail: 进程生命周期内的 Map 缓存,不做 TTL;换 claude 版本要重启 GUI 才重探,
//           与仓内 subscription-usage.js 的 userAgent() 同口径。
const _helpCache = new Map();

// 经 claudeExecSpec 组装:Windows 上 npm 装的 claude.cmd(以及 `where` 给的无扩展名
// shim)不是 Node 能直接执行的文件,裸 execFile 抛 ENOENT/EINVAL → 探测恒失败 →
// 所有按 flag 门控的优化在 Windows 上静默失效(标题瘦身、系统提示快照全不生效)。
function defaultHelpProbe(claudePath) {
  const spec = claudeExecSpec(claudePath, ['--help']);
  return String(execFileSync(spec.file, spec.args, { timeout: 5000, encoding: 'utf8' }));
}

// 通用 flag 探测。flag 传全称(含 `--`)。probe 可注入(单测直接喂 help 文本)。
// 判据两道:① 只认**选项列**(commander 把选项排在缩进 2,描述换行排在缩进 6/40)——
//   2.1.257 的 help 描述里就有 "with --system-prompt)."(缩进 6)和 "--system-prompt or"
//   (缩进 40)这种提及别的选项名的正文,整份 includes 会把它们当成"支持";
// ② 后界断言,避免 `--system-prompt` 被 `--system-prompt-snapshot` 误判成支持。
// 选项行形态:`  --flag`、`  -c, --continue`、`  --allowedTools, --allowed-tools`。
export function cliSupportsFlag(claudePath, flag, probe = defaultHelpProbe) {
  const key = String(claudePath || '');
  if (!_helpCache.has(key)) {
    let help = '';
    try { help = String(probe(key) || ''); } catch { help = ''; }
    _helpCache.set(key, help);
  }
  const help = _helpCache.get(key);
  if (!help) return false;
  const esc = String(flag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^ {1,4}(?:[-\\w]+, )*${esc}(?![\\w-])`, 'm').test(help);
}

export function cliSupportsSnapshotFlag(claudePath, probe = defaultHelpProbe) {
  return cliSupportsFlag(claudePath, '--system-prompt-snapshot', probe);
}

// 该不该给 SDK 加 --system-prompt-snapshot:三个条件缺一不可。
//  ① settings.json 的 CARVED_SLATE 开着(resolveSnapshotOn);
//  ② **claudePath 非空** —— 空 = SDK 回落自带 CLI(claudeCodeVersion 2.1.191,不认这个
//     flag)。Windows 上 npm 装出来的是 %APPDATA%\npm\claude.cmd,resolveSdkClaude 一律
//     返 null,而 PATH 上探到的却是新版 —— 拿新版的能力去喂自带的旧版 = 每一轮
//     `error: unknown option` 直接退进程。**自带二进制本就不支持,不替它猜。**
//  ③ 该路径的 CLI 确实认这个 flag(--help 探测)。
// settings.js 的面板显示口径复用同一个函数,保证"显示支持"与"实际会加"永远一致。
// export 仅为可单测(supports 可注入)。
export function snapshotFlagOn(claudePath, snapshotEnvOn, supports = cliSupportsSnapshotFlag) {
  return !!snapshotEnvOn && !!claudePath && supports(claudePath);
}

// 单测用:清掉探测缓存(生产代码不调用)。
export function _resetSnapFlagCache() { _helpCache.clear(); }
