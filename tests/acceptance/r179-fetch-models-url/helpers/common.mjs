// r179 · 各用例共用的常量与「经保存接口预置条目」的小工具。只走对外接口(HTTP)与隔离家目录里的数据文件。
import fs from 'node:fs';
import path from 'node:path';
import { req } from './instance.mjs';

export const MSG = '接口地址已改动，已保存的密钥只会发往已保存的地址。要按新地址拉取模型，请重新填写密钥，或先保存再拉取。';
export const STORED_KEY = 'sk-r179-STORED-key-aaaa1111';
export const NEW_KEY = 'sk-r179-NEWREQ-key-bbbb2222';
export const TEXT_FETCH = '/api/custom-providers/fetch-models';
export const IMAGE_FETCH = '/api/image-providers/fetch-models';

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 经 POST /api/custom-providers 建文本 Provider,返回 id。 */
export async function createText(base, { name, type = 'openai', baseURL, apiKey = STORED_KEY, models = ['m-placeholder'] }) {
  const r = await req(base, 'POST', '/api/custom-providers', { name: name || `r179 文本 ${uniq()}`, type, baseURL, apiKey, models });
  if (r.status !== 200) throw new Error(`建文本 Provider 失败:HTTP ${r.status} ${r.text.slice(0, 300)}`);
  const id = (r.json?.provider ?? r.json)?.id;
  if (!id) throw new Error(`建文本 Provider 的回显里没有 id:${r.text.slice(0, 300)}`);
  return id;
}

/** 经 POST /api/image-providers 建生图 Provider,返回 id。savePath 由调用方给(必须是已存在可写的绝对目录)。 */
export async function createImage(base, { name, protocol = 'openai', baseURL, apiKey = STORED_KEY, model = 'gpt-image-saved', savePath, proxyUrl }) {
  const body = { name: name || `r179 生图 ${uniq()}`, protocol, baseURL, apiKey, model, savePath };
  if (proxyUrl) body.proxyUrl = proxyUrl;
  const r = await req(base, 'POST', '/api/image-providers', body);
  if (r.status !== 200 || !r.json?.id) throw new Error(`建生图 Provider 失败:HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r.json.id;
}

export function newSaveDir(home, label = 'img') {
  const dir = path.join(home, 'images', `${label}-${uniq()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 在任意形状的 JSON 里按 id 找那个条目(存储文件的外层形状接口文件没写,所以递归找)。 */
export function findById(node, id) {
  if (Array.isArray(node)) { for (const x of node) { const r = findById(x, id); if (r) return r; } return null; }
  if (node && typeof node === 'object') {
    if (node.id === id) return node;
    for (const v of Object.values(node)) { const r = findById(v, id); if (r) return r; }
  }
  return null;
}

export const dataFile = (home, name) => path.join(home, '.claude-gui', name);
export const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
