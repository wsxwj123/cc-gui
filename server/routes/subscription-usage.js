import { Router } from 'express';
import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { claudeSpawn, cleanChildEnv } from './chat.js';
import { readClaudeOAuthToken } from './settings.js';
import { claudeCommand } from '../utils/claude-resolver.js';

const execFileP = promisify(execFile);
const router = Router();

// W7:官方订阅额度。数据来自 GET https://api.anthropic.com/api/oauth/usage —— 官方
// 自己算好的三档百分比(5h 窗口 / 周·全模型 / 周·当前限额模型),Pro/Max 通用,不写死套餐档位。
// 原实现 spawn `claude -p /usage` 抠文本:CLI 2.1+ 既慢(~14s 扫本地 session)又不再输出
// 百分比 → 已删除,不留 fallback(旧路径同样拿不到数字)。
// 非官方 provider 直接返回 official:false,前端整卡隐藏。
let cache = null; // { at, data } —— 最后一次成功的数据,401/429 降级时回放
const CACHE_MS = 60_000;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// 缺 `User-Agent: claude-code/<ver>` 会落入激进限流桶 → 持续 429。**前缀 claude-code/ 是关键**,
// 版本号只需大致跟上本机 CLI;探测失败时用这个常量兜底(定期更新)。
const UA_FALLBACK = 'claude-code/2.1.179';
let uaCached = '';
// ponytail:一次 `claude --version` 探测,进程生命周期内缓存(失败不缓存,下次再试)。
// 不 import version-check.js(另一批在改),也不值得为一个 UA 建第二套版本缓存。
async function userAgent() {
  if (uaCached) return uaCached;
  try {
    const { file, args } = claudeCommand(['--version']);
    const { stdout } = await execFileP(file, args, { timeout: 5000 });
    const m = String(stdout).match(/(\d+\.\d+\.\d+)/);
    if (m) uaCached = `claude-code/${m[1]}`;
  } catch { /* 探测不到就用常量 */ }
  return uaCached || UA_FALLBACK;
}

function isOfficial() {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    const base = String(s?.env?.ANTHROPIC_BASE_URL || '');
    return !base || /api\.anthropic\.com/.test(base);
  } catch { return true; }
}

// ISO8601 → "M月d日 HH:mm"(server 本地时区,前端直显不再二次格式化)。
function formatReset(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function roundPercent(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  return null;
}

/**
 * /api/oauth/usage 响应 → { session, weekAll, weekScoped }(纯函数,tests/unit 直接 import)。
 * 三段任一都解析不出返回 null(调用方据此报"无法解析")。
 * weekScoped 走 limits[kind==='weekly_scoped'],模型名取 scope.model.display_name ——
 * **不读 seven_day_sonnet 等固定字段**:服务端会随主力模型变更(现为 Fable,sonnet 字段恒 null)。
 */
export function parseOAuthUsage(raw) {
  let j;
  try { j = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const seg = (percent, iso, label) => (percent === null
    ? null
    : { percent, resetText: formatReset(iso), ...(label ? { label } : {}) });
  const scoped = Array.isArray(j.limits)
    ? j.limits.find((l) => l && l.kind === 'weekly_scoped')
    : null;
  const out = {
    session: seg(roundPercent(j.five_hour?.utilization), j.five_hour?.resets_at),
    weekAll: seg(roundPercent(j.seven_day?.utilization), j.seven_day?.resets_at),
    weekScoped: scoped
      ? seg(roundPercent(scoped.percent), scoped.resets_at,
        typeof scoped.scope?.model?.display_name === 'string' ? scoped.scope.model.display_name : '')
      : null,
  };
  return (out.session || out.weekAll || out.weekScoped) ? out : null;
}

// 走 curl 而非 fetch:继承 server 的 https_proxy(api.anthropic.com 常只能经代理可达),
// 与 settings.js probeOfficialModels 同款。token 经 curl 的 `--config -` 从 stdin 传入,
// **绝不进 argv / 进程表**。返回 { status, body }。
function fetchUsage(token, ua) {
  return new Promise((resolve, reject) => {
    const ch = spawn('curl',
      ['-sS', '--max-time', '15', '-w', '\n%{http_code}', '--config', '-', USAGE_URL]);
    let out = '', err = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { err += d; });
    ch.on('error', reject);
    ch.stdin.on('error', () => {}); // curl 早退 → EPIPE,不该炸进程
    ch.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `curl 退出码 ${code}`));
      const i = out.lastIndexOf('\n');
      resolve({ status: parseInt(out.slice(i + 1), 10) || 0, body: i < 0 ? '' : out.slice(0, i) });
    });
    ch.stdin.write(`header = "authorization: Bearer ${token}"\n`
      + 'header = "anthropic-beta: oauth-2025-04-20"\n'
      + 'header = "anthropic-version: 2023-06-01"\n'
      + `header = "User-Agent: ${ua}"\n`);
    ch.stdin.end();
  });
}

router.get('/subscription-usage', async (_req, res) => {
  if (!isOfficial()) return res.json({ official: false });
  if (cache && Date.now() - cache.at < CACHE_MS) return res.json(cache.data);
  const token = await readClaudeOAuthToken();
  if (!token) return res.json({ official: true, error: '未找到 Claude 登录凭证（请在 Claude Code 中登录）' });
  // curl config 的引号语法:含 " 或换行的 token 会破坏 header 行(理论上不会,信任边界仍拦一道)。
  if (/["\r\n]/.test(token)) return res.json({ official: true, error: '登录凭证格式异常' });

  let r;
  try {
    r = await fetchUsage(token, await userAgent());
  } catch (e) {
    return res.json({ official: true, error: '用量接口请求失败：' + e.message });
  }
  if (r.status !== 200) {
    // 401 = OAuth accessToken 的刷新窗口(CLI 一跑就刷新自愈)。**绝不自己刷 token** ——
    // 会轮转 refreshToken 把 CLI 的登录弄挂。429 = 限流。两者都拿上次数据温和降级。
    const soft = r.status === 401 || r.status === 429;
    const msg = r.status === 401 ? '凭证刷新中，显示上次数据（Claude Code 运行后自动恢复）'
      : r.status === 429 ? '接口限流中，显示上次数据（稍后自动恢复）'
        : `用量接口 HTTP ${r.status}`;
    if (soft && cache) return res.json({ ...cache.data, degraded: true, error: msg });
    return res.json({ official: true, error: msg });
  }
  const parsed = parseOAuthUsage(r.body);
  if (!parsed) return res.json({ official: true, error: '无法解析用量数据' });
  const data = { official: true, ...parsed, fetchedAt: Date.now() };
  cache = { at: Date.now(), data };
  res.json(data);
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
