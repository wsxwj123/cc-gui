import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, realpathSync, readdirSync } from 'fs';
import { resolveClaudeAsync, listClaudeInstallsAsync, getClaudeOverride, setClaudeOverride, getClaudeOverrideRaw, pauseClaudeOverride, winLivePathDirsAsync, classifyShim } from '../utils/claude-resolver.js';
import { scanAllTools, nodeMeets, NODE_MIN_MAJOR, probeNpm } from '../utils/env-scanner.js';
import { gfetch } from '../utils/github-fetch.js'; // r14-1:GitHub 直连失败/限流自动走本机代理
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir, homedir } from 'os';
import { execFile, spawn } from 'child_process';
import { createConnection } from 'net';
import { promisify } from 'util';
import { closeAllPersistentProcesses } from './chat.js';
import { updatePrefs } from './prefs.js'; // r26-C6:prefs 写统一走共享队列(契约 C-C6)
import { isLocalReq } from '../services/auth.js';

const execFileP = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(__dirname, '..', '..', 'package.json');
const router = Router();

// GitHub API 缓存。未认证 IP 限制 60 次/小时,用户频繁点"检查更新"或多台
// 设备同 IP 很容易撞 403 → 设 5 分钟 TTL 重用上次结果,即便 403 也回 200
// 旧数据,不让 UI 报错。
let cache = null;       // { tagName, htmlUrl, publishedAt, assets } 缓存的 GitHub 响应
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// 本地 bot 版判据(与 server/index.js 的 IS_LOCAL_BUILD 同口径,此处 bots.local.js 是
// 本文件的 sibling):前端自动更新 gate 用,防公开版自动更新覆盖带 bot 本地版。
const IS_LOCAL_BUILD = existsSync(join(__dirname, 'bots.local.js'));

function getCurrentVersion() {
  try { return JSON.parse(readFileSync(PKG_PATH, 'utf-8')).version || null; } catch { return null; }
}

// 简单语义版本对比 0.1.24 vs 0.1.23 — 前 3 段数字逐位比较;比较器只关心
// 我们自己的 vX.Y.Z 格式,不处理 pre-release 标签(本项目从不用)。
function semverGt(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

/**
 * GET /api/version-check
 * 比对本地 package.json 版本与 GitHub releases/latest tag。
 * 返回 { currentVersion, latestVersion, hasUpdate, htmlUrl, publishedAt, error? }。
 * 失败永远返回 200 — 前端只看 hasUpdate / error 字段决定 UI。
 */
// 从 tag_name 构造常用资产直链 — 当 GitHub 返回 403/empty assets 时兜底,确保
// 前端"一键下载并安装"按钮始终可用。直链模式即使 API 拒,Release 页面的资产
// 文件仍可直接 GET(走 CDN,不计 API rate limit)。
function buildFallbackAssets(version) {
  // r13-p2-23:资产名跟随 productName —— 0.2.303 改名 CC-GUI 后 CI 产物变成
  // CC-GUI_x.y.z_*,而这里原本写死 Claude.GUI_*,应用内「一键下载并安装」必 404。
  // Tauri 把产物名里的空格替换为 '.',CC-GUI 无空格故原样。旧版资产名保留为备选,
  // 让装着旧版的用户仍能下到(GitHub 上历史 release 用的是旧名)。
  const base = `https://github.com/wsxwj123/claude-gui/releases/download/v${version}`;
  const suffixes = ['aarch64.dmg', 'x64-setup.exe', 'x64_en-US.msi'];
  const out = [];
  for (const stem of ['CC-GUI', 'Claude.GUI']) {
    for (const sfx of suffixes) {
      const name = `${stem}_${version}_${sfx}`;
      out.push({ name, url: `${base}/${name}`, size: 0 });
    }
  }
  return out;
}

const GH_HEADERS = { 'User-Agent': 'claude-gui-version-check', 'Accept': 'application/vnd.github+json' };

// 退路:`releases/latest` 在"还没有已发布 release"时返回 404 —— CI 正在构建(~9min)、
// 或刚删了旧 release 的空窗,都会让它 404 → 检测彻底失效(用户报告的"显示最新/404")。
// 而 git **tag 一推上去就立刻存在**(不依赖 CI),所以退回看最大 semver tag,检测照常工作;
// 下载链接用 tag 直链兜底(buildFallbackAssets),CI 发布 DMG 后即可下。
async function fetchLatestTagSnap() {
  const r = await gfetch('https://api.github.com/repos/wsxwj123/claude-gui/tags?per_page=100', { headers: GH_HEADERS });
  if (!r.ok) { const err = new Error(`GitHub API ${r.status}`); err.status = r.status; throw err; }
  const arr = await r.json();
  const names = (Array.isArray(arr) ? arr : [])
    .map((t) => String(t.name || ''))
    .filter((n) => /^v?\d+\.\d+\.\d+$/.test(n));
  if (!names.length) throw new Error('GitHub 仓库没有符合 semver 的 tag');
  names.sort((a, b) => (semverGt(a.replace(/^v/, ''), b.replace(/^v/, '')) ? -1 : 1));
  const raw = names[0].replace(/^v/, '');
  return { tagName: `v${raw}`, htmlUrl: `https://github.com/wsxwj123/claude-gui/releases/tag/v${raw}`, publishedAt: null, assets: [] };
}

/**
 * r14-2:免代理的备用版本源 —— jsDelivr 的包元数据接口在墙内通常直连可达,
 * 不需要任何代理。GitHub API 直连失败且本机代理也不可用时用它兜底,
 * 至少让"有没有新版"这件事在任何网络下都问得出来(下载仍需 GitHub,
 * 届时前端给手动下载指引)。返回形状与 fetchGitHubLatest 一致。
 */
// r26-C3:jsDelivr 的版本号取自 git tag,可能带 v 前缀(本仓 tag 就是 v0.2.x)。
// 原样采用会拼出 `vv0.2.318` → htmlUrl 404。与 fetchLatestTagSnap(:88)同口径剥 v。
// 纯函数抽出供单测(export 仅为可单测)。
export function normalizeJsdelivrVersions(list) {
  const versions = (Array.isArray(list) ? list : [])
    .map((v) => String(v || '').replace(/^v/, ''))
    .filter((n) => /^\d+\.\d+\.\d+$/.test(n));
  if (!versions.length) return null;
  return versions.reduce((a, b) => (semverGt(b, a) ? b : a), versions[0]);
}

async function fetchJsdelivrLatest() {
  const r = await fetch('https://data.jsdelivr.com/v1/packages/gh/wsxwj123/claude-gui', {
    headers: { 'User-Agent': 'claude-gui-version-check' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`jsDelivr ${r.status}`);
  const d = await r.json();
  const versions = Array.isArray(d.versions) ? d.versions.map((v) => String(v.version || '')).filter(Boolean) : [];
  // 该接口按语义化版本降序返回,取第一个;仍做一次 semver 兜底比较防顺序变化。
  const latest = normalizeJsdelivrVersions(versions);
  if (!latest) throw new Error('jsDelivr 未返回版本');
  return { tagName: `v${latest}`, htmlUrl: `https://github.com/wsxwj123/claude-gui/releases/tag/v${latest}`, publishedAt: null, assets: [], viaMirror: true };
}

async function fetchGitHubLatest() {
  // r14-1:改走 gfetch —— 直连失败或匿名限流 403 时自动经本机代理重试。
  // 原来是裸 fetch,而 Node fetch 不读系统代理 → 墙内机器恒"检测不到更新"。
  const r = await gfetch('https://api.github.com/repos/wsxwj123/claude-gui/releases/latest', { headers: GH_HEADERS });
  if (r.status === 404) return await fetchLatestTagSnap(); // 无已发布 release → 退回看最新 tag
  if (!r.ok) {
    const err = new Error(`GitHub API ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const d = await r.json();
  return {
    tagName: String(d.tag_name || ''),
    htmlUrl: d.html_url || '',
    publishedAt: d.published_at || null,
    assets: Array.isArray(d.assets)
      ? d.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))
      : [],
  };
}

router.get('/version-check', async (req, res) => {
  const currentVersion = getCurrentVersion();
  if (!currentVersion) {
    return res.json({ currentVersion: null, error: '无法读取本地版本(package.json)' });
  }

  let snap;
  let staleError = null; // r14-1:用了旧缓存时的失败原因(前端可提示"结果可能过期")
  const now = Date.now();
  // TTL 内复用缓存,避开 GitHub 60/hr rate limit
  if (cache && now - cachedAt < CACHE_TTL_MS) {
    snap = cache;
  } else {
    try {
      snap = await fetchGitHubLatest();
      cache = snap;
      cachedAt = now;
    } catch (err) {
      // r14-2:GitHub(含本机代理回落)全败 → 免代理的 jsDelivr 兜底,
      // 让"没开代理的机器"也能知道有没有新版。
      try {
        snap = await fetchJsdelivrLatest();
        cache = snap;
        cachedAt = now;
      } catch { /* 镜像也失败 → 走下面的旧缓存/报错分支 */ }
      if (!snap) {
        // 403 / 网络失败 — 有旧缓存就用旧缓存(stale-while-error),没有就报错。
        // r14-1:失败原因必须可见 —— 原来静默复用旧缓存,用户只看到"没反应",
        // 分不清"真没新版"还是"连不上 GitHub"(墙内最常见)。
        const why = /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network/i.test(String(err.message || ''))
          ? '无法连接 GitHub 与备用源(墙内通常需要开启代理)'
          : (err.status === 403 ? 'GitHub 接口限流(匿名 60 次/小时),稍后重试' : (err.message || 'fetch failed'));
        if (cache) {
          snap = cache;
          staleError = why;
        } else {
          return res.json({ currentVersion, error: why });
        }
      }
    }
  }

  const latestRaw = snap.tagName.replace(/^v/, '');
  if (!latestRaw) return res.json({ currentVersion, error: 'GitHub 未返回 tag_name' });
  const hasUpdate = semverGt(latestRaw, currentVersion);
  // assets 为空(403 期间也可能拿到不完整数据)时用 tag 直链兜底
  const assets = snap.assets.length > 0 ? snap.assets : buildFallbackAssets(latestRaw);

  res.json({
    currentVersion,
    latestVersion: latestRaw,
    hasUpdate,
    ...(staleError ? { staleError } : {}),
    htmlUrl: snap.htmlUrl || `https://github.com/wsxwj123/claude-gui/releases/tag/v${latestRaw}`,
    publishedAt: snap.publishedAt,
    assets,
    // r26-C4:jsDelivr 镜像兜底源标记透传 —— 墙内用户拿到 assets 是 GitHub 直链,
    // 下载必败;前端见 viaMirror 显示手动下载指引。只增字段,旧前端忽略。
    ...(snap.viaMirror ? { viaMirror: true } : {}),
    // server 端 process.platform 比前端 navigator.userAgent 更可靠 — Tauri
    // WebView2/WKWebView 的 UA 在某些版本被改写过,前端单独靠 UA 选 asset
    // 可能 null → 按钮不渲染只剩手动链接(用户当前的体感问题)。
    serverPlatform: process.platform,
    // 本机 HTTP 代理(可能 null):前端 Tauri updater check({proxy}) 用。updater 的
    // Rust 侧下载不读系统代理,墙内直连 GitHub 常超时,探测到 Clash 等本机代理就透传。
    proxy: await detectLocalProxy().catch(() => null),
    // 本地 bot 版标记:true 时前端禁用自动更新(公开包不含 bots.local.js/FDA 签名)。
    localBuild: IS_LOCAL_BUILD,
  });
});

// ─── Claude Code CLI 版本检测 + 一键更新 ───────────────────────────────
let ccCache = null;       // claude-code 最新版本(native 渠道或 npm,按 ccCacheSrc 区分)
let ccCacheSrc = '';      // 'native' | 'npm' — 缓存来自哪个真源,防止跨源错用
let ccCachedAt = 0;

// 本机 claude 版本的内存缓存(按解析到的路径分键,不同安装各记各的)。版本号是强缓存
// 友好的数据(只有用户更新 claude 才变),而 `claude --version` 冷启动会偶发超时:npm shim
// 里再起一个 node、系统负载高、Windows 杀毒实时扫描。一次超时就报"读取版本超时"是误报,
// 有旧值就用旧值(下一次成功探测自动刷新)。
const ccVersionByPath = new Map();

async function getClaudeVersion(claudePath) {
  const cacheKey = claudePath || 'claude';
  try {
    // 优先用 detectInstall 解析到的绝对路径,确保"报告的版本"与"要更新的那个 claude"
    // 是同一个(否则 mac 上 login-shell PATH 与 Node 进程 PATH 顺序不同可能取到不同安装)。
    // `claude --version` → "2.1.160 (Claude Code)"，取首个 x.y.z
    // CI-1:Windows 上 npm 装的是 claude.cmd/.ps1 或 `where claude` 给的是无扩展名裸路径
    // (如 ...\npm\claude)——Node execFile **不能直接执行**它们(.cmd 抛 EINVAL、无扩展名抛
    // ENOENT),必须经 cmd.exe /c(cmd 会按 PATHEXT 把裸路径解析成 .cmd)。否则版本检测/环境
    // tab 永远 installed:false(用户报告:npm 装好仍扫不到)。与 cli-check.js 同款修法。
    // 超时 15s(原 8s):冷启动实测会偶发擦线,超时值比"回退旧值"更早生效,先给足时间。
    let stdout;
    if (process.platform === 'win32') {
      ({ stdout } = await execFileP('cmd.exe', ['/c', claudePath || 'claude', '--version'], { timeout: 15000 }));
    } else {
      ({ stdout } = await execFileP(claudePath || 'claude', ['--version'], { timeout: 15000 }));
    }
    const m = String(stdout).match(/(\d+\.\d+\.\d+)/);
    if (m) { ccVersionByPath.set(cacheKey, m[1]); return m[1]; }
    return ccVersionByPath.get(cacheKey) || null; // 输出没版本号(异常形态)→ 有旧值先顶着
  } catch (err) {
    // 只有【探测本身没跑成】才回退旧值:超时(execFile killed / ETIMEDOUT)、被信号杀、
    // 系统忙。二进制真没了(ENOENT/EACCES,用户卸载或换了安装方式)必须如实返回 null,
    // 否则缓存会让 GUI 一直报一个已经不存在的版本、"未安装"提示永远出不来。
    const transient = err?.killed === true
      || err?.signal != null
      || ['ETIMEDOUT', 'EBUSY', 'EAGAIN'].includes(err?.code);
    if (!transient) return null;
    return ccVersionByPath.get(cacheKey) || null;
  }
}

// 带代理回退的 GET:node fetch 不读系统代理,墙内直连 downloads.claude.ai 必失败
// → 探测本机代理端口后经 curl 重试(mac 自带、Win10+ 自带 curl.exe)。
async function httpGetText(url, headers = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) { const e = new Error(`HTTP ${r.status} (${new URL(url).host})`); e.status = r.status; throw e; }
    return await r.text();
  } catch (err) {
    const proxy = await detectLocalProxy().catch(() => null);
    if (!proxy) throw err;
    const { stdout } = await execFileP('curl', ['-fsSL', '--max-time', '15', '-x', proxy, url], { timeout: 20000 });
    return stdout;
  }
}

