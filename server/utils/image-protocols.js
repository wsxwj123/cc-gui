// r16-3 生图:三种同步协议的请求组装 / 响应取图 / 文件名 / 预览路径校验。
//
// 全部是【零 IO 纯函数】(唯一依赖是 path 的纯计算与 safe-path 的 isPathInside),
// 单测直接 import 真函数,不起 server 也不打网络。路由层(routes/image.js)只负责
// fetch、落盘和错误呈现,协议差异一律收在本文件。
//
// 第一版只覆盖三种【同步】形态(openai / gemini / chat)。r82 补上任务制形态('mj'):
// 提交只回 task_id、图要轮询 {base}/tasks/{id} 取。抽象没被拖脏的做法是 —— 本文件仍
// 只出三个纯函数(extractTaskId / buildTaskPollRequest / extractTaskState),等待与下载
// 那套状态机留在 routes/image.js 的 pollTask 里。ComfyUI / Suno / NovelAI 的 zip 仍未做。
import { extname, isAbsolute, resolve } from 'path';
import { isPathInside } from './safe-path.js';
// r87 能力表/取值白名单的唯一副本(纯数据 + 纯函数,前端经再导出共用同一份)。
import {
  IMAGE_RESOLUTIONS, IMAGE_QUALITIES, IMAGE_OUTPUT_FORMATS, IMAGE_BACKGROUNDS,
  IMAGE_MODERATIONS, imageDialect, imageCount, pickEnum, sizeCapFor,
} from './image-caps.js';

export const IMAGE_PROTOCOLS = ['openai', 'gemini', 'chat', 'mj'];

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
 * gemini 的模型列表请求(纯函数):GET {base}/models。认证头与出图同口径 ——
 * 官方端点用 x-goog-api-key、中转站用 Bearer;选错就 401,调用方拿 altHeaders 重试一次。
 * 返回 { url, headers, altHeaders }。
 */
export function geminiModelsRequest(baseURL, apiKey) {
  const base = String(baseURL || '').trim().replace(/\/+$/, '');
  const key = typeof apiKey === 'string' ? apiKey : '';
  // 带真实 User-Agent:node fetch 默认 UA 会被部分 WAF 当机器人挡掉(同 settings.js 的先例)。
  const common = { 'User-Agent': 'claude-gui', Accept: 'application/json' };
  const goog = { ...common, 'x-goog-api-key': key };
  const bearer = { ...common, Authorization: `Bearer ${key}` };
  const official = isOfficialGemini(base);
  return {
    url: `${base}/models`,
    headers: official ? goog : bearer,
    altHeaders: official ? bearer : goog,
  };
}

// r54 图生图:参考图形态 { name, mime, base64 }(路由层已完成读盘/解码/校验,本文件仍零 IO)。
// dataURI 走小写 mime —— 方舟明确要求 `data:image/<小写格式>;base64,<编码>`。
export const I2I_MODES = ['edits', 'generations-image'];
// ───────────────────────── r84 Midjourney 结构化参数的取值范围 ─────────────────────────
// 取值一律来自 apimart 文档 imagine.md「结构化参数」表与其下的版本说明,不是猜的:
//  - 版本:文档原文「线上已验证可用版本:8.2、8.1、7、6.1、5.2、5.1、niji 7、niji 6」。
//    主版本走 body 的 version;Niji 走 niji:true + version:"7"/"6"(计费归一化成 niji7/niji6),
//    即 niji 与 version 【不互斥,是搭配使用】。这里把两者压成一个下拉值,niji 档在
//    mjVersionFields 里拆回两个字段 —— UI 少一个"两个控件必须配对填对"的坑。
//  - 速度:relax(默认) / fast / turbo。
// 空串 = 不指定,该键不下发(由上游取默认)。
// 宽高比形态:两个正整数加冒号(文档示例 16:9 / 1:1 / 9:16)。像素值 1024x1024 不匹配。
export const MJ_RATIO_RE = /^\d+:\d+$/;
export const MJ_VERSIONS = ['8.2', '8.1', '7', '6.1', '5.2', '5.1', 'niji7', 'niji6'];
export const MJ_SPEEDS = ['relax', 'fast', 'turbo'];

