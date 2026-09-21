// r123 R3 生图报错分层(纯函数、零 IO):一次失败 → { kind, summary, action }。
//   kind    十类之一(IMAGE_ERROR_KINDS),前端按它选图标/颜色,单测按它断言;
//   summary 一句人话原因(历史条目的 error 字符串以它开头);
//   action  建议动作(条件 + 祈使,不写营销腔);没有可给的动作时为空串。
// 诊断详情(最终地址 / HTTP 状态 / content-type / 正文前 300 字 / 任务号)由调用方组装进 errorInfo.detail,
// 这里只管"这是哪一类、该怎么说"。**任何入参都当作已脱敏的文本**:调用方(routes/image.js 的 failWith)
// 在传进来之前过 redactKey,出去之后再过一次;本文件不知道 key 是什么。
import { suggestBaseURL, collapseDoubleV1 } from './image-url.js';

export const IMAGE_ERROR_KINDS = [
  'base-url', 'auth', 'balance', 'rate-limit', 'moderation',
  'task-failed', 'timeout', 'no-image', 'network', 'other',
];

/** 响应像网页:content-type 是 text/html,或正文首个非空白字符是 <(new-api 系对未知路径回 200 + 首页)。 */
export function looksLikeHtml(contentType, body) {
  if (/text\/html/i.test(String(contentType || ''))) return true;
  return /^\s*</.test(String(body || ''));
}

/** 404 + 正文含 Invalid URL 与 /v1/v1/:基址多写了一层 /v1(new-api / one-api 的 NoRoute 文案)。 */
export function looksLikeDoubleV1(status, body) {
  const b = String(body || '');
  return Number(status) === 404 && /Invalid URL/i.test(b) && /\/v1\/v1\//.test(b);
}

/**
 * 上游正文里"它自己那句话"的摘录(≤160 字,压空白):JSON 形态取 error.message / message / error 字符串,
 * 截断成半截的 JSON 用正则兜 "message":"…";纯文本原样。放进 summary 是为了保留"原文透传"——
 * 「上游拒绝了密钥」之外,用户还需要看到上游说的是 Incorrect API key 还是 model not allowed。
 */
