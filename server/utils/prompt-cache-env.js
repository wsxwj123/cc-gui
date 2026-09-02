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
//
// 两个键都必须写进 ~/.claude/settings.json 的 env:chat.js 的 stripHostClaudeEnv 会把子进程
// 继承的 CLAUDE_CODE_* / ENABLE_TOOL_SEARCH 整类删掉,写进程 env 是写了个寂寞。
//
// settings.json 与终端 claude / bot 共用 —— 这两个键在终端里同样生效,不是 GUI 私有开关。

export const SNAPSHOT_ENV_KEY = 'CLAUDE_CODE_CARVED_SLATE';
export const TOOL_SEARCH_ENV_KEY = 'ENABLE_TOOL_SEARCH';
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

// 原地改 env,返回新的备忘(memo)。memo 记录用户自己设的 ENABLE_TOOL_SEARCH,
// 关掉本功能 / 切回官方时按原值还回去,不把用户的选择冲掉。
//  memo 形态:{ toolSearch: string | null }(null = 该键原本不存在);null/undefined = 无备忘。
// 返回值:新的 memo(on 时首次记账后保持不变;off 时清空为 null)。
export function applyPromptCacheEnv(env, on, memo) {
  const remembered = (memo && typeof memo === 'object') ? memo : null;
  if (on) {
    // 已有备忘就不重记:否则第二次切第三方会把我们自己写的 'false' 当成用户原值记下来。
    const next = remembered || { toolSearch: TOOL_SEARCH_ENV_KEY in env ? env[TOOL_SEARCH_ENV_KEY] : null };
    env[SNAPSHOT_ENV_KEY] = '1';
    env[TOOL_SEARCH_ENV_KEY] = 'false';
    return next;
  }
  delete env[SNAPSHOT_ENV_KEY];
  // 只在当前值仍是我们写的 'false' 时才还原:用户在第三方下手动把它改回 true,
  // 那是用户的选择,切回官方时不该被备忘覆盖。
  if (remembered && env[TOOL_SEARCH_ENV_KEY] === 'false') {
    if (remembered.toolSearch == null) delete env[TOOL_SEARCH_ENV_KEY];
    else env[TOOL_SEARCH_ENV_KEY] = remembered.toolSearch;
  }
  return null;
}