/** 版本下拉值 → 下发字段。'niji7' → { niji:true, version:'7' };未知/空值 → {}(不发)。 */
export function mjVersionFields(v) {
  const val = typeof v === 'string' ? v.trim() : '';
  if (!MJ_VERSIONS.includes(val)) return {};
  const niji = val.startsWith('niji');
  return niji ? { niji: true, version: val.slice(4) } : { version: val };
}

// ───────────────────── r84 Midjourney 二次操作(U1–U4 放大选图 / V1–V4 变体) ─────────────────────
// 端点与请求体逐字取自 apimart 文档(证据链见 .devflow/RESEARCH-r84-mj-actions.md §1):
//   POST {base}/midjourney/generations/upscale    {task_id, index, speed?}
//   POST {base}/midjourney/generations/variation  {task_id, index, speed?}
// index ∈ 1..4,对应四宫格的【左上=1 右上=2 左下=3 右下=4】(= 返回的 image_urls 顺序)。
// 提交响应与 imagine 【逐字同形】({code,data:[{status,task_id}]}),所以取图完全复用
// extractTaskId → pollTask → 下载落盘那条既有链路,不另造状态机。
// 刻意【不并入 extra】:extra 是为 imagine 的结构化参数准备的(stylize / chaos / seed…),
// 动作端点不收这些字段,原样转发只会让上游 400 或静默丢弃。
export const MJ_ACTIONS = ['upscale', 'variation'];
export const MJ_ACTION_INDEX_MAX = 4; // 文档:index 必须 1–4,越界上游返回 400

export function buildMjActionRequest(config, action, index, taskId) {
  const cfg = config || {};
  const base = String(cfg.baseURL || '').trim().replace(/\/+$/, '');
  const key = typeof cfg.apiKey === 'string' ? cfg.apiKey : '';
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  const n = Math.floor(Number(index));
  if (!MJ_ACTIONS.includes(action)) throw new Error(`未知的 Midjourney 操作:${action}`);
  if (!base) throw new Error('baseURL 未配置');
  if (!id) throw new Error('缺少上游任务号,无法发起该操作');
  if (!Number.isFinite(n) || n < 1 || n > MJ_ACTION_INDEX_MAX) throw new Error(`只能对第 1–${MJ_ACTION_INDEX_MAX} 张发起该操作`);
  const body = { task_id: id, index: n };
  if (cfg.mjSpeed) body.speed = String(cfg.mjSpeed);
  return {
    // action 已过白名单,不会把路径拼歪(不是拿用户输入直接进 path)。
    url: `${base}/midjourney/generations/${action}`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body,
    form: null,
    altHeaders: null,
  };
}

// ───────────────── r87 OpenAI 系生图参数:上游【方言】与能力表 ─────────────────
// 为什么要有"方言"这一层:同一个 `size` 键在两个上游上【同名反义】——
//   · OpenAI 官方:像素串(`1536x1024`),枚举见官方 Images API 的 CreateImageRequest;
//   · apimart:宽高比串(`16:9`),像素档位另由 `resolution`(1k/2k/4k)控制。
// 同一个模型名(gpt-image-2)在两边语义相反,所以"这个模型支持哪些值"只看模型名是判不了的,
// 必须 (方言, 模型) 二元。方言存在 provider 上(缺省 = 'openai'),新建/编辑时按 baseURL
// host 预选;缺省语义与升级前逐字相同 —— 存量条目零变化。
// 证据链:.devflow/RESEARCH-r87-image-params.md §A-3(apimart 逐字段表)与 §B(官方对照表)。
//
// 能力表与取值白名单的唯一副本在 ./image-caps.js(前端经 client/src/utils/imageSizeCaps.js
// 再导出同一份)。这里原样转出,既有 import 方(routes/image.js、单测)不用改。
export {
  IMAGE_DIALECTS, IMAGE_RESOLUTIONS, IMAGE_QUALITIES, IMAGE_OUTPUT_FORMATS,
  IMAGE_BACKGROUNDS, IMAGE_MODERATIONS, IMAGE_N_MAX, APIMART_RATIOS, SIZE_OPTIONS,
  imageDialect, dialectForBaseURL, imageCount, sizeCapFor, sizeOptionsFor,
} from './image-caps.js';

