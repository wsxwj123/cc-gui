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

// 不能当审核模型的型号:CLI 遇到它们会无视设置、改用内置默认(调研 Y §1)。
// 规则:转小写后等于或以这两个前缀开头(前缀匹配,所以带日期 / [1m] 的变体同样算)。
const UNUSABLE_AUDITOR_PREFIXES = ['claude-sonnet-5-5', 'claude-opus-5-5'];
export function isUnusableAuditor(name) {
  if (typeof name !== 'string') return false;
  const s = name.toLowerCase();
  return UNUSABLE_AUDITOR_PREFIXES.some((p) => s.startsWith(p));
}

// PUT /api/auto-audit/model 的名字规范化:去首尾空白与结尾的 [1m](不区分大小写),存处理后的名字。
export function normalizeAuditModelName(name) {
  return String(name).trim().replace(/\[1m\]$/i, '').trim();
}

const TIERS = ['haiku', 'sonnet', 'opus', 'fable'];
const tierValue = (tm, t) => (tm && typeof tm === 'object' && typeof tm[t] === 'string' && tm[t] ? tm[t] : '');
// 档位映射里有没有任何一档(值为非空字符串)。
export function hasAnyTier(tm) {
  return TIERS.some((t) => tierValue(tm, t));
}

// 审核模型写入时,覆盖层里该 provider 条目改成什么(只动 sonnet 一档)。
//   prevEntry   覆盖层里该 provider 原有的条目(可缺)
//   effective   切换时实际生效的档位映射(覆盖层的校验后非空 → 它;否则 provider 自带的)
//   ownHasTiers provider 自带的档位映射非空
//   model       已规范化的新值;'' = 清掉 sonnet 档(回到"等于默认模型")
// 覆盖层的 tierModels 一旦存在就整体替换 provider 自带的,只写 sonnet 会把自带的其它档冲掉,
// 所以以"生效的档位"为底改 sonnet 一格后整体写回;defaultModel 等其它键原样保留。
// 清掉后一档不剩:provider 自带有档位 → 写 {}(全部跟随默认模型,压住自带的);否则删掉 tierModels 键。
export function auditModelOverrideEntry(prevEntry, effective, ownHasTiers, model) {
  const entry = prevEntry && typeof prevEntry === 'object' && !Array.isArray(prevEntry) ? { ...prevEntry } : {};
  const tm = {};
  for (const t of TIERS) {
    if (t === 'sonnet') continue;
    const v = tierValue(effective, t);
    if (v) tm[t] = v;
  }
  if (model) tm.sonnet = model;
  if (Object.keys(tm).length) entry.tierModels = tm;
  else if (ownHasTiers) entry.tierModels = {};
  else delete entry.tierModels;
  return entry;
}

// GET /api/auto-audit/status 的应答组装(读文件在 routes/settings.js,这里只拼字段)。
//   official      当前 provider 是否官方端点(调用方按与服务端门控相同的判据算好传入)
//   providerId    当前在用的 provider id;认不出 → null,此时 models 一律 []
//   settingsSonnet settings.json 里 env.ANTHROPIC_DEFAULT_SONNET_MODEL 的值(审核模型 = sonnet 档)
//   sonnetTierSet 该 provider 显式设了 sonnet 档(覆盖层或 provider 自带,口径同切换时的合并)
export function buildAutoAuditStatus({ official, enabled, providerId, models, settingsSonnet, sonnetTierSet }) {
  const id = typeof providerId === 'string' && providerId ? providerId : null;
  const list = id && !official && Array.isArray(models) ? [...new Set(models.filter((m) => typeof m === 'string' && m))] : [];
  const auditModel = !official && typeof settingsSonnet === 'string' && settingsSonnet ? settingsSonnet : null;
  return {
    official: official === true,
    enabled: enabled === true,
    providerId: id,
    auditModel,
    auditModelSource: auditModel === null ? null : (id && sonnetTierSet ? 'tier' : 'default'),
    models: list,
    unusable: list.filter(isUnusableAuditor),
  };
}

// 服务端对 auto 的门控(INTERFACE Y.3.1 末,审查 I3):第三方 + 第三方 auto 总开关没开 + 请求 auto →
// 按 default 起回合,并给出降级信号(应答 permissionModeDowngraded、事件流里带 reason 的 mode_mismatch)。
// 官方端点、或开关开、或请求的不是 auto:原样(与改动前相同)。前端的发送前降级保留,这里是最后一道。
export const THIRD_PARTY_AUTO_DISABLED = 'third-party-auto-disabled';
export function gateAutoPermissionMode(requested, { official, enabled }) {
  if (requested === 'auto' && official !== true && enabled !== true) {
    return { mode: 'default', downgraded: { requested: 'auto', effective: 'default', reason: THIRD_PARTY_AUTO_DISABLED } };
  }
  return { mode: requested, downgraded: null };
}

// 第三方 auto 档下 PreToolUse 回调的判定(T-Y10 ②,方案 Y.1;H10 已实测:返回 ask 后 CLI 把调用交给 canUseTool,
// 审核请求不再发出)。审核判"放行"时 CLI 不回调宿主,GUI 的危险命令强制弹卡在这条路径上失效,所以对命中危险命令
// 规则的 Bash 在这里要求人工确认。官方 / 非 auto 档 / 不危险 → null(回调照旧 continue,与改动前相同)。
export const THIRD_PARTY_AUTO_ASK_REASON = '第三方 provider 的「自动」档下，这类命令需要你确认后才执行。';
export function thirdPartyAutoAskOutput() {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: THIRD_PARTY_AUTO_ASK_REASON } };
}
export function thirdPartyAutoPreToolUse({ thirdParty, mode, dangerous }) {
  if (thirdParty !== true || mode !== 'auto' || dangerous !== true) return null;
  return thirdPartyAutoAskOutput();
}

// 第三方 auto 档下 CLI 上交给 GUI 的调用(含审核连拦后上交)必须由人确认(INTERFACE Y.3.3,审查 M1):
// 权限请求带 mustPrompt,前端"本会话永远允许"白名单遇到它不代为放行。官方 auto 与其它档不带(与改动前相同)。
export function thirdPartyAutoMustPrompt({ thirdParty, mode }) {
  return thirdParty === true && mode === 'auto';
}
