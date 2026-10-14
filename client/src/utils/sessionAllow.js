// "本会话永远允许"白名单能否代为放行一条权限请求。三处共用:实时广播(useWebSocket)、挂载补拉(PermissionPrompt)、
// 勾选白名单时对同会话同工具挂起请求的批量补扫(PermissionPrompt.whitelistAndAllow,经 batchWhitelistTargets)。
// 不吃白名单:越界访问(blockedPath,沙箱边界不静默扩权);第三方「自动」档上交的调用(服务端标 mustPrompt,r151a 审查 M1)。
export function sessionWhitelistAllows(req, whitelist) {
  return Array.isArray(whitelist) && !!req && whitelist.includes(req.toolName) && !req.blockedPath && req.mustPrompt !== true;
}

// 勾选"本会话永远允许 X"时,哪些挂起请求可以随当前这条一并放行:同会话(draft 即 sessionId=null 不补扫,免串放行)、
// 同工具、不是当前这条,且每一条自己也能走白名单(sessionWhitelistAllows),也不是危险命令 —— 危险命令永远逐条确认
// (实时分支里它们先于白名单强制弹卡,这里同口径)。isDangerous 由调用方注入(useWebSocket 的 isDangerousCommand)。
export function batchWhitelistTargets(req, pendingList, isDangerous) {
  if (!req || req.sessionId == null || !Array.isArray(pendingList)) return [];
  return pendingList.filter((p) => !!p && p.id !== req.id && p.sessionId === req.sessionId && p.toolName === req.toolName
    && sessionWhitelistAllows(p, [req.toolName])
    && !(typeof isDangerous === 'function' && isDangerous(p)));
}