async function fetchNpmLatest() {
  const text = await httpGetText('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', { 'Accept': 'application/json' });
  return String(JSON.parse(text).version || '');
}

// 原生安装(claude update)的真源是官方下载渠道清单,不是 npm。两渠道发布有时间差
// (实测窗口期:本机原生 2.1.198 = 当时渠道最新,npm 已 2.1.199)→ 原生用户按 npm 比
// 会"永远差一版",红色更新按钮点了更新也不灭。native 只按本渠道比,失败就报错,
// **不回落 npm**(跨渠道比对必然造出"已是渠道最新却仍提示更新"的假阳性)。
async function fetchNativeLatest() {
  const v = String(await httpGetText('https://downloads.claude.ai/claude-code-releases/latest')).trim();
  if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error('原生渠道返回的版本号格式异常');
  return v;
}

// 检测 claude CLI 的安装方式 + 解析它的绝对路径。返回 { method, path, via }。
// 路径解析统一走 claude-resolver(PATH → login shell → npm 全局前缀 → 已知安装
// 路径),与 claudeSpawn / SDK / cli-check 同源 —— 报告版本、执行更新的都是 GUI
// 实际会用的那个安装。此处只负责按路径特征分类安装方式(native/brew/npm)。
// 按真实落点(解 symlink 后)把 claude 安装分类成 native/npm/brew。Windows 无软链概念,
// 直接用入口路径匹配;mac/linux 传 readlink -f 解析后的 target。
function classifyClaudePath(real) {
  if (process.platform === 'win32') {
    if (/AnthropicClaude|\\\.claude\\local|\\\.local\\bin|\\claude\\versions\\/i.test(real)) return 'native';
    if (/npm|node_modules|nodejs/i.test(real)) return 'npm';
    return 'native';  // 兜底按 native 自更新(claude update 在 Windows 亦支持)
  }
  if (/\/\.local\/(share|bin)\/claude|\/claude\/versions\//.test(real)) return 'native';
  if (/Caskroom|Cellar|\/brew\//i.test(real)) return 'brew';
  if (/node_modules|\/npm|\.nvm|\.npm-global|\/lib\/node/.test(real)) return 'npm';
  return 'unknown';
}

async function detectInstall() {
  // refresh:true 绕过 15s 负缓存 —— 本函数只被【用户显式检查】的端点调用(版本检查/env-check/
  // 安装列表)。GUI 更新/claude 重装期间二进制正被替换,一次解析落空就负缓存 15s,期间打开设置
  // 页会误显"未安装或不在 PATH"(用户实报:更新中断/完成后偶发未安装)。显式检查永远现场重解析;
  // 聊天 spawn 热路径仍走带缓存的 resolveClaude() 不受影响。
  const hit = await resolveClaudeAsync({ refresh: true });
  if (!hit) return { method: 'unknown', path: '', via: null };
  const real = hit.path;
  // 解析软链(~/.local/bin/claude → ~/.local/share/claude/versions/x.y.z)以便按
  // 真实落点分类;分类用 target,返回的 path 保留解析到的入口路径(可直接执行)。
  let target = real;
  if (process.platform !== 'win32') {
    try { const r = await execFileP('readlink', ['-f', real], { timeout: 5000 }); target = r.stdout.trim() || real; } catch {}
  }
  return { method: classifyClaudePath(target), path: real, via: hit.via };
}

// 按安装方式给出更新命令。native 用「绝对路径 + update」自更新,避免终端里裸 `claude`
// 解析到另一个安装(用户的 shell PATH 和 GUI 的 PATH 顺序可能不同)。
// ── r13-p2-20:更新渠道选择 ────────────────────────────────────────────
// 背景纠错:R8-1 把 npm 安装的更新一律导向原生 `claude update`,理由是"npm 慢源
// 半途而废"。用户实测反驳并复测确认:慢的是 registry.npmmirror.com 的元数据重定向
// (660 B/s),真正拉包的 cdn.npmmirror.com 是 2.23 MB/s,比原生二进制源(经代理
// 1.04 MB/s)快一倍 —— 对镜像源用户,npm 才是快的那条。
// 故改为可选:'npm' / 'native' 两项(与安装方式一一对应,不设第三种状态)。
// 未设过 = 跟随检测到的安装方式(内部空值,不在 UI 里占一格)。存 prefs.json。
const PREFS_FILE = join(homedir(), '.claude-gui', 'prefs.json');
export const UPDATE_CHANNELS = ['npm', 'native'];

/** 返回用户显式选择的渠道;没选过返回 null(= 跟随安装方式)。 */
export function readUpdateChannel() {
  try {
    const v = JSON.parse(readFileSync(PREFS_FILE, 'utf-8'))?.updateChannel;
    return UPDATE_CHANNELS.includes(v) ? v : null;
  } catch { return null; }
}

// r26-C6:写改走 prefs.js 的 updatePrefs 共享写函数(withPrefsQueue 串行化 + 原子写),
// 不再裸 readFileSync/writeFileSync 直写 —— 原来与 prefs 路由的队列写互踩,并发
// read-merge-write 丢一路(lost-update),且直写非原子(崩溃写一半 → 整份 prefs 损坏)。
// 签名变 async,调用点(PUT /claude-update-channel)await。channel=null = 删除键(r26-C5)。
export async function writeUpdateChannel(channel) {
  if (channel !== null && !UPDATE_CHANNELS.includes(channel)) return false;
  try {
    await updatePrefs((p) => {
      if (channel === null) delete p.updateChannel; // 删除而非写 null,回到「跟随安装方式」
      else p.updateChannel = channel;
    });
    return true;
  } catch { return false; }
}

// r26-C1:跨渠道判据(纯函数,export 供单测)。仅「显式 npm 渠道 × 非 npm 安装」算
// 跨渠道 —— 此时 `npm install -g` 会写进 npm 前缀的另一份安装,而 PATH 里先生效的
// 仍是当前安装。native 渠道 × npm 安装走 claude 自更新是官方支持路径,不算跨渠道。
export function isCrossChannel(channel, installMethod) {
  return channel === 'npm' && installMethod !== 'npm';
}

/** 渠道 + 安装方式 → 实际更新方式。未选过则跟随安装方式(npm 装的走 npm)。
 *  r26-C1:跨渠道组合(显式 npm 渠道 × 非 npm 安装)默认返回 null —— 不得静默给出
 *  'npm-registry'(那会把更新写进另一份安装,自检命中 PATH 旧版假成功);
 *  只有调用方带来显式确认回执(opts.allowCrossChannel === true,前端确认弹窗)才放行。 */
export function resolveUpdateMethod(channel, installMethod, { allowCrossChannel = false } = {}) {
  if (channel === 'npm') {
    if (installMethod === 'npm') return 'npm-registry';
    return allowCrossChannel ? 'npm-registry' : null;
  }
  if (channel === 'native') return 'native';
  return installMethod === 'npm' ? 'npm-registry' : installMethod;
}

/** UI 展示用:当前生效的渠道(未显式选择时回落安装方式)。 */
export function effectiveChannel(channel, installMethod) {
  return channel || (installMethod === 'npm' ? 'npm' : 'native');
}

// r26-C7:latest 的「真源」必须按生效渠道选,不是按安装方式。用户显式选了渠道后
// (如 npm 安装选 native 渠道),版本检查若仍按安装方式取 npm 源,看到的 latest 与
// 更新命令实际拉的源不一致 —— 「永远差一版」的变体。纯函数抽出供单测。
// r36:端点已不用它选【比较源】(见 compareSrcKey);保留导出与语义供既有单测引用。
export function resolveSrcKey(channel, installMethod) {
  return effectiveChannel(channel, installMethod) === 'native' ? 'native' : 'npm';
}

// r36-①:「要不要提醒更新」的比较源必须按【在用二进制自己的渠道】取,与显式渠道无关。
// r26-C7 让比较源跟显式渠道走,于是 currentVersion(在用二进制的版本)被拿去比另一渠道的
// latest —— 两渠道发布有时间差,原生装的已是原生最新仍红点提醒(用户实报),反之亦然。
// 渠道从此只管「更新走哪条管线 + 用哪个渠道的 claude」(见 pickChannelInstall),不参与比较。
// 一元签名是刻意的:渠道参数物理上进不来,想塞回去必须改签名。
export function compareSrcKey(installMethod) {
  return installMethod === 'npm' ? 'npm' : 'native';
}

// r36-②:选渠道 = 同时把 GUI 实际用的 claude 钉到该渠道的安装。挑选逻辑抽成纯函数
// (classify 可注入,单测不碰真实文件系统)。broken 壳包跳过 —— 钉死它之后所有 spawn 都会废
// (PUT /claude-active 同判)。目标渠道没有安装返回 null,由调用方保持现状并如实回执。
export function pickChannelInstall(channel, installs, classify = classifyClaudePath) {
  if (channel !== 'npm' && channel !== 'native') return null;
  for (const it of installs || []) {
    if (!it || it.broken) continue;
    if (classify(it.real || it.path) === channel) return it;
  }
  return null;
}

export function updateCmdFor(method, claudePath) { // export 仅为可单测
  switch (method) {
    // Y1:brew 渠道由社区维护、版本严重滞后(用户实测 latest 仅 1.5x,官方已 2.1.x),
    // `brew upgrade` 等于没更新。改为直接运行官方原生安装器:装到 ~/.local/bin,
    // GUI 的 PATH 前置使其优先于 brew 旧版,此后由 claude 自更新接管。
    case 'brew': return installCmdFor();
    // R8-1:npm 渠道已被官方降级为原生安装器引导壳(≥2.1.227 的 npm 包 bin 是引导 stub,
    // 真二进制来自 optionalDep 平台包)。再 `npm i -g` 会撞慢源半途而废的整条事故链
    // (npmmirror 对 81MB 平台包 16-20KB/s → GUI 更新流超时留僵尸 → bin 链未建 → 死安装)。
    // 更新改走原生渠道:`claude update` 自更新(npm 装的 claude 同样支持,装到 ~/.local 后
    // 由原生自更新接管)。用绝对路径防终端 PATH 解析到另一个安装;Windows 上 npm 的入口
    // 是 claude.cmd(批处理)—— .bat 里直调另一个 .cmd 控制权不返回,必须 call(同
    // installCmdFor 注释的坑);mac/linux 单引号防路径含空格/$。
    // r13-p2-20:'npm-registry' = 真的走 npm 更新(用户自己的 registry/镜像);
    // 平台包(真二进制)由 optionalDependencies 带下来,装完自检版本。
    // 'npm' 仍表示"npm 安装但走原生自更新"(渠道选 native 时命中)。
    case 'npm-registry': {
      // r26-C1:自检钉到刚装的那个安装。裸 `claude --version` 走 PATH 解析,native
      // 安装用户命中的是旧 native 版,0 退出码 → 「更新完成」但生效的是 npm 前缀里
      // 没人用的新安装(假成功)。改为直接验证 npm 全局前缀里的新二进制。
      // Windows .bat 捕获 `npm prefix -g` 输出需 for /f,过于脆弱 —— Win 保持
      // call claude --version,跨渠道风险由前端 crossChannel 确认弹窗明示。
      const verify = process.platform === 'win32'
        ? 'call npm install -g @anthropic-ai/claude-code@latest && call claude --version'
        : 'npm install -g @anthropic-ai/claude-code@latest && "$(npm prefix -g)/bin/claude" --version';
      return verify;
    }
    case 'npm': {
      if (process.platform === 'win32') {
        return claudePath ? `call "${claudePath}" update` : 'call claude update';
      }
      return claudePath ? `'${claudePath.replace(/'/g, `'\\''`)}' update` : 'claude update';
    }
    case 'native':
    default: {
      // update 与 upgrade 是同一命令的别名;用 upgrade(用户实测 Windows 上体验更好)。
      // 路径按平台正确转义:Windows .bat 用双引号;mac/linux bash 用单引号(防路径含
      // 空格/$/反引号被 shell 解释)。
      let bin = 'claude';
      if (claudePath) {
        bin = process.platform === 'win32'
          ? `"${claudePath}"`
          : `'${claudePath.replace(/'/g, `'\\''`)}'`;
      }
      return `${bin} upgrade`;
    }
  }
}
export function installCmdFor(proxyUrl = null, method = 'native') { // export 仅为可单测
  // 未安装时的一键安装命令。method:'npm' | 'native'。
  // npm:读 HTTP_PROXY 环境变量(由 launchInTerminal 在脚本里 set/export),且自带
  // 下载/安装进度输出 —— 想"看得见进度"选它;前提是本机有 node(GUI 后端本就靠 node 跑,
  // 所以 GUI 能开 = node 在)。
  // 装完自动把 npm 全局 bin 写入用户 PATH(npm 自己从不写 → "装成功但终端/检测都找不到"
  // 的根因):Win 用 PowerShell 追加 HKCU\Environment\Path(不用 setx——超 1024 字符会
  // 截断毁 PATH;SetEnvironmentVariable 会广播 WM_SETTINGCHANGE,新开终端即生效);
  // mac/linux 追加 export 行到 ~/.zshrc(darwin)/~/.bashrc。已包含则跳过,不重复写。
  if (method === 'npm') {
    if (process.platform === 'win32') {
      const psAppend = `$p=(npm config get prefix).Trim(); $u=[Environment]::GetEnvironmentVariable('Path','User'); if(@(($u -split ';') | Where-Object {$_ -eq $p}).Count -eq 0){[Environment]::SetEnvironmentVariable('Path', ($u.TrimEnd(';')+';'+$p), 'User'); Write-Host ('npm bin dir written to user PATH: '+$p)} else {Write-Host 'user PATH already contains npm bin dir'}`;
      // 关键:`call npm`——npm 是 npm.cmd(批处理),在 .bat 里不加 call 直调另一个 .cmd
      // 控制权不返回 → npm 装完后 `&& powershell`(写 PATH)、后续 pause 全被跳过,PATH
      // 写入根本没跑 → "装成功但检测不到"。加 call 让 npm.cmd 返回,链条才完整执行。
      return `call npm install -g @anthropic-ai/claude-code && powershell -NoProfile -Command "${psAppend}"`;
    }
    const rc = process.platform === 'darwin' ? '$HOME/.zshrc' : '$HOME/.bashrc';
    // EACCES 根治(用户实报 permission denied):官方 pkg 装的 node,npm 全局目录
    // (/usr/local/lib/node_modules)归 root,裸 `npm install -g` 必失败。检测实际写入目录
    // 不可写时改装到 ~/.npm-global(免 sudo;claude-resolver fixedCandidates 已含此落点,
    // rc 未生效前 GUI 也能找到)。W 逐级回退:node_modules 可能尚不存在。
    return `PREFIX="$(npm prefix -g)" && W="$PREFIX/lib/node_modules" && { [ -d "$W" ] || W="$PREFIX/lib"; } && { [ -d "$W" ] || W="$PREFIX"; } && { [ -w "$W" ] || { PREFIX="$HOME/.npm-global"; echo "npm 全局目录 $W 无写权限(permission denied 根因),改装到 $PREFIX(免 sudo)"; }; } && npm install -g --prefix "$PREFIX" @anthropic-ai/claude-code && NPMBIN="$PREFIX/bin" && { case ":$PATH:" in *":$NPMBIN:"*) echo "PATH 已包含 $NPMBIN";; *) echo "export PATH=\\"$NPMBIN:\\$PATH\\"" >> ${rc} && echo "已把 $NPMBIN 写入 ${rc}(新开终端生效)";; esac; }`;
  }
  if (process.platform === 'win32') {
    // O2: Windows 官方原生安装器(独立二进制,不需要 Node/npm,自动写 PATH)。
    // 关键(墙内卡死根因):Windows PowerShell 5.1 的 irm/Invoke-WebRequest **不读
    // HTTP_PROXY 环境变量**(只认 WinINET 系统代理),所以外层 .bat 的 `set HTTP_PROXY`
    // 对 irm 无效 → 直连被屏蔽的 claude.ai → 卡死/极慢/无输出(用户报告:只显示代理
    // 端口后再无动静)。检测到本机代理时,在 PowerShell 进程内显式设 .NET DefaultWebProxy
    // + $env,让脚本本体及其下载的二进制都走代理(同进程 iex,代理设置进程级生效)。
    const setup = proxyUrl
      ? `$p='${proxyUrl}'; [System.Net.WebRequest]::DefaultWebProxy=New-Object System.Net.WebProxy($p); $env:HTTP_PROXY=$p; $env:HTTPS_PROXY=$p; Write-Host ('(proxy: '+$p+')'); `
      : '';
    const inner = `${setup}$ProgressPreference='Continue'; Write-Host 'Installing Claude Code CLI (downloading from claude.ai)...'; irm https://claude.ai/install.ps1 | iex`;
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "${inner}"`;
  }
  return 'curl -fsSL https://claude.ai/install.sh | bash'; // mac/linux 官方一键安装
}

// 打开一个「可见终端」运行命令,而不是 headless execFile。原因:
//  ① `claude update` / install.sh 是交互式自更新/安装器,无 TTY 时可能挂起或
//     无反馈(用户报告"点了没反应")。
//  ② 终端里跑能让官方安装器自己把 CLI 目录写进 shell profile 的 PATH。
//  ③ 用户能直观看到进度 / 出错信息,无需在 GUI 里盲等。
// 做法:写一个临时脚本,用 `open`(mac)/`start`(win)/终端模拟器(linux)启动。
// fire-and-forget——终端是独立进程,server 不捕获结果,UI 引导用户完成后点"检查更新"。
// M1: 探测本机 HTTP 代理端口(Clash/v2ray 等常用端口)。Windows 终端子进程不继承
// PowerShell/系统代理设置,claude update / install.sh 直连 claude.ai 或 npm 经常
// ETIMEDOUT。找到在听的端口就在更新/安装命令前 export,找不到返回 null(直连)。
const COMMON_PROXY_PORTS = [7890, 7897, 1087, 8889, 8118, 10809];
/** r14-2:读操作系统的代理设置(mac scutil --proxy;Windows 注册表 ProxyServer)。 */
async function readSystemProxy() {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const run = promisify(execFile);
  if (process.platform === 'darwin') {
    const { stdout } = await run('scutil', ['--proxy'], { timeout: 3000 });
    const get = (k) => (stdout.match(new RegExp(`${k}\\s*:\\s*(\\S+)`)) || [])[1];
    if (get('HTTPSEnable') === '1' && get('HTTPSProxy')) return `http://${get('HTTPSProxy')}:${get('HTTPSPort') || 8080}`;
    if (get('HTTPEnable') === '1' && get('HTTPProxy')) return `http://${get('HTTPProxy')}:${get('HTTPPort') || 8080}`;
    return null;
  }
  if (process.platform === 'win32') {
    // reg query 输出形如:ProxyEnable REG_DWORD 0x1 / ProxyServer REG_SZ 127.0.0.1:7890
    const { stdout } = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { timeout: 3000 });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout)) return null;
    const m = stdout.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
    if (!m) return null;
    const val = m[1];
    // 可能是 "host:port" 或 "http=host:port;https=host:port"
    const https = val.match(/https=([^;]+)/i)?.[1];
    const http = val.match(/http=([^;]+)/i)?.[1];
    const plain = /=/.test(val) ? null : val;
    const target = https || http || plain;
    return target ? `http://${target}` : null;
  }
  return null;
}

