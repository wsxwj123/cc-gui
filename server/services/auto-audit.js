// r151a 功能 Y:第三方 provider 下的 auto 审计 —— 判定规则单点。
// 只放纯逻辑(只看入参,不读写文件、不碰进程表),只被别人引用,不引用 routes/chat.js。
// 读文件、落盘、广播都在调用方(routes/chat.js、routes/settings.js、routes/prefs.js)。
import { isOfficialAnthropic } from './model-resolver.js';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// 会话进程环境里要不要注入 CLAUDE_CODE_AUTO_MODE_SERVER(返回要注入的值,或 null = 不注入)。
// 第三方端点用不上 CLI 的服务端审核通道(没有结论 → CLI 本会话改走本地审核),但不关的话首个
// 主请求会带 safeguards 字段(内含家目录、配置目录等本机路径)与一条英文计费提示。所以:
//   settings.json 的 env.ANTHROPIC_BASE_URL 是非官方地址 + 第三方 auto 总开关开 + env 里没写过该键 → "0";
//   其余一律 null(开关关 = 与改动前逐字相同;用户在 settings.json 显式写了就由它自己生效)。
// 官方判据与 provider 切换侧同源(isOfficialAnthropic),不用"有没有 BASE_URL"。
// 不看档位:default 档进程也注入,回合中途切到 auto 不必重建进程(H1 实测:default 档带不带该
// 变量,主请求体、请求头、init 都相同)。
export function autoModeServerInjection(settingsEnv, enabled) {
  if (enabled !== true) return null;
  if (!settingsEnv || typeof settingsEnv !== 'object' || Array.isArray(settingsEnv)) return null;
  const base = settingsEnv.ANTHROPIC_BASE_URL;
  if (typeof base !== 'string' || !base || isOfficialAnthropic(base)) return null;
  if (hasOwn(settingsEnv, 'CLAUDE_CODE_AUTO_MODE_SERVER')) return null;
  return '0';
}