/**
 * (方言, 模型) → 本次真正该下发的参数值。**下发的唯一门**:buildImageRequest 与报价预估
 * 都走这里,别在别处再判一次。
 *
 * 为什么必须按能力表门控、而不只是"表单里填了什么就发什么":控件是按能力表显隐的,换个
 * 模型控件就消失,但【值还留在 provider 上】。r87 首版只按方言门 resolution/nsfw_check,
 * 于是 gpt-image-2 上设的 quality=low / n=3 在切到 dall-e-3 后照发 —— 官方 dall-e-3 两处
 * 各自 400,而界面上已经没有控件可以清掉它们。门开在这里,存量残值一律发不出去。
 *
 * 逃生口不变:`extra` 仍在 body 之后展开,用户显式写进附加参数的键照发、优先级最高。
 */
export function imageParams(cfg) {
  const dialect = imageDialect(cfg);
  const cap = sizeCapFor(dialect, cfg?.model);
  // 能力表没放开的字段一律当没填。官方方言 + 未登记模型时 cap 为 null(候选回落全量),
  // 此时这几个结构化参数【一个都不发】—— 表单在这种情况下本来就不显示它们,
  // 有值只可能是换模型后的残值;真要发就写进 extra。
  const allows = (f) => !!cap?.fields?.includes(f);
  // resolution 与 nsfw_check 是 apimart 独有键,再加一道方言门:能力表哪天写错了,
  // 官方 API 也不会收到这两个它根本没有的键(t1【方言门】钉的就是这条)。
  const apimartOnly = (f) => dialect === 'apimart' && allows(f);
  return {
    dialect,
    cap,
    allows,
    n: allows('n') ? imageCount(cfg?.n) : 1,
    resolution: apimartOnly('resolution') ? pickEnum(cfg?.resolution, IMAGE_RESOLUTIONS) : '',
    quality: allows('quality') ? pickEnum(cfg?.quality, IMAGE_QUALITIES) : '',
    outputFormat: allows('outputFormat') ? pickEnum(cfg?.outputFormat, IMAGE_OUTPUT_FORMATS) : '',
    background: allows('background') ? pickEnum(cfg?.background, IMAGE_BACKGROUNDS) : '',
    moderation: allows('moderation') ? pickEnum(cfg?.moderation, IMAGE_MODERATIONS) : '',
    nsfwCheck: apimartOnly('nsfwCheck') && cfg?.nsfwCheck === true,
  };
}

// credits / USD 的换算常量。唯一依据是 apimart 官方渠道页成功响应样例里 cost 0.004792 与
// credits_cost 0.047920000000000004 的比值(恰为 10)——【只有一个样例】,所以它只用于
// "预估约",真实花费一律以任务响应里的 credits_cost 为准(见 extractTaskState)。
export const CREDITS_PER_USD = 10;

/**
 * 预估本次出图的 credits。只按调研已【逐位复算命中】的那条公式算:
 *   size_quality_prices["<size>@<resolution>"][quality] × pricing.price_factor × 10
 * (1k 档的键是裸比例、没有 `@1k` 后缀;quality 省略按 auto —— 文档说 auto 通常等同 low,
 *  且价格表里两者同值)。
 *
 * 【宁缺勿错】:任一字段缺失或形态不符一律返回 null,由调用方不显示。别的模型的报价形态
 * (中转渠道的 `resolution_prices` 大写 K 且无 pricing 块、只有 model_price 的按次计费、
 * 只有 model_ratio 的无法定价)本轮都不猜 —— 报价页本身也写明"展示价按 default 分组,
 * 用户真实扣费可能低于展示价",估价天生只能是"约"。
 *
 * @param {object} pricing GET /api/pricing/model 的完整响应体
 * @param {{size?:string, resolution?:string, quality?:string}} cfg
 * @returns {number|null}
 */