// r26-C2:短超时 TCP 探活(只探 connect,不发请求)。系统代理设置可能残留
// (代理软件已关但系统设置没还原),读到不等于能用 —— 先探活再采用。
// 纯函数抽出供单测(export 仅为可单测)。
export function probeTcp(host, port, timeout = 400) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port, timeout });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

export async function detectLocalProxy({ readSystem = readSystemProxy, baseEnv = process.env } = {}) { // export:skills.js 直连 GitHub 失败时回落代理用
  // 用户已显式配置的优先(server 进程自己的 env)。显式配置信任优先,不探活(既有语义)。
  const envProxy = baseEnv.HTTPS_PROXY || baseEnv.https_proxy || baseEnv.HTTP_PROXY || baseEnv.http_proxy;
  if (envProxy) return envProxy;
  // r14-2:先读【系统代理设置】—— 用户"开了系统代理但不是 TUN"时,Node 的 fetch 不认它,
  // 而端口探测又可能因端口非常见而落空。mac 用 scutil --proxy,Windows 读注册表。
  // r26-C2:读到必须先探活 —— 残留的死代理(代理软件已退、设置没还原)直接采用会让
  // 更新命令全部走死代理(用户看到「更新卡死」)。不通 → 落到端口探测 → 再不通直连。
  // readSystem 可注入(单测 mock;本机造不出确定的「系统代理死端口」)。
  const sys = await readSystem().catch(() => null);
  if (sys) {
    try {
      const u = new URL(sys);
      if (await probeTcp(u.hostname, Number(u.port) || 8080)) return sys;
    } catch { /* 代理解析失败同样不落,继续端口探测 */ }
  }
  const hits = await Promise.all(COMMON_PROXY_PORTS.map(async (port) => (await probeTcp('127.0.0.1', port, 300)) ? port : null));
  const port = hits.find(Boolean);
  return port ? `http://127.0.0.1:${port}` : null;
}

