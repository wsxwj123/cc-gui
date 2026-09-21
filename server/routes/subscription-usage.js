import { Router } from 'express';
import { readFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { claudeSpawn, cleanChildEnv } from './chat.js';
import { readOfficialUsage, simpleHash } from '../utils/cli-official.js';

const router = Router();

// ── 官方订阅额度(W7 → R28 重写)────────────────────────────────────────────
// 数据来自 CLI 自己的 /usage 控制通道(见 utils/cli-official.js):GUI 不读订阅 token、
// 不拼 OAuth HTTP、不冒充 CLI User-Agent。CLI 说"plan 限额不适用"(API key / Bedrock /
// Vertex / 第三方中转)就如实报 not-subscribed,绝不拿 0 充数;r122 起若它同时报回的账户
// 信息是"未识别 + oauth-or-none"则报 not-logged-in(CLI 没登录,不是账户没订阅)。
//
// 60 秒正/负缓存:成功与失败都缓存。命中同一「查询模式+provider 范围」键的并发请求合并成
// 一次(chat-done 与 120s 轮询会同时打进来);失败也冷却,否则限流期会被自己的轮询加长。
const CACHE_MS = 60_000;
const cache = new Map();   // key -> { at, data }
const lastGood = new Map(); // key -> 上一次成功的数据(stale 降级用)
const inflight = new Map(); // key -> Promise(同键并发合并)

export const SOURCE = 'official-sdk-experimental';

// 当前 provider 说"我是官方"吗。判据与旧实现一致:settings.json 的 ANTHROPIC_BASE_URL
// 没设或指向 api.anthropic.com。这个门只决定「不 probe 的自动查询要不要真去问 CLI」。
export function isOfficial() {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    const base = String(s?.env?.ANTHROPIC_BASE_URL || '');
    return !base || /api\.anthropic\.com/.test(base);
  } catch { return true; }
}

// 「认证来源/提供方」范围键:切 provider 或改 base URL 立即换键 = 不吃上一个来源的数据。
// 残余边界:换的只是 Claude 账户(provider/env 都不动)时,只能等下一次真查询(≤60s)
// 由 CLI 报回的新 accountScope 体现 —— 更早发现就得去读本地凭证,而合同禁止。
function providerKey() {
  let base = '';
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    base = String(s?.env?.ANTHROPIC_BASE_URL || '');
  } catch { /* 读不到按空处理 */ }
  let id = '';
  try {
    id = String(JSON.parse(readFileSync(join(homedir(), '.claude-gui', 'active-provider.json'), 'utf8'))?.id || '');
  } catch { /* 老装机没有这个文件 */ }
  return `${simpleHash(base)}:${id}`;
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
  if (typeof v === 'number' && Number.isFinite(v)) return Math.min(100, Math.max(0, Math.round(v)));
  return null;
}

