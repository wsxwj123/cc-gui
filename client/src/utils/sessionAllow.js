// "本会话永远允许"白名单能否代为放行一条权限请求(实时广播 useWebSocket 与挂载补拉 PermissionPrompt 两处共用)。
// 不吃白名单:越界访问(blockedPath,沙箱边界不静默扩权);第三方「自动」档上交的调用(服务端标 mustPrompt,r151a 审查 M1)。
export function sessionWhitelistAllows(req, whitelist) {
  return Array.isArray(whitelist) && !!req && whitelist.includes(req.toolName) && !req.blockedPath && req.mustPrompt !== true;
}