// 「只对回环地址判死」判据(论证见下方 liveProxy)。host 需已剥 IPv6 字面量的方括号。
// export:mcp.js 的插件代理探活(probePluginProxy)必须同一口径,判据只此一份。
export function isLoopbackProxyHost(host) {
  return /^(127\.|::1$|localhost$)/.test(String(host || ''));
}

// r34-③:【注入前必须探活】。detectLocalProxy 的第一分支(server 自己的 HTTP(S)_PROXY
// env)按"显式配置信任优先"不探活 —— 但那份 env 可能是代理软件退出后残留的死地址,
// 带着它跑更新 = 走一个不存在的出口,挂到兜底被杀。
// 对照:r31 的 marketplaceProxyEnv 只做了"不覆盖用户已有 env",既不探活也不删死代理;
// 那条路(marketplace add/update)失败即返回,不像更新会一直挂着,所以当时没做到这一步。
//
// 【只对回环地址判死】:企业/局域网代理(proxy.corp:80、TUN 网关)探不通的原因太多
// (ACL、只认 CONNECT、探测源不同),而 r34 之后"判死"是有牙的(会把代理从子进程 env 里
// 删掉)—— 误杀一个能用的代理,用户直连必然挂满 60 分钟兜底,比不探活更糟。
// 故:非回环一律原样信任;解析不了/探测器自己炸 = 无法证伪,同样信任。export 仅为可单测。
export async function liveProxy(proxyUrl, probe = probeTcp) {
  if (!proxyUrl) return null;
  // 无 scheme 的写法(`http_proxy=127.0.0.1:7897`,curl/npm 都认)裸解析会抛/解错:
  // '127.0.0.1:7897' 直接抛;'localhost:7890' 更阴 —— 会被当成 scheme 是 "localhost"
  // 解析成功但 hostname 为空。两种都会落到"证不了死就信任",把死代理原样注回去 =
  // 回到 60 分钟挂死。故:第一次解析要 hostname 非空才算数,否则补 http:// 再试一次。
  let u = null;
  for (const cand of [proxyUrl, `http://${proxyUrl}`]) {
    try { const p = new URL(cand); if (p.hostname) { u = p; break; } } catch { /* 试下一种 */ }
  }
  if (!u) return proxyUrl; // 真解析不了 = 无法证伪,信任
  try {
    const host = u.hostname.replace(/^\[|\]$/g, ''); // IPv6 字面量带方括号,剥掉再探
    if (!isLoopbackProxyHost(host)) return proxyUrl;
    return (await probe(host, Number(u.port) || (u.protocol === 'https:' ? 443 : 80))) ? proxyUrl : null;
  } catch { return proxyUrl; }
}
/**
 * 探活通过才返回的代理。用在"把代理喂给子进程 env / 终端脚本"的调用点:
 * /claude-update、/claude-update/stream(内联,要额外报告死代理)、/claude-install、
 * /env-check/install。仍用原值的两处是刻意的:/claude-version-check 的 proxy 字段透传给
 * Tauri updater(它自己下载、自己超时),httpGetText 的 curl 回退(15s 上限,失败即止)。
 */
export async function detectLiveProxy() {
  return liveProxy(await detectLocalProxy().catch(() => null));
}
/** 代理地址可能带 user:pass@,进日志/回执前遮罩(只遮 userinfo,主机端口要能看)。 */
export function maskProxy(url) {
  return String(url || '').replace(/\/\/[^/@]*@/, '//***@');
}

// r34-③修:【判死必须删 env】。判死后只是"不注入"的话,`{...process.env}` 会把那份死代理
// 原样带给子进程,照走死出口 —— 探活等于零效果。npm 另有自己的 npm_config_* 口径,一并删
// (.npmrc 里的配置管不到,故日志不说"直连")。键表只此一份:流式通道与终端脚本通道共用。
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'npm_config_proxy', 'npm_config_https_proxy'];
export function withoutProxyEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const k of PROXY_ENV_KEYS) delete env[k];
  return env;
}

function launchInTerminal(cmd, title, proxyUrl = null) {
  const stamp = `cgui-cc-${process.pid}-${Math.round(process.hrtime()[1])}`;
  // r49a-⑤:终端也是子进程,继承 server 自己的 env。探活判死的代理只是"不写进脚本"
  // 拦不住继承(用户视角:终端里的更新一样卡死);探活通过的那个由脚本自己 export,
  // 删继承值不影响它。与流式通道同一处清理。
  const env = withoutProxyEnv();
  if (process.platform === 'darwin') {
    const file = join(tmpdir(), `${stamp}.command`);
    const proxyLine = proxyUrl ? `export HTTP_PROXY='${proxyUrl}' HTTPS_PROXY='${proxyUrl}' http_proxy='${proxyUrl}' https_proxy='${proxyUrl}'\necho "(代理: ${proxyUrl})"\n` : '';
    writeFileSync(file, `#!/bin/bash\necho "▶ ${title}"\n${proxyLine}${cmd}\nstatus=$?\necho\nif [ $status -eq 0 ]; then echo "✅ 完成,可关闭本窗口"; else echo "❌ 失败(退出码 $status)"; fi\n`, { mode: 0o755 });
    spawn('open', [file], { detached: true, stdio: 'ignore', env }).unref();
  } else if (process.platform === 'win32') {
    const file = join(tmpdir(), `${stamp}.bat`);
    const proxyLine = proxyUrl ? `set HTTP_PROXY=${proxyUrl}\r\nset HTTPS_PROXY=${proxyUrl}\r\necho (代理: ${proxyUrl})\r\n` : '';
    writeFileSync(file, `@echo off\r\necho ▶ ${title}\r\n${proxyLine}${cmd}\r\necho.\r\necho ===== 完成,按任意键关闭 =====\r\npause >nul\r\n`);
    // start '' <file> — 空标题占位,避免把文件路径当成窗口标题
    spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: false, env }).unref();
  } else {
    const file = join(tmpdir(), `${stamp}.sh`);
    writeFileSync(file, `#!/bin/bash\necho "▶ ${title}"\n${cmd}\necho\nread -p "完成,回车关闭…"\n`, { mode: 0o755 });
    // 常见终端模拟器逐个尝试(best-effort)
    const term = process.env.TERMINAL || 'x-terminal-emulator';
    spawn(term, ['-e', `bash "${file}"`], { detached: true, stdio: 'ignore', env }).unref();
  }
}

/**
 * GET /api/claude-version-check
 * 比对本地 `claude --version` 与 npm latest,并返回安装方式 + 对应更新命令。
 * 失败永远返回 200(只看字段)。
 */
router.get('/claude-version-check', async (req, res) => {
  const { method, path: claudePath } = await detectInstall();
  const currentVersion = await getClaudeVersion(claudePath);
  if (!currentVersion) {
    // 区分两种落空:①完全没解析到二进制 = 真未安装;②解析到路径但 --version 超时/异常
    // (杀毒实时扫描、npm shim 里 node 冷启动 >8s)= 已装但探测失败,别误报"未安装"诱导重装。
    if (claudePath) {
      return res.json({
        currentVersion: null, installed: true, method, path: claudePath,
        error: '已检测到 Claude 但读取版本超时(可能被杀毒扫描拦截),稍后重试',
      });
    }
    return res.json({
      currentVersion: null, installed: false,
      installCommand: installCmdFor(),
      error: 'Claude Code 未安装或不在 PATH',
    });
  }
  let latest = '';
  let staleError = null; // r23-④:这次没查成、显示的是旧缓存(前端必须明示,见下方 catch)
  const now = Date.now();
  // 缓存按"真源"分键:native 渠道与 npm 的版本可能不同,混用一个缓存会把 npm 的
  // 版本号错发给原生安装(正是"永远差一版"的放大器)。
  // r36-①:真源改按【在用二进制的安装方式】取(compareSrcKey),不再跟显式渠道走。
  // currentVersion 来自在用的那个二进制,latest 必须来自同一渠道才能比 —— r26-C7 让它跟
  // 显式渠道走,等于拿 A 渠道的最新版比 B 渠道的二进制,发布时间差直接造出假的"有更新"。
  // 渠道仍决定更新走哪条管线(updateCommand/crossChannel 照旧按渠道算)。
  const channel = readUpdateChannel();
  const srcKey = compareSrcKey(method);
  if (ccCache && ccCacheSrc === srcKey && now - ccCachedAt < CACHE_TTL_MS) {
    latest = ccCache;
  } else {
    try {
      latest = srcKey === 'native'
        ? await fetchNativeLatest()
        : await fetchNpmLatest();
      ccCache = latest; ccCacheSrc = srcKey; ccCachedAt = now;
    } catch (err) {
      if (ccCache && ccCacheSrc === srcKey) {
        // r23-④:静默复用旧缓存 = 界面照显「✓ 已是最新版本」,用户根本不知道这次没查成
        // (与 GUI 那条链路 r14-1 修掉的是同一个症状,CLI 这条一直原样留着)。
        latest = ccCache;
        const mins = Math.max(1, Math.round((now - ccCachedAt) / 60000));
        staleError = `${err.message || '版本查询失败'}(这次没查成,显示的是 ${mins} 分钟前的结果)`;
      } else return res.json({ currentVersion, installed: true, method, path: claudePath, error: err.message || '版本查询失败' });
    }
  }
  res.json({
    currentVersion,
    latestVersion: latest,
    installed: true,
    ...(staleError ? { staleError } : {}),
    method,                         // native | brew | npm | unknown
    path: claudePath,               // r36-③:检测对象(前端显示"在比的是哪个二进制")
    // r26-C1:跨渠道时 resolveUpdateMethod 回 null → updateCommand 如实为 null,
    // 前端按 crossChannel 弹确认,而不是直接跑一条会写进另一份安装的命令。
    updateCommand: (() => { const m = resolveUpdateMethod(channel, method); return m ? updateCmdFor(m, claudePath) : null; })(),
    updateChannel: effectiveChannel(channel, method),
    // r26-C1:跨渠道标记(显式 npm 渠道 × 非 npm 安装),前端更新按钮据此弹确认。
    crossChannel: isCrossChannel(channel, method),
    hasUpdate: latest ? semverGt(latest, currentVersion) : false,
  });
});

