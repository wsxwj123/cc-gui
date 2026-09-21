// r126 · 对隔离实例直调接口。只用 INTERFACE-r126 §B/§C 点名的接口 + r125 套件已在用的既有接口:
//   GET /api/providers、POST/PUT/DELETE /api/custom-providers[/:id]、GET /api/provider-models、PUT /api/provider-models/:id、
//   GET/POST/PUT/DELETE /api/image-providers[/:id]、POST /api/provider/switch {id[,model]}(既有切换接口;INTERFACE C3 允许)。
// 所有基址都是用例自己起的隔离实例;绝不出网(baseURL 一律回环 + 无人监听的口)。
import fs from 'node:fs';
import path from 'node:path';
import { req } from './instance.mjs';
import { assertIsolated } from './fixtures.mjs';

export { req };

/** 可辨识的假 key(永不真连)。 */
export const FAKE_KEY = 'sk-r126-not-a-real-key-0123456789';
export const OFFICIAL = 'builtin-official';   // 内置官方 provider 的 id(r125 套件实测口径)

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const getProviders = (base) => req(base, 'GET', '/api/providers');

/** 自定义 provider 建项的标准请求体(OpenAI 兼容;基址指向回环上无人监听的口)。 */
export const customBody = (overrides = {}) => ({ name: `r126 自定义 ${uniq()}`, type: 'openai', baseURL: 'http://127.0.0.1:9/v1', apiKey: FAKE_KEY, models: ['r126-m1', 'r126-m2'], ...overrides });

/** 建一个自定义 provider,返回接口回显(含 id);失败抛错(前提不成立)。 */
export async function createCustomProvider(base, overrides = {}) {
  const r = await req(base, 'POST', '/api/custom-providers', customBody(overrides));
  if (r.status !== 200) throw new Error(`前提失败:建自定义 provider HTTP ${r.status} ${r.text.slice(0, 300)}`);
  const created = r.json?.provider ?? r.json;
  if (!created?.id) throw new Error(`前提失败:建自定义 provider 的回显里没有 id:${r.text.slice(0, 300)}`);
  return created;
}
export const postCustom = (base, body) => req(base, 'POST', '/api/custom-providers', body);
export const putCustom = (base, id, body) => req(base, 'PUT', `/api/custom-providers/${encodeURIComponent(id)}`, body);
export const deleteCustom = (base, id) => req(base, 'DELETE', `/api/custom-providers/${encodeURIComponent(id)}`);

export const getProviderModels = (base) => req(base, 'GET', '/api/provider-models');
export const putProviderModels = (base, id, models) => req(base, 'PUT', `/api/provider-models/${encodeURIComponent(id)}`, { models });

// ---------------------------------------------------------------------------
// 生图 provider(照 r123 / r125 套件:建项必填 savePath;落在隔离 HOME 之下)
// ---------------------------------------------------------------------------
export function newSaveDir(home, label = 'img') {
  assertIsolated(home);
  const dir = path.join(home, 'images', `${label}-${uniq()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export const imageBody = (home, overrides = {}) => ({ name: `r126 生图 ${uniq()}`, protocol: 'openai', baseURL: 'http://127.0.0.1:9/v1', apiKey: FAKE_KEY, model: 'r126-img-a', models: ['r126-img-a', 'r126-img-b'], size: '1024x1024', savePath: overrides.savePath || newSaveDir(home), ...overrides });
export async function createImageProvider(base, home, overrides = {}) {
  const r = await req(base, 'POST', '/api/image-providers', imageBody(home, overrides));
  if (r.status !== 200 || !r.json?.id) throw new Error(`前提失败:建生图 provider HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}
export const postImage = (base, body) => req(base, 'POST', '/api/image-providers', body);
export const putImage = (base, id, body) => req(base, 'PUT', `/api/image-providers/${encodeURIComponent(id)}`, body);
export const deleteImage = (base, id) => req(base, 'DELETE', `/api/image-providers/${encodeURIComponent(id)}`);
export async function listImageProviders(base) {
  const r = await req(base, 'GET', '/api/image-providers');
  const j = r.json;
  return { r, list: Array.isArray(j) ? j : (j?.providers || j?.items || []) };
}

// ---------------------------------------------------------------------------
// 切换 provider:INTERFACE C3 写的是「POST /api/providers/switch 或既有切换接口」。
// 先打既有的 /api/provider/switch(r125 套件实测存在);若它 404(被改名)再打 /api/providers/switch。返回体带 path 说明打的是哪条。
// ---------------------------------------------------------------------------
export async function switchProvider(base, body) {
  const a = await req(base, 'POST', '/api/provider/switch', body);
  if (a.status !== 404) return { ...a, path: '/api/provider/switch' };
  const b = await req(base, 'POST', '/api/providers/switch', body);
  return { ...b, path: '/api/providers/switch' };
}

/** GET /api/providers 里 kind 为某值的 warnings 项(warnings 缺失时按 [] 处理,便于反向断言)。 */
export const warningsOf = (json, kind) => (Array.isArray(json?.warnings) ? json.warnings : []).filter((w) => w && w.kind === kind);
export const corruptWarningFor = (json, fileName) => warningsOf(json, 'config-corrupt').find((w) => typeof w.file === 'string' && w.file.endsWith(fileName)) || null;
