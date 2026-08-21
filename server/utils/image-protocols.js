// r16-3 生图:三种同步协议的请求组装 / 响应取图 / 文件名 / 预览路径校验。
//
// 全部是【零 IO 纯函数】(唯一依赖是 path 的纯计算与 safe-path 的 isPathInside),
// 单测直接 import 真函数,不起 server 也不打网络。路由层(routes/image.js)只负责
// fetch、落盘和错误呈现,协议差异一律收在本文件。
//
// 第一版只覆盖三种【同步】形态(openai / gemini / chat),异步任务制(ComfyUI 的
// /prompt→/history→/view、MJ、Suno、NovelAI 的 zip)是另一套状态机,留到第二版,
// 硬塞进来会把这三种的抽象拖脏。
import { extname, isAbsolute, resolve } from 'path';
import { isPathInside } from './safe-path.js';

export const IMAGE_PROTOCOLS = ['openai', 'gemini', 'chat'];

// 允许落盘/预览的图片扩展名 → Content-Type。白名单同时是"预览只读图片"的第二道闸:
// savePath 之下的 .env / .json 之类即便路径合法也不给读。
export const IMAGE_CONTENT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif',
};

export function imageExtFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'png'; // 认不出一律 png(生图上游默认输出)
}

// 官方 Gemini 端点判据:认证头按端点形态自动选 —— 官方现推荐 x-goog-api-key,
// 中转站(one-api / new-api 等)多为 Authorization: Bearer。选错就 401,故另给
// altHeaders 让调用方在 401/403 时原样重试一次,而不是一刀切押一种。
function isOfficialGemini(baseURL) {
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return host === 'googleapis.com' || host.endsWith('.googleapis.com');
  } catch { return false; }
}

/**
 * 组装一次生图请求。纯函数:输入 config+prompt,输出 { url, headers, body, altHeaders }。
 * altHeaders 仅 gemini 非空(认证头回落),其余为 null。
 * config: { protocol, baseURL, apiKey, model, size, extra }
 */
export function buildImageRequest(config, prompt) {
  const cfg = config || {};
  const protocol = cfg.protocol;
  const base = String(cfg.baseURL || '').trim().replace(/\/+$/, '');
  const model = String(cfg.model || '').trim();
  const key = typeof cfg.apiKey === 'string' ? cfg.apiKey : '';
  const text = String(prompt || '').trim();
  const extra = cfg.extra && typeof cfg.extra === 'object' && !Array.isArray(cfg.extra) ? cfg.extra : {};
  if (!IMAGE_PROTOCOLS.includes(protocol)) throw new Error(`未知协议:${protocol}`);
  if (!base) throw new Error('baseURL 未配置');
  if (!model) throw new Error('模型未配置');
  if (!text) throw new Error('提示词不能为空');
  const json = { 'Content-Type': 'application/json' };

  if (protocol === 'openai') {
    // POST {base}/images/generations。size 只有本协议有原生字段;gpt-image 系恒返 b64
    // 且【不支持 response_format 参数】(传了会 400),所以这里不主动带它,由取图侧兼容两种。
    const body = { model, prompt: text, n: 1 };
    if (cfg.size) body.size = String(cfg.size);
    return {
      url: `${base}/images/generations`,
      headers: { ...json, Authorization: `Bearer ${key}` },
      body: { ...body, ...extra },
      altHeaders: null,
    };
  }

  if (protocol === 'gemini') {
    // POST {base}/models/{model}:generateContent。用户可能连 "models/" 前缀一起粘过来。
    // r26-J5:model 进 URL path 必须编码 —— 含空格/斜杠的型号名不编码会把 URL 拼歪
    // (路径注入:model 里的 '/' 会改变请求的实际路径段)。
    const bare = model.replace(/^models\//, '');
    const { generationConfig: extraGen, ...restExtra } = extra;
    const body = {
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ['IMAGE'], ...(extraGen && typeof extraGen === 'object' ? extraGen : {}) },
      ...restExtra,
    };
    // size 无原生字段(Gemini 走 imageConfig.aspectRatio),不臆造映射;要传就填 extra。
    const official = isOfficialGemini(base);
    const goog = { ...json, 'x-goog-api-key': key };
    const bearer = { ...json, Authorization: `Bearer ${key}` };
    return {
      url: `${base}/models/${encodeURIComponent(bare)}:generateContent`,
      headers: official ? goog : bearer,
      body,
      altHeaders: official ? bearer : goog,
    };
  }

  // chat:中转站最常见的"用对话接口出图"。图在回复正文里(markdown / 裸链 / data URL)。
  return {
    url: `${base}/chat/completions`,
    headers: { ...json, Authorization: `Bearer ${key}` },
    body: { model, messages: [{ role: 'user', content: text }], ...extra },
    altHeaders: null,
  };
}

// chat 协议的 content 可能是字符串,也可能是多模态分片数组 → 统一压成文本再提取。
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p?.text || p?.image_url?.url || ''))).join('\n');
  }
  return '';
}