/**
 * POST /api/claude-update — 按检测到的安装方式运行匹配的更新命令。
 * native→claude update,brew→brew upgrade,npm→也走 claude update(npm 包 ≥2.1.227
 * 是原生安装器引导壳,npm i -g 只会拉壳不出可用 CLI,见 updateCmdFor)。
 * 终端路径没有任何超时定时器(也正因如此从没毁过用户的安装,见 startUpdateTimers)。
 */
router.post('/claude-update', async (req, res) => {
  const { method, path: claudePath } = await detectInstall();
  // r13-p2-20:按用户选择的渠道解析(auto=跟随安装方式;npm 装的默认走 npm,镜像源更快)
  // r26-C1:跨渠道(npm 渠道 × 非 npm 安装)裸调用拒绝执行 —— 命令会写进 npm 前缀的
  // 另一份安装,PATH 先生效的仍是当前安装(假成功)。前端确认弹窗回执(allowCrossChannel)
  // 才放行;否则给明确指引。
  const channel = readUpdateChannel();
  const resolved = resolveUpdateMethod(channel, method, { allowCrossChannel: req.body?.allowCrossChannel === true });
  if (!resolved) {
    return res.status(409).json({
      ok: false, crossChannel: true,
      error: '更新渠道(npm)与当前安装方式不一致:执行会写入 npm 全局前缀的另一份安装,而 PATH 里先生效的仍是当前安装。请把更新渠道改回「跟随安装方式」后重试。',
    });
  }
  const cmd = updateCmdFor(resolved, claudePath);
  // M1: native 自更新直连 claude.ai 下载,墙内必须带代理;npm/brew 同样受益。
  // r34-③:探活通过的才往终端脚本里 export —— 死代理会让终端更新同样"卡死"。
  const proxyUrl = await detectLiveProxy();
  // Windows:运行中的 claude 锁住 claude.exe,npm/upgrade 覆盖时报 "could not write ...claude.exe"。
  // 更新前先关掉 GUI 自己的常驻 claude 进程释放文件锁(终端里 npm 先下载,给进程退出留足时间)。
  if (process.platform === 'win32') { try { closeAllPersistentProcesses(); } catch {} }
  try {
    launchInTerminal(cmd, `更新 Claude Code (${method})`, proxyUrl);
    res.json({ ok: true, launched: true, command: cmd, platform: process.platform, proxy: proxyUrl });
  } catch (err) {
    res.json({ ok: false, error: err.message || '启动终端失败', command: cmd });
  }
});

// r12-①c:重装成功后自动恢复钉选(export 仅为可单测)。判据:存在 paused override
// 且 existsSync(path) 且 classifyShim(realpath) 非 broken 且版本探测成功 →
// setClaudeOverride(path)(自动清 paused)+ resolver 强刷。任一判据不过保持 paused
// 不动(幂等,下次触发再探)。路径永久失效不自动改钉别的安装(猜错更糟)——
// 改钉走前端横幅的一键按钮(现有 PUT path 语义)。
// Windows:探测复用 getClaudeVersion(内部已走 cmd.exe /c)与 classifyShim,零新裸 spawn。
export async function tryRestorePausedOverride() {
  const raw = getClaudeOverrideRaw();
  if (!raw.paused || !raw.path) return null;
  if (!existsSync(raw.path)) return null;
  let real = raw.path;
  try { real = realpathSync(raw.path); } catch {}
  if (classifyShim(real)?.broken) return null;
  const version = await getClaudeVersion(raw.path);
  if (!version) return null;
  setClaudeOverride(raw.path);
  await resolveClaudeAsync({ refresh: true }); // 强刷,下次 spawn 立即用回钉选
  return { path: raw.path, version };
}

/**
 * POST /api/claude-update/stream — CN-2:在 GUI 内显示更新进度。headless spawn 更新命令
 * (npm/native),把 stdout+stderr 以 NDJSON 逐行推给前端实时展示,不用开外部终端。
 * 注:npm -g 在个别 Unix 需 sudo 会 headless 挂起 —— 前端保留"改用终端"兜底。
 */
// ── r13-p2-21:更新改为【服务端后台任务】,关面板/断连不再杀进程 ──────────
// 用户实报:更新中关掉右侧面板,更新就停了,得重新点。根因=下方 req.on('close') 里
// killTree —— SSE 一断就杀整棵进程树。现在:进程归服务端持有,SSE 只是"看进度的窗口",
// 断开只摘监听;重开面板可续看(replay 已产生的日志);r34-①:8 分钟只提示不杀、
// 60 分钟极限兜底才杀;用户想主动停有独立的 cancel 端点。
// export 仅为可单测(r26-C9:attach 终态帧用例需要直接置 status/code)
export const updateTask = {
  child: null,
  cmd: '',
  status: 'idle',          // idle | running | done | error
  code: null,
  error: '',
  cancelRequested: false,  // r34-②:spawn 前的取消(那时还没有 child 可杀),spawn 前兑现
  log: [],                 // 最近 500 行
  startedAt: 0,
  finishedAt: 0,
  restored: null,          // 自动回钉钉选的回执(r12-①c)
  listeners: new Set(),    // 当前挂着的 SSE 响应
};

function taskPush(evt) {
  if (evt.type === 'log') {
    updateTask.log.push(evt.line);
    if (updateTask.log.length > 500) updateTask.log.splice(0, updateTask.log.length - 500);
  }
  for (const res of updateTask.listeners) {
    try { res.write(JSON.stringify(evt) + '\n'); } catch {}
  }
}

function killUpdateTree() {
  const child = updateTask.child;
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {}); } catch {}
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

// ── r34-①:【超时不再杀】────────────────────────────────────────────────
// 用户实报(Windows):GUI 内更新一中断,claude.cmd 消失、node_modules 里只剩半解压的
// 包,得整个重下;终端更新从来不出事。根因就是这里的 8 分钟强杀:
//   `npm install -g` 非原子 —— 先删旧 bin 链/旧包,再解压 81MB 平台包。慢源(npmmirror
//   对平台包 16-20KB/s)下 8 分钟远不够,强杀必然落在「旧的已删、新的没好」的窗口。
//   即:这个"防挂死保护"本身就是损坏的制造者。终端路径没有定时器,所以从不出事。
// 现在:8 分钟只提示(任务继续跑),只有用户显式取消、或超过 60 分钟(真挂死)才终止。
export const UPDATE_SLOW_NOTICE_MS = 8 * 60 * 1000;
export const UPDATE_HARD_LIMIT_MS = 60 * 60 * 1000;
export const UPDATE_SLOW_NOTICE_LINE = '⚠️ 更新已运行 8 分钟,仍在进行中(不会自动终止)。npm 源较慢时 81MB 的平台包可能需要 30-60 分钟,建议继续等待;确实要停可点「取消更新」—— 取消可能留下半成品安装,重新运行一次更新即可补齐。';
// 恢复指引不写进常量:native 渠道是原子替换,不可能半装,说"可能不可用"是吓唬人。
// 交给 withRecoveryHint 按渠道追加(npm 才加)。
export const UPDATE_HARD_LIMIT_ERROR = '更新已超过 60 分钟仍未完成,判定为挂死并终止。npm 源过慢是常见根因:确认代理已开后重试,或点「改用终端更新」走官方渠道。';
// 慢提示(不杀)+ 极限兜底(杀)。返回清理函数,正常完成/失败收尾时调用。
// 延时可注入仅为可单测(单测不可能真等 8 分钟);export 仅为可单测。
export function startUpdateTimers({
  push = taskPush, kill = killUpdateTree, task = updateTask,
  noticeMs = UPDATE_SLOW_NOTICE_MS, hardMs = UPDATE_HARD_LIMIT_MS,
} = {}) {
  // 提示走 log 帧:前端 doUpdateStream 只渲染 log/start/error/done,自造帧类型会被静默丢弃。
  const notice = setTimeout(() => { push({ type: 'log', line: UPDATE_SLOW_NOTICE_LINE }); }, noticeMs);
  const hard = setTimeout(() => {
    task.error = withRecoveryHint(UPDATE_HARD_LIMIT_ERROR, task.cmd);
    push({ type: 'error', error: task.error });
    kill();
  }, hardMs);
  notice.unref?.(); hard.unref?.();
  return () => { clearTimeout(notice); clearTimeout(hard); };
}

// r34-②:npm 渠道的中断(取消/极限超时/spawn 失败/非零退出)都可能留下半成品安装。
// 恢复办法就是"再跑一次更新"(npm 会补齐缺失文件),不需要用户手动清理 —— 所以
// 错误文案统一带上这句,别让用户以为安装已经死透只能重装系统级的东西。
export function isNpmRegistryCmd(cmd) {
  return /npm\s+install\s+-g\s+@anthropic-ai\/claude-code/.test(String(cmd || ''));
}
export function withRecoveryHint(error, cmd) {
  return isNpmRegistryCmd(cmd) ? `${error}\n若此次中断导致 claude 不可用:重新运行一次更新即可补齐缺失文件。` : error;
}

