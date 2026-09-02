// r16-3 生图面板的后端:自定义生图 provider 的 CRUD + 出图 + 预览回源。
//
// 与文本 provider 完全分开:配置独立落 ~/.claude-gui/image-providers.json,
// 【绝不写 ~/.claude/settings.json】(CLI 的 env 与生图无关,混进去只会污染会话)。
// 协议差异全在 utils/image-protocols.js 的纯函数里,本文件只做 fetch / 落盘 / 错误呈现。
import { Router } from 'express';
import { realpathSync } from 'node:fs';
import { isPathInside } from '../utils/safe-path.js';
import { readFile, writeFile, mkdir, rename, unlink, stat, access } from 'fs/promises';
import { constants } from 'fs';
import { join, isAbsolute, basename } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import {
  IMAGE_PROTOCOLS, IMAGE_CONTENT_TYPES, I2I_MODES, buildImageRequest, extractImage,
  buildImageFileName, imageExtFromMime, resolvePreviewPath, redactKey,
  geminiModelsRequest, extractTaskId, buildTaskPollRequest, extractTaskState,
  MJ_VERSIONS, MJ_SPEEDS, MJ_RATIO_RE, buildMjActionRequest,
  IMAGE_DIALECTS, IMAGE_RESOLUTIONS, IMAGE_QUALITIES, IMAGE_OUTPUT_FORMATS,
  IMAGE_BACKGROUNDS, IMAGE_MODERATIONS, IMAGE_N_MAX, imageDialect, estimateCredits,
} from '../utils/image-protocols.js';
import { readCapped } from '../utils/read-capped.js';
// r56 按 provider 生图代理:生图链路的三处外联(生成 POST / 图片下载 / 拉模型)统一
// 改走 undici 的 fetch(它是 Node 全局 fetch 的同源实现,AbortSignal / redirect:'manual' /
// 读流语义相同),不传 dispatcher 就是直连,传了才走代理。刻意【不】按"有无代理二选一"
// 用两种 fetch:同一条安全链路挂两套网络栈,以后任何一处改动都要验两遍。
// ⚠️ 唯一实测不等价处:本包的 fetch 不认 Node 内建的 FormData(见下面 runImageJob 里的
// multipart 预序列化),别把 FormData 直接交给它。
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { assertPublicBaseURL, probeUpstreamModels } from './settings.js';

const router = Router();

// 代理池:同一个 proxyUrl 复用一个 ProxyAgent(每次新建 = 每次新连接池,连接不复用)。
// 上限 8 条,超了淘汰最久未用的那条并关掉它的连接池(Map 迭代序 = 插入序,命中时
// 删了再插 = 挪到队尾,于是队头恒为最久未用)。
const MAX_PROXY_AGENTS = 8;
const proxyAgents = new Map();
function proxyAgentFor(proxyUrl) {
  const key = typeof proxyUrl === 'string' ? proxyUrl.trim() : '';
  if (!key) return null;
  const hit = proxyAgents.get(key);
  if (hit) { proxyAgents.delete(key); proxyAgents.set(key, hit); return hit; }
  let agent;
  try { agent = new ProxyAgent(key); }
  catch { return null; } // 代理地址已在保存时校验过;这里再坏也只是回落直连,不让生成整个崩掉
  proxyAgents.set(key, agent);
  if (proxyAgents.size > MAX_PROXY_AGENTS) {
    const oldest = proxyAgents.keys().next().value;
    const dead = proxyAgents.get(oldest);
    proxyAgents.delete(oldest);
    try { dead?.close?.()?.catch?.(() => {}); } catch { /* 关不掉就交给 GC */ }
  }
  return agent;
}

/** provider → fetch 选项片段:配了代理就带 dispatcher,没配就是空对象(与原先逐字一致)。 */
function dispatchOpts(proxyUrl) {
  const agent = proxyAgentFor(proxyUrl);
  return agent ? { dispatcher: agent } : {};
}

// r57 兜底:第三方 fetch 实现的 Node 地板一旦高于 app 地板(20),import 会成功、启动不报警,
// 但 fetch() 第一句就抛 TypeError(undici@8 调 Promise.withResolvers,Node 22+ 才有)——
// 三处外联全死,还被归类成"连接上游失败"让用户白查网络。依赖侧已把 undici 锁回 ^7
// (engines >=20.18.1,与 app 地板对齐),这条判据只为将来再踩时如实点名真因。
// 注:AbortSignal.any 需 Node ≥20.3,在 app 地板之内,无需同类兜底。
// export 仅为单测:真踩地板的形态只能靠伪造 TypeError 复现。
export function nodeFloorHint(e) {
  return e instanceof TypeError && /withResolvers|not a function/.test(e?.message || '')
    ? '当前 Node 版本过低（生图需 Node ≥20.18），请升级 Node 后重试'
    : null;
}

// 路径按调用取(不在模块顶层固化):单测把 HOME 指向 mktemp 目录后再 import 也能生效,
// 真实 HOME 一个字节都不碰。
function imageProvidersPath() {
  return join(homedir(), '.claude-gui', 'image-providers.json');
}

// 生图比文本慢得多。允许被环境变量下调:单测要在秒级验证「上游超时 ≠ 用户取消」
// (两者抛出的异常形态相同),不设该变量时恒为 120s,产品行为一字不变。
const GENERATE_TIMEOUT_MS = Number(process.env.CGUI_IMAGE_GENERATE_TIMEOUT_MS) || 120_000;
const DOWNLOAD_TIMEOUT_MS = 60_000; // 上游只回 URL 时下载原图
// 判官必修②:下载/解码体积上限。后端是单进程、扛着全部会话与 WS,一个坏掉或恶意的
// 中转站回一坨大 body 就是全局 OOM。
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_UPSTREAM_ERR = 500; // 上游报错原文透传上限(剥 key 后)
// r26-J2:生成 POST 的响应体同样要有界(下载分支早有,这条原先裸 r.text())。
// 上限取 b64 闸(64MB×1.4)上方一档 ×1.5:凡是能通过 b64 闸的合法响应都装得下,
// 再大的响应横竖过不了 b64 闸,不如在读取前就按体积拒掉(不读完 = 内存没吃)。
const MAX_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES * 1.5) + 4096;
const MAX_ERROR_BYTES = 256 * 1024;
// r54 图生图:参考图张数与单张体积上限。
// 15MB 不是拍脑袋 —— 请求整体走 express.json({limit:'25mb'})(server/index.js),
// base64 比原图大约 1.34x,单张 15MB 编码后约 20MB,是能被受理的最大一档;再大只会被
// body 解析层 413 掉,报不出人话。总体积超限时前端按 413 给可行动文案。
const MAX_REFS = 6;
const MAX_REF_BYTES = 15 * 1024 * 1024;
// 上传形态只收这三种(与前端 accept 一致);history 形态的扩展名白名单在 resolvePreviewPath 里。
const REF_UPLOAD_MIMES = ['image/png', 'image/jpeg', 'image/webp'];

