// midjourney-proxy(含 one-api / new-api 原样代理的那些站)方言层:五个零 IO 纯函数。
// 与 apimart(protocol 'mj')的差别只有"路径与 body 键名",提交→轮询→下载那条状态机
// 完全复用 routes/image.js 既有的一份,不另造。
//
// 三处踩过的坑,别回退:
//  ① baseURL 末尾的 `/mj` 要剥掉 —— 各家 README 给的地址就是 https://站点/mj,
//    不剥就打成 /mj/mj/submit/imagine;
//  ② 双鉴权头都要发 —— proxy 原版认 mj-api-secret,经 one-api/new-api 代理时认 Bearer,
//    只发一种就会在另一类站上 401;
//  ③ cost / creditsCost 恒 null 不许写 0 —— 该协议压根不回计费字段,0 会在界面上
//    显示成"这单免费"。
import { compileMjFlags, mjCapsFor } from './mj-params.js';

const MAX_BUTTONS = 32;
const MAX_INDEX = 4;
const MAX_URLS = 16;

/** 规范化 baseURL:去末尾斜杠,再去末尾的 `/mj`(用户按 README 抄的地址就带它)。 */
export function normalizeProxyBaseURL(baseURL) {
  return String(baseURL || '').trim().replace(/\/+$/, '').replace(/\/mj$/i, '').replace(/\/+$/, '');
}

/** 双鉴权头:原版认 mj-api-secret,经中转网关时认 Bearer。发两个比猜一个可靠。 */
function proxyHeaders(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey : '';
  return { 'Content-Type': 'application/json', 'mj-api-secret': key, Authorization: `Bearer ${key}` };
}

const dataUri = (ref) => `data:${String(ref.mime || 'image/png').toLowerCase()};base64,${ref.base64}`;
const roleOf = (r) => (r && typeof r.role === 'string' && r.role ? r.role : 'image');

/**
 * 提交:POST {base}/mj/submit/imagine。
 * 参数一律编译成提示词末尾的 flag;版本 flag(--v/--niji)在这里拼 —— 它是本协议的
 * 承载方式,不是通用参数(apimart 那条走 body.version,见 image-protocols.js)。
 * 垫图固定走 base64Array(该协议没有"换 URL"这一步),URL 垫图当场抛错而不是静默丢。
 */
export function buildProxyImagineRequest(config, prompt, refs) {
  const cfg = config || {};
  const base = normalizeProxyBaseURL(cfg.baseURL);
  const text = String(prompt || '').trim();
  if (!base) throw new Error('baseURL 未配置');
  if (!text) throw new Error('提示词不能为空');

  const version = typeof cfg.mjVersion === 'string' ? cfg.mjVersion.trim() : '';
  const speed = typeof cfg.mjSpeed === 'string' ? cfg.mjSpeed.trim().toLowerCase() : '';
  const list = Array.isArray(refs) ? refs.filter(Boolean) : [];
  const images = list.filter((r) => roleOf(r) === 'image');
  for (const r of images) {
    if (typeof r.base64 !== 'string' || !r.base64) {
      throw new Error('midjourney-proxy 协议的垫图只能是本地图片(以 base64 随请求提交),不接受图片链接');
    }
  }
  const byRole = (role) => list.find((r) => roleOf(r) === role);
  const refFlag = (role) => {
    const hit = byRole(role);
    return hit && typeof hit.url === 'string' ? hit.url : '';
  };
  const weightOf = (role) => {
    const hit = byRole(role);
    return hit && hit.weight !== undefined && hit.weight !== null ? hit.weight : '';
  };
  const compiled = compileMjFlags({
    ...(cfg.mjParams && typeof cfg.mjParams === 'object' ? cfg.mjParams : {}),
    ar: cfg.size,
    iw: images.length ? weightOf('image') : '',
    cref: refFlag('cref'), cw: weightOf('cref'),
    oref: refFlag('oref'), ow: weightOf('oref'),
    sref: refFlag('sref'), sw: weightOf('sref'),
  }, { version, speed, carrier: 'mj-proxy', prompt: text });

  // 版本 flag 与手写优先同口径:提示词里已经有 `--v` / `--niji` 就不再补一个。
  const caps = mjCapsFor(version);
  const has = (f) => new RegExp(`(^|\\s)${f}(\\s|$)`).test(compiled.prompt);
  const versionFlag = !version ? ''
    : caps.niji ? (has('--niji') ? '' : `--niji ${caps.base}`)
      : (has('--v') ? '' : `--v ${caps.base}`);
  const body = { prompt: [compiled.prompt, versionFlag].filter(Boolean).join(' ') };
  if (caps.niji && version) body.botType = 'NIJI_JOURNEY';
  if (speed === 'fast' || speed === 'turbo') body.accountFilter = { modes: [speed.toUpperCase()] };
  if (images.length) body.base64Array = images.map(dataUri);
  return { url: `${base}/mj/submit/imagine`, headers: proxyHeaders(cfg.apiKey), body, form: null, altHeaders: null };
}

/**
 * 提交响应 → { taskId, error }。code 1/21/22 都算受理(21 = 已存在同款任务、22 = 排队中),
 * 其余一律给人话:24 是敏感词、23 是队列满,这两条用户看得懂就能自己改。
 */