router.post('/claude-update/stream', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });

  // 已有更新在跑 → 挂上去续看(回放已产生的日志),不重复起进程。
  if (updateTask.status === 'running') {
    res.write(JSON.stringify({ type: 'start', command: updateTask.cmd, attached: true }) + '\n');
    for (const line of updateTask.log) res.write(JSON.stringify({ type: 'log', line }) + '\n');
    updateTask.listeners.add(res);
    req.on('close', () => { updateTask.listeners.delete(res); }); // 只摘监听,绝不杀进程
    return;
  }

  // r22-③:【先占位,再解析】。原来 status='running' 写在下面两个 await 之后,而
  // detectInstall({refresh}) 走登录 shell、detectLocalProxy 要 scutil + 探 6 个端口,
  // 都可达秒级 —— 同时到达的两个请求(手机端与桌面端各开一次面板、或用户连点两下)
  // 会双双通过上面的 running 检查,spawn 出两个 `npm i -g` 写同一个目录:
  // updateTask.child 被后者覆盖,前者成孤儿,8 分钟超时定时器也只管得住后一个。
  updateTask.cmd = '';
  updateTask.status = 'running';
  updateTask.code = null;
  updateTask.error = '';
  updateTask.cancelRequested = false;
  updateTask.log = [];
  updateTask.restored = null;
  updateTask.startedAt = Date.now();
  updateTask.finishedAt = 0;
  updateTask.listeners.add(res);
  req.on('close', () => { updateTask.listeners.delete(res); }); // 关面板 = 只断窗口

  let method, cmd, proxyUrl, deadProxy = null;
  try {
    const detected = await detectInstall();
    method = detected.method;
    // r26-C1:跨渠道裸调用解析回 null —— 不许静默起会写进另一份安装的 npm install;
    // 前端确认回执(allowCrossChannel)才放行,否则走与检测失败相同的 error 收尾
    // (前端流消费本就有 error 分支,直接复用)。
    const resolved = resolveUpdateMethod(readUpdateChannel(), method, { allowCrossChannel: req.body?.allowCrossChannel === true });
    if (!resolved) {
      throw new Error('更新渠道(npm)与当前安装方式不一致:执行会写入 npm 全局前缀的另一份安装,而 PATH 里先生效的仍是当前安装。请把更新渠道改回「跟随安装方式」后重试。');
    }
    cmd = updateCmdFor(resolved, detected.path);
    // r34-③:探活通过才注入。死代理(软件已退、env/系统设置没还原)注进去 = 整条更新
    // 走一个不存在的出口,表现成"更新卡死"。探不通就直连,并在流里说明。
    const rawProxy = await detectLocalProxy().catch(() => null);
    proxyUrl = await liveProxy(rawProxy);
    if (rawProxy && !proxyUrl) deadProxy = rawProxy;
  } catch (e) {
    // 占位后任何一步失败都必须还原状态,否则任务卡成"永远 running":后续所有请求
    // 都只挂上来续看一个根本不存在的进程,用户再也更新不了(直到重启后端)。
    updateTask.status = 'error';
    updateTask.error = `检测安装方式失败:${e.message}`;
    updateTask.finishedAt = Date.now();
    taskPush({ type: 'error', error: updateTask.error });
    for (const r of updateTask.listeners) { try { r.end(); } catch {} }
    updateTask.listeners.clear();
    return;
  }
  let env = { ...process.env };
  if (proxyUrl) { env.HTTP_PROXY = env.HTTPS_PROXY = env.http_proxy = env.https_proxy = proxyUrl; }
  else if (deadProxy) {
    // r34-③修:【判死必须删 env】。detectLocalProxy 的第一分支读的就是 server 自己的
    // HTTP(S)_PROXY —— 判死后只是"不注入"的话,`{...process.env}` 原样把那份死代理带给
    // npm,照走死出口:挂满兜底时长再被杀,正好落回本轮要根治的半装损坏。键表见
    // withoutProxyEnv(终端脚本通道共用同一份)。
    env = withoutProxyEnv(env);
  }

  updateTask.cmd = cmd;

  taskPush({ type: 'start', command: cmd, method, proxy: proxyUrl && maskProxy(proxyUrl) });
  if (deadProxy) taskPush({ type: 'log', line: `检测到代理 ${maskProxy(deadProxy)} 不可达,本次更新不再注入代理(.npmrc 里的代理配置本进程管不到)。` });

  // Windows:先关常驻 claude 释放 claude.exe 锁(否则覆盖失败 "could not write");等 ~1.2s 让进程退出。
  if (process.platform === 'win32') {
    let closed = 0; try { closed = closeAllPersistentProcesses(); } catch {}
    if (closed) { taskPush({ type: 'log', line: `已关闭 ${closed} 个运行中的 claude 进程以释放 claude.exe(更新前置)` }); await new Promise((r) => setTimeout(r, 1200)); }
  }

  // r34-②:从占位 running 到这里有 2-15 秒(detectInstall 走登录 shell + 探活 + Win 那 1.2s
  // 等待)。这段窗口里点取消,killUpdateTree 看到 child=null 直接 return —— 用户拿到
  // 「已取消」的回执,进程却照常起来跑。所以取消要落成标志,在 spawn 前兑现。
  if (updateTask.cancelRequested) {
    updateTask.status = 'error';
    // 这条路径不套 withRecoveryHint:进程压根没起,不可能有半成品,再说"若 claude 不可用"
    // 自相矛盾。
    updateTask.error = '已由用户终止(更新进程尚未启动,未做任何改动)';
    updateTask.finishedAt = Date.now();
    taskPush({ type: 'error', error: updateTask.error });
    for (const r of updateTask.listeners) { try { r.end(); } catch {} }
    updateTask.listeners.clear();
    return;
  }

  let child;
  try {
    // detached(非 Win)让 shell 成为新进程组组长,超时可整组 SIGKILL(-pid)。
    child = spawn(cmd, { shell: true, env, detached: process.platform !== 'win32' });
  } catch (e) {
    updateTask.status = 'error';
    updateTask.error = withRecoveryHint(e.message, cmd);
    updateTask.finishedAt = Date.now();
    taskPush({ type: 'error', error: updateTask.error });
    for (const r of updateTask.listeners) { try { r.end(); } catch {} }
    updateTask.listeners.clear();
    return;
  }
  updateTask.child = child;

  // r34-①:8 分钟只提示不杀;60 分钟极限兜底才杀(见 startUpdateTimers 的事故说明)。
  // 计时器归任务所有,与任何 SSE 连接无关;正常/异常收尾都要 clearUpdateTimers()。
  const clearUpdateTimers = startUpdateTimers();

  const pump = (chunk) => {
    String(chunk).split(/\r?\n/).forEach((line) => { if (line.trim()) taskPush({ type: 'log', line }); });
  };
  child.stdout?.on('data', pump);
  child.stderr?.on('data', pump);

  child.on('error', (e) => {
    clearUpdateTimers();
    updateTask.status = 'error';
    updateTask.error = withRecoveryHint(e.message, updateTask.cmd);
    updateTask.finishedAt = Date.now();
    updateTask.child = null;
    taskPush({ type: 'error', error: updateTask.error });
    for (const r of updateTask.listeners) { try { r.end(); } catch {} }
    updateTask.listeners.clear();
  });

  child.on('close', async (code) => {
    clearUpdateTimers();
    // r12-①c:更新成功 → 探测 paused 钉选是否恢复健康,是则自动回钉。
    let restored = null;
    if (code === 0) { try { restored = await tryRestorePausedOverride(); } catch {} }
    updateTask.status = code === 0 ? 'done' : 'error';
    updateTask.code = code;
    if (code !== 0 && !updateTask.error) updateTask.error = withRecoveryHint(`更新进程退出码 ${code}(详见上方日志)`, updateTask.cmd);
    updateTask.restored = restored;
    updateTask.finishedAt = Date.now();
    updateTask.child = null;
    // r34-③:done 必须带上原因。前端 done 分支无条件覆盖 result,不带 error 的话
    // 取消/兜底超时刚推的那条 error 帧会被「命令退出码 null」盖掉,恢复指引全丢。
    // (形状与 /attach 的终态帧一致。)
    taskPush({ type: 'done', code, error: updateTask.error });
    if (restored) taskPush({ type: 'override-restored', path: restored.path, version: restored.version });
    for (const r of updateTask.listeners) { try { r.end(); } catch {} }
    updateTask.listeners.clear();
  });
});

/**
 * POST /api/claude-update/attach — r22-③:【只续看,绝不 spawn】。
 *
 * 原来前端挂载对账后直接 POST /claude-update/stream 续看,而那是"会启动安装"的入口
 * (doUpdateStream 的 {attach:true} 参数从头到尾没人读)。更新只要恰好在 GET /status
 * 与这次 POST 之间跑完,服务端就看到 status!==running → 用户只是【打开了设置面板】,
 * 就静默跑起 `npm install -g @anthropic-ai/claude-code@latest`,一句确认都没有
 * (确认只在 doUpdate 里)。所以"续看"必须有自己的、不会起进程的入口。
 */
router.post('/claude-update/attach', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
  if (updateTask.status !== 'running') {
    // r26-C9:任务恰在 GET /status 与 POST /attach 之间结束时,空流会让用户永远看不到
    // 结论 —— 补一帧终态再收尾(前端 doUpdateStream 本就有 done 分支,自动复用)。
    // idle(从未跑过)不出帧:没有结论可补。
    if (updateTask.status === 'done' || updateTask.status === 'error') {
      res.write(JSON.stringify({ type: 'done', code: updateTask.code, status: updateTask.status, error: updateTask.error }) + '\n');
    }
    res.end();
    return;
  }
  res.write(JSON.stringify({ type: 'start', command: updateTask.cmd || '(正在检测安装方式…)', attached: true }) + '\n');
  for (const line of updateTask.log) res.write(JSON.stringify({ type: 'log', line }) + '\n');
  updateTask.listeners.add(res);
  req.on('close', () => { updateTask.listeners.delete(res); }); // 只摘监听,绝不杀进程
});

// GET /api/claude-update/status — 重开面板时对账:是否还在更新/上次结果与日志。
router.get('/claude-update/status', (_req, res) => {
  res.json({
    status: updateTask.status,
    running: updateTask.status === 'running',
    command: updateTask.cmd,
    code: updateTask.code,
    error: updateTask.error,
    startedAt: updateTask.startedAt,
    finishedAt: updateTask.finishedAt,
    restored: updateTask.restored,
    log: updateTask.log.slice(-200),
  });
});

// POST /api/claude-update/cancel — 用户主动终止(关面板不再等于取消,故给显式出口)。
// r34-①:超时不再自动杀 → 这里是唯一的"用户显式决定"的终止口,保留杀的能力。
router.post('/claude-update/cancel', (_req, res) => {
  if (updateTask.status !== 'running') return res.json({ ok: true, running: false, cancelled: false });
  updateTask.error = withRecoveryHint('已由用户终止', updateTask.cmd);
  // r34-②:进程还没起(检测/探活窗口)时杀不到东西 —— 记标志,由 spawn 前的检查兑现,
  // 回执如实告诉前端是"立刻杀了"还是"记下了待兑现",别再一律回 cancelled:true。
  const hadChild = !!updateTask.child?.pid;
  updateTask.cancelRequested = true;
  killUpdateTree();
  res.json({ ok: true, running: false, cancelled: true, deferred: !hadChild });
});

/**
 * POST /api/claude-install — 未安装时一键安装(mac/linux: 官方 install.sh;win: npm)。
 * 在可见终端运行,让官方安装器自行把 CLI 目录写入系统 PATH。
 */
// GET/PUT /api/claude-update-channel — 更新渠道(npm | native)。
// 未显式选择时跟随检测到的安装方式;镜像源用户 npm 通常远快于原生二进制源
// (实测 cdn.npmmirror 2.23MB/s vs 原生源经代理 1.04MB/s)。
router.get('/claude-update-channel', async (_req, res) => {
  const { method } = await detectInstall();
  const explicit = readUpdateChannel();
  res.json({
    channel: effectiveChannel(explicit, method),
    explicit,
    installMethod: method,
    channels: UPDATE_CHANNELS,
  });
});
router.put('/claude-update-channel', async (req, res) => {
  // r26-C5:null / 'auto' = 清除显式选择,回到「跟随安装方式」(writeUpdateChannel(null)
  // 删除 prefs.updateChannel 键;GET 的 explicit:null 既有逻辑天然支持)。
  const raw = req.body?.channel;
  const ch = raw === null || raw === 'auto' ? null : String(raw || '');
  if (ch !== null && !UPDATE_CHANNELS.includes(ch)) {
    return res.status(400).json({ error: '渠道必须是 npm、native 或 null(跟随安装方式)' });
  }
  if (!(await writeUpdateChannel(ch))) return res.status(500).json({ error: '写入失败' });
  // r36-②:选渠道 = 总开关 —— 顺带把 GUI 实际使用的 claude 钉到该渠道的安装。否则"选了 npm
  // 渠道"却仍在跑原生二进制,版本提示、更新命令、聊天 spawn 三处各说各话。
  // ch=null(跟随安装方式)不动 override:用户可能手动钉过别的安装,清渠道不该连带清掉。
  // 该渠道没有安装 → 保持现状并如实回执(前端提示 + 现有安装入口),这里不新增安装逻辑。
  if (ch) {
    // 安全边界:钉选候选【封闭】于本机扫描列表(listClaudeInstallsAsync),不接受请求体
    // 路径,broken 壳包已滤 —— /claude-active 的 isLocalReq 门禁针对的"任意路径→RCE"
    // 通路在此不存在,且渠道本就是给远程(手机)设置项,故不加本机门禁。
    const hit = pickChannelInstall(ch, await listClaudeInstallsAsync());
    if (!hit) return res.json({ ok: true, channel: ch, channelInstallMissing: true });
    // setClaudeOverride 内部清 resolver 缓存,下次 spawn/版本检查立即用它(无需重启)。
    setClaudeOverride(hit.path);
    return res.json({ ok: true, channel: ch, activePath: hit.path });
  }
  res.json({ ok: true, channel: ch });
});