async function readImageProviders() {
  try {
    const d = JSON.parse(await readFile(imageProvidersPath(), 'utf-8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

// 原子写:tmp 名带 uuid + rename 落地(半截 writeFile 不会留下坏文件)。
// mode 0600:providers 文件里有明文 apiKey,默认 0644 等于同机其他用户可读
// (历史文件不存 key,但同目录同口径写,不必区分)。
async function atomicWriteJson(target, data) {
  await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
  const tmp = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, target);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

async function atomicWriteProviders(list) {
  await atomicWriteJson(imageProvidersPath(), Array.isArray(list) ? list : []);
}

// 串行队列。**读也必须在队列里**:判官实测并发 5 次 POST 只剩 1 条(各自读到同一份旧
// list、后写的覆盖先写的)。原实现只把"写"排队,读-改-写整体不是原子的,排队等于白排。
// mutator 收到当前 list,返回 { list, result };抛错则不写盘(用于 404 之类)。
let _imageProvidersQueue = Promise.resolve();
function mutateImageProviders(mutator) {
  const run = _imageProvidersQueue.catch(() => {}).then(async () => {
    const list = await readImageProviders();
    const out = await mutator(list);
    await atomicWriteProviders(out.list);
    return out.result;
  });
  _imageProvidersQueue = run;
  return run.catch((e) => { throw e; });
}

// 保留直写口(测试与迁移用);常规 CRUD 一律走 mutateImageProviders。
function writeImageProviders(list) {
  const run = _imageProvidersQueue.catch(() => {}).then(() => atomicWriteProviders(list));
  _imageProvidersQueue = run;
  return run;
}

// ─────────────────────────── 出图历史(任务化的落盘层) ───────────────────────────
// 生图是后台任务:前端面板关掉/刷新都不影响它跑完,状态只认这个文件。
// 条目绝不含 apiKey(与 providers 文件不同,这份是给前端整条读走的)。
function imageHistoryPath() {
  return join(homedir(), '.claude-gui', 'image-history.json');
}
const MAX_HISTORY = 100;

async function readHistoryFile() {
  try {
    const d = JSON.parse(await readFile(imageHistoryPath(), 'utf-8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; } // 文件不存在/损坏 → 空历史,不崩
}

// 启动清障:上一个进程被杀时留下的 running 条目在本进程里永远不会有人再更新它,
// 不改写就成了永久的"生成中"僵尸。进程内只做一次 —— 之后的 running 都是本进程的活任务。
let _historySwept = false;
function sweepInterrupted(list) {
  if (_historySwept) return false;
  _historySwept = true;
  let changed = false;
  for (const e of list) {
    if (e && e.status === 'running') {
      e.status = 'interrupted';
      e.error = '应用重启，生成中断';
      changed = true;
    }
  }
  return changed;
}

// 串行队列(同 providers 口径):多个 job 并发更新各自条目,读-改-写整体必须原子,
// 否则后写的会把先写的整条盖掉。mutator 返回 { list, result };list 为 null = 只读。
let _imageHistoryQueue = Promise.resolve();
function withHistory(mutator) {
  const run = _imageHistoryQueue.catch(() => {}).then(async () => {
    const list = await readHistoryFile();
    const swept = sweepInterrupted(list);
    const out = await mutator(list);
    const next = out.list || (swept ? list : null);
    if (next) await atomicWriteJson(imageHistoryPath(), next.slice(0, MAX_HISTORY)); // ← 上限裁尾(新在前)
    return out.result;
  });
  _imageHistoryQueue = run;
  return run.catch((e) => { throw e; });
}

function addHistoryEntry(entry) {
  return withHistory((list) => {
    list.unshift(entry);
    return { list, result: entry.id };
  });
}

function updateHistoryEntry(id, patch) {
  return withHistory((list) => {
    const idx = list.findIndex((e) => e && e.id === id);
    if (idx === -1) return { list: null, result: false }; // 条目已被裁掉:任务照跑,不复活它
    list[idx] = { ...list[idx], ...patch };
    return { list, result: true };
  });
}

function readHistory(limit = MAX_HISTORY) {
  return withHistory((list) => ({ list: null, result: list.slice(0, limit) }));
}

// 并发上限:每个在跑的任务最多持有一张 25MB 级的图片缓冲(b64 文本 + Buffer),
// 不设上限的话用户连点几十次就能把单进程后端的内存打爆。计数是内存量(本进程在跑的),
// 不看历史文件里的 running(那是别的进程留下的,已被启动清障改写)。
const MAX_CONCURRENT_JOBS = 3;
let activeJobs = 0;
// r54 取消:jobId → AbortController(登记 = 本进程里还在跑;runner 的 finally 里删)。
const jobControllers = new Map();
// 被用户取消的 jobId。abort 抛出的异常与超时同形态,只有这个标志位能把两者分开。
const cancelledJobs = new Set();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// 出参永远不含 apiKey —— 只回 hasKey(与文本 provider 同口径)。
function publicView(p) {
  return {
    id: p.id, name: p.name, protocol: p.protocol, baseURL: p.baseURL,
    model: p.model || '', size: p.size || '', savePath: p.savePath || '',
    // r52:模型白名单(用户勾选的候选,供「模型」输入框的候选列表用)。存量条目无此字段 → 空数组。
    models: Array.isArray(p.models) ? p.models : [],
    // r54:图生图形态(仅 openai 协议有意义)。存量条目无此字段 → 默认官方 edits 端点。
    i2iMode: p.i2iMode === 'generations-image' ? 'generations-image' : 'edits',
    // r56:本 provider 的正向代理地址。保存时已禁掉内嵌账号密码,故【不是敏感值】,
    // 可以整条回给前端(不回传就没法在编辑表单里显示已配的代理)。
    proxyUrl: typeof p.proxyUrl === 'string' ? p.proxyUrl : '',
    // r84:Midjourney 的具名结构化参数(仅 mj 协议下发)。空串 = 不指定该键。
    mjVersion: MJ_VERSIONS.includes(p.mjVersion) ? p.mjVersion : '',
    mjSpeed: MJ_SPEEDS.includes(p.mjSpeed) ? p.mjSpeed : '',
    // r87:上游方言 + OpenAI 系结构化参数(仅 openai 协议下发)。存量条目无这些字段 →
    // 方言回落 'openai'(= 升级前语义)、其余回落空(= 不下发该键)。
    dialect: imageDialect(p),
    resolution: IMAGE_RESOLUTIONS.includes(p.resolution) ? p.resolution : '',
    quality: IMAGE_QUALITIES.includes(p.quality) ? p.quality : '',
    outputFormat: IMAGE_OUTPUT_FORMATS.includes(p.outputFormat) ? p.outputFormat : '',
    background: IMAGE_BACKGROUNDS.includes(p.background) ? p.background : '',
    moderation: IMAGE_MODERATIONS.includes(p.moderation) ? p.moderation : '',
    n: Number.isInteger(p.n) && p.n >= 1 && p.n <= IMAGE_N_MAX ? p.n : '',
    nsfwCheck: p.nsfwCheck === true,
    extra: p.extra || null, hasKey: !!p.apiKey,
  };
}

// r52:白名单上限 —— 单条 128 字符(模型 id 再长也够),总数 200(中转站目录动辄几百条,
// 全量灌进来对用户无意义,且这份数组每次读配置都要解析)。
const MAX_MODEL_ID_LEN = 128;
const MAX_MODELS = 200;

// 返回 { error } 或 { models }(未传 models 时返回 {} = 保持不变)。
function validateModels(models) {
  if (models === undefined || models === null) return {};
  if (!Array.isArray(models)) return { error: '模型列表必须是数组' };
  if (models.length > MAX_MODELS) return { error: `模型列表最多 ${MAX_MODELS} 条,请先取消部分勾选` };
  const out = [];
  for (const m of models) {
    if (typeof m !== 'string') return { error: '模型列表只能包含字符串' };
    const id = m.trim();
    if (!id) continue;
    if (id.length > MAX_MODEL_ID_LEN) return { error: `模型名过长(上限 ${MAX_MODEL_ID_LEN} 字符)` };
    if (!out.includes(id)) out.push(id);
  }
  return { models: out };
}

/**
 * r56 代理地址校验。返回 { error } / { proxyUrl } / {}(未传 = 保持原值,与 apiKey 同语义)。
 *  - 空串 = 清除(改回直连);
 *  - 必须 http(s) 形态;
 *  - 【禁内嵌账号密码】:代理凭据会被原样存进 image-providers.json 并出现在 publicView /
 *    错误信息里(redactKey 只剥 apiKey,认不出代理密码)。本机代理端口不需要认证,
 *    真需要认证的远端代理请用不落密码的形态;
 *  - 【放行回环】:Clash / 本机代理端口正是这个字段的主用途,不套 assertPublicBaseURL
 *    (那是防"服务端拿着密钥去打内网",而代理地址是用户自己指定的出口)。
 */
function validateProxyUrl(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') return { error: '代理地址必须是字符串' };
  const s = raw.trim();
  if (!s) return { proxyUrl: '' };
  let u;
  try { u = new URL(s); } catch { return { error: '代理地址非法，请填写形如 http://127.0.0.1:7897 的地址' }; }
  if (!/^https?:$/.test(u.protocol)) return { error: '代理地址必须是 http(s)' };
  if (u.username || u.password) return { error: '代理地址不支持内嵌账号密码，请使用本机免认证代理端口' };
  return { proxyUrl: s };
}

// 保存目录:必须是绝对路径 + 存在 + 可写。人话错误,不抛栈。
async function checkSavePath(savePath) {
  if (typeof savePath !== 'string' || !savePath.trim()) return '保存路径必填，请选择一个保存目录';
  if (!isAbsolute(savePath.trim())) return '保存路径必须是绝对路径';
  try {
    const st = await stat(savePath.trim());
    if (!st.isDirectory()) return '保存路径不是一个目录，请重新选择';
    await access(savePath.trim(), constants.W_OK);
  } catch { return '保存目录不存在或不可写，请重新选择'; }
  return null;
}

function sanitizeExtra(extra) {
  if (extra === null || extra === undefined || extra === '') return null;
  if (typeof extra === 'object' && !Array.isArray(extra)) return Object.keys(extra).length ? extra : null;
  return undefined; // 非法形态:调用方转 400
}

// 表单入参校验(POST/PUT 共用)。返回 { error } 或 { value }。
async function validateBody(body) {
  const { name, protocol, baseURL, model, size, savePath } = body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return { error: '名称必填' };
  if (!IMAGE_PROTOCOLS.includes(protocol)) return { error: `协议必须是 ${IMAGE_PROTOCOLS.join(' / ')}` };
  let url; try { url = new URL(baseURL); } catch { return { error: 'baseURL 非法' }; }
  if (!/^https?:$/.test(url.protocol)) return { error: 'baseURL 必须是 http(s)' };
  // SSRF 守卫(与文本 provider 同口径):server 会带存储的 apiKey 主动请求这个地址。
  try { await assertPublicBaseURL(baseURL); } catch (e) { return { error: e.message }; }
  if (!model || typeof model !== 'string' || !model.trim()) return { error: '模型必填' };
  const pathErr = await checkSavePath(savePath);
  if (pathErr) return { error: pathErr };
  const extra = sanitizeExtra(body?.extra);
  if (extra === undefined) return { error: '附加参数必须是 JSON 对象' };
  // r52:模型白名单可选。不传 = 不改动已存值(与 apiKey 同语义:客户端没发就别动)。
  const mv = validateModels(body?.models);
  if (mv.error) return { error: mv.error };
  // r54:图生图形态。不传 = 默认官方 edits(存量条目同此默认)。
  const i2iMode = body?.i2iMode === undefined || body?.i2iMode === null || body?.i2iMode === '' ? 'edits' : body.i2iMode;
  if (!I2I_MODES.includes(i2iMode)) return { error: `图生图形态必须是 ${I2I_MODES.join(' / ')}` };
  // r56:代理地址可选。不传 = 不动已存值;空串 = 清除。
  const pv = validateProxyUrl(body?.proxyUrl);
  if (pv.error) return { error: pv.error };
  // r84:mj 的具名参数。取值必须在文档明列的清单里 —— 这两个值会原样进请求体,
  // 不做白名单的话就是"表单里能填什么上游就收到什么"。空串/未传 = 不下发该键。
  const mjVersion = body?.mjVersion === undefined || body?.mjVersion === null ? '' : String(body.mjVersion);
  if (mjVersion && !MJ_VERSIONS.includes(mjVersion)) return { error: `Midjourney 版本必须是 ${MJ_VERSIONS.join(' / ')}` };
  const mjSpeed = body?.mjSpeed === undefined || body?.mjSpeed === null ? '' : String(body.mjSpeed);
  if (mjSpeed && !MJ_SPEEDS.includes(mjSpeed)) return { error: `Midjourney 速度必须是 ${MJ_SPEEDS.join(' / ')}` };
  // r87:OpenAI 系的结构化参数。这些值会【原样进请求体】,不做白名单就是"表单里能填什么
  // 上游就收到什么";空串/未传 = 不指定(不下发该键)。取值范围出自两边的官方文档,
  // 权威清单在 utils/image-protocols.js。
  const dialect = body?.dialect === undefined || body?.dialect === null || body?.dialect === '' ? 'openai' : body.dialect;
  if (!IMAGE_DIALECTS.includes(dialect)) return { error: `上游方言必须是 ${IMAGE_DIALECTS.join(' / ')}` };
  const enums = [
    ['resolution', IMAGE_RESOLUTIONS, '分辨率档'],
    ['quality', IMAGE_QUALITIES, '质量'],
    ['outputFormat', IMAGE_OUTPUT_FORMATS, '输出格式'],
    ['background', IMAGE_BACKGROUNDS, '背景'],
    ['moderation', IMAGE_MODERATIONS, '审核强度'],
  ];
  const params = {};
  for (const [key, allowed, label] of enums) {
    const raw = body?.[key] === undefined || body?.[key] === null ? '' : String(body[key]);
    if (raw && !allowed.includes(raw)) return { error: `${label}必须是 ${allowed.join(' / ')}` };
    params[key] = raw;
  }
  // 张数:空 = 不指定(按 1 出图);填了就必须是 1..4 的整数。
  const rawN = body?.n;
  let n = '';
  if (rawN !== undefined && rawN !== null && rawN !== '') {
    n = typeof rawN === 'number' ? rawN : Number(String(rawN).trim());
    if (!Number.isInteger(n) || n < 1 || n > IMAGE_N_MAX) return { error: `图像数量必须是 1–${IMAGE_N_MAX} 的整数` };
  }
  if (body?.nsfwCheck !== undefined && body?.nsfwCheck !== null && typeof body.nsfwCheck !== 'boolean') {
    return { error: '提交前预审必须是布尔值' };
  }
  const nsfwCheck = body?.nsfwCheck === true;
  // mj 的 size 是宽高比不是像素。新保存的当场拒(填错要即时可见);【存量条目不受这里管】——
  // 它们不经过保存,由协议层的同款守卫静默忽略掉非比例值(见 buildImageRequest 的 mj 分支)。
  const sizeStr = typeof size === 'string' ? size.trim() : '';
  if (protocol === 'mj' && sizeStr && !MJ_RATIO_RE.test(sizeStr)) {
    return { error: 'Midjourney 的尺寸是宽高比（如 16:9 / 1:1 / 9:16），不是像素尺寸' };
  }
  return {
    value: {
      i2iMode,
      mjVersion,
      mjSpeed,
      dialect,
      ...params,
      n,
      nsfwCheck,
      name: name.trim(),
      protocol,
      baseURL: baseURL.trim().replace(/\/+$/, ''),
      model: model.trim(),
      size: typeof size === 'string' ? size.trim() : '',
      savePath: savePath.trim(),
      extra,
      ...(mv.models ? { models: mv.models } : {}),
      ...(pv.proxyUrl === undefined ? {} : { proxyUrl: pv.proxyUrl }),
    },
  };
}

/** GET /api/image-providers — 列表(绝不含 apiKey)。 */
router.get('/image-providers', async (_req, res) => {
  res.json({ providers: (await readImageProviders()).map(publicView) });
});

/** POST /api/image-providers — 新增。 */
router.post('/image-providers', async (req, res) => {
  try {
    const { error, value } = await validateBody(req.body);
    if (error) return res.status(400).json({ error });
    const entry = {
      id: randomUUID(),
      ...value,
      apiKey: typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '',
    };
    const id = await mutateImageProviders((list) => {
      list.push(entry);
      return { list, result: entry.id };
    });
    res.json({ ok: true, id });
  } catch (err) { res.status(err?.status || 500).json({ error: err.message }); }
});

/** PUT /api/image-providers/:id — 编辑。apiKey 留空 = 保留原 key(前端从不持有 key)。 */
router.put('/image-providers/:id', async (req, res) => {
  try {
    const { error, value } = await validateBody(req.body);
    if (error) return res.status(400).json({ error });
    const apiKey = req.body?.apiKey;
    const id = await mutateImageProviders((list) => {
      const idx = list.findIndex((p) => p.id === req.params.id);
      if (idx === -1) throw new HttpError(404, 'not found');
      list[idx] = {
        ...list[idx],
        ...value,
        id: list[idx].id,
        apiKey: (typeof apiKey === 'string' && apiKey.trim()) ? apiKey.trim() : list[idx].apiKey,
      };
      return { list, result: list[idx].id };
    });
    res.json({ ok: true, id });
  } catch (err) { res.status(err?.status || 500).json({ error: err.message }); }
});

/** DELETE /api/image-providers/:id — 删除(只删配置,不动已出的图)。 */
router.delete('/image-providers/:id', async (req, res) => {
  try {
    await mutateImageProviders((list) => {
      const next = list.filter((p) => p.id !== req.params.id);
      if (next.length === list.length) throw new HttpError(404, 'not found');
      return { list: next, result: true };
    });
    res.json({ ok: true });
  } catch (err) { res.status(err?.status || 500).json({ error: err.message }); }
});

const FETCH_MODELS_TIMEOUT_MS = 10_000; // 与文本 provider 的拉取口径一致
// 模型列表的读取上限:大目录(OpenRouter 那类几百个模型)约 1MB 量级,2MB 够用;
// 超限一律按"读不了"处理,不把一坨大 body 读进单进程后端。
const MAX_MODELS_BYTES = 2 * 1024 * 1024;

// 失败三分类:auth(密钥不对)/ network(请求没到达对方)/ unsupported(该服务没有列表接口),
// 前端据此给可行动文案。probeUpstreamModels 只抛中文 Error(红线:不改其本体),
// 故按其固定措辞归类。
class ModelsError extends Error {
  constructor(type, message) { super(message); this.type = type; }
}
function classifyModelsError(msg) {
  if (/鉴权失败|\b40[13]\b/.test(msg)) return 'auth';
  if (/连不上|超时|网络层失败/.test(msg)) return 'network';
  return 'unsupported';
}

// gemini 的模型列表:GET {base}/models。认证头按端点形态选,401/403 换另一组重试一次
// (与出图链路的 altHeaders 同口径)。**不按能力过滤** —— 响应里没有可靠的"能否生图"
// 标记,过滤只会把可用模型误杀,全量返回由用户挑。
async function fetchGeminiModels(baseURL, apiKey, proxyUrl) {
  await assertPublicBaseURL(baseURL);
  const spec = geminiModelsRequest(baseURL, apiKey);
  // redirect:manual —— 请求带着 apiKey,跟随 3xx 会把密钥带到没验过的地址(同出图链路)。
  const get = (headers) => undiciFetch(spec.url, {
    headers, signal: AbortSignal.timeout(FETCH_MODELS_TIMEOUT_MS), redirect: 'manual',
    ...dispatchOpts(proxyUrl),
  });
  let resp;
  try { resp = await get(spec.headers); }
  catch (e) {
    const floor = nodeFloorHint(e);
    if (floor) throw new ModelsError('network', floor);
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const cause = e?.cause?.code || e?.cause?.message || '';
    throw new ModelsError('network', timedOut
      ? `拉取超时(${FETCH_MODELS_TIMEOUT_MS / 1000}s):${spec.url}`
      : `连不上 ${spec.url}${cause || e?.message ? `:${[e?.message, cause].filter(Boolean).join(' — ')}` : ''}`);
  }
  if (!resp.ok && (resp.status === 401 || resp.status === 403)) {
    // 判官r50:重试成功时消费掉首个 401/403 的响应体,及时释放连接(不等 GC)。
    const first = resp;
    try { resp = await get(spec.altHeaders); await first.body?.cancel?.(); } catch { /* 保留首次响应 */ }
  }
  // 读 body 一律走 readCapped:下游 host 是用户自填的,无界读 = 单进程后端 OOM(r26-J2 口径)。
  if (!resp.ok) {
    const body = ((await readCapped(resp, MAX_ERROR_BYTES).catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (resp.status === 401 || resp.status === 403) {
      throw new ModelsError('auth', `上游 ${spec.url} 返回 ${resp.status}(鉴权失败):请检查密钥${body ? `。${body}` : ''}`);
    }
    throw new ModelsError('unsupported',
      `该服务未提供模型列表接口(${spec.url} 返回 ${resp.status})，请在「模型」框手动填写模型名。${body ? `\n上游:${body}` : ''}`);
  }
  const raw = await readCapped(resp, MAX_MODELS_BYTES).catch(() => '');
  if (raw === null) throw new ModelsError('unsupported', `模型列表响应过大（超过 ${MAX_MODELS_BYTES / 1048576}MB），已拒绝读取`);
  let data = null;
  try { data = JSON.parse(raw); } catch { data = null; }
  const arr = Array.isArray(data?.models) ? data.models : (Array.isArray(data?.data) ? data.data : []);
  const ids = [];
  for (const m of arr) {
    // 官方回 models/{id};中转站有回裸 id 或 openai 形态 {id} 的,一并认。
    const entry = typeof m === 'string' ? m : (m?.name || m?.id);
    if (typeof entry !== 'string' || !entry) continue;
    const id = entry.replace(/^models\//, '');
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * POST /api/image-providers/fetch-models { id? | (baseURL, protocol), apiKey? }
 * → { ok:true, models:[id…] } / { ok:false, type:'auth'|'network'|'unsupported', message }
 *
 * 两态:
 *  - 带 id(编辑态):读存储 provider,**baseURL 强制取存储值**、协议同理;apiKey 取请求体
 *    非空值,否则用存储 key。请求体里的 baseURL 一律忽略 —— 否则 {id, baseURL:攻击者地址}
 *    会让服务端把该 provider 的真实密钥发去攻击者端点(key 与 baseURL 必须同源;
 *    与 settings.js 的 custom-providers/fetch-models 同口径)。
 *  - 不带 id(新建表单态):用表单值,SSRF 守卫在下游探测函数内。
 * 出错信息透传前一律过 redactKey,响应任何路径都不含 apiKey。
 */
router.post('/image-providers/fetch-models', async (req, res) => {
  let apiKeyForRedact = '';
  try {
    let { baseURL, apiKey, protocol } = req.body || {};
    // r56:代理与 baseURL 同口径 —— 编辑态用【存储值】,新建表单态才用请求体里的值
    // (校验同保存路径:非 http(s)/带凭据一律拒,不给一个没验过的出口)。
    let proxyUrl = '';
    if (req.body?.id) {
      const stored = (await readImageProviders()).find((p) => p.id === req.body.id);
      if (!stored) return res.status(404).json({ ok: false, type: 'unsupported', message: '未找到该生图 provider' });
      if (!apiKey || !String(apiKey).trim()) apiKey = stored.apiKey;
      baseURL = stored.baseURL; // ← 防密钥外传:请求体的 baseURL 一律忽略
      protocol = stored.protocol || protocol;
      proxyUrl = typeof stored.proxyUrl === 'string' ? stored.proxyUrl : '';
    } else {
      const pv = validateProxyUrl(req.body?.proxyUrl);
      if (pv.error) return res.status(400).json({ ok: false, type: 'unsupported', message: pv.error });
      proxyUrl = pv.proxyUrl || '';
    }
    apiKeyForRedact = typeof apiKey === 'string' ? apiKey : '';
    if (typeof baseURL !== 'string' || !baseURL.trim()) {
      return res.status(400).json({ ok: false, type: 'unsupported', message: '请先填写接口地址（baseURL）' });
    }
    let u;
    try { u = new URL(baseURL); } catch { return res.status(400).json({ ok: false, type: 'unsupported', message: 'baseURL 非法' }); }
    if (!/^https?:$/.test(u.protocol)) {
      return res.status(400).json({ ok: false, type: 'unsupported', message: 'baseURL 必须是 http(s)' });
    }
    // openai / chat 的 baseURL 语义与文本 provider 相同 → 复用同一条探测链路(候选 URL、
    // 双 header 轮询、SSRF 守卫都在里面);gemini 是另一套端点形态,单独走。
    // ⚠️ 已知边界:probeUpstreamModels 在 settings.js 且与文本 provider 共用(其本体
    // 有"一个字不改"的红线),故 openai/chat 的【拉模型】这一次请求仍是直连,不经代理;
    // 生成与图片下载(真正会被墙掐断的两处)以及 gemini 拉模型都已过代理。
    const models = protocol === 'gemini'
      ? await fetchGeminiModels(baseURL, apiKey, proxyUrl)
      : ((await probeUpstreamModels(baseURL, apiKey)).ids || []);
    res.json({ ok: true, models });
  } catch (err) {
    const message = redactKey(err?.message || '拉取模型失败', apiKeyForRedact);
    res.status(err?.status || 502).json({ ok: false, type: err?.type || classifyModelsError(message), message });
  }
});

// 落盘:重名加序号(-1、-2……),不覆盖已有图。
// r26-J4:existsSync 预检 + writeFile 是两步,并发下同 tick 同名会互相覆盖(检查时都
// 不存在,然后各写各的)。改 flag:'wx' 原子创建,EEXIST 撞名加后缀重试(上限 100 次,
// 与 download-update.js 既有模式同款)。
// export 仅为单测:并发撞名双存活只能在函数级确定性构造(路由级要赌时间戳同秒)。
export async function saveImage(dir, baseName, buf) {
  const ext = extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  for (let i = 0; i <= 100; i++) {
    const name = i === 0 ? baseName : `${stem}-${i}${ext}`;
    const full = join(dir, name);
    try {
      await writeFile(full, buf, { flag: 'wx' });
      return full;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e; // 只兜撞名;ENOSPC/EACCES 等原样上抛给错误分类
    }
  }
  const e = new Error('同名文件过多（超过 100 个），保存失败');
  e.code = 'EEXIST';
  throw e;
}

// ─────────────────── r87 报价代理:出图前的「预估约 X credits」 ───────────────────
// apimart 的报价接口【免鉴权】(文档原文「本接口无需鉴权,不必传 Authorization」),
// 但路径在 `/api/` 而不是 `/v1/` —— 要取 provider baseURL 的 origin 再拼,不能直接
// `${baseURL}/api/pricing/model`。这里做成服务端代理有三个理由:走 provider 自己的代理
// 链路(浏览器直连会被墙/被 CORS 挡)、不把 provider 配置逻辑搬去前端、能加缓存。
//
// 【绝不带 apiKey】:免鉴权接口带上密钥等于把它多送一个地方。
// 【失败一律静默】:预估价是锦上添花,拿不到就不显示(响应恒 200 + credits:null),
// 绝不因为报价查不到就把生图面板搞出一个红色错误。
const PRICING_TTL_MS = 10 * 60 * 1000;
const PRICING_TIMEOUT_MS = 8_000;
const MAX_PRICING_BYTES = 1024 * 1024; // 实测单模型响应 ~8KB,1MB 是宽裕的上限
const MAX_PRICING_CACHE = 32;
const pricingCache = new Map(); // `${origin}|${model}` → { at, data }

async function fetchPricing(provider) {
  const model = String(provider.model || '').trim();
  if (!model) return null;
  let origin;
  try { origin = new URL(provider.baseURL).origin; } catch { return null; }
  const key = `${origin}|${model}`;
  const hit = pricingCache.get(key);
  if (hit && Date.now() - hit.at < PRICING_TTL_MS) return hit.data;
  const url = `${origin}/api/pricing/model?model=${encodeURIComponent(model)}`;
  // baseURL 在保存时已过 assertPublicBaseURL,这里同 origin 再验一次(便宜,且挡住
  // "配置文件被手改成内网地址"这条路);回环放行与 baseURL 同口径(本机中转站是正当用法)。
  try { await assertPublicBaseURL(url); } catch { return null; }
  let data = null;
  try {
    const r = await undiciFetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'claude-gui' },
      signal: AbortSignal.timeout(PRICING_TIMEOUT_MS),
      redirect: 'manual',
      ...dispatchOpts(provider.proxyUrl),
    });
    if (!r.ok || r.status >= 300) { await r.body?.cancel?.().catch(() => {}); return null; }
    const raw = await readCapped(r, MAX_PRICING_BYTES).catch(() => null);
    data = raw === null ? null : JSON.parse(raw);
  } catch { return null; } // 网络不通 / 非 JSON / 超时:静默
  pricingCache.set(key, { at: Date.now(), data });
  if (pricingCache.size > MAX_PRICING_CACHE) pricingCache.delete(pricingCache.keys().next().value);
  return data;
}

/**
 * GET /api/image/pricing?providerId=… → { credits: number|null }
 * 只有 apimart 方言才查(官方 Images API 没有报价接口)。credits 为 null = 不显示预估。
 */
router.get('/image/pricing', async (req, res) => {
  try {
    const provider = (await readImageProviders()).find((p) => p.id === req.query?.providerId);
    if (!provider || provider.protocol !== 'openai' || imageDialect(provider) !== 'apimart') {
      return res.json({ credits: null });
    }
    const pricing = await fetchPricing(provider);
    res.json({ credits: estimateCredits(pricing, provider) });
  } catch { res.json({ credits: null }); }
});

// ─────────────────── r82 任务制上游(apimart / Midjourney 形态)的轮询 ───────────────────
// 这类上游提交只回 task_id,图要轮询 {base}/tasks/{id} 到终态才有。
// 5s 一档 = 上游文档建议的 3–5s 里最省的一档(查询不计费,但 MJ 实测 60s 才出图,更密无意义)。
// 15 分钟本地上限:平台侧要 30 分钟才判超时并退款,GUI 挂半小时不合理 —— 到点写成 error
// 并在文案里说明平台侧任务可能仍在跑。
// 间隔允许被环境变量下调(同 GENERATE_TIMEOUT_MS 的先例):端到端单测要在秒级跑完
// 提交→轮询→多图落盘这一整条,不设该变量时恒为 5s,产品行为一字不变。
// 200ms 地板:负数或 0 会让 Number(...)||5000 落回 5s 没错,但 0.1 这类小正数会变成
// 紧轮询,把用户自己的中转站打成 DDoS 目标。下调口只是给单测用的,不需要更快。
const TASK_POLL_INTERVAL_MS = Math.max(200, Number(process.env.CGUI_IMAGE_TASK_POLL_INTERVAL_MS) || 5_000);
const TASK_POLL_DEADLINE_MS = 15 * 60 * 1000;
const TASK_POLL_TIMEOUT_MS = 30_000; // 单次查询的超时:一次查不到不判死,等下一轮

/**
 * 可中断的等待。取消要"点了就停" —— 用裸 setTimeout 的话最多要把这一轮 5s 睡完才落地,
 * 按钮看起来就是坏的。export 仅为单测。
 */
export function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    let timer;
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * 轮询一个上游任务到终态。返回 { urls } / { error } / { cancelled:true } ——
 * 写历史与错误呈现一律交给调用方(与 runImageJob 的 fail() 同一处口径,不在这里分叉)。
 *
 * 安全口径与既有两处外联逐条对齐:redirect:'manual'(请求带着密钥,不跟随 3xx)、
 * readCapped 限量读、走 provider 自己的代理。轮询地址是【已过 assertPublicBaseURL 的
 * baseURL】+ 编码后的 task id,origin 没变,故不再验一次;真正上游可控的是结果里的图片
 * 链接,那些回到 runImageJob 的下载分支做 SSRF 复检(那段一行未改)。
 *
 * 单次查询失败(网络抖动 / 5xx / 单次超时)不判死:任务在上游照跑,等下一轮;
 * 确定性错误(4xx、非 JSON、上游报 failed)才判死。总时长由 deadline 兜住。
 *
 * io 仅为单测注入(fetch / sleep / now),默认就是真网络与真定时器。signal 必传。
 */
export async function pollTask({ taskId, provider, signal, onProgress }, io = {}) {
  const doFetch = io.fetch || undiciFetch;
  const sleep = io.sleep || sleepAbortable;
  const now = io.now || Date.now;
  let spec;
  try { spec = buildTaskPollRequest(provider.baseURL, provider.apiKey, taskId); }
  catch (e) { return { error: `无法构造任务查询请求：${e.message}` }; }
  const proxy = dispatchOpts(provider.proxyUrl);
  const deadline = now() + TASK_POLL_DEADLINE_MS;
  let lastProgress = null;
  for (;;) {
    // 先等再查:提交那一刻上游不可能已经出图,立刻查是白打一次。
    await sleep(TASK_POLL_INTERVAL_MS, signal);
    if (signal?.aborted) return { cancelled: true }; // 取消是终态,文案由 cancel 端点写
    if (now() >= deadline) {
      return { error: `等待上游任务超时（${TASK_POLL_DEADLINE_MS / 60000} 分钟未出结果）。平台侧任务可能仍在生成，请稍后在该服务的控制台查看。` };
    }
    let resp;
    try {
      resp = await doFetch(spec.url, {
        headers: spec.headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(TASK_POLL_TIMEOUT_MS)]),
        redirect: 'manual',
        ...proxy,
      });
    } catch {
      if (signal?.aborted) return { cancelled: true };
      continue; // 网络抖动 / 单次查询超时:不判死,等下一轮
    }
    if (resp.status >= 300 && resp.status < 400) {
      await resp.body?.cancel?.().catch(() => {});
      return { error: `查询任务状态时上游返回了重定向（HTTP ${resp.status}），已拒绝跟随（防止密钥被带到未校验的地址）` };
    }
    if (!resp.ok) {
      // 读出来既是为了给人话,也是为了把连接放掉(不等 GC)。
      const errRaw = await readCapped(resp, MAX_ERROR_BYTES).catch(() => '');
      if (resp.status >= 500 || resp.status === 429) continue; // 中转站常见抖动:继续轮询
      const safe = redactKey(errRaw || '', provider.apiKey).replace(/\s+/g, ' ').trim().slice(0, MAX_UPSTREAM_ERR);
      return { error: `查询任务状态失败：HTTP ${resp.status}${safe ? `：${safe}` : ''}` };
    }
    const raw = await readCapped(resp, MAX_RESPONSE_BYTES).catch(() => '');
    if (raw === null) {
      return { error: `任务状态响应体积过大（超过 ${Math.round(MAX_RESPONSE_BYTES / 1048576)}MB 上限，已拒绝读取）` };
    }
    let data;
    try { data = JSON.parse(raw); }
    catch { return { error: `任务状态响应不是 JSON：${redactKey(raw, provider.apiKey).slice(0, 300) || '(空响应)'}` }; }
    const st = extractTaskState(data);
    if (st.progress !== null && st.progress !== lastProgress) {
      lastProgress = st.progress;
      onProgress?.(st.progress); // fire-and-forget:写历史不该拖住轮询节奏
    }
    if (st.status === 'failed' || st.status === 'cancelled') {
      // 上游主动取消不是失败(常见于平台侧敏感词拦截后的自动退款),措辞如实区分。
      const what = st.status === 'cancelled' ? '上游任务已取消' : '上游任务失败';
      const why = redactKey(st.message, provider.apiKey).slice(0, MAX_UPSTREAM_ERR);
      // r87:失败/取消也把实付带出来 —— 平台侧敏感词拦截之类同样可能已经扣费。
      return { error: `${what}${why ? `：${why}` : '（上游未给出原因）'}`, cost: st.cost, creditsCost: st.creditsCost };
    }
    if (st.status === 'completed') {
      if (!st.urls.length) {
        return { error: `上游任务已完成但没有返回可用的图片链接：${redactKey(raw, provider.apiKey).slice(0, 300)}` };
      }
      return { urls: st.urls, cost: st.cost, creditsCost: st.creditsCost };
    }
  }
}

/**
 * 出图任务主体。异步跑,不占着 HTTP 连接 —— 安全链路(下载链接的 SSRF 复检、
 * redirect:'manual' 拒 3xx、redactKey、限量读、体积闸)整体自路由搬进来一字未改,
 * 只把原先的 `return res.status(x).json({error})` 换成「把同一句文案写进历史条目」。
 */
async function runImageJob({ jobId, provider, prompt, spec, startedAt }) {
  // r54 取消:per-job controller 登记在 jobControllers(有登记 = 本进程里还在跑)。
  const controller = new AbortController();
  jobControllers.set(jobId, controller);
  // r54:手动 abort 与 AbortSignal.timeout 抛出的异常【形态相同】(都是 AbortError/
  // TimeoutError 一类),靠 e.name 分不出"用户取消"还是"上游超时"。判据只能在 controller
  // 侧:cancelledJobs 里有它 = 是我们主动掐的,状态已由 cancel 端点写成 cancelled,
  // 这里就不再覆写任何错误文案(超时仍走下面的原文案,一字未改)。
  const fail = (error, extra) => (cancelledJobs.has(jobId) ? Promise.resolve() : updateHistoryEntry(jobId, {
    status: 'error', error, tookMs: Date.now() - startedAt, ...(extra || {}),
  }).catch(() => {}));
  // r87:任务制上游在查询响应里给【实付】(cost 金额 / credits_cost 积分)。取真实值比自己
  // 估价可靠得多(估价要处理 6 种报价形态且只能说"约"),故落进条目由界面显示。
  let money = null;
  const started = startedAt;
  try {
    // r56:本 provider 配了代理就整条链路都走它(生成 POST 与下面的图片下载)。
    // r57:这行必须在 try 内 —— try 之外的任何抛错都绕过 finally,并发名额与 controller
    // 双泄漏,3 次之后永久 429(生图彻底发不出去)。
    const proxy = dispatchOpts(provider.proxyUrl);
    // r56 实测坑:undici 包的 fetch 【不认】Node 内建的 FormData(它只认自己那份实现),
    // 拿到内建 FormData 会退化成 String(body) = 字面量 "[object FormData]" 且
    // Content-Type 变 text/plain —— 图生图 edits 形态会静默发出一坨垃圾,上游 400。
    // 故 multipart 在这里先用【Node 自己的序列化器】压成字节并取出它写的 boundary,
    // 再交给 undici 发:请求字节与原先全局 fetch 发出去的逐字一致(同一个序列化器),
    // 且 image-protocols.js 仍用原生 FormData(零新依赖)。
    // ponytail: 多一份 body 副本在内存里;参考图总量本就被 express.json 的 25MB 卡死,
    // 真要流式再说(要么等 undici 支持内建 FormData,要么换成 undici 自己的 FormData)。
    let formBody = null; let formType = null;
    if (spec.form) {
      const packed = new Response(spec.form);
      formType = packed.headers.get('content-type'); // multipart/form-data; boundary=…
      formBody = Buffer.from(await packed.arrayBuffer());
    }
    const post = (headers) => undiciFetch(spec.url, {
      method: 'POST',
      headers: formType ? { ...headers, 'Content-Type': formType } : headers,
      body: formBody || JSON.stringify(spec.body), // form 非空 = multipart(图生图 edits 形态)
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(GENERATE_TIMEOUT_MS)]),
      ...proxy,
      // r26-J1:与下方下载分支同口径 —— 不跟随重定向。生成 POST 带着 apiKey,跟随 302
      // 会把请求(或响应读取)引到 assertPublicBaseURL 没验过的地址(鉴权跳转/网关劫持)。
      redirect: 'manual',
    });
    let r;
    try { r = await post(spec.headers); }
    catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      // r57:代理没起/配错时 undici 只给一句 "fetch failed",真因(ECONNREFUSED 等)在
      // e.cause 里 —— 与拉模型分支(fetchGeminiModels)同口径拼进去,别让用户对着它猜。
      const cause = e?.cause?.code || e?.cause?.message || '';
      return fail(
        timedOut ? `生成超时（${GENERATE_TIMEOUT_MS / 1000} 秒），上游没有返回`
          : nodeFloorHint(e) || `连接上游失败：${redactKey([e?.message, cause].filter(Boolean).join(' — '), provider.apiKey)}`,
      );
    }
    // gemini 认证头按端点形态选(官方 x-goog-api-key / 中转站 Bearer),选错就 401/403
    // → 用另一种原样重试一次,而不是一刀切押一种。
    if (!r.ok && spec.altHeaders && (r.status === 401 || r.status === 403)) {
      try { r = await post(spec.altHeaders); } catch { /* 保留首次响应 */ }
    }
    // r26-J1:3xx 一律报错,不读 Location、不跟随(下载分支同款;API 端点的 302 通常是
    // 鉴权跳转/网关劫持,跟随必错且会脱离刚验过的 origin)。
    if (r.status >= 300 && r.status < 400) {
      await r.body?.cancel?.().catch(() => {});
      return fail(`上游返回了重定向（HTTP ${r.status}），已拒绝跟随（防止密钥被带到未校验的地址）`);
    }
    // r26-J2:错误分支限量读 256KB(超限带截断标记);上游回一坨大错误体不能 OOM 后端。
    if (!r.ok) {
      const errRaw = await readCapped(r, MAX_ERROR_BYTES).catch(() => '');
      const truncated = errRaw === null;
      const safeErr = redactKey(truncated ? '' : errRaw, provider.apiKey).slice(0, MAX_UPSTREAM_ERR);
      return fail(`上游返回 ${r.status}：${safeErr || '(空响应)'}${truncated ? '（错误内容过大，已截断）' : ''}`);
    }
    // r26-J2:成功分支 content-length 预检 + 限量读 —— 上限外一律按体积报错,
    // 而不是把整坨读进内存后再按「不是 JSON」报(读完 = 内存已经吃了)。
    const declared = Number(r.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await r.body?.cancel?.().catch(() => {});
      return fail(`上游响应体积过大（声明 ${Math.round(declared / 1048576)}MB，上限 ${Math.round(MAX_RESPONSE_BYTES / 1048576)}MB）`);
    }
    const capped = await readCapped(r, MAX_RESPONSE_BYTES).catch(() => '');
    if (capped === null) {
      return fail(`上游响应体积过大（超过 ${Math.round(MAX_RESPONSE_BYTES / 1048576)}MB 上限，已拒绝读取）`);
    }
    const raw = capped;
    const safeRaw = redactKey(raw, provider.apiKey).slice(0, MAX_UPSTREAM_ERR);

    let data;
    try { data = JSON.parse(raw); }
    catch { return fail(`上游响应不是 JSON：${safeRaw || '(空响应)'}`); }
    // 同步协议:图就在这次响应里。取不到再看是不是【任务制】上游(apimart / MJ:提交只回
    // task_id),是就轮询到终态再取图。判据是【响应形态】而不是协议名 —— 同一个 openai
    // 协议接到任务制中转站时同样能出图,且同步命中时下面这一整段与 r82 之前逐字等价。
    const sync = extractImage(provider.protocol, data);
    let pickedList = sync ? [sync] : null;
    if (!pickedList) {
      const taskId = extractTaskId(data);
      if (taskId) {
        // r84:上游任务号写进条目 —— 二次操作(U/V)要拿它当 task_id 提交,不存就没得引用。
        // 在轮询之前写:轮询要一分钟起,期间用户已经能看到这条记录。
        await updateHistoryEntry(jobId, { taskId }).catch(() => {});
        const polled = await pollTask({
          taskId,
          provider,
          signal: controller.signal,
          onProgress: (p) => { updateHistoryEntry(jobId, { progress: p }).catch(() => {}); },
        });
        if (polled.cancelled) return; // 取消是终态,状态已由 cancel 端点写
        if (polled.cost !== null && polled.cost !== undefined) money = { cost: polled.cost, creditsCost: polled.creditsCost };
        if (polled.error) return fail(polled.error, money);
        // 一个任务可能出多张图(MJ 实测 4 张单图):逐张走下面同一条下载链路,落多个文件。
        pickedList = polled.urls.map((url) => ({ mime: '', url }));
      }
    }
    if (!pickedList) return fail(`上游响应里没有找到图片：${safeRaw.slice(0, 300)}`);

    const files = [];
    let totalBytes = 0;
    for (const picked of pickedList) {
      let buf; let mime = picked.mime || '';
      if (picked.base64) {
        // 判官必修②:b64 分支同样要挡 —— base64 文本本身已进内存,再解一份 Buffer。
        if (picked.base64.length > MAX_IMAGE_BYTES * 1.4) {
          return fail(`图片过大（上限 ${MAX_IMAGE_BYTES / 1048576}MB）`);
        }
        buf = Buffer.from(picked.base64, 'base64');
        // r26-J13:字符串长度闸挡不住"编码前过小、解码后超限"(1.4 是粗估,非精确 4/3)——
        // 解码后的真实字节数再过一次上限闸(与二进制下载通道同值)。
        if (buf.length > MAX_IMAGE_BYTES) {
          return fail(`图片过大（解码后 ${Math.round(buf.length / 1048576)}MB，上限 ${MAX_IMAGE_BYTES / 1048576}MB）`);
        }
      } else {
        // 判官必修①(SSRF):这个 URL 是【上游回什么就是什么】,攻击者可控性最高的一处 ——
        // 而 baseURL 在上面刚过了 assertPublicBaseURL,这里原先一次都没过。实测能用
        // http://127.0.0.1:.../x.png(Content-Type: text/html) 把内网响应落成"图片"。
        // r22-⑤:光调 assertPublicBaseURL 还不够 —— 它默认【放行回环】(用户接本机
        // ComfyUI/one-api 是刻意支持的),所以上游回 http://127.0.0.1:<任意端口>/x.png
        // 时服务端照样会去请求,唯一拦住的只有事后的 Content-Type 检查。链路本地(169.254)
        // 与 302 跳转那两条是真拦住了,回环这条没有。
        // 但也不能一刀切禁回环:那会砍掉本机推理服务这个正当用法。区分点是【信任的是谁】——
        // 回环豁免属于用户自己填的那个 host:port,不属于"本机所有端口"。故同源才继承豁免,
        // 上游把链接指到本机别的端口 = 拿服务端当跳板探内网,一律拒绝。
        let sameOrigin = false;
        try {
          const u = new URL(picked.url); const b = new URL(provider.baseURL);
          // localhost 与 127.0.0.1 指的是同一个服务(用户填 localhost、本机服务回
          // 127.0.0.1 的链接很常见),端口相同即算同源;其余一律按 origin 严格比。
          const lo = (h) => /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|::1)$/i.test(h);
          sameOrigin = u.origin === b.origin || (lo(u.hostname) && lo(b.hostname) && u.port === b.port);
        } catch {}
        try { await assertPublicBaseURL(picked.url, { allowLoopback: sameOrigin }); }
        catch (e) { return fail(`拒绝下载该链接：${e.message}`); }
        let img;
        try {
          img = await undiciFetch(picked.url, {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
            // 判官必修①:默认跟随重定向 = 事后校验白做(302 到内网照样下)。手动挡下 3xx。
            redirect: 'manual',
            ...proxy,
          });
        } catch (e) {
          // 判官r57建议2:与生成分支同款拼 cause(代理死/DNS 失败时不再只报裸 fetch failed)。
          const cause = e?.cause?.code || e?.cause?.message || '';
          return fail(nodeFloorHint(e) || `下载生成的图片失败：${redactKey(e.message, provider.apiKey)}${cause ? `（${cause}）` : ''}`);
        }
        if (img.status >= 300 && img.status < 400) {
          return fail('上游图片链接发生跳转，已拒绝（防止绕过内网地址检查）');
        }
        if (!img.ok) return fail(`下载生成的图片失败：HTTP ${img.status}`);
        const ct = img.headers.get('content-type') || '';
        // 判官必修①:原先"Content-Type 不是图片但 URL 以 .png 结尾"也放行 —— 后缀是攻击者
        // 写的,不能当证据。这里只认 Content-Type。
        if (!/^image\//i.test(ct)) {
          return fail(`上游返回的链接不是图片（Content-Type: ${ct || '未知'}）`);
        }
        // 判官必修②:无上限地 arrayBuffer() 一个坏掉/恶意的上游 = 单进程后端 OOM
        // (实测 4×12MB 并发 → RSS 446MB,base64+JSON+Buffer 约 10x 放大)。
        const declared = Number(img.headers.get('content-length') || 0);
        if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
          return fail(`图片过大（${Math.round(declared / 1048576)}MB，上限 ${MAX_IMAGE_BYTES / 1048576}MB）`);
        }
        mime = ct;
        buf = Buffer.from(await img.arrayBuffer());
        if (buf.length > MAX_IMAGE_BYTES) {
          return fail(`图片过大（上限 ${MAX_IMAGE_BYTES / 1048576}MB）`);
        }
      }
      if (!buf.length) return fail('上游返回了空图片');

      let file;
      try { file = await saveImage(provider.savePath, buildImageFileName(prompt, imageExtFromMime(mime)), buf); }
      catch (e) {
        const msg = e?.code === 'ENOSPC' ? '磁盘空间不足，无法保存图片'
          : e?.code === 'EACCES' || e?.code === 'EPERM' ? '保存目录没有写入权限，请重新选择'
            : e?.code === 'ENOENT' ? '保存目录不存在，请重新选择'
              : `保存失败（${e?.code || 'unknown'}）`;
        return fail(msg);
      }
      files.push(file);
      totalBytes += buf.length;
    }
    // 取消是终态:图恰好在 abort 前拿到也不把条目翻回 done(用户看到的必须是他点的那个结果)。
    if (!cancelledJobs.has(jobId)) {
      await updateHistoryEntry(jobId, {
        status: 'done',
        file: files[0],
        previewUrl: `/api/image/preview?file=${encodeURIComponent(files[0])}`,
        bytes: totalBytes,
        ...(money || {}), // r87 实付(任务制上游才有;同步协议一个键都不多写)
        // 一图任务(同步三协议)到这里与 r82 之前逐字一致:files 长度为 1 时不写这个字段。
        // 多图任务(MJ 一次 4 张)才有 files —— file/previewUrl 仍指第一张,既有 UI 不用改。
        ...(files.length > 1 ? { files } : {}),
        tookMs: Date.now() - started,
      }).catch(() => {});
    }
  } catch (err) {
    // 兜底也要剥 key:异常消息可能带上 URL/头部回显。r26-J3:传真实 apiKey(字面替换),
    // 不再只靠 Bearer/api_key 形态兜底。
    await fail(redactKey(err.message, provider.apiKey || ''));
  } finally {
    activeJobs -= 1; // 无论成败都要还名额,否则跑几次就再也发不出新任务
    jobControllers.delete(jobId);
    cancelledJobs.delete(jobId);
  }
}

/**
 * r54 图生图:参考图入参解析。前置同步做 —— 任一张不合格一律 400,不进后台任务
 * (「填错了」要即时可见,不该沉进历史里等用户去翻)。
 * 返回 { error } 或 { refs, meta }:
 *  - refs 给协议层(含 base64,只在内存里活到请求发出);
 *  - meta 写进历史条目,【绝不含 base64】—— 历史文件是整条读给前端的,塞图片等于把
 *    ~/.claude-gui/image-history.json 撑成几十 MB 并且每次轮询都全量回传。
 * history 形态与「预览 / 在文件夹中显示」共用同一道闸(resolvePreviewPath 拒 `..` 段 +
 * 前缀比对 + 扩展名白名单,realPathInsideSaveDirs 再解一次软链复检):只许引用 savePath
 * 之下的图,防 `../../.ssh/id_rsa` 被当参考图读走再发给上游。
 */
async function resolveRefs(input, saveDirs) {
  if (input === undefined || input === null || input === '') return { refs: [], meta: null };
  if (!Array.isArray(input)) return { error: '参考图必须是数组' };
  if (!input.length) return { refs: [], meta: null };
  if (input.length > MAX_REFS) return { error: `参考图最多 ${MAX_REFS} 张` };
  const refs = [];
  const meta = [];
  for (const r of input) {
    if (!r || typeof r !== 'object') return { error: '参考图条目格式不正确' };
    if (r.kind === 'history') {
      const full = resolvePreviewPath(String(r.file || ''), saveDirs);
      if (!full || !realPathInsideSaveDirs(full, saveDirs)) {
        return { error: '参考图路径非法：只能引用已生成的图片（保存目录之内）' };
      }
      let buf;
      try {
        const st = await stat(full);
        if (st.size > MAX_REF_BYTES) return { error: `参考图过大（单张上限 ${MAX_REF_BYTES / 1048576}MB）` };
        buf = await readFile(full);
      } catch { return { error: '参考图文件不存在（可能已被移动或删除）' }; }
      const ext = extname(full).slice(1).toLowerCase();
      refs.push({ kind: 'history', name: basename(full), mime: IMAGE_CONTENT_TYPES[ext] || 'image/png', base64: buf.toString('base64') });
      meta.push({ kind: 'history', file: full });
      continue;
    }
    if (r.kind !== 'upload') return { error: '参考图类型必须是 upload 或 history' };
    const mime = String(r.mime || '').toLowerCase();
    if (!REF_UPLOAD_MIMES.includes(mime)) return { error: `参考图格式仅支持 ${REF_UPLOAD_MIMES.join(' / ')}` };
    if (typeof r.dataB64 !== 'string' || !r.dataB64) return { error: '参考图内容为空' };
    // 容忍整条 dataURI(前端只发 base64 段,但客户端写法走样时不该变成一坨乱码发给上游)。
    const b64 = r.dataB64.startsWith('data:') ? r.dataB64.slice(r.dataB64.indexOf(',') + 1) : r.dataB64;
    // 先按文本长度粗筛再解码:避免为了报"过大"先把一坨大 base64 解成 Buffer(内存已经吃了)。
    if (b64.length > MAX_REF_BYTES * 1.4) return { error: `参考图过大（单张上限 ${MAX_REF_BYTES / 1048576}MB）` };
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return { error: '参考图内容为空或不是合法的 base64' };
    if (buf.length > MAX_REF_BYTES) return { error: `参考图过大（单张上限 ${MAX_REF_BYTES / 1048576}MB）` };
    const name = String(r.name || 'image.png').slice(0, 80).replace(/[\\/\r\n"]+/g, '_');
    // 重新编码 = 顺手把折行/杂字符规整掉(发给上游的必须是干净 base64)。
    refs.push({ kind: 'upload', name, mime, base64: buf.toString('base64') });
    meta.push({ kind: 'upload', name });
  }
  return { refs, meta };
}

/**
 * POST /api/image/generate { providerId, prompt, refs? } → 受理任务,秒回 { jobId }。
 * 生成主体进 runImageJob 后台跑,状态与结果只经 GET /api/image/history 取。
 * 前置校验(provider / savePath / 请求组装 / SSRF)仍同步做:这些错误是"填错了",
 * 要即时可见,不该沉进后台历史里等用户去翻。
 */
router.post('/image/generate', async (req, res) => {
  // r26-J3:兜底 catch 也要剥 key —— provider 在 try 里才查到,先把 key 提到外层作用域,
  // 否则 catch 里 redactKey(msg, null) 只能靠形态兜底,明文 key 原样回显。
  let apiKeyForRedact = '';
  let counted = false; // 已占并发名额但任务还没起来 → 出错要还回去,否则名额永久漏光
  try {
    const { providerId, prompt } = req.body || {};
    const all = await readImageProviders();
    const provider = all.find((p) => p.id === providerId);
    if (!provider) return res.status(404).json({ error: '未找到该生图 provider' });
    apiKeyForRedact = provider.apiKey || '';
    const pathErr = await checkSavePath(provider.savePath);
    if (pathErr) return res.status(400).json({ error: pathErr });

    // 参考图(图生图):校验失败一律前置 400,不进后台任务。
    const resolved = await resolveRefs(req.body?.refs, all.map((p) => p.savePath));
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    let spec;
    try { spec = buildImageRequest(provider, prompt, resolved.refs); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    try { await assertPublicBaseURL(provider.baseURL); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

    // 并发闸:检查与自增之间没有 await,单线程下这一对是原子的(中间插一个 await
    // 就会出现两个请求都读到 2 然后都放行的窗口)。
    if (activeJobs >= MAX_CONCURRENT_JOBS) {
      return res.status(429).json({ error: `同时生成的任务已达 ${MAX_CONCURRENT_JOBS} 个上限，请等待任一任务完成` });
    }
    activeJobs += 1;
    counted = true;
    const jobId = randomUUID();
    const startedAt = Date.now();
    await addHistoryEntry({
      id: jobId,
      prompt: String(prompt || '').trim(),
      providerId: provider.id,
      providerName: provider.name || '',
      model: provider.model || '',
      size: provider.size || '',
      status: 'running',
      startedAt,
      // 只写摘要(kind + 文件名/路径),不写 base64 —— 历史文件不存图片内容。
      ...(resolved.meta ? { refs: resolved.meta } : {}),
    });
    // 立即返回:前端不再挂长连接。WKWebView 对 fetch 有约 60s 资源超时,而服务端最长等
    // 上游 120s —— 慢生成(4K 等)时前端先被掐断报 "Load failed",服务端其实已经出图。
    res.json({ ok: true, jobId });
    // fire-and-forget:任务与这次请求彻底脱钩,面板关掉/刷新都照跑。
    runImageJob({ jobId, provider, prompt, spec, startedAt }); // 名额由 runner 的 finally 归还
  } catch (err) {
    if (counted) activeJobs -= 1;
    res.status(500).json({ error: redactKey(err.message, apiKeyForRedact) });
  }
});

/**
 * POST /api/image/actions { jobId, action, index } — 对一条【已完成的 mj 任务】发起二次操作
 * (upscale = U1–U4 放大选图,variation = V1–V4 变体)。
 *
 * 与 /image/generate 是同一条流水线:组装 → 秒回 jobId → runImageJob 后台跑(提交响应
 * 与 imagine 逐字同形,轮询与下载一行不改)。差别只在请求组装换成 buildMjActionRequest,
 * 以及新条目带上「来自哪个任务的哪个动作」。
 *
 * 前置校验一律同步做(填错/点错要即时可见,不沉进历史):
 *  - 父条目必须存在、已完成、且【记了上游任务号】(r84 之前的老条目没有 taskId,不能操作);
 *  - provider 必须还在且是 mj 协议(换协议/删 provider 之后老条目上的按钮不能仍然能点);
 *  - index 与 action 的白名单在协议层(buildMjActionRequest 抛人话错误)。
 */
router.post('/image/actions', async (req, res) => {
  let apiKeyForRedact = '';
  let counted = false;
  try {
    const { jobId: parentId, action, index } = req.body || {};
    if (typeof parentId !== 'string' || !parentId) return res.status(400).json({ error: '请求格式不正确:缺少任务 id' });
    const parent = (await readHistory(MAX_HISTORY)).find((e) => e && e.id === parentId);
    if (!parent) return res.status(404).json({ error: '未找到该任务记录' });
    if (parent.status !== 'done') return res.status(400).json({ error: '只能对已完成的任务发起该操作' });
    if (!parent.taskId) return res.status(400).json({ error: '该记录没有保存上游任务号（早于本功能的记录），请重新生成一次后再操作' });

    const all = await readImageProviders();
    const provider = all.find((p) => p.id === parent.providerId);
    if (!provider) return res.status(404).json({ error: '该任务所用的生图 provider 已被删除' });
    if (provider.protocol !== 'mj') return res.status(400).json({ error: '该操作仅适用于 Midjourney 协议的 provider' });
    apiKeyForRedact = provider.apiKey || '';
    const pathErr = await checkSavePath(provider.savePath);
    if (pathErr) return res.status(400).json({ error: pathErr });

    let spec;
    try { spec = buildMjActionRequest(provider, action, index, parent.taskId); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    try { await assertPublicBaseURL(provider.baseURL); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

    // 与 /image/generate 同一个并发闸(检查与自增之间没有 await)。
    if (activeJobs >= MAX_CONCURRENT_JOBS) {
      return res.status(429).json({ error: `同时生成的任务已达 ${MAX_CONCURRENT_JOBS} 个上限，请等待任一任务完成` });
    }
    activeJobs += 1;
    counted = true;
    const jobId = randomUUID();
    const startedAt = Date.now();
    const prompt = String(parent.prompt || '').trim();
    await addHistoryEntry({
      id: jobId,
      prompt,
      providerId: provider.id,
      providerName: provider.name || '',
      model: provider.model || '',
      size: provider.size || '',
      status: 'running',
      startedAt,
      // 可追溯:这条图是从哪条任务的第几张、做了什么动作来的。
      parentId,
      mjAction: action,
      mjIndex: spec.body.index,
    });
    res.json({ ok: true, jobId });
    runImageJob({ jobId, provider, prompt, spec, startedAt }); // 名额由 runner 的 finally 归还
  } catch (err) {
    if (counted) activeJobs -= 1;
    res.status(500).json({ error: redactKey(err.message, apiKeyForRedact) });
  }
});

/**
 * POST /api/image/jobs/:id/cancel — 取消一个还在跑的生成任务。
 *  - 仍在跑 → 打取消标志 + abort 上游请求 + 条目落 status:'cancelled' → { ok:true };
 *    并发名额由 runner 的 finally 归还(与正常结束同一条路径)。
 *  - 已终态 / 不存在 → { ok:false, error }(200,幂等 —— 用户手快点两下不该看到报错)。
 * 只作用于点名的那一个 jobId:controller 是 per-job 的,不存在"取消一个停一片"。
 */
router.post('/image/jobs/:id/cancel', async (req, res) => {
  const id = String(req.params.id || '');
  const controller = jobControllers.get(id);
  // 有登记 = 本进程里还在跑(runner 的 finally 会删掉)。
  if (!controller) return res.json({ ok: false, error: '该任务已结束或不存在' });
  // 先打标志再 abort:runner 的 fail() 同步读它,顺序反了会先写成 error 再被看见。
  cancelledJobs.add(id);
  try { controller.abort(); } catch { /* 已 abort:幂等 */ }
  await withHistory((list) => {
    const e = list.find((x) => x && x.id === id);
    if (!e) return { list: null, result: false }; // 条目已被裁掉:标志位照旧挡住 error 覆写
    e.status = 'cancelled';
    e.error = '';
    e.tookMs = Date.now() - (e.startedAt || Date.now());
    return { list, result: true };
  }).catch(() => {});
  res.json({ ok: true });
});

/**
 * POST /api/image/history/delete { ids:[…], deleteFile?:boolean } — 删除历史记录(单删与
 * 批量同一个端点,单删就是数组只有一个元素)。
 *  - running 条目先走取消(复用上面那条链路:标志位 + abort),名额仍由 runner 的 finally 归还;
 *  - 条目移除在 withHistory 串行队列内完成 → 与并发的任务更新不会互相覆盖,原子落盘;
 *  - deleteFile 时【只 unlink 单个文件】,且每个文件必须过与预览同款的两道闸
 *    (resolvePreviewPath + realPathInsideSaveDirs)。守卫不过 = 跳过并记进 skipped:
 *    历史条目的 file 是一个可被改写的 JSON 字段,不能凭它对任意路径下删除动作。
 *    没有、也不许有任何目录级/递归删除。
 *  - r58 归因分两路:skipped = 守卫拒(路径不在保存目录之内),failed = unlink 真抛错
 *    (Windows 上文件被看图程序/缩略图缓存占着就是 EBUSY/EPERM)。两者成因与解法完全不同,
 *    混成一个数组会让前端把"文件被占用"说成"路径不对",用户被指去改配置。
 *    失败那条【记录留着不删】:记录与文件同生死 —— 记录先没了会变成文件还在磁盘上、
 *    用户既看不见也删不掉,只能自己去文件夹翻。整条留着 = 关掉占用的程序再点一次就好。
 */
router.post('/image/history/delete', async (req, res) => {
  const raw = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!raw) return res.status(400).json({ error: '请求格式不正确:ids 必须是数组' });
  const ids = [...new Set(raw.filter((x) => typeof x === 'string' && x))].slice(0, MAX_HISTORY);
  if (!ids.length) return res.status(400).json({ error: '请先选择要删除的记录' });
  const deleteFile = req.body?.deleteFile === true;
  // 还在跑的先掐掉:否则删完条目任务还在后台跑,写回时找不到条目(白跑一趟且占着名额)。
  for (const id of ids) {
    const controller = jobControllers.get(id);
    if (!controller) continue;
    cancelledJobs.add(id);
    try { controller.abort(); } catch { /* 已 abort:幂等 */ }
  }
  const saveDirs = (await readImageProviders()).map((p) => p.savePath);
  try {
    const result = await withHistory(async (list) => {
      const wanted = new Set(ids);
      const targets = list.filter((e) => e && wanted.has(e.id));
      const skipped = [];
      const failed = [];
      const keep = new Set(); // unlink 抛错的条目:这一轮不删记录,等用户解除占用后重删
      let filesDeleted = 0;
      if (deleteFile) {
        for (const e of targets) {
          if (!e.file) continue;
          const full = resolvePreviewPath(String(e.file), saveDirs);
          if (!full || !realPathInsideSaveDirs(full, saveDirs)) { skipped.push(e.file); continue; }
          try { await unlink(full); filesDeleted += 1; }
          catch (err) {
            if (err?.code === 'ENOENT') continue; // 文件早没了:不是失败,记录照删
            failed.push({ file: e.file, code: err?.code || '' });
            keep.add(e.id);
          }
        }
      }
      // 先 unlink 后算 next:失败的条目要原样留在列表里(keep)。
      const next = list.filter((e) => !(e && wanted.has(e.id) && !keep.has(e.id)));
      return { list: next, result: { removed: targets.length - keep.size, filesDeleted, skipped, failed } };
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/image/history?limit= — 出图历史(含 running 条目),新在前,上限 100 条。
 * 前端靠它做"重开面板恢复状态"与轮询;条目本就不存 apiKey,响应无 key 可漏。
 */
router.get('/image/history', async (req, res) => {
  const n = Number(req.query.limit);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_HISTORY) : MAX_HISTORY;
  try {
    res.json({ history: await readHistory(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/image/preview?file=<abs> — 回源图片给前端预览。
 * 只允许读【已配置 provider 的 savePath 之下】的图片:拒 `..` 段 + resolve 后前缀比对
 * + 扩展名白名单(见 resolvePreviewPath),防路径穿透读到 ~/.ssh 之类。
 */
/**
 * 判官必修③:resolvePreviewPath 是纯字面计算,不解软链 —— savePath 里预埋一个
 * `evil.png -> /外部/id_rsa` 就能把任意文件读走(判官实测 200 + 明文)。触发门槛很低:
 * 把 savePath 设成 ~/Downloads 再解压一个带软链的 zip 即可。本仓 safe-path.js 早就
 * 防过同一招(共享目录里预埋的 symlink),这里补齐。
 * IO 留在路由层是刻意的:image-protocols.js 头部声明了"零 IO 纯函数",不往里塞 fs。
 * 返回 true = 真实路径仍落在某个 savePath 之下。文件不存在交给上层的 404 分支。
 */
function realPathInsideSaveDirs(full, savePaths) {
  let real;
  try { real = realpathSync(full); } catch { return true; } // 不存在 → 交给 stat 报 404
  for (const root of savePaths) {
    if (typeof root !== 'string' || !root) continue;
    let realRoot;
    try { realRoot = realpathSync(root); } catch { continue; }
    if (real !== realRoot && isPathInside(real, realRoot)) return true;
  }
  return false;
}

router.get('/image/preview', async (req, res) => {
  const list = await readImageProviders();
  const saveDirs = list.map((p) => p.savePath);
  const full = resolvePreviewPath(String(req.query.file || ''), saveDirs);
  if (!full) return res.status(400).json({ error: '非法的预览路径' });
  if (!realPathInsideSaveDirs(full, saveDirs)) return res.status(400).json({ error: '非法的预览路径' });
  try { await stat(full); } catch { return res.status(404).json({ error: '文件不存在（可能已被移动或删除）' }); }
  const ext = extname(full).slice(1).toLowerCase();
  res.setHeader('Content-Type', IMAGE_CONTENT_TYPES[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  // dotfiles:'allow' —— 保存目录路径里可能有点开头的目录段(sendFile 默认整条拒)。
  res.sendFile(full, { dotfiles: 'allow' });
});

/**
 * POST /api/image/reveal { file } — 在访达/资源管理器里定位刚出的图。
 * 与预览同一道闸(resolvePreviewPath):只认 savePath 之下的图片,不接受任意路径。
 * 远程/手机访问时作用在【跑 server 的那台机器】(同 /api/reveal-path 的既有预期)。
 */
router.post('/image/reveal', async (req, res) => {
  const list = await readImageProviders();
  const revealDirs = list.map((p) => p.savePath);
  const full = resolvePreviewPath(String(req.body?.file || ''), revealDirs);
  if (full && !realPathInsideSaveDirs(full, revealDirs)) return res.status(400).json({ error: '非法的路径' });
  if (!full) return res.status(400).json({ error: '非法的文件路径' });
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileP = promisify(execFile);
    let cmd, args;
    if (process.platform === 'darwin') { cmd = 'open'; args = ['-R', full]; }
    else if (process.platform === 'win32') { cmd = 'explorer'; args = [`/select,${full}`]; }
    else { cmd = 'xdg-open'; args = [full.slice(0, full.lastIndexOf('/'))]; }
    // explorer 成功也常以非零码退出(Windows 三坑),不当失败。
    try { await execFileP(cmd, args, { timeout: 10000 }); }
    catch (e) { if (process.platform !== 'win32') throw e; }
    res.json({ ok: true });
  } catch (err) { res.status(err?.status || 500).json({ error: err.message }); }
});

export default router;
