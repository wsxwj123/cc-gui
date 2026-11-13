// r176:接口报错下方该挂哪种动作、补哪几条提示 —— 报错分支(本地副本)与历史回合共用这一份判据。
//
// 判据原样搬自 App.jsx 报错分支,不放宽:
//   - 内容审核:classifyUpstreamRefusal(contentRisk.js);
//   - 鉴权:报错文字命中下面的正则,或结构化标记(命令行落盘的 apiErrorStatus 401 / 403、
//     类别 authentication_failed)命中;
//   - 空内容块:报错文字命中 must be non-empty / non-whitespace thinking
//     (与服务端 server/routes/chat.js 的 matchOfficialEmptyBlockError 同判据,改一处必须同步另一处);
//   - 优先级:内容审核 > 鉴权 > 空内容块。
// 三条补充提示(1M、官方未登录、签名)的判据与文案也照搬报错分支。
import { classifyUpstreamRefusal } from './contentRisk.js';
import { OFFICIAL_LOGIN_HINT, matchOfficialLoginError } from './officialAuth.js';

const AUTH_TEXT_RE = /\b401\b|unauthorized|authenticat|api[ -_]?key|x-api-key/i;
const EMPTY_BLOCK_RE = /must be non-empty|non-whitespace thinking/i;
// (?<![$￥]) 排除 "$1m budget" 这类金额文案的误命中。
const ONE_M_RE = /(?<![$￥])\b1m\b|\[1m\]|long context|context length|1000000|1,000,000/i;
const SIGNATURE_RE = /invalid\W+signature\W+in\W+thinking\W+block/i;

export const ONE_M_HINT = '该会话被识别为 1M 上下文；若账户不支持,请在模型弹层关闭 1M 后重试。';
export const SIGNATURE_HINT = '会话历史里有其他模型留下的思考内容，当前接口不接受。切回原来的 provider,在此会话执行 /compact 后再切回;或新开会话。';
export const LOGIN_HINT = `${OFFICIAL_LOGIN_HINT}。`;

// r178:命令行内部诊断串 `[ede_diagnostic] result_type=… last_content_type=… stop_reason=…` 的中文说明。
// 类型名来自上游(外部数据),只接受 [A-Za-z0-9_-]{1,40},不合规就用通用说法,不把原串拼进文案。
// 说明文字里不得出现诊断串的标记词本身(验收按它计数)。
// 解析不在整段报错上跑正则(外部可控的超长输入会让带回溯的写法变成平方级):先截一个短窗口
// —— `last_content_type=` 之后、第一个换行之前、最多 EDE_TYPE_WINDOW 个字符 —— 只在窗口里按空白
// 切词,遇到下一个 `键=` 词为止;原值超出窗口(被截断、窗口里没遇到下一个键)按不合规处理。
const EDE_RE = /\[ede_diagnostic\]/;
const EDE_TYPE_KEY = 'last_content_type=';
const EDE_TYPE_WINDOW = 80;
const EDE_NEXT_KEY_RE = /^[A-Za-z_]+=/;
const EDE_TYPE_OK_RE = /^[A-Za-z0-9_-]{1,40}$/;
// 返回类型名;没有该字段返回 undefined;被截断返回 null(按不合规处理)。
function edeContentType(msg) {
  const at = msg.indexOf(EDE_TYPE_KEY);
  if (at < 0) return undefined;
  const rest = msg.slice(at + EDE_TYPE_KEY.length, at + EDE_TYPE_KEY.length + EDE_TYPE_WINDOW + 1);
  const nl = rest.indexOf('\n');
  const line = nl >= 0 ? rest.slice(0, nl) : rest;
  const truncated = line.length > EDE_TYPE_WINDOW;
  const win = truncated ? line.slice(0, EDE_TYPE_WINDOW) : line;
  const parts = win.split(/(\s+)/); // 保留分隔的空白,值里的空白原样留下
  let value = '';
  for (let i = 0; i < parts.length; i += 2) {
    if (i > 0 && EDE_NEXT_KEY_RE.test(parts[i])) return value.replace(/\s+$/, '');
    value += parts[i] + (parts[i + 1] || '');
  }
  return truncated ? null : value.replace(/\s+$/, '');
}
export const EDE_EMPTY_HINT = '上游返回了内容为空的回复,命令行重试一次后仍为空,本轮结束。中转站出错但按成功返回时会这样(余额不足、限流、模型名不受支持等)。稍后重试,或换模型、换 Provider。';
export function edeUnknownTypeHint(type) {
  return `上游返回了命令行无法识别的内容类型(${type}),本轮结束。该 Provider 的返回格式与 Claude Code 不兼容,换模型或换 Provider。`;
}
// 有该字段、但类型名不合规或被截断时的说明(不带类型名,不拼原串)。
export const EDE_UNKNOWN_HINT = '上游返回了命令行无法识别的内容,本轮结束。该 Provider 的返回格式与 Claude Code 不兼容,换模型或换 Provider。';
const EDE_RESULT_KEY = 'result_type=assistant';
// 子串查找:`result_type=assistant` 后面是空白或结尾才算(不用带回溯的正则)。
function hasAssistantResultType(msg) {
  for (let at = msg.indexOf(EDE_RESULT_KEY); at >= 0; at = msg.indexOf(EDE_RESULT_KEY, at + 1)) {
    const next = msg.charAt(at + EDE_RESULT_KEY.length);
    if (next === '' || /\s/.test(next)) return true;
  }
  return false;
}
// 只解释取样验证过的形态:[ede_diagnostic] + result_type=assistant + last_content_type 字段;
// 其余形态不加说明,原文照显(不猜)。
function edeHint(msg) {
  if (!EDE_RE.test(msg) || !hasAssistantResultType(msg)) return null;
  const type = edeContentType(msg);
  if (type === undefined) return null;
  if (type === 'none') return EDE_EMPTY_HINT;
  if (type === null || !EDE_TYPE_OK_RE.test(type)) return EDE_UNKNOWN_HINT;
  return edeUnknownTypeHint(type);
}

