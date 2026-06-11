import { Router } from 'express';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { claudeSpawn, cleanChildEnv } from './chat.js';

const router = Router();

// W7:官方订阅额度(claude-usage-monitor 功能整合,P0)。
// 做法照搬 monitor 的 UsageService:spawn `claude -p /usage --output-format json`,
// 正则提取 Anthropic 官方算好的三档百分比(5h 窗口 / 周·全模型 / 周·Sonnet)。
// 不调 usage API、不写死套餐档位(百分比由官方 /usage 输出,Pro/Max 通用);
// 非官方 provider 直接返回 official:false,前端整卡隐藏。
// env 必须走 cleanChildEnv —— 否则继承的 ANTHROPIC_* 覆盖钥匙串 OAuth,
// 官方登录态下也拿不到数字(spawn env 污染 / OAuth 优先级的既有坑)。
let cache = null; // { at, data }
const CACHE_MS = 60_000;

function isOfficial() {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    const base = String(s?.env?.ANTHROPIC_BASE_URL || '');
    return !base || /api\.anthropic\.com/.test(base);
  } catch { return true; }
}

// "<marker> …… NN% used · resets <文本>"。兼容纯文本 / JSON 包裹 / stream-json
// 三种输出形态(直接在整段原始输出上扫,marker 锚定各段)。
function matchSegment(text, marker) {
  const re = new RegExp(marker + '[\\s\\S]{0,300}?(\\d+)%\\s*used[\\s\\S]{0,120}?resets\\s*([^\\n"\\\\]+)', 'i');
  const m = text.match(re);
  return m ? { percent: parseInt(m[1], 10), resetText: m[2].trim() } : null;
}

router.get('/subscription-usage', async (_req, res) => {
  if (!isOfficial()) return res.json({ official: false });
  if (cache && Date.now() - cache.at < CACHE_MS) return res.json(cache.data);
  let proc;
  try {
    proc = claudeSpawn(['-p', '/usage', '--output-format', 'json'], {
      cwd: homedir(), stdio: ['ignore', 'pipe', 'pipe'], env: cleanChildEnv(),
    });
  } catch (e) { return res.json({ official: true, error: 'spawn failed: ' + e.message }); }
  if (!proc.pid) { proc.on('error', () => {}); return res.json({ official: true, error: 'claude CLI not found' }); }
  let out = '';
  let done = false;
  const finish = (data) => {
    if (done) return; done = true;
    clearTimeout(timer);
    try { proc.kill('SIGKILL'); } catch {}
    res.json(data);
  };
  const timer = setTimeout(() => finish({ official: true, error: '/usage 超时' }), 20000);
  proc.stdout.on('data', (c) => { out += c.toString(); });
  proc.on('close', () => {
    const data = {
      official: true,
      session: matchSegment(out, 'Current session'),
      weekAll: matchSegment(out, 'all models'),
      weekSonnet: matchSegment(out, 'Sonnet only'),
      fetchedAt: Date.now(),
    };
    if (!data.session && !data.weekAll && !data.weekSonnet) {
      data.error = '未能解析 /usage 输出（可能未登录官方订阅）';
    } else {
      cache = { at: Date.now(), data };
    }
    finish(data);
  });
  proc.on('error', (e) => finish({ official: true, error: e.message }));
});

export default router;
