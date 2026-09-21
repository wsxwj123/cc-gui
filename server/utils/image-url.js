// r123 生图接口地址的纯规则(零依赖、进得了浏览器包):
//   · 各协议的最终请求地址(buildImageRequest 与表单里的「最终请求地址」预览共用这一份,
//     两处各写一份早晚会漂 —— 用户在表单里看到的必须就是服务端真正打出去的);
//   · 保存提供方时的基址规范化(去首尾空白与末尾斜杠、剥掉用户把完整接口地址当基址贴进来的尾段);
//   · 「/v数字」段的判定与建议基址(网页响应 / /v1 写重 两类报错要给建议值,表单要决定是否显示
//     「补 /v1」按钮)。**这里不自动补 /v1**:静默改写等于替用户改配置,只给建议与一键按钮。
// 与 image-caps.js 同款约定:不 import 任何 node 内置模块;前端经 client/src/utils/imageRequestUrl.js 再导出。
import { normalizeProxyBaseURL } from './mj-proxy.js';

/** 去首尾空白与末尾斜杠(所有协议组装请求前的第一步,与 buildImageRequest 逐字同口径)。 */
export const stripBaseURL = (s) => String(s || '').trim().replace(/\/+$/, '');

// 用户把完整接口地址当基址贴进来时要剥掉的尾段(大小写不敏感;末尾斜杠先去掉再比)。
const ENDPOINT_TAILS = /\/(?:images\/generations|images\/edits|chat\/completions)$/i;

/**
 * 保存提供方时的基址规范化:trim → 去末尾斜杠 → 剥接口尾段 → 再去一次末尾斜杠。
 * 只做这三件事;缺 /v1 不补(见文件头)。非字符串一律回空串,由调用方按「baseURL 非法」拒。
 */
export function normalizeImageBaseURL(s) {
  const base = stripBaseURL(s);
  return base.replace(ENDPOINT_TAILS, '').replace(/\/+$/, '');
}

/** 基址路径里是否已有「/v数字…」段(如 /v1、/v2、/v1beta)。只看路径,不看主机名(v2.example.com 不算)。 */
export function hasVersionSegment(baseURL) {
  const s = stripBaseURL(baseURL);
  let path = '';
  try { path = new URL(s).pathname; }
  catch { path = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''); }
  return /\/v\d+[a-z0-9]*(?=\/|$)/i.test(path);
}

/** 上游回网页时的建议基址:没有 /v数字 段就在末尾补 /v1,有就原样。 */
export function suggestBaseURL(baseURL) {
  const base = stripBaseURL(baseURL);
  return hasVersionSegment(base) ? base : `${base}/v1`;
}

/** /v1 写重时的建议基址:把末尾(或紧跟路径分隔前)的一层重复 /v1/v1 收成 /v1;没有重复就原样。 */
export function collapseDoubleV1(baseURL) {
  return stripBaseURL(baseURL).replace(/\/v1\/v1(?=\/|$)/i, '/v1');
}

/**
 * 各协议的最终请求地址(纯字符串规则,不校验协议合法性 —— 那是 buildImageRequest 的事)。
 *   openai   → {base}/images/generations(edits:true 时 {base}/images/edits,图生图 multipart 形态)
 *   chat     → {base}/chat/completions
 *   gemini   → {base}/models/{model}:generateContent(model 剥 models/ 前缀后 encodeURIComponent,r26-J5)
 *   mj       → {base}/midjourney/generations
 *   mj-proxy → {归一后的 base}/mj/submit/imagine(末尾 /mj 先去掉,见 normalizeProxyBaseURL)
 * base 为空一律回空串(表单还没填基址时预览不显示半截路径)。
 */
export function imageRequestURL(protocol, baseURL, model, { edits = false } = {}) {
  const base = stripBaseURL(baseURL);
  if (!base) return '';
  if (protocol === 'openai') return `${base}/images/${edits ? 'edits' : 'generations'}`;
  if (protocol === 'chat') return `${base}/chat/completions`;
  if (protocol === 'gemini') {
    const bare = String(model || '').trim().replace(/^models\//, '');
    return `${base}/models/${encodeURIComponent(bare)}:generateContent`;
  }
  if (protocol === 'mj') return `${base}/midjourney/generations`;
  if (protocol === 'mj-proxy') {
    const proxyBase = normalizeProxyBaseURL(base);
    return proxyBase ? `${proxyBase}/mj/submit/imagine` : '';
  }
  return '';
}

/** 表单预览用:文生图形态的最终请求地址(与 imageRequestURL 同一份规则,只是不带 edits 分支)。 */
export const previewImageRequestURL = (protocol, baseURL, model) => imageRequestURL(protocol, baseURL, model);