export function estimateCredits(pricing, cfg) {
  const size = typeof cfg?.size === 'string' ? cfg.size.trim() : '';
  if (!size) return null;
  const table = pricing?.data?.size_quality_prices;
  if (!table || typeof table !== 'object' || Array.isArray(table)) return null;
  const res = pickEnum(cfg?.resolution, IMAGE_RESOLUTIONS);
  const key = res && res !== '1k' ? `${size}@${res}` : size;
  const row = table[key];
  if (!row || typeof row !== 'object') return null;
  const usd = row[pickEnum(cfg?.quality, IMAGE_QUALITIES) || 'auto'];
  const factor = pricing?.data?.pricing?.price_factor;
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return null;
  if (typeof factor !== 'number' || !Number.isFinite(factor)) return null;
  return usd * factor * CREDITS_PER_USD;
}

function refDataUri(ref) {
  return `data:${String(ref.mime || 'image/png').toLowerCase()};base64,${ref.base64}`;
}
function normRefs(refs) {
  return Array.isArray(refs) ? refs.filter((r) => r && typeof r.base64 === 'string' && r.base64) : [];
}

/**
 * 组装一次生图请求。纯函数:输入 config+prompt(+参考图),输出
 * { url, headers, body, form, altHeaders }。form 非空 = multipart 形态(此时 body 为 null,
 * 且 headers 不带 Content-Type —— 交给 fetch 自己写 boundary)。
 * altHeaders 仅 gemini 非空(认证头回落),其余为 null。
 * config: { protocol, baseURL, apiKey, model, size, extra, i2iMode, mjVersion, mjSpeed,
 *           dialect, resolution, quality, outputFormat, background, moderation, n, nsfwCheck }
 *
 * 红线:refs 为空时,各协议构造出的请求与加本功能之前逐字一致(纯文生图零回归)。
 */