function markerSaysAuth(marker) {
  if (!marker || typeof marker !== 'object') return false;
  return marker.status === 401 || marker.status === 403 || marker.kind === 'authentication_failed';
}

// 输入:报错文字 + 可选结构化标记 { status, kind }。
// 输出:{ action: 'content-risk' | 'provider' | 'repair-official' | null, hints: string[] }。
// hints 的顺序固定为 1M、官方未登录、签名(与报错分支拼接顺序一致),r178 的诊断串说明排在最后。
export function deriveApiErrorUi(text, marker = null) {
  const msg = String(text || '');
  const risk = classifyUpstreamRefusal(msg);
  const isAuth = AUTH_TEXT_RE.test(msg) || markerSaysAuth(marker);
  const isEmptyBlock = EMPTY_BLOCK_RE.test(msg);
  const action = risk ? 'content-risk' : isAuth ? 'provider' : isEmptyBlock ? 'repair-official' : null;
  const hints = [];
  if (ONE_M_RE.test(msg)) hints.push(ONE_M_HINT);
  if (matchOfficialLoginError(msg)) hints.push(LOGIN_HINT);
  if (SIGNATURE_RE.test(msg)) hints.push(SIGNATURE_HINT);
  const ede = edeHint(msg);
  if (ede) hints.push(ede);
  return { action, hints };
}

// 原先拼到本地 ❌ 块正文后面的那段(每条前面空一行、以 "> " 引用)。r183 起 App.jsx 不再使用
// (提示改走 errorHints 结构化渲染);tests/unit/check-r176-api-error-ui.mjs 仍钉着它的输出,保留。
export function hintsAsQuoteSuffix(hints) {
  return (hints || []).map((h) => `\n\n> ${h}`).join('');
}

// 报错分支要不要省掉本地 ❌ 块:只有这次的报错原文确实已在本回合累积正文里才省。
//   - 本回合出现过命令行的合成报错消息:累积正文包含这次的报错原文 → 省;
//     (同一回合后来又来一条原文不同的报错,例如进程异常退出,照旧画 ❌ 块,不被省掉)
//   - 没出现过合成报错:累积正文与报错原文完全相等 → 省;
//   - 累积正文为空或报错原文为空 → 不省(本回合副本要有正文才会 push)。
// 两边都先去首尾空白。
export function shouldSkipLocalErrorBlock(accText, errText, sawApiErrorMessage) {
  const acc = String(accText || '').trim();
  const err = String(errText || '').trim();
  if (!acc || !err) return false;
  return sawApiErrorMessage ? acc.includes(err) : acc === err;
}

