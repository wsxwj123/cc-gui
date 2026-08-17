// r10-10:官方订阅登录态指引(切官方预检 warning + chat 错误匹配共用)。
// 根因见 PLAN §0.10:钥匙串条目在但 token 空 → CLI 报 Not logged in,GUI 只做预检+指引。

export const OFFICIAL_LOGIN_HINT = '未检测到订阅登录,请在终端运行 claude /login 后重试';

// chat 错误文本是否为"官方订阅未登录/登录过期"类(需补登录指引)。
export function matchOfficialLoginError(text) {
  return /OAuth session expired|Not logged in|Please run \/login/i.test(String(text || ''));
}

// 切 provider 响应带 warning:'oauth-missing' → 通知全局横幅(App 顶层监听)。
// 各切换调用点(SessionSelectors/App 内多处)统一走这一个入口。
export function notifyOauthMissing(resp) {
  if (resp && resp.warning === 'oauth-missing') {
    window.dispatchEvent(new CustomEvent('cgui:oauth-missing'));
  }
}
