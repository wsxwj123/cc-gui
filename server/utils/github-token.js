// r67:GitHub API 令牌解析。未鉴权 GitHub API 限 60 次/小时且按出口 IP 计,挂共享代理
// (Clash 机场等)的用户出口 IP 配额常年被打满 → 技能市场六个源恒空、版本检测限流。
// 带令牌后 5000 次/小时按令牌计,与出口 IP 无关,根治。
// 解析顺序:GH_TOKEN/GITHUB_TOKEN 环境变量 → ~/.claude-gui/github-token.json(导入页填的
// PAT)→ `gh auth token`(装了 gh 且已登录则零配置自动用上)。结果(含"没有")缓存 5 分钟,
// 避免每个请求 spawn 一次 gh;带令牌收到 401 时由 gfetch 调 invalidate 作废重解析。
// ⚠️ 令牌是敏感信息:不写日志、任何端点不回显值、文件 0600、不进 settings.json。
import { readFile, writeFile, mkdir, rename, rm } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);
// 测试种子:单测把文件指到临时目录,绝不读写真实 ~/.claude-gui(里面可能有用户真令牌)。
const TOKEN_FILE = process.env.CGUI_GITHUB_TOKEN_FILE || join(homedir(), '.claude-gui', 'github-token.json');
// 形状校验:可见 ASCII、无空白,长度 8-255(ghp_/github_pat_/gho_/40 位 hex 全在内)。
// 故意松:真伪由保存端点在线打 /rate_limit 验,这里只挡明显粘错的(中文/带空格/整段命令)。
const TOKEN_RE = /^[\x21-\x7e]{8,255}$/;

const TTL = 5 * 60 * 1000;
let cached = null;   // { at, value: { token, source } | null }
let inflight = null; // 并发去重:同一时刻只解析一次(避免并发首拉时 spawn 多个 gh)

async function fromFile() {
  try {
    const t = String(JSON.parse(await readFile(TOKEN_FILE, 'utf-8'))?.token || '').trim();
    return TOKEN_RE.test(t) ? t : null;
  } catch { return null; }
}

async function fromGh() {
  // index.js 启动时已把 /opt/homebrew/bin 等常见安装目录前置进 PATH,mac 打包版 execFile('gh')
  // 能命中;Win 的 GUI 进程持旧 PATH 快照(装完 gh 不重启进程看不到),补安装器默认绝对路径兜底。
  const candidates = process.platform === 'win32'
    ? ['gh', join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe')]
    : ['gh'];
  for (const bin of candidates) {
    try {
      const { stdout } = await execFileP(bin, ['auth', 'token'], { timeout: 5000, windowsHide: true });
      const t = String(stdout).trim();
      if (TOKEN_RE.test(t)) return t;
    } catch { /* 未装/未登录/超时 → 下一个候选 */ }
  }
  return null;
}

async function doResolve() {
  const env = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  if (TOKEN_RE.test(env)) return { token: env, source: 'env' };
  const pat = await fromFile();
  if (pat) return { token: pat, source: 'pat' };
  const gh = await fromGh();
  if (gh) return { token: gh, source: 'gh' };
  return null;
}

// 返回 { token, source: 'env'|'pat'|'gh' } 或 null。永不 reject。
export function resolveGithubToken() {
  if (cached && Date.now() - cached.at < TTL) return Promise.resolve(cached.value);
  if (!inflight) {
    inflight = doResolve()
      .catch(() => null)
      .then((v) => { cached = { at: Date.now(), value: v }; inflight = null; return v; });
  }
  return inflight;
}
export function invalidateGithubToken() { cached = null; }

// 令牌只注入 GitHub API 域:raw.githubusercontent 不吃 API 配额,gitee/其它域带上徒增泄露面。
// 调用方已自带 Authorization(如保存端点在线验令牌)则不动。返回注入后的新 headers;不注入返回 null。
export function withGithubAuth(url, headers = {}, token) {
  if (!token || !String(url).startsWith('https://api.github.com/')) return null;
  for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') return null;
  return { ...headers, Authorization: `Bearer ${token}` };
}

export async function saveGithubToken(raw) {
  const token = String(raw || '').trim();
  if (!TOKEN_RE.test(token)) {
    const e = new Error('令牌格式不对:应为 GitHub 生成的 token(无空格与中文,长度 8-255)');
    e.status = 400;
    throw e;
  }
  await mkdir(join(TOKEN_FILE, '..'), { recursive: true });
  // 原子写 + 0600(仅本用户可读):与 skills.js 的 sources/repos 文件同一手法。
  const tmp = `${TOKEN_FILE}.tmp-${Date.now()}`;
  await writeFile(tmp, JSON.stringify({ token }), { mode: 0o600 });
  await rename(tmp, TOKEN_FILE);
  invalidateGithubToken();
}

export async function clearGithubToken() {
  await rm(TOKEN_FILE, { force: true });
  invalidateGithubToken();
}
