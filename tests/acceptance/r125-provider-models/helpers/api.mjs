// r125 · 对共享隔离实例直调接口(只用 INTERFACE-r125 §A 公布的既有接口 + 探路实测的两条:
//   POST /api/custom-providers(建自定义 provider,形状 {name,type,baseURL,apiKey,models})、
//   POST /api/provider/switch {id}(切当前 provider;既有验收套件里已在用)。
//   R125_API_BASE / R125_HOME 由 run.sh 注入。
import fs from 'node:fs';
import path from 'node:path';
import { API_BASE, HOME_DIR } from './fixtures.mjs';

/** 可辨识的假 key(永不真连:baseURL 一律回环 + 无人监听的口)。 */
export const FAKE_KEY = 'sk-r125-not-a-real-key-0123456789';

export async function req(method, url, body, base = API_BASE()) {
  if (!base) throw new Error('R125_API_BASE 未设置(run.sh 负责)');
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, text, json };
}

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 建一个自定义 provider(OpenAI 兼容;基址指向回环上无人监听的口,绝不出网),返回接口回显(含 id)。 */
export async function createCustomProvider(overrides = {}, base = API_BASE()) {
  const body = { name: `r125 自定义 ${uniq()}`, type: 'openai', baseURL: 'http://127.0.0.1:9/v1', apiKey: FAKE_KEY, models: ['r125-old-a', 'r125-old-b'], ...overrides };
  const r = await req('POST', '/api/custom-providers', body, base);
  if (r.status !== 200) throw new Error(`建自定义 provider 失败:HTTP ${r.status} ${r.text.slice(0, 300)}`);
  const created = r.json?.provider ?? r.json;
  if (!created?.id) throw new Error(`建自定义 provider 的回显里没有 id:${r.text.slice(0, 300)}`);
  return created;
}

/** 切当前 provider。白名单为空的 provider 必须带 model(探路实测:不带报「provider 未配置任何模型,需手动指定 model」)。 */
export async function switchProvider(id, { model, base = API_BASE() } = {}) {
  const r = await req('POST', '/api/provider/switch', model ? { id, model } : { id }, base);
  if (r.status !== 200) throw new Error(`切换 provider ${id} 失败:HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}

export const getProviders = (base = API_BASE()) => req('GET', '/api/providers', undefined, base);
export const getProviderModels = (base = API_BASE()) => req('GET', '/api/provider-models', undefined, base);
export const putProviderModels = (id, models, base = API_BASE()) => req('PUT', `/api/provider-models/${encodeURIComponent(id)}`, { models }, base);
export const getModel = (base = API_BASE()) => req('GET', '/api/model', undefined, base);

/** 自定义 provider 当前落盘的白名单(INTERFACE B2:看 GET /api/providers 的 customProviders[].models)。 */
export async function customModelsOf(id, base = API_BASE()) {
  const r = await getProviders(base);
  const p = (r.json?.customProviders ?? []).find((x) => x.id === id);
  return p ? [...(p.models ?? [])] : null;
}

/** 当前 provider(GET /api/providers 里 isCurrent 的那条;自定义优先)。 */
export async function currentProvider(base = API_BASE()) {
  const r = await getProviders(base);
  return (r.json?.customProviders ?? []).find((p) => p.isCurrent)
    || (r.json?.providers ?? []).find((p) => p.isCurrent)
    || (r.json?.openaiProviders ?? []).find((p) => p.isCurrent)
    || null;
}

/** 官方 provider 的 id(既有套件的口径:category === 'official' || appType === 'claude' || format === 'claude')。 */
export async function officialProviderId(base = API_BASE()) {
  const r = await getProviders(base);
  const hit = (r.json?.providers ?? []).find((p) => p.category === 'official' || p.appType === 'claude' || p.format === 'claude' || /official/i.test(String(p.id)));
  return hit?.id ?? null;
}

// ---------------------------------------------------------------------------
// 生图 provider(INTERFACE B2:看 GET /api/image-providers 的 models)
// ---------------------------------------------------------------------------
/** 生图 provider 建项必填 savePath(探路实测:缺了报「保存路径必填」);落在隔离 HOME 之下。 */
export function newSaveDir(label = 'img', home = HOME_DIR()) {
  if (!home) throw new Error('R125_HOME 未设置(run.sh 负责)');
  const dir = path.join(home, 'images', `${label}-${uniq()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export async function createImageProvider(overrides = {}, base = API_BASE()) {
  const body = { name: `r125 生图 ${uniq()}`, protocol: 'openai', baseURL: 'http://127.0.0.1:9/v1', apiKey: FAKE_KEY, model: 'r125-img-old-a', models: ['r125-img-old-a', 'r125-img-old-b'], size: '1024x1024', savePath: overrides.savePath || newSaveDir('img'), ...overrides };
  const r = await req('POST', '/api/image-providers', body, base);
  if (r.status !== 200 || !r.json?.id) throw new Error(`建生图 provider 失败:HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}
export async function listImageProviders(base = API_BASE()) {
  const r = await req('GET', '/api/image-providers', undefined, base);
  const j = r.json;
  return Array.isArray(j) ? j : (j?.providers || j?.items || []);
}
export async function imageModelsOf(id, base = API_BASE()) {
  const p = (await listImageProviders(base)).find((x) => x.id === id);
  return p ? [...(p.models ?? [])] : null;
}
