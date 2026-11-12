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

function markerSaysAuth(marker) {
  if (!marker || typeof marker !== 'object') return false;
  return marker.status === 401 || marker.status === 403 || marker.kind === 'authentication_failed';
}

// 输入:报错文字 + 可选结构化标记 { status, kind }。
// 输出:{ action: 'content-risk' | 'provider' | 'repair-official' | null, hints: string[] }。
// hints 的顺序固定为 1M、官方未登录、签名(与报错分支拼接顺序一致)。
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
  return { action, hints };
}

// 报错分支里拼到本地 ❌ 块正文后面的那段(与改动前逐字相同:每条前面空一行、以 "> " 引用)。
export function hintsAsQuoteSuffix(hints) {
  return (hints || []).map((h) => `\n\n> ${h}`).join('');
}

// 历史回合是不是「接口报错消息」:有后端带出的 apiError 标记;没有标记的老会话文件按
// model === '<synthetic>' 兜底。普通助手回合即使正文含 401 / api key 也不算。
export function isApiErrorTurn(turn) {
  if (!turn || turn.type !== 'turn') return false;
  if (turn.apiError && typeof turn.apiError === 'object') return true;
  return turn.model === '<synthetic>';
}

function turnText(turn) {
  if (Array.isArray(turn.text) && turn.text.length) return turn.text.join('\n');
  if (Array.isArray(turn.blocks)) {
    return turn.blocks.filter((b) => b && b.type === 'text').map((b) => b.content || '').join('\n');
  }
  return '';
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
    const ui = deriveApiErrorUi(turnText(m), m.apiError || null);
    if (!ui.action && ui.hints.length === 0) return null;
    return { ...ui, uuid: m.uuid || null };
  }
  return null;
}