export function buildImageRequest(config, prompt, refs) {
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
  const list = normRefs(refs);

  if (protocol === 'openai') {
    // 图生图两种形态(provider 的 i2iMode 决定,表单只在本协议显示):
    //  - edits(默认):OpenAI 官方 POST {base}/images/edits,multipart。选 multipart 而非
    //    JSON 形态是因为 JSON 的 size 枚举受限(仅 auto/1024 系),multipart 与 generations
    //    同款支持任意 WxH。
    //  - generations-image:方舟/Seedream 没有 edits 端点,图生图 = generations 加 image 字段。
    if (list.length && cfg.i2iMode !== 'generations-image') {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', text);
      if (cfg.size) form.append('size', String(cfg.size));
      for (const r of list) {
        // image[] 重复字段 = 官方多参考图形态(gpt-image 系最多 16 张)。
        form.append('image[]', new Blob([Buffer.from(r.base64, 'base64')], { type: r.mime || 'image/png' }), r.name || 'image.png');
      }
      // extra 是用户自填的透传参数;multipart 里只能是字符串,对象/数组按 JSON 文本发。
      for (const [k, v] of Object.entries(extra)) {
        form.append(k, v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      return {
        url: `${base}/images/edits`,
        headers: { Authorization: `Bearer ${key}` }, // ← 不带 Content-Type:boundary 由 fetch 写
        body: null,
        form,
        altHeaders: null,
      };
    }
    // POST {base}/images/generations。size 只有本协议有原生字段;gpt-image 系恒返 b64
    // 且【不支持 response_format 参数】(传了会 400),所以这里不主动带它,由取图侧兼容两种。
    // r87:n 从硬编码改为可配(未配置/能力表没放开时 imageParams 给 1 → 与升级前逐字一致);
    // 其余结构化参数一律【有值才发】,空值 / 白名单外的值 / 【该模型不支持的键】都不发
    // (发空串 = 显式指定空值)。门在 imageParams 里,见那里的注释。
    const p = imageParams(cfg);
    const body = { model, prompt: text, n: p.n };
    if (cfg.size) body.size = String(cfg.size);
    if (p.resolution) body.resolution = p.resolution;
    if (p.quality) body.quality = p.quality;
    if (p.outputFormat) body.output_format = p.outputFormat;
    if (p.background) body.background = p.background;
    if (p.moderation) body.moderation = p.moderation;
    // 提交前预审(omni-moderation-latest):加钱加延迟,不开就【不发键】而不是发 false。
    if (p.nsfwCheck) body.nsfw_check = true;
    // 方舟形态:image 收 string[](URL 或 dataURI),4.x 最多 14 张。
    if (list.length) body.image = list.map(refDataUri);
    return {
      url: `${base}/images/generations`,
      headers: { ...json, Authorization: `Bearer ${key}` },
      body: { ...body, ...extra },
      form: null,
      altHeaders: null,
    };
  }

  if (protocol === 'gemini') {
    // POST {base}/models/{model}:generateContent。用户可能连 "models/" 前缀一起粘过来。
    // r26-J5:model 进 URL path 必须编码 —— 含空格/斜杠的型号名不编码会把 URL 拼歪
    // (路径注入:model 里的 '/' 会改变请求的实际路径段)。
    const bare = model.replace(/^models\//, '');
    const { generationConfig: extraGen, ...restExtra } = extra;
    // 官方示例顺序:文本 part 在前、inline_data 图 part 在后。
    const parts = [{ text }, ...list.map((r) => ({ inline_data: { mime_type: r.mime || 'image/png', data: r.base64 } }))];
    const body = {
      contents: [{ parts }],
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
      form: null,
      altHeaders: official ? bearer : goog,
    };
  }

  if (protocol === 'mj') {
    // r82 Midjourney(apimart 形态):POST {base}/midjourney/generations —— 异步任务制,
    // 响应只回 task_id,取图靠 routes/image.js 的 pollTask 轮询。
    // 该路由自动注入 model=midjourney(实测不传也过),故 body 不发 model。
    // r84:size / version / speed 三个结构化参数改为下发 —— 文档 imagine.md 的请求体样例
    // 逐字为 {"prompt":"…","size":"16:9","version":"6.1","speed":"fast"},字段语义与取值
    // 范围都是文档明列的,不再属于"未经实测的字段"。size 在本协议是【宽高比】(--ar)
    // 不是像素,UI 已就此改口径。extra 仍在最后展开 = 用户写进附加参数的同名键覆盖表单值
    // (与其余三种协议的 extra 语义一致)。空值一律不发该键,别发空串。
    // ⚠️ 本分支【不使用参考图】(list 有值也不发),UI 已就此给出说明。
    const body = { prompt: text };
    // size 在本协议是【宽高比】(--ar):不是 W:H 形态的值一律【不发】而不是原样透传 ——
    // r82 时该字段不下发,存量 provider 完全可能存着从别的协议抄来的像素值(1024x1024),
    // 升级后原样发出去就成了 --ar 1024x1024。守卫放在协议层这个共同经过点(表单提示只有
    // 打开表单才看得到);静默忽略而不是报错:按默认比例出图比整单失败对用户更好。
    if (MJ_RATIO_RE.test(String(cfg.size || '').trim())) body.size = String(cfg.size).trim();
    Object.assign(body, mjVersionFields(cfg.mjVersion));
    if (cfg.mjSpeed) body.speed = String(cfg.mjSpeed);
    return {
      url: `${base}/midjourney/generations`,
      headers: { ...json, Authorization: `Bearer ${key}` },
      body: { ...body, ...extra },
      form: null,
      altHeaders: null,
    };
  }

  // chat:中转站最常见的"用对话接口出图"。图在回复正文里(markdown / 裸链 / data URL)。
  // 带参考图时 content 换成多模态分片(image_url 是官方语义上的输入),无参考图仍是纯字符串。
  const content = list.length
    ? [{ type: 'text', text }, ...list.map((r) => ({ type: 'image_url', image_url: { url: refDataUri(r) } }))]
    : text;
  return {
    url: `${base}/chat/completions`,
    headers: { ...json, Authorization: `Bearer ${key}` },
    body: { model, messages: [{ role: 'user', content }], ...extra },
    form: null,
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

/** openai 的 data[] 单项 → { mime, base64 } / { mime, url };不是图一律 null。 */
function openaiItem(item, data) {
  if (!item) return null;
  // gpt-image 系恒返 b64_json;dall-e-3 视 response_format 返 b64 或 url → 两种都认。
  if (typeof item.b64_json === 'string' && item.b64_json) {
    const fmt = item.output_format || data?.output_format;
    return { mime: fmt ? `image/${String(fmt).toLowerCase()}` : 'image/png', base64: item.b64_json };
  }
  if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url)) return { mime: '', url: item.url };
  return null;
}

/**
 * 从上游响应对象取【全部】图。纯函数,输出数组(取不到就是空数组)。
 *
 * 为什么必须是数组:`n` 可配之后,openai 【同步】响应会在 data[] 里回 n 张
 * (官方 gpt-image 系 n 最多 10、apimart G2O/G1O 1~4)。r87 之前 n 恒为 1,只取 data[0]
 * 没暴露;n 一放开,取首张 = 后面几张【付了钱不落盘、界面还不吭声】。任务制那条路
 * (polled.urls)本来就是多张,不受影响 —— 所以只测 apimart 会漏掉这个。
 *
 * 上限同样套 MAX_TASK_IMAGES(16):上游说几张就是几张,不设限的后果与任务制那条一样。
 * gemini / chat 的响应形态天生只有一张,包成单元素数组,与 openai 走同一条落盘链。
 */
export function extractImages(protocol, data) {
  if (protocol === 'openai') {
    // 上限在循环里 break,不做事后 slice —— 与 extractTaskState 同款(那边的理由是别把
    // O(n²) 去重先跑完;这边是别把上游给的两万条先 map 出一整个数组来)。
    const out = [];
    for (const item of Array.isArray(data?.data) ? data.data : []) {
      const one = openaiItem(item, data);
      if (!one) continue;
      out.push(one);
      if (out.length >= MAX_TASK_IMAGES) break;
    }
    return out;
  }
  const one = extractImage(protocol, data);
  return one ? [one] : [];
}

/**
 * 取首张。`extractImages` 的薄封装 —— 保留它是因为调用方(与几个单测)只关心"有没有图",
 * 改签名不值当。多张场景一律走 extractImages。
 */
export function extractImage(protocol, data) {
  if (protocol === 'openai') return openaiItem(data?.data?.[0], data);

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

// ───────────────── r82 任务制上游(apimart / Midjourney 形态)的三个纯函数 ─────────────────
// 形态全部取自真机实测响应(.devflow/mj-submit.json、mj-result.json),不按文档臆造。
// 这里只做"认形态",fetch / 等待 / 下载在 routes/image.js 的 pollTask 里(本文件零 IO 不变)。

/**
 * 提交响应里的任务 id:{"code":200,"data":[{"status":"submitted","task_id":"task_…"}]}。
 * 不是这个形态一律返回 null —— 调用方先试 extractImage(同步出图),取不到才试它。
 */
export function extractTaskId(data) {
  const id = data?.data?.[0]?.task_id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * 轮询请求:GET {base}/tasks/{id},鉴权与提交同口径(Bearer)。
 * taskId 来自上游响应,进 URL path 前必须编码 —— 同 gemini 的 model(r26-J5):
 * 不编码时 id 里的 '/' 会改变请求的实际路径段。
 */
export function buildTaskPollRequest(baseURL, apiKey, taskId) {
  const base = String(baseURL || '').trim().replace(/\/+$/, '');
  const key = typeof apiKey === 'string' ? apiKey : '';
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  if (!base) throw new Error('baseURL 未配置');
  if (!id) throw new Error('任务 id 为空');
  return { url: `${base}/tasks/${encodeURIComponent(id)}`, headers: { Authorization: `Bearer ${key}` } };
}

// 一个任务最多取几张图。上游返回的张数是【它说几张就是几张】,不设上限有两处后果:
// ① 去重的 urls.includes 退化成 O(n²) —— 实测 10 万条链接(响应体仅 3.6MB,远在
//    MAX_RESPONSE_BYTES 之内)让单进程后端同步冻住 30 秒,期间聊天流 / 权限弹窗 / WS 全停,
//    这发生在任何下载之前,现有的体积闸与下载闸一个都拦不住;
// ② 拿到后逐张下载,张数与总时长都没有预算(saveImage 的 100 次撞名重试不是上限 ——
//    文件名带秒级时间戳,跨秒即重置)。
// 16 = MJ 实测 4 张的四倍余量。上限必须在拍平循环里 break 掉,事后 slice 是没用的
// (要 slice 的时候 O(n²) 已经跑完了)。
export const MAX_TASK_IMAGES = 16;

/**
 * 轮询响应 → { status:'processing'|'completed'|'failed'|'cancelled', progress, urls, message,
 *             cost, creditsCost }。
 *  - 终态只认 completed / failed / cancelled,【其余一律 processing】(含 pending /
 *    submitted / 未知值):按白名单枚举非终态的话,上游加一档新状态就会被当失败判死。
 *    failed 与 cancelled 分开返回 —— 上游主动取消不是失败,措辞得如实。
 *  - urls 从 result.images[].url[] 拍平 —— url 是【数组】不是字符串(MJ 实测一次 4 张
 *    独立单图);只认 http(s):这个值随后要交给下载分支去请求,别的形态一律不接;
 *    最多取 MAX_TASK_IMAGES 张(见上面的常量注释)。
 *  - progress 取不到时为 null 而不是 0(0 会在界面上显示成"已开始但毫无进展")。
 *  - r87 cost / creditsCost = 上游【实付】(data.cost 金额 / data.credits_cost 积分,文档
 *    「查询任务结果」响应字段表)。取不到一律 null 而不是 0 —— 0 会在界面上显示成"这次免费"。
 *    失败/取消态也带出来:平台侧拦截同样可能已经计费。有实付值就不必自己估价(估价要处理
 *    6 种报价形态 + price_factor 缺失 + 折扣字段歧义,还只能说"约")。
 */
export function extractTaskState(data) {
  const d = data?.data;
  const raw = String(d?.status || '').toLowerCase();
  const n = Number(d?.progress ?? NaN);
  const progress = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  const money = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const cost = money(d?.cost);
  const creditsCost = money(d?.credits_cost);
  // 失败原因三种已知落点(文档 error.message / 顶层 error / MJ 的 fail_reason),取第一个非空。
  const message = [d?.error?.message, data?.error?.message, d?.fail_reason]
    .find((m) => typeof m === 'string' && m.trim()) || '';
  if (raw === 'failed' || raw === 'cancelled') return { status: raw, progress, urls: [], message, cost, creditsCost };
  const urls = [];
  capped:
  for (const img of Array.isArray(d?.result?.images) ? d.result.images : []) {
    const one = img?.url;
    for (const u of Array.isArray(one) ? one : [one]) {
      if (typeof u === 'string' && /^https?:\/\//i.test(u) && !urls.includes(u)) {
        urls.push(u);
        if (urls.length >= MAX_TASK_IMAGES) break capped; // ← 必须在这里断,不是事后 slice
      }
    }
  }
  if (raw === 'completed') return { status: 'completed', progress, urls, message, cost, creditsCost };
  return { status: 'processing', progress, urls: [], message, cost, creditsCost };
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
