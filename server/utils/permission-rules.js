// canUseTool 的 PermissionResult.updatedPermissions 构造(纯函数,单测覆盖:
// npm run test:permissions)。规则最终由 CLI 自己写入 ~/.claude/settings.json 的
// permissions.allow —— GUI 不直接改文件,与终端 CLI 天然互通(同一存储、同一写入方)。
import { dirname, extname } from 'node:path';

/**
 * "始终允许" → 权限规则更新。
 * 优先采用 SDK 的 suggestions(sdk.d.ts:面向"always allow"场景应整组返回,
 * 是 CLI 官方生成的细粒度规则,如 Bash 前缀规则),但 destination 统一改写为
 * userSettings:CLI 建议默认带 localSettings(项目 .claude/settings.local.json),
 * 与 GUI 卡片"写入 ~/.claude/settings.json"的承诺不符,且设置→权限页只读全局,
 * 落项目级用户就看不到自己批过的规则。只改写 addRules;addDirectories/setMode
 * 等保持原 destination(实测 CLI 建议里附带 addDirectories(cwd, session)——
 * 会话级目录授权,若也改成 userSettings 会把项目目录永久写进全局=越权)。
 * 无建议时按工具回落构造:
 *   Bash     → 精确命令规则 Bash(<command>)(不自行做前缀泛化,泛化交给 SDK 建议)
 *   WebFetch → 域名规则 WebFetch(domain:<host>)
 *   其余     → 裸工具名(与旧"永远允许 <tool>"白名单语义一致)
 * destination=userSettings:写 ~/.claude/settings.json,跨会话、跨 GUI/终端生效。
 */
export function buildAlwaysAllowUpdates(toolName, input, suggestions) {
  if (Array.isArray(suggestions) && suggestions.length) {
    return suggestions.map((s) => (
      (s && s.type === 'addRules') ? { ...s, destination: 'userSettings' } : s
    ));
  }
  const rule = { toolName };
  if (toolName === 'Bash') {
    const cmd = String(input?.command || '').trim();
    if (cmd) rule.ruleContent = cmd;
  } else if (toolName === 'WebFetch') {
    try { rule.ruleContent = 'domain:' + new URL(String(input?.url)).hostname; } catch {}
  }
  return [{ type: 'addRules', rules: [rule], behavior: 'allow', destination: 'userSettings' }];
}

/**
 * 越界路径(blockedPath)→ 目录授权更新。
 * blockedPath 可能是文件也可能是目录:带扩展名视为文件取其父目录,否则视为目录本身
 * (isDir 由调用方按 statSync 传入,单测可直接注入,不依赖真实文件系统)。
 * permanent=true → userSettings(持久写 settings.json 的 additionalDirectories);
 * 否则 session(仅当前 SDK 会话内有效,进程结束即失效)。
 */
export function buildDirAuthUpdates(blockedPath, { permanent = false, isDir = null } = {}) {
  const p = String(blockedPath || '');
  if (!p) return [];
  const asDir = isDir === null ? extname(p) === '' : !!isDir;
  const dir = asDir ? p : dirname(p);
  return [{ type: 'addDirectories', directories: [dir], destination: permanent ? 'userSettings' : 'session' }];
}