/**
 * 从上游响应对象取图。纯函数:输入 protocol + 已解析的响应 JSON,
 * 输出 { mime, base64 } 或 { mime, url };取不到返回 null。
 */
export function extractImage(protocol, data) {
  if (protocol === 'openai') {
    const first = data?.data?.[0];
    if (!first) return null;
    // gpt-image 系恒返 b64_json;dall-e-3 视 response_format 返 b64 或 url → 两种都认。
    if (typeof first.b64_json === 'string' && first.b64_json) {
      const fmt = first.output_format || data?.output_format;
      return { mime: fmt ? `image/${String(fmt).toLowerCase()}` : 'image/png', base64: first.b64_json };
    }
    if (typeof first.url === 'string' && /^https?:\/\//i.test(first.url)) return { mime: '', url: first.url };
    return null;
  }

  if (protocol === 'gemini') {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return null;
    for (const p of parts) {
      // 官方 REST 是 camelCase inlineData;部分中转站回 snake_case,两种都认。
      const inline = p?.inlineData || p?.inline_data;
      const b64 = inline?.data;
      if (typeof b64 === 'string' && b64) {
        return { mime: inline.mimeType || inline.mime_type || 'image/png', base64: b64 };
      }
    }
    return null;
  }

  if (protocol === 'chat') {
    const text = contentToText(data?.choices?.[0]?.message?.content);
    if (!text) return null;
    // data URL 先判:下面两条规则只认 http(s),`![](data:image/...;base64,…)` 这种
    // 只能靠这一条兜住;放最前面也顺带挡住"将来把 markdown 规则放宽成任意 URL"的回归。
    // r26-J12:data 段允许 \s —— 部分上游把 base64 折行(PEM 风格 64 列换行)输出,
    // 不含 \s 的正则碰到折行就整条漏识别;命中后剥空白再解码(下一行的 replace)。
    const dataUrl = text.match(/data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/i);
    if (dataUrl) return { mime: `image/${dataUrl[1].toLowerCase()}`, base64: dataUrl[2].replace(/\s+/g, '') };
    const md = text.match(/!\[[^\]]*\]\(\s*(https?:\/\/[^\s)]+)\s*\)/);
    if (md) return { mime: '', url: md[1] };
    // 裸 URL 必须看着像图片(扩展名白名单)。放开成"任意 URL"会把上游正文里的
    // 说明链接/文档链接当图去下,拿回一坨 HTML 落盘成 .png。
    const bare = text.match(/https?:\/\/[^\s)"'<>]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s)"'<>]*)?/i);
    if (bare) return { mime: '', url: bare[0] };
    return null;
  }

  return null;
}

/** 文件名:{时间戳}-{prompt 前 20 字符 slug}.{ext}。重名由调用方加序号。 */
export function buildImageFileName(prompt, ext, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const slug = String(prompt || '')
    .slice(0, 20)
    // 路径分隔符、`..`、控制字符、空白一律折成 `-`(文件名不能由上游/提示词控形态)。
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const safeExt = IMAGE_CONTENT_TYPES[String(ext || '').toLowerCase()] ? String(ext).toLowerCase() : 'png';
  return `${ts}${slug ? `-${slug}` : ''}.${safeExt}`;
}

/**
 * 预览路径校验:file 必须落在【某个已配置 provider 的 savePath】之下,且是白名单图片扩展名。
 * 通过返回绝对路径,否则返回 null。防的是 `?file=../../.ssh/id_rsa` 这类穿透:
 * 显式拒 `..` 段 + resolve 后前缀比对(isPathInside),两道都过才放行。
 */
export function resolvePreviewPath(file, savePaths) {
  if (typeof file !== 'string' || !file) return null;
  // 只收绝对路径:相对路径会按 server 进程 cwd 解析,语义不可控。
  if (!isAbsolute(file)) return null;
  // 显式拒段:即便前缀比对能兜住,也不接受带 `..` 的输入(少一层"resolve 语义漂移"的风险)。
  if (file.split(/[\\/]+/).some((s) => s === '..')) return null;
  const ext = extname(file).slice(1).toLowerCase();
  if (!IMAGE_CONTENT_TYPES[ext]) return null;
  const full = resolve(file);
  const roots = (Array.isArray(savePaths) ? savePaths : []).filter((d) => typeof d === 'string' && d);
  for (const root of roots) {
    // isPathInside 对同一路径(full === root)也返回 true → 额外要求"真在目录之下"。
    if (full !== resolve(root) && isPathInside(full, root)) return full;
  }
  return null;
}

/**
 * 上游报错原文透传前先剥 key:部分中转站会把请求头/鉴权信息回显在错误里,
 * 原样丢给前端等于把用户密钥打到界面和日志上。
 */
export function redactKey(text, apiKey) {
  let out = String(text ?? '');
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key.length >= 6) out = out.split(key).join('***');
  // 兜底:形如 "Bearer sk-xxx" / "api_key": "xxx" 的回显(key 被上游截断时按字面替换匹配不到)。
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer ***');
  out = out.replace(/(["']?(?:api[-_]?key|x-goog-api-key|authorization)["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{6,}/gi, '$1***');
  return out;
}
