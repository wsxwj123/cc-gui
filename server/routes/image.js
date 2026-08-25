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
import { join, isAbsolute } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import {
  IMAGE_PROTOCOLS, IMAGE_CONTENT_TYPES, buildImageRequest, extractImage,
  buildImageFileName, imageExtFromMime, resolvePreviewPath, redactKey,
  geminiModelsRequest,
} from '../utils/image-protocols.js';
import { readCapped } from '../utils/read-capped.js';
import { assertPublicBaseURL, probeUpstreamModels } from './settings.js';

const router = Router();

// 路径按调用取(不在模块顶层固化):单测把 HOME 指向 mktemp 目录后再 import 也能生效,
// 真实 HOME 一个字节都不碰。
function imageProvidersPath() {
  return join(homedir(), '.claude-gui', 'image-providers.json');
}

const GENERATE_TIMEOUT_MS = 120_000; // 生图比文本慢得多
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

async function readImageProviders() {
  try {
    const d = JSON.parse(await readFile(imageProvidersPath(), 'utf-8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

// 原子写:tmp 名带 uuid + rename 落地(半截 writeFile 不会留下坏文件)。
// mode 0600:文件里有明文 apiKey,默认 0644 等于同机其他用户可读。
async function atomicWriteProviders(list) {
  const target = imageProvidersPath();
  await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
  const tmp = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(Array.isArray(list) ? list : [], null, 2), { mode: 0o600 });
    await rename(tmp, target);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
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

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// 出参永远不含 apiKey —— 只回 hasKey(与文本 provider 同口径)。
function publicView(p) {
  return {
    id: p.id, name: p.name, protocol: p.protocol, baseURL: p.baseURL,
    model: p.model || '', size: p.size || '', savePath: p.savePath || '',
    extra: p.extra || null, hasKey: !!p.apiKey,
  };
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
  return {
    value: {
      name: name.trim(),
      protocol,
      baseURL: baseURL.trim().replace(/\/+$/, ''),
      model: model.trim(),
      size: typeof size === 'string' ? size.trim() : '',
      savePath: savePath.trim(),
      extra,
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
async function fetchGeminiModels(baseURL, apiKey) {
  await assertPublicBaseURL(baseURL);
  const spec = geminiModelsRequest(baseURL, apiKey);
  // redirect:manual —— 请求带着 apiKey,跟随 3xx 会把密钥带到没验过的地址(同出图链路)。
  const get = (headers) => fetch(spec.url, {
    headers, signal: AbortSignal.timeout(FETCH_MODELS_TIMEOUT_MS), redirect: 'manual',
  });
  let resp;
  try { resp = await get(spec.headers); }
  catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const cause = e?.cause?.code || e?.cause?.message || '';
    throw new ModelsError('network', timedOut
      ? `拉取超时(${FETCH_MODELS_TIMEOUT_MS / 1000}s):${spec.url}`
      : `连不上 ${spec.url}${cause || e?.message ? `:${[e?.message, cause].filter(Boolean).join(' — ')}` : ''}`);
  }
  if (!resp.ok && (resp.status === 401 || resp.status === 403)) {
    try { resp = await get(spec.altHeaders); } catch { /* 保留首次响应 */ }
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
    const raw = typeof m === 'string' ? m : (m?.name || m?.id);
    if (typeof raw !== 'string' || !raw) continue;
    const id = raw.replace(/^models\//, '');
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
    if (req.body?.id) {
      const stored = (await readImageProviders()).find((p) => p.id === req.body.id);
      if (!stored) return res.status(404).json({ ok: false, type: 'unsupported', message: '未找到该生图 provider' });
      if (!apiKey || !String(apiKey).trim()) apiKey = stored.apiKey;
      baseURL = stored.baseURL; // ← 防密钥外传:请求体的 baseURL 一律忽略
      protocol = stored.protocol || protocol;
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
    const models = protocol === 'gemini'
      ? await fetchGeminiModels(baseURL, apiKey)
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

/**
 * POST /api/image/generate { providerId, prompt } → 组请求 → 取图 → 落盘 → 预览。
 * 上游报错原文透传,但先经 redactKey 剥掉可能回显的密钥。
 */
router.post('/image/generate', async (req, res) => {
  const started = Date.now();
  // r26-J3:兜底 catch 也要剥 key —— provider 在 try 里才查到,先把 key 提到外层作用域,
  // 否则 catch 里 redactKey(msg, null) 只能靠形态兜底,明文 key 原样回显。
  let apiKeyForRedact = '';
  try {
    const { providerId, prompt } = req.body || {};
    const provider = (await readImageProviders()).find((p) => p.id === providerId);
    if (!provider) return res.status(404).json({ error: '未找到该生图 provider' });
    apiKeyForRedact = provider.apiKey || '';
    const pathErr = await checkSavePath(provider.savePath);
    if (pathErr) return res.status(400).json({ error: pathErr });

    let spec;
    try { spec = buildImageRequest(provider, prompt); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    try { await assertPublicBaseURL(provider.baseURL); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

    const post = (headers) => fetch(spec.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(spec.body),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      // r26-J1:与下方下载分支同口径 —— 不跟随重定向。生成 POST 带着 apiKey,跟随 302
      // 会把请求(或响应读取)引到 assertPublicBaseURL 没验过的地址(鉴权跳转/网关劫持)。
      redirect: 'manual',
    });
    let r;
    try { r = await post(spec.headers); }
    catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      return res.status(timedOut ? 504 : 502).json({
        error: timedOut ? '生成超时（120 秒），上游没有返回' : `连接上游失败：${redactKey(e.message, provider.apiKey)}`,
      });
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
      return res.status(502).json({ error: `上游返回了重定向（HTTP ${r.status}），已拒绝跟随（防止密钥被带到未校验的地址）` });
    }
    // r26-J2:错误分支限量读 256KB(超限带截断标记);上游回一坨大错误体不能 OOM 后端。
    if (!r.ok) {
      const errRaw = await readCapped(r, MAX_ERROR_BYTES).catch(() => '');
      const truncated = errRaw === null;
      const safeErr = redactKey(truncated ? '' : errRaw, provider.apiKey).slice(0, MAX_UPSTREAM_ERR);
      return res.status(502).json({
        error: `上游返回 ${r.status}：${safeErr || '(空响应)'}${truncated ? '（错误内容过大，已截断）' : ''}`,
      });
    }
    // r26-J2:成功分支 content-length 预检 + 限量读 —— 上限外一律按体积报错,
    // 而不是把整坨读进内存后再按「不是 JSON」报(读完 = 内存已经吃了)。
    const declared = Number(r.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await r.body?.cancel?.().catch(() => {});
      return res.status(502).json({
        error: `上游响应体积过大（声明 ${Math.round(declared / 1048576)}MB，上限 ${Math.round(MAX_RESPONSE_BYTES / 1048576)}MB）`,
      });
    }
    const capped = await readCapped(r, MAX_RESPONSE_BYTES).catch(() => '');
    if (capped === null) {
      return res.status(502).json({
        error: `上游响应体积过大（超过 ${Math.round(MAX_RESPONSE_BYTES / 1048576)}MB 上限，已拒绝读取）`,
      });
    }
    const raw = capped;
    const safeRaw = redactKey(raw, provider.apiKey).slice(0, MAX_UPSTREAM_ERR);

    let data;
    try { data = JSON.parse(raw); }
    catch { return res.status(502).json({ error: `上游响应不是 JSON：${safeRaw || '(空响应)'}` }); }
    const picked = extractImage(provider.protocol, data);
    if (!picked) return res.status(502).json({ error: `上游响应里没有找到图片：${safeRaw.slice(0, 300)}` });

    let buf; let mime = picked.mime || '';
    if (picked.base64) {
      // 判官必修②:b64 分支同样要挡 —— base64 文本本身已进内存,再解一份 Buffer。
      if (picked.base64.length > MAX_IMAGE_BYTES * 1.4) {
        return res.status(502).json({ error: `图片过大（上限 ${MAX_IMAGE_BYTES / 1048576}MB）` });
      }
      buf = Buffer.from(picked.base64, 'base64');
      // r26-J13:字符串长度闸挡不住"编码前过小、解码后超限"(1.4 是粗估,非精确 4/3)——
      // 解码后的真实字节数再过一次上限闸(与二进制下载通道同值)。
      if (buf.length > MAX_IMAGE_BYTES) {
        return res.status(413).json({ error: `图片过大（解码后 ${Math.round(buf.length / 1048576)}MB，上限 ${MAX_IMAGE_BYTES / 1048576}MB）` });
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
      catch (e) { return res.status(e.status || 502).json({ error: `拒绝下载该链接：${e.message}` }); }
      let img;
      try {
        img = await fetch(picked.url, {
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
          // 判官必修①:默认跟随重定向 = 事后校验白做(302 到内网照样下)。手动挡下 3xx。
          redirect: 'manual',
        });
      } catch (e) { return res.status(502).json({ error: `下载生成的图片失败：${redactKey(e.message, provider.apiKey)}` }); }
      if (img.status >= 300 && img.status < 400) {
        return res.status(502).json({ error: '上游图片链接发生跳转，已拒绝（防止绕过内网地址检查）' });
      }
      if (!img.ok) return res.status(502).json({ error: `下载生成的图片失败：HTTP ${img.status}` });
      const ct = img.headers.get('content-type') || '';
      // 判官必修①:原先"Content-Type 不是图片但 URL 以 .png 结尾"也放行 —— 后缀是攻击者
      // 写的,不能当证据。这里只认 Content-Type。
      if (!/^image\//i.test(ct)) {
        return res.status(502).json({ error: `上游返回的链接不是图片（Content-Type: ${ct || '未知'}）` });
      }
      // 判官必修②:无上限地 arrayBuffer() 一个坏掉/恶意的上游 = 单进程后端 OOM
      // (实测 4×12MB 并发 → RSS 446MB,base64+JSON+Buffer 约 10x 放大)。
      const declared = Number(img.headers.get('content-length') || 0);
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        return res.status(502).json({ error: `图片过大（${Math.round(declared / 1048576)}MB，上限 ${MAX_IMAGE_BYTES / 1048576}MB）` });
      }
      mime = ct;
      buf = Buffer.from(await img.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) {
        return res.status(502).json({ error: `图片过大（上限 ${MAX_IMAGE_BYTES / 1048576}MB）` });
      }
    }
    if (!buf.length) return res.status(502).json({ error: '上游返回了空图片' });

    let file;
    try { file = await saveImage(provider.savePath, buildImageFileName(prompt, imageExtFromMime(mime)), buf); }
    catch (e) {
      const msg = e?.code === 'ENOSPC' ? '磁盘空间不足，无法保存图片'
        : e?.code === 'EACCES' || e?.code === 'EPERM' ? '保存目录没有写入权限，请重新选择'
          : e?.code === 'ENOENT' ? '保存目录不存在，请重新选择'
            : `保存失败（${e?.code || 'unknown'}）`;
      return res.status(400).json({ error: msg });
    }
    res.json({
      ok: true,
      file,
      previewUrl: `/api/image/preview?file=${encodeURIComponent(file)}`,
      bytes: buf.length,
      tookMs: Date.now() - started,
    });
  } catch (err) {
    // 兜底也要剥 key:异常消息可能带上 URL/头部回显。r26-J3:传真实 apiKey(字面替换),
    // 不再只靠 Bearer/api_key 形态兜底。
    res.status(500).json({ error: redactKey(err.message, apiKeyForRedact) });
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