// 历史回合是不是「接口报错消息」:有后端带出的 apiError 标记;没有标记的老会话文件按
// model === '<synthetic>' 兜底。普通助手回合即使正文含 401 / api key 也不算。
export function isApiErrorTurn(turn) {
  if (!turn || turn.type !== 'turn') return false;
  if (turn.apiError && typeof turn.apiError === 'object') return true;
  return turn.model === '<synthetic>';
}

// 只取报错原文喂判据,不取整个回合的文字:同一回合前面可能有正常正文,里面的「API key」
// 「must be non-empty」「Content Exists Risk」字样会让判据放宽(上游 500 误挂「检查 Provider
// 设置」,误挂会改写会话文件的回退 / 清理入口)。
//   - 有后端标记:用标记里带出的那条合成消息自己的原文(apiError.text);
//   - 老会话文件无标记、按 <synthetic> 兜底:取回合最后一段文字。这条兜底到得了 ——
//     session-reader 在合成消息是该回合第一条助手行时用它的 model 建回合(建回合那处不跳过
//     「<」开头的模型名,只有后续的「last one wins」更新才跳过),所以 model 会是 <synthetic>;
//     报错是回合最后写下的那一条,最后一段就是它。
function errorTextOf(turn) {
  if (turn.apiError && typeof turn.apiError === 'object') {
    return typeof turn.apiError.text === 'string' ? turn.apiError.text : '';
  }
  if (Array.isArray(turn.text) && turn.text.length) return String(turn.text[turn.text.length - 1] || '');
  if (Array.isArray(turn.blocks)) {
    const texts = turn.blocks.filter((b) => b && b.type === 'text');
    return texts.length ? String(texts[texts.length - 1].content || '') : '';
  }
  return '';
}

// r183:回合里哪几段文字是报错原文(要原样显示,不交给 Markdown)。texts 是该回合的文字段数组。
//   - 有后端标记:内容(去首尾空白)等于 apiError.text 的那几段;标记里没有原文 → 一段都不算;
//   - 老会话文件无标记、按 <synthetic> 兜底:最后一段非空文字(与 errorTextOf 同口径);
//   - 普通回合:一段都不算。
// 返回下标集合。
export function errorTextIndexes(turn, texts) {
  const out = new Set();
  if (!isApiErrorTurn(turn) || !Array.isArray(texts)) return out;
  if (turn.apiError && typeof turn.apiError === 'object') {
    const want = typeof turn.apiError.text === 'string' ? turn.apiError.text.trim() : '';
    if (!want) return out;
    texts.forEach((t, i) => { if (typeof t === 'string' && t.trim() === want) out.add(i); });
    return out;
  }
  for (let i = texts.length - 1; i >= 0; i--) {
    if (typeof texts[i] === 'string' && texts[i]) { out.add(i); break; }
  }
  return out;
}

// r183:给回合的 blocks 打上报错原文标记(errorText),供 TurnBubble 选择渲染方式。
//   - 已有块带标记(本地 ❌ 块、流式时按 is_api_error_message 打的)→ 原样返回;
//   - 否则按 errorTextIndexes 在 text 块里找(历史回合);找不到 → 原样返回(同一引用)。
// 只加标记字段,不改 content,不增删块(正文指纹等按块内容算的判据输入不变)。
export function markErrorTextBlocks(turn) {
  const blocks = turn?.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return blocks;
  if (blocks.some((b) => b && b.errorText)) return blocks;
  const texts = blocks.map((b) => (b && b.type === 'text' ? String(b.content || '') : null));
  const hit = errorTextIndexes(turn, texts);
  if (hit.size === 0) return blocks;
  return blocks.map((b, i) => (hit.has(i) ? { ...b, errorText: true } : b));
}

// 历史列表 → 最后一个回合要挂的动作与提示(没有则 null)。
// 只看会话里最后一条用户消息 / 回合:最后一条是用户消息(之后还没回复)或普通回合,都不派生;
// 之前的报错回合一律不派生(之后对话成功了,旧报错下面不再挂按钮)。
export function deriveHistoryApiErrorUi(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.type === 'user') return null;
    if (m.type !== 'turn') continue;
    if (!isApiErrorTurn(m)) return null;
    const ui = deriveApiErrorUi(errorTextOf(m), m.apiError || null);
    if (!ui.action && ui.hints.length === 0) return null;
    return { ...ui, uuid: m.uuid || null };
  }
  return null;
}