router.post('/claude-install', async (req, res) => {
  const method = req.body?.method === 'npm' ? 'npm' : 'native';
  const proxyUrl = await detectLiveProxy(); // r34-③:探活通过才注入(死代理 = 安装卡死)
  const cmd = installCmdFor(proxyUrl, method);
  // 代理注入位置按 method 分:
  //  · npm / 任意平台的 curl:进程读 HTTP_PROXY 环境变量 → 交给 launchInTerminal 在脚本里 set/export。
  //  · native + Windows:PowerShell 的 irm 不读 env,代理已在命令内注入 → 不再让 .bat 重复 set。
  const termProxy = (method === 'npm' || process.platform !== 'win32') ? proxyUrl : null;
  const title = method === 'npm' ? '安装 Claude Code (npm)' : '安装 Claude Code (官方安装器)';
  try {
    launchInTerminal(cmd, title, termProxy);
    res.json({ ok: true, launched: true, command: cmd, method, platform: process.platform, proxy: proxyUrl });
  } catch (err) {
    res.json({ ok: false, error: err.message || '启动终端失败', command: cmd });
  }
});

// GET /api/claude-installs
// 列出机器上所有 claude 安装(不止当前用的那个)+ 各自版本 + 分类,并标出当前
// 实际激活的是哪个(供设置页"切换用哪个 claude")。overridden = 用户是否已手动钉死。
router.get('/claude-installs', async (_req, res) => {
  // r12-①c 触发点二:覆盖终端内/GUI 外重装——扫描时同款恢复探测(幂等,失败保持 paused)。
  let restored = null;
  try { restored = await tryRestorePausedOverride(); } catch {}
  const list = await listClaudeInstallsAsync();
  const override = getClaudeOverride();
  // refresh:true 同 detectInstall:显式检查不吃 15s 负缓存(更新中断后误显未安装/无选中)。
  const active = await resolveClaudeAsync({ refresh: true });  // 含 override,当前 spawn/SDK 实际会用的那个
  let activeReal = '';
  if (active) { try { activeReal = realpathSync(active.path); } catch { activeReal = active.path; } }
  // Windows 路径大小写不敏感(盘符 C:\ vs c:\、目录大小写)而 === 敏感 → active 比对落空,
  // 设置页没有任何安装被标"当前"(首开不选中的根因之一)。归一化后再比。
  const norm = (p) => process.platform === 'win32' ? String(p).replace(/\//g, '\\').toLowerCase() : String(p);
  const activeKey = norm(activeReal);
  const installs = await Promise.all(list.map(async (it) => ({
    path: it.path,
    method: classifyClaudePath(it.real),
    // 探测超时回退该路径上次探到的版本;二进制真没了(ENOENT 等)如实为 null。
    // R8-1:broken 的壳包(bin 还是文本 stub)不再跑 --version —— 执行文本 stub 必失败,
    // 白等一次超时;version 如实 null。前端(设置页安装列表)按 broken 渲染警示徽标并
    // 禁选;PUT /claude-active 服务端同判 broken 拒绝(双保险,防旧前端选中坏项)。
    version: it.broken ? null : await getClaudeVersion(it.path),
    active: !!activeKey && norm(it.real) === activeKey,
    // R8-1:npm 引导壳标注(只增字段,老前端忽略)。shim=引导壳安装;broken=未完成
    // (postinstall 没落真二进制,切过去 spawn 必废),reason 给人话原因。
    ...(it.shim ? { shim: true } : {}),
    ...(it.broken ? { broken: true, reason: it.reason || '' } : {}),
  })));
  // R8-2:手动指定的路径已失效(卸载/移动)→ 显式标注,前端渲染横幅给「清除指定 /
  // 重新选择」出口;此前 resolver 只静默回落,用户以为还在用指定的那个。只增字段。
  const overrideDead = !!override && !existsSync(override);
  // r12-①a:paused 态只增字段(老前端忽略)。
  const rawOv = getClaudeOverrideRaw();
  res.json({
    installs, overridden: !!override, override, overrideDead, activeVia: active?.via || null,
    overridePaused: rawOv.paused, overridePausedPath: rawOv.paused ? rawOv.path : '',
    ...(restored ? { overrideRestored: true, overrideRestoredPath: restored.path } : {}),
  });
});

// PUT /api/claude-active { path }
// 钉死 GUI 用哪个 claude;path 传空串 → 清除,回到自动优先级。写覆盖文件并强制
// resolver 重解析,下次聊天/agent/MCP spawn 立即用新的(无需重启)。
router.put('/claude-active', async (req, res) => {
  // 限本机请求(fable 审计实测:原来任何存在的文件都收,连不可执行文本都行,之后全部
  // spawn 用它——authed 局域网客户端可打瘫 GUI,配合本机可执行恶意文件可升级 RCE)。
  // 钉 claude 路径是桌面机主动作,与 permissions.js 权限检查接口同款门禁。
  if (!isLocalReq(req)) return res.status(403).json({ error: '该操作仅限本机执行' });
  // r12-①a:{pause:true} = 暂停指定(可恢复)——不清 path 只置 paused,重装探测健康后
  // 自动回钉(r12-①c)。path 必须已存在于 override,否则 400。老语义零影响:
  // {path:''} 仍是彻底清除,{path:'新路径'} 正常钉选并清 paused 态。
  if (req.body?.pause === true) {
    const raw = getClaudeOverrideRaw();
    if (!raw.path) return res.status(400).json({ error: '当前没有手动指定的 claude 路径,无可暂停' });
    pauseClaudeOverride();
    const active = await resolveClaudeAsync({ refresh: true });
    return res.json({ ok: true, paused: true, path: raw.path, active: active?.path || '', via: active?.via || null });
  }
  const p = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
  if (p && !existsSync(p)) return res.status(400).json({ error: '该路径不存在或已失效' });
  // R8-1 补齐:坏壳包(bin 还是文本 stub)禁选 —— 钉死它之后所有 spawn 都会废。服务端
  // 兜底判定,防旧前端/绕过前端直接 PUT 选中坏项。按 realpath 判(入口可能是 shim)。
  if (p) {
    let real = p;
    try { real = realpathSync(p); } catch {}
    const shimInfo = classifyShim(real);
    if (shimInfo?.broken) {
      return res.status(400).json({ error: `该安装不可用:${shimInfo.reason || '壳包未完成安装'}。请重装后再选择。` });
    }
  }
  try {
    setClaudeOverride(p);
    const active = await resolveClaudeAsync({ refresh: true });
    res.json({ ok: true, active: active?.path || '', via: active?.via || null });
  } catch (e) {
    res.status(500).json({ error: e.message || '写入失败' });
  }
});

// ─── 统一环境检查(node / claude / python)──────────────────────────────
// Windows 通用兜底:手动装完 python/git/uv 后仍检测不到的根因 = 正在运行的 GUI 进程持有
// 安装前的旧 PATH 快照(安装器只把新目录写进注册表,不重启读不到)。用注册表实时 PATH
// 逐目录拼 exe 名 —— 与 claude-resolver 的 fromWinLivePath 同思路,装了无需重启即可发现。
// 异步(opus 审计):同步版在 PATH 未命中的 Windows 上每次 env-check 同步 spawn PowerShell
// 1-3s 阻塞事件循环;异步版 + resolver 侧 30s 缓存,一次 env-check 三个工具只 spawn 一次。
async function winLiveCandidates(exeNames) {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (const d of await winLivePathDirsAsync()) for (const n of exeNames) out.push(join(d, n));
  return out;
}
// python.org / Store 安装器的固定落点(用户没勾"Add to PATH"时注册表也没有 → 直扫)。
// 目录名带版本(Python312 等),扫父目录下 /^Python\d/ 子目录。
function pythonWinFixed() {
  const home = homedir();
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const out = [];
  for (const base of [
    join(local, 'Programs', 'Python'),                                 // python.org 仅当前用户(默认)
    process.env.ProgramFiles || 'C:\\Program Files',                   // python.org 所有用户
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  ]) {
    try { for (const d of readdirSync(base)) if (/^Python\d/i.test(d)) out.push(join(base, d, 'python.exe')); } catch {}
  }
  out.push(join(local, 'Microsoft', 'WindowsApps', 'python.exe'));     // Microsoft Store 版垫片
  return out;
}

async function detectPython() {
  const tryRun = async (bin, args = ['--version']) => {
    try {
      const { stdout, stderr } = await execFileP(bin, args, { timeout: 5000 });
      const out = (stdout || stderr || '').trim(); // 老版本 python 把版本打到 stderr
      const m = out.match(/(\d+\.\d+\.\d+)/);
      if (m) return { version: m[1], path: bin };
    } catch {}
    return null;
  };
  for (const bin of ['python3', 'python']) {
    const hit = await tryRun(bin);
    if (hit) return { installed: true, ...hit };
  }
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileP('sh', ['-lc', 'command -v python3 || command -v python'], { timeout: 5000 });
      const p = stdout.trim();
      if (p) { const hit = await tryRun(p); if (hit) return { installed: true, ...hit, via: 'login-shell' }; }
    } catch {}
  }
  const home = homedir();
  const cands = process.platform === 'win32'
    ? [...(await winLiveCandidates(['python3.exe', 'python.exe'])), ...pythonWinFixed()]  // 注册表实时 PATH + python.org/Store 固定落点
    : ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', join(home, '.asdf/shims/python3')];
  for (const p of cands) {
    if (!existsSync(p)) continue;
    const hit = await tryRun(p);
    if (hit) return { installed: true, ...hit, via: 'fallback' };
  }
  return { installed: false };
}