export function extractProxySubmitId(data) {
  const code = data && typeof data === 'object' ? data.code : undefined;
  const result = data && typeof data === 'object' ? data.result : undefined;
  const desc = data && typeof data === 'object'
    ? [data.description, data.error, data.message].find((m) => typeof m === 'string' && m.trim()) : '';
  if ([1, 21, 22].includes(code) && typeof result === 'string' && result.trim()) {
    return { taskId: result.trim(), error: null };
  }
  return {
    taskId: null,
    error: `上游未受理该任务${code === undefined ? '' : `(code ${code})`}${desc ? `:${desc}` : ':响应形态不是 midjourney-proxy 的 {code, result}'}`,
  };
}

/** 轮询:GET {base}/mj/task/{id}/fetch。id 进 path 必须编码(含 `/` 会改变路径层级)。 */
export function buildProxyPollRequest(baseURL, apiKey, taskId) {
  const base = normalizeProxyBaseURL(baseURL);
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  if (!base) throw new Error('baseURL 未配置');
  if (!id) throw new Error('任务 id 为空');
  return { url: `${base}/mj/task/${encodeURIComponent(id)}/fetch`, headers: proxyHeaders(apiKey) };
}

/** 上游按钮 → [{customId,label}]:去重、跳过空/非串、截断 32。 */
export function normalizeMjButtons(raw) {
  const out = [];
  const seen = new Set();
  for (const b of Array.isArray(raw) ? raw : []) {
    const customId = b && typeof b.customId === 'string' ? b.customId : '';
    if (!customId || seen.has(customId)) continue;
    seen.add(customId);
    out.push({ customId, label: typeof b.label === 'string' ? b.label : '' });
    if (out.length >= MAX_BUTTONS) break;
  }
  return out;
}

/**
 * 轮询响应 → 恰 7 个键(与既有 extractTaskState 同名同义,但那个是 apimart 形态,
 * 两者【不合并】—— 合并就得在一个函数里塞两套字段名,改一处炸两条链路)。
 * 未知状态一律 processing:proxy 的状态机会加新值,判死会让在跑的任务被标失败。
 */
export function extractProxyTaskState(data) {
  const d = data && typeof data === 'object' ? data : {};
  const raw = String(d.status || '').toUpperCase();
  const pct = String(d.progress ?? '').match(/-?\d+/);
  const progress = pct ? Math.max(0, Math.min(100, parseInt(pct[0], 10))) : null;
  const message = [d.failReason, d.description, d.error].find((m) => typeof m === 'string' && m.trim()) || '';
  const buttons = normalizeMjButtons(d.buttons);
  const base = { progress, message, cost: null, creditsCost: null, buttons };
  if (raw === 'FAILURE') return { status: 'failed', urls: [], ...base };
  if (raw === 'CANCEL' || raw === 'CANCELLED') return { status: 'cancelled', urls: [], ...base };
  if (raw !== 'SUCCESS') return { status: 'processing', urls: [], ...base };
  const urls = [];
  for (const u of [d.imageUrl, ...(Array.isArray(d.imageUrls) ? d.imageUrls : [])]) {
    if (typeof u === 'string' && /^https?:\/\//i.test(u) && !urls.includes(u)) urls.push(u);
    if (urls.length >= MAX_URLS) break;
  }
  return { status: 'completed', urls, ...base };
}

/**
 * 二次操作:plus 版走 /mj/submit/action(customId),原版走 /mj/submit/change(action+index)。
 * 没有 customId 又不是 U/V 的动作一律抛错 —— 原版的 change 只覆盖 1–4 格的放大与变体,
 * 自己拼一个 hash 打过去只会 400 并且可能计费。
 */
export function buildProxyActionRequest(config, action) {
  const cfg = config || {};
  const a = action && typeof action === 'object' ? action : {};
  const base = normalizeProxyBaseURL(cfg.baseURL);
  const taskId = typeof a.taskId === 'string' ? a.taskId.trim() : '';
  const customId = typeof a.customId === 'string' ? a.customId.trim() : '';
  if (!base) throw new Error('baseURL 未配置');
  if (!taskId) throw new Error('缺少上游任务号,无法发起该操作');
  const headers = proxyHeaders(cfg.apiKey);
  if (customId) {
    if (/[\r\n]/.test(customId)) throw new Error('按钮标识非法(含换行)');
    return { url: `${base}/mj/submit/action`, headers, body: { taskId, customId }, form: null, altHeaders: null };
  }
  const change = { pick: 'UPSCALE', variation: 'VARIATION' }[a.kind];
  if (!change) throw new Error(`该中转站不支持这个操作:${a.kind || '未知'}(没有按钮标识时只能做取出单图与变体)`);
  const n = Math.floor(Number(a.index));
  if (!Number.isFinite(n) || n !== Number(a.index) || n < 1 || n > MAX_INDEX) {
    throw new Error(`只能对第 1–${MAX_INDEX} 张发起该操作`);
  }
  return { url: `${base}/mj/submit/change`, headers, body: { taskId, action: change, index: n }, form: null, altHeaders: null };
}