export function upstreamExcerpt(body) {
  const b = String(body || '').trim();
  if (!b) return '';
  let m = '';
  try {
    const j = JSON.parse(b);
    m = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : '') || j?.msg || j?.detail || '';
  } catch {
    const mm = b.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    m = mm ? mm[1] : (/^[[{]/.test(b) ? '' : b);
  }
  return String(m || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}
const withExcerpt = (head, body) => { const x = upstreamExcerpt(body); return x ? `${head}：${x}` : head; };

const BALANCE_RE = /insufficient|余额|quota|欠费|额度不足|credit/i;
const MODERATION_RE = /content_policy|safety|moderation|敏感|违规|blocked by|rejected by the safety/i;

/**
 * @param {object} e
 * @param {number|null} [e.status]      HTTP 状态;没打到对方时为 null
 * @param {string}      [e.contentType] 上游响应的 content-type
 * @param {string}      [e.bodyHead]    上游正文前段(已脱敏)
 * @param {string}      [e.phase]       失败发生在哪一步:network / timeout / html / http / not-json / task-failed /
 *                                      task-cancelled / no-image / download / image-url-rejected / polling-url-cross-origin / other
 * @param {string}      [e.message]     该步骤已经算好的一句话(已脱敏),没有更具体的分类时原样当 summary
 * @param {string}      [e.url]         最终请求地址(网页响应类要写进建议里)
 * @param {string}      [e.baseURL]     提供方基址(算建议基址用)
 * @param {string}      [e.taskId]      上游任务号(任务失败类写进建议里)
 * @returns {{ kind: string, summary: string, action: string }}
 */
export function classifyImageError(e) {
  const { status = null, contentType = '', bodyHead = '', phase = 'other', message = '', url = '', baseURL = '', taskId = '' } = e || {};
  const body = String(bodyHead || '');
  const msg = String(message || '').trim();
  const code = Number.isFinite(Number(status)) && status !== null ? Number(status) : null;

  if (phase === 'network') {
    return { kind: 'network', summary: msg || '连接上游失败', action: '请检查网络、代理设置与基址是否可达' };
  }
  if (phase === 'timeout') {
    return { kind: 'timeout', summary: msg || '等待上游超时', action: '上游任务可能仍在生成，请稍后在该服务的控制台查看，或重试' };
  }
  // 步骤明确的失败先按步骤归类:图片下载 / 任务终态 / 取不到图 / 链接被拒 这些阶段的 content-type
  // 与正文说的是【另一次请求】,不能再套下面「响应像网页 = 基址缺 /v1」的判据。
  if (phase === 'task-failed' || phase === 'task-cancelled') {
    return {
      kind: 'task-failed',
      summary: msg || (phase === 'task-cancelled' ? '上游任务已取消' : '上游任务失败'),
      action: taskId ? `请在该服务的控制台按任务号 ${taskId} 查看详情，或调整提示词后重试` : '请调整提示词后重试，或在该服务的控制台查看任务详情',
    };
  }
  if (phase === 'no-image') {
    return {
      kind: 'no-image',
      summary: msg || '上游响应里没有找到图片',
      action: '请确认该模型会返回图片、协议选择正确；上游正文见诊断详情',
    };
  }
  if (phase === 'download') {
    // 图片链接的下载失败(HTTP 非 2xx / 不是图片 / 网络):按状态码套鉴权规则会误导 —— 图床 403 多半是链接过期,不是密钥问题。
    return { kind: 'network', summary: msg || '下载生成的图片失败', action: '图片链接可能已过期或需要另行鉴权，请重试，或到该服务的控制台下载' };
  }
  if (phase === 'image-url-rejected') {
    return { kind: 'network', summary: `拒绝下载该链接：${msg || '链接不符合出站规则'}`, action: '请检查上游返回的图片链接，或改用会直接返回图片数据（b64）的模型' };
  }
  if (phase === 'polling-url-cross-origin') {
    return { kind: 'other', summary: msg || '上游给出的轮询地址与提供方基址不同源，已拒绝请求', action: '请核对该服务的接口文档，或联系该服务确认轮询地址' };
  }
  // 请求本身的响应(提交 POST / 任务查询):先认网页与 /v1 写重,再按状态码与正文关键词。
  if (phase === 'html' || looksLikeHtml(contentType, body)) {
    return {
      kind: 'base-url',
      summary: '请求打到了网站页面而不是接口（返回的是 HTML）',
      action: `基址多半缺少 /v1：当前请求地址 ${url || '（未知）'}，建议基址改为 ${suggestBaseURL(baseURL)}`,
    };
  }
  if (looksLikeDoubleV1(code, body)) {
    return {
      kind: 'base-url',
      summary: '接口路径里 /v1 写重了（上游返回 404 Invalid URL）',
      action: `请把基址改为 ${collapseDoubleV1(baseURL)}（去掉一层 /v1）`,
    };
  }
  if (code === 401 || code === 403) {
    return { kind: 'auth', summary: withExcerpt(`上游拒绝了密钥（HTTP ${code}）`, body), action: '请检查该提供方的 API key 是否正确、是否有该模型的访问权限' };
  }
  if (code === 402 || BALANCE_RE.test(body) || BALANCE_RE.test(msg)) {
    return { kind: 'balance', summary: withExcerpt(`上游提示余额或配额不足${code ? `（HTTP ${code}）` : ''}`, body), action: '请到该服务的控制台充值或检查配额后重试' };
  }
  if (MODERATION_RE.test(body) || MODERATION_RE.test(msg)) {
    return { kind: 'moderation', summary: withExcerpt(`提示词或结果被上游内容审核拦截${code ? `（HTTP ${code}）` : ''}`, body), action: '请调整提示词后重试' };
  }
  if (code === 429) {
    return { kind: 'rate-limit', summary: withExcerpt('上游限流（HTTP 429）', body), action: '请稍后重试，或降低同时提交的任务数' };
  }
  return {
    kind: 'other',
    summary: msg || (code ? `上游返回 ${code}` : '生成失败'),
    action: '请展开诊断详情查看上游原文；问题持续请联系该服务',
  };
}