// uv 检测(uvx 命令随 uv 一起装)。部分 MCP(fetch / paper-search 等)走 uvx 拉起,
// 别人机器上不一定有 uv;uvx 需要时会自动下载托管 Python,所以只需检测/安装 uv。
// 策略同 detectPython:PATH → login-shell → 全平台已知安装目录(astral/cargo/brew/
// scoop/winget/pipx/rye 等),避免「PATH 没刷新/版本管理器装的」误报未装。
export async function detectUv() { // export:mcp.js 把裸 uvx 改写为真实 uv 绝对路径用
  const tryRun = async (bin) => {
    try {
      const { stdout } = await execFileP(bin, ['--version'], { timeout: 5000 });
      const m = String(stdout).match(/(\d+\.\d+\.\d+)/);
      if (m) return { version: m[1], path: bin };
    } catch {}
    return null;
  };
  const hit1 = await tryRun('uv');
  if (hit1) return { installed: true, ...hit1, via: 'PATH' };
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileP('sh', ['-lc', 'command -v uv'], { timeout: 5000 });
      const p = stdout.trim();
      if (p) { const hit = await tryRun(p); if (hit) return { installed: true, ...hit, via: 'login-shell' }; }
    } catch {}
  }
  const home = homedir();
  const cands = process.platform === 'win32'
    ? [
        ...(await winLiveCandidates(['uv.exe'])),                                                                // 注册表实时 PATH(装完不重启即认)
        join(home, '.local', 'bin', 'uv.exe'),                                                          // astral 官方安装器
        join(home, '.cargo', 'bin', 'uv.exe'),                                                          // cargo install
        join(home, 'scoop', 'shims', 'uv.exe'),                                                         // scoop
        join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links', 'uv.exe'), // winget(非 Store 包落 WinGet\Links,非 WindowsApps)
        join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Python', 'Scripts', 'uv.exe'),   // pip --user
      ]
    : [
        join(home, '.local', 'bin', 'uv'),   // astral 安装器 / pipx
        join(home, '.cargo', 'bin', 'uv'),   // cargo
        '/opt/homebrew/bin/uv',              // brew (Apple Silicon)
        '/usr/local/bin/uv',                 // brew (Intel) / 手动
        '/usr/bin/uv',                       // 系统包
        '/opt/local/bin/uv',                 // MacPorts
        join(home, '.rye', 'shims', 'uv'),   // rye 自带 uv
        join(home, '.pyenv', 'shims', 'uv'), // pyenv 垫片(pip/pyenv 装的 uv)
      ];
  for (const p of cands) {
    if (!existsSync(p)) continue;
    const hit = await tryRun(p);
    if (hit) return { installed: true, ...hit, via: 'fallback' };
  }
  return { installed: false };
}

function envInstallCmd(target, proxyUrl = null, method = null) {
  const win = process.platform === 'win32';
  const mac = process.platform === 'darwin';
  // CI-2:claude 支持选 npm / native。原来恒 native(`irm claude.ai/install.ps1`),Windows 上
  // claude.ai 常被墙;npm 走 `npm install -g @anthropic-ai/claude-code`(GUI 能开=node 在)。
  if (target === 'claude') return installCmdFor(proxyUrl, method === 'npm' ? 'npm' : 'native');
  if (target === 'uv') {
    // Windows 同 claude native:PowerShell 5.1 的 irm 不读 HTTP_PROXY 环境变量,
    // 必须在进程内注入 .NET DefaultWebProxy,否则墙内卡死(见 installCmdFor 注释)。
    if (win) {
      const setup = proxyUrl
        ? `$p='${proxyUrl}'; [System.Net.WebRequest]::DefaultWebProxy=New-Object System.Net.WebProxy($p); $env:HTTP_PROXY=$p; $env:HTTPS_PROXY=$p; Write-Host ('(proxy: '+$p+')'); `
        : '';
      const inner = `${setup}$ProgressPreference='Continue'; Write-Host 'Installing uv (astral.sh)...'; irm https://astral.sh/uv/install.ps1 | iex`;
      return `powershell -NoProfile -ExecutionPolicy Bypass -Command "${inner}"`;
    }
    return 'curl -LsSf https://astral.sh/uv/install.sh | sh'; // mac + linux 官方安装器
  }
  // Windows winget 兜底:winget(App Installer)在 LTSC/Server/未更新旧 Win10/企业锁机上
  // 可能缺失 → 裸 `winget install` 会报"不是内部命令"卡死。批处理里先 `where winget` 探测,
  // 没有就 `start` 打开官方下载页(默认浏览器)。`if errorlevel 1`= where 未找到(errorlevel≥1)。
  const wingetOr = (id, url) =>
    `where winget >nul 2>nul & if errorlevel 1 ( echo winget 不可用,正在打开官方下载页... & start "" "${url}" ) else ( winget install -e --id ${id} )`;
  if (target === 'node') {
    if (win) return wingetOr('OpenJS.NodeJS.LTS', 'https://nodejs.org/en/download/');
    if (mac) return 'brew install node || { echo "未检测到 Homebrew,已打开 Node.js 官网 —— 下载 pkg 双击安装即可(无需 Xcode CLT / Homebrew)"; open "https://nodejs.org/en/download/"; }';
    return 'sudo apt-get update && sudo apt-get install -y nodejs npm || echo "请用你的发行版包管理器安装 node"';
  }
  if (target === 'python') {
    if (win) return wingetOr('Python.Python.3.12', 'https://www.python.org/downloads/windows/');
    if (mac) return 'brew install python || { echo "未检测到 Homebrew,已打开 Python 官网 —— 下载 pkg 双击安装即可(无需 Xcode CLT / Homebrew)"; open "https://www.python.org/downloads/"; }';
    return 'sudo apt-get update && sudo apt-get install -y python3 python3-pip || echo "请用你的发行版包管理器安装 python3"';
  }
  if (target === 'git') {
    if (win) return wingetOr('Git.Git', 'https://git-scm.com/download/win');
    if (mac) return 'xcode-select --install || brew install git || echo "请到 https://git-scm.com/download/mac 下载安装"';
    return 'sudo apt-get update && sudo apt-get install -y git || echo "请用你的发行版包管理器安装 git"';
  }
  return null;
}

// git 检测。GUI 的 git init / 回滚 / worktree 都依赖它,且子代理的 using-git-worktrees
// skill 在无 git 时会报错。策略同 detectPython:PATH → 全平台已知安装目录。
async function detectGit() {
  const tryRun = async (bin) => {
    try {
      const { stdout } = await execFileP(bin, ['--version'], { timeout: 5000 });
      const m = String(stdout).match(/(\d+\.\d+\.\d+)/);
      if (m) return { version: m[1], path: bin };
    } catch {}
    return null;
  };
  const onPath = await tryRun('git');
  if (onPath) return { installed: true, ...onPath };
  const home = homedir();
  const cands = process.platform === 'win32'
    ? [
        ...(await winLiveCandidates(['git.exe'])),  // 注册表实时 PATH(Git for Windows 装完写 Machine PATH,进程旧快照读不到)
        join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
        join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
        join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Programs', 'Git', 'cmd', 'git.exe'),
      ]
    : ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'];
  for (const p of cands) {
    if (!existsSync(p)) continue;
    const hit = await tryRun(p);
    if (hit) return { installed: true, ...hit, via: 'fallback' };
  }
  return { installed: false };
}

router.get('/env-check', async (req, res) => {
  // ?refresh=1(面板"重新检测"):绕过全量扫描的 5 分钟缓存,装完软件立即可见。
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const [{ method, path: claudePath, via }, python, uv, git, scan, npmInfo] = await Promise.all([
    detectInstall(), detectPython(), detectUv(), detectGit(), scanAllTools({ refresh }), probeNpm(),
  ]);
  // R8-2:死 override 判定(手动指定的 claude 路径文件已不存在)
  const claudeOverride = getClaudeOverride();
  const claudeOverrideDead = !!claudeOverride && !existsSync(claudeOverride);
  const claudeVersion = await getClaudeVersion(claudePath);
  // claude 的全部安装:复用 resolver 的全策略列举(与设置页"切换用哪个 claude"同源)。
  const claudeInstalls = await Promise.all((await listClaudeInstallsAsync()).map(async (it) => ({
    path: it.path, version: await getClaudeVersion(it.path),
  })));
  // 主检测(PATH 优先)落空但全量扫描扫到了(典型:装在非 C 盘/非常规目录且 PATH 没配)
  // → 以扫描首个命中兜底报"已安装",resolvedPath 指向它。
  const withScan = (primary, installs) => {
    const p = (!primary.installed && installs.length)
      ? { installed: true, version: installs[0].version, path: installs[0].path, via: 'scan' }
      : primary;
    return {
      installed: p.installed, version: p.version || null,
      // PATH 直查命中时 detect* 的 path 是裸命令名(如 'git'),换成扫描给出的绝对路径。
      resolvedPath: (p.path && /[\\/]/.test(p.path)) ? p.path
        : (installs.find((i) => i.via === 'PATH')?.path || p.path || null),
      via: p.via || (p.installed ? 'PATH' : null),
      installs,
    };
  };
  res.json({
    node: {
      installed: true, version: process.version, required: true,
      // GUI 后端实际跑在哪个 node 上(Tauri find_node 选定);扫描列表是机器上全部 node。
      resolvedPath: process.execPath, via: 'runtime',
      meets: nodeMeets(process.version), minVersion: String(NODE_MIN_MAJOR),
      installs: scan.node,
    },
    // resolvedPath/via:实际解析到的二进制位置与命中策略(PATH / login-shell /
    // npm-prefix / known-path / scan),检测面板据此展示"从哪找到的"。
    claude: {
      // 解析到路径即算已装(即便 --version 超时未取到版本号),避免"已装但探测慢"被误报未安装。
      installed: !!claudePath, version: claudeVersion || null, method, required: true,
      resolvedPath: claudePath || null, via: via || null,
      versionProbeFailed: !!claudePath && !claudeVersion,
      installs: claudeInstalls,
      // R8-2:死 override 标注(环境检查面板据此显示横幅,与 cli-check/claude-installs 同口径)
      ...(claudeOverrideDead ? { overrideDead: true, override: claudeOverride } : {}),
      // r12-①a:paused 态(EnvCheckPanel 恢复横幅数据源;只增字段)
      ...(getClaudeOverrideRaw().paused ? { overridePaused: true, overridePausedPath: getClaudeOverrideRaw().path } : {}),
    },
    git: { ...withScan(git, scan.git), required: false },
    // r13-p2-22:npm 不扫路径(Node 自带,扫是冗余),只报有效配置 ——
    // 版本(哪个 node 带的)/全局前缀(claude 会装到哪)/registry(决定 npm 渠道快慢)。
    npm: { ...npmInfo, required: false },
    python: { ...withScan(python, scan.python), required: false },
    uv: { ...withScan(uv, scan.uv), required: false },
    platform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
  });
});

router.post('/env-check/install', async (req, res) => {
  const target = String(req.body?.target || '');
  const method = req.body?.method === 'npm' ? 'npm' : null; // CI-2:claude 可选 npm 安装
  try {
    const proxyUrl = await detectLiveProxy(); // r34-③:探活通过才注入
    const cmd = envInstallCmd(target, proxyUrl, method);
    if (!cmd) return res.status(400).json({ ok: false, error: 'unknown target: ' + target });
    // win + uv:代理已注入 PS 命令内,不让 .bat 再 set(对 irm 无效且重复)。其余照旧由
    // launchInTerminal 在脚本里 export/set HTTP_PROXY。
    const termProxy = (target === 'uv' && process.platform === 'win32') ? null : proxyUrl;
    const titles = { claude: '安装 Claude Code', node: '安装 Node.js', python: '安装 Python', uv: '安装 uv', git: '安装 Git' };
    launchInTerminal(cmd, titles[target] || '安装', termProxy);
    res.json({ ok: true, launched: true, command: cmd, platform: process.platform, proxy: proxyUrl });
  } catch (err) {
    res.json({ ok: false, error: err.message || '启动终端失败' });
  }
});

export default router;