function validTime(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

// 一段额度窗口 → 合同的三段形态。percent 缺失(utilization 为 null)整段记 null,
// 不写 0 —— 0 是"已用 0%",与"不知道"是两件事。
function segment(window) {
  if (!window || typeof window !== 'object') return null;
  const percent = roundPercent(window.utilization);
  if (percent === null) return null;
  return { percent, resetAt: validTime(window.resets_at), resetText: formatReset(window.resets_at) };
}

/**
 * CLI 控制响应的 rate_limits → { session, weekAll, weekScoped, modelScoped }(纯函数,单测直 import)。
 * weekScoped 取服务端 limits[] 来的 model_scoped 首项(名字跟服务端走),没有就退到
 * seven_day_sonnet / seven_day_opus —— 不写死具体模型名。
 */
export function parseCliUsageWindows(rateLimits) {
  const empty = { session: null, weekAll: null, weekScoped: null, modelScoped: [] };
  if (!rateLimits || typeof rateLimits !== 'object') return empty;
  const scoped = Array.isArray(rateLimits.model_scoped) ? rateLimits.model_scoped.filter((s) => s && typeof s === 'object') : [];
  const modelScoped = scoped.map((s) => {
    const seg = segment(s);
    if (!seg) return null;
    return { ...seg, label: typeof s.display_name === 'string' ? s.display_name : '' };
  }).filter(Boolean);
  let weekScoped = modelScoped[0] || null;
  if (!weekScoped) {
    const fallback = ['seven_day_sonnet', 'seven_day_opus']
      .map((key) => (segment(rateLimits[key]) ? { ...segment(rateLimits[key]), label: key === 'seven_day_sonnet' ? 'Sonnet' : 'Opus' } : null))
      .find(Boolean);
    weekScoped = fallback || null;
  }
  return {
    session: segment(rateLimits.five_hour),
    weekAll: segment(rateLimits.seven_day),
    weekScoped,
    modelScoped,
  };
}

const UNIDENTIFIED_SCOPE = { kind: 'official-cli', scopeId: 'unidentified', authKind: 'unknown', subscription: null };

/**
 * r122(用户 2026-09-21):CLI 说"plan 限额不适用"时,再看它自己报回的账户信息 —— 没有账户身份、
 * 没有订阅类型、认证类别是 oauth-or-none(SDK tokenSource 为 'none')= 这台机器的 CLI 根本没登录,
 * 而不是"该账户没有订阅"。判据**只用 CLI 报回的 accountScope**,不读本机凭据(本路由既有约定)。
 * scope 缺失(UNIDENTIFIED_SCOPE 的 authKind 是 'unknown')不算未登录:拿不到账户信息时维持原判。
 */
export function isCliNotLoggedIn(scope) {
  if (!scope || typeof scope !== 'object') return false;
  return scope.scopeId === 'unidentified' && scope.authKind === 'oauth-or-none' && !scope.subscription;
}

/**
 * 非官方 provider 且不 probe 的答案:不查、不猜。字段齐全(合同要求),三段额度一律 null,
 * official:false —— 不拿第三方额度冒官方,也不用 0 冒充"没查到"。
 * fetchedAt = 本次判定时间(该答案也在 60s 缓存里,同窗口内两次读数不许抖)。
 */
function notApplicablePayload(fetchedAt) {
  return {
    official: false,
    status: 'unavailable',
    source: SOURCE,
    fetchedAt,
    accountScope: UNIDENTIFIED_SCOPE,
    session: null,
    weekAll: null,
    weekScoped: null,
    code: 'NOT_OFFICIAL_PROVIDER',
    error: '当前 provider 不是官方订阅（未查询官方额度）；如需探测官方 CLI 是否有订阅，用 ?probe=1',
  };
}

/** 用一次 CLI 查询结果 + 同键旧值,组装合同响应。 */
export function buildQuotaPayload({ result, previous, fetchedAt }) {
  const base = {
    official: false,
    source: SOURCE,
    fetchedAt,
    accountScope: previous?.accountScope || UNIDENTIFIED_SCOPE,
    session: null,
    weekAll: null,
    weekScoped: null,
  };
  if (result.ok) {
    const value = result.value;
    const scope = value.scope || UNIDENTIFIED_SCOPE;
    if (!value.rateLimitsAvailable) {
      if (isCliNotLoggedIn(scope)) {
        // r122:CLI 未登录任何官方账户 —— 把它说成"该账户没有订阅额度"会误导走订阅的用户
        // (Claude 桌面应用里的登录 CLI 看不到)。明说未登录 + 给办法。
        return {
          ...base,
          status: 'not-logged-in',
          accountScope: scope,
          code: 'NOT_LOGGED_IN',
          error: '官方 CLI 未登录任何账户（CLI 报告 plan 限额不适用且账户未识别）；在终端运行 claude auth login 后重试',
        };
      }
      // CLI 明说 plan 限额不适用(API key / Bedrock / Vertex / 第三方中转)= 没有官方订阅额度。
      return {
        ...base,
        status: 'not-subscribed',
        accountScope: scope,
        code: 'NOT_SUBSCRIBED',
        error: '该账户/会话没有可用的官方订阅额度（CLI 报告 plan 限额不适用）',
      };
    }
    const windows = parseCliUsageWindows(value.rateLimits);
    if (!windows.session && !windows.weekAll && !windows.weekScoped) {
      // 说"限额适用"却给不出任何一段:CLI 响应形态变了,如实报字段变动,不显示 0。
      return {
        ...base,
        status: 'unavailable',
        accountScope: scope,
        code: 'CLI_RESPONSE_INVALID',
        error: 'CLI 用量响应里没有可解析的额度窗口',
      };
    }
    return {
      ...base,
      official: true,
      status: 'available',
      accountScope: scope,
      ...windows,
    };
  }
  // 失败路径:有同账户旧值 → stale(旧值 + 上次成功时间 + 原因),无旧值 → unavailable。
  const code = result.code || 'CLI_UNAVAILABLE';
  const reason = `${code}: ${result.message || '官方 CLI 查询失败'}`;
  if (previous) {
    return {
      ...previous,
      status: 'stale',
      degraded: true,
      fetchedAt: previous.fetchedAt, // 旧值的时间:陈旧就明说陈旧
      reason,
      code,
      error: `显示上次数据（${reason}）`,
    };
  }
  // 没查到任何官方数据:official 只能是 false —— 不能因为当前 provider 是官方就假装有额度。
  return {
    ...base,
    official: false,
    status: 'unavailable',
    code,
    error: reason,
  };
}

async function quotaFor(probe) {
  const key = `${probe ? 'probe' : 'auto'}:${providerKey()}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.data;
  if (inflight.has(key)) return inflight.get(key);
  const pending = (async () => {
    const result = await readOfficialUsage();
    const data = buildQuotaPayload({
      result, previous: lastGood.get(key), fetchedAt: new Date().toISOString(),
    });
    cache.set(key, { at: Date.now(), data });
    if (data.status === 'available') lastGood.set(key, data);
    return data;
  })();
  inflight.set(key, pending);
  try {
    return await pending;
  } finally {
    inflight.delete(key);
  }
}

async function notApplicable() {
  const key = `auto:${providerKey()}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.data;
  const data = notApplicablePayload(new Date().toISOString());
  cache.set(key, { at: Date.now(), data });
  return data;
}

router.get('/subscription-usage', async (req, res) => {
  // probe=1 问的是"这台机器是否存在官方订阅"(OAuth 凭证是机器级的,与当前挂着哪个
  // provider 无关)→ 那道门只对不 probe 的自动查询生效;带 probe 必须真去问 CLI。
  const probe = Boolean(req.query.probe);
  const officialCurrent = isOfficial();
  if (!probe && !officialCurrent) return res.json(await notApplicable());
  const data = await quotaFor(probe);
  res.json(data);
});

// 从 CLI stdout 里抓 file:///…​.html 换成候选本地路径(按顺序试读,先能读到的算数)。
// 抓不到就只给稳定回落路径 —— 单个候选读不到时不再直接 500,继续试下一个。
//
// Windows 上 CLI 打印的是 file:///C:/Users/…/report.html:捕获组拿到的是 /C:/Users/…
// (带一个前导斜杠),那不是盘符路径,readFile 必失败;所以命中盘符形态时剥掉前导斜杠。
// mac 上捕获的 /Users/… 就是本地路径,原样返回(既有行为不动)。
export function insightsReportCandidates(out, home = homedir()) {
  const fallback = join(home, '.claude', 'usage-data', 'report.html');
  const m = String(out || '').match(/file:\/\/(\/[^\s"'`]+\.html)/i);
  if (!m) return [fallback];
  let captured = m[1];
  try { captured = decodeURIComponent(captured); } catch { /* 非法百分号编码:按原文试读 */ }
  if (/^\/[A-Za-z]:[\\/]/.test(captured)) captured = captured.slice(1); // /C:/x → C:/x
  return captured === fallback ? [fallback] : [captured, fallback];
}

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
    // 逐个候选试读:抓到的路径读不到时,继续回落稳定路径 report.html(命中正则就不再回落
    // 是 Windows 上 500 的成因之一);全读不到才报错,错误文案保持原样。
    let lastErr = null;
    for (const htmlPath of insightsReportCandidates(out)) {
      try {
        const html = await readFile(htmlPath, 'utf8');
        return finish(200, { html, path: htmlPath });
      } catch (e) { lastErr = e; }
    }
    finish(500, { error: '未找到生成的报告文件：' + lastErr.message });
  });
  proc.on('error', (e) => finish(500, { error: e.message }));
});

export default router;
