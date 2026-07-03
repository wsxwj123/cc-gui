import { Router } from 'express';
import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
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
  // stderr 是 pipe 但只读 stdout —— 不排空则 stderr 超 ~64KB 子进程挂死到 20s 超时(v0.2.93 同类漏网)。
  proc.stderr?.resume();
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

// 使用报告(/insights)。CLI 内置 slash 命令 /insights 在 -p 模式下可直接执行:
// 它先把一份 HTML 报告写到 ~/.claude/usage-data/report-<时间戳>.html(同时刷新
// report.html),再输出一段带 file:// 路径的总结。这里 spawn `claude -p /insights`,
// 从 stdout 解析出 file:// 路径读回 HTML 内容返回前端(前端用 ArtifactPreview 预览)。
// env 走 cleanChildEnv;--dangerously-skip-permissions 让只读的会话分析在无 TTY 下
// 不被权限询问挂住(报告本身不触碰项目代码)。生成耗时较长,超时给 120s。
router.post('/insights-report', async (_req, res) => {
  let proc;
  try {
    proc = claudeSpawn(['-p', '/insights', '--dangerously-skip-permissions'], {
      cwd: homedir(), stdio: ['ignore', 'pipe', 'pipe'], env: cleanChildEnv(),
    });
  } catch (e) { return res.status(500).json({ error: 'spawn failed: ' + e.message }); }
  if (!proc.pid) { proc.on('error', () => {}); return res.status(500).json({ error: 'claude CLI not found' }); }
  // stderr 必须排空 —— 不读满 ~64KB 会挂死子进程(与 /usage 同坑)。
  proc.stderr?.resume();
  let out = '';
  let done = false;
  const finish = (status, data) => {
    if (done) return; done = true;
    clearTimeout(timer);
    try { proc.kill('SIGKILL'); } catch {}
    res.status(status).json(data);
  };
  const timer = setTimeout(() => finish(504, { error: '/insights 生成超时（120s）' }), 120_000);
  proc.stdout.on('data', (c) => { out += c.toString(); });
  proc.on('close', async () => {
    if (done) return;
    // 从输出里抓 file:///…report…​.html。抓不到则回退到稳定路径 report.html。
    const m = out.match(/file:\/\/(\/[^\s"'`]+\.html)/i);
    const htmlPath = m ? decodeURIComponent(m[1]) : join(homedir(), '.claude', 'usage-data', 'report.html');
    try {
      const html = await readFile(htmlPath, 'utf8');
      finish(200, { html, path: htmlPath });
    } catch (e) {
      finish(500, { error: '未找到生成的报告文件：' + e.message });
    }
  });
  proc.on('error', (e) => finish(500, { error: e.message }));
});

export default router;
