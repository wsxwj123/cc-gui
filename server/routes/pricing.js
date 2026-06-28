// GET /api/pricing — LiteLLM 单价表(USD/1M tokens)。
// 数据源: BerriAI/litellm 的 model_prices_and_context_window.json(社区维护、
// 覆盖各家官方价,比手抄表新)。24h 内存+磁盘双缓存;拉取失败回退磁盘旧数据,
// 再失败返回 {},客户端自动回退内置表。只下发 chat 模型的四个字段,体积可控。
import { Router } from 'express';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const router = Router();

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_DIR = join(homedir(), '.claude-gui');
const CACHE_PATH = join(CACHE_DIR, 'litellm-prices.json');
const TTL_MS = 24 * 60 * 60 * 1000;

// 只保留这些 provider 的条目(其余几百个与 GUI 无关,徒增体积)
const KEEP_PROVIDERS = new Set([
  'anthropic', 'openai', 'gemini', 'deepseek', 'moonshot', 'xai',
  'vertex_ai-anthropic_models', 'minimax', 'zhipuai',
  // CQ批次3:扩国产 provider 覆盖(LiteLLM 有则下发,无则不匹配=零副作用)。
  'dashscope', 'volcengine', 'hunyuan', 'stepfun', 'siliconflow', 'baidu', 'fireworks_ai',
]);

let mem = null;        // { fetchedAt, prices }
let inflight = null;   // 并发去重

function slim(raw) {
  const out = {};
  for (const [name, e] of Object.entries(raw)) {
    if (!e || typeof e !== 'object') continue;
    if (e.mode !== 'chat') continue;
    if (!KEEP_PROVIDERS.has(e.litellm_provider)) continue;
    const input = e.input_cost_per_token;
    const output = e.output_cost_per_token;
    if (typeof input !== 'number' || typeof output !== 'number') continue;
    const M = 1_000_000;
    out[name] = {
      input: input * M,
      output: output * M,
      cacheRead: typeof e.cache_read_input_token_cost === 'number' ? e.cache_read_input_token_cost * M : input * M * 0.1,
      cacheWrite: typeof e.cache_creation_input_token_cost === 'number' ? e.cache_creation_input_token_cost * M : input * M * 1.25,
    };
  }
  return out;
}

function readDiskCache() {
  try { return JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch { return null; }
}

async function refresh() {
  const r = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('litellm fetch ' + r.status);
  const prices = slim(await r.json());
  if (!Object.keys(prices).length) throw new Error('litellm empty after filter');
  mem = { fetchedAt: Date.now(), prices };
  try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(CACHE_PATH, JSON.stringify(mem)); } catch {}
  return mem;
}

router.get('/pricing', async (_req, res) => {
  if (!mem) mem = readDiskCache();
  if (mem && Date.now() - (mem.fetchedAt || 0) < TTL_MS) {
    return res.json({ source: 'litellm', fetchedAt: mem.fetchedAt, prices: mem.prices });
  }
  try {
    inflight = inflight || refresh();
    const fresh = await inflight;
    inflight = null;
    return res.json({ source: 'litellm', fetchedAt: fresh.fetchedAt, prices: fresh.prices });
  } catch (e) {
    inflight = null;
    if (mem && mem.prices) {
      // 过期但可用:旧价比没价强
      return res.json({ source: 'litellm-stale', fetchedAt: mem.fetchedAt, prices: mem.prices });
    }
    return res.json({ source: 'none', error: String(e?.message || e), prices: {} });
  }
});

export default router;
