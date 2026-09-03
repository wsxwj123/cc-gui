import { Router } from 'express';
import { realpath } from 'fs/promises';
import { resolve } from 'path';
import { homedir } from 'os';
import { isPathInside, isKnownClaudeWorkspace } from '../utils/safe-path.js';
import { claudeCommand } from '../utils/claude-resolver.js';
import { getAvailableModels } from '../services/model-resolver.js';

// node-pty 是本 server 唯一的原生模块,其 .node 二进制按「构建时的 Node ABI」编译。
// 打包发布时(CI Node 20)编译进 bundle,但 app 运行时 spawn 的是用户机器上「任意版本」
// 的系统 node;大版本不一致时 require 会抛 NODE_MODULE_VERSION 不匹配。它只服务「手机
// 远程控制」这一个可选功能,绝不该让整个后端在启动(顶层静态 import)就被它带崩——这正是
// 「另一台 Windows 上后端起不来 / did not accept connections」的根因。改惰性加载:首次用到
// 才 import,失败只让本功能返回错误,server 照常启动。
let _ptyPromise;
function loadPty() {
  if (!_ptyPromise) {
    _ptyPromise = import('node-pty').then((m) => m.default?.spawn ? m.default : m).catch((e) => {
      _ptyPromise = undefined; // 不缓存失败,允许后续重试
      throw new Error(`node-pty 加载失败,手机远程控制不可用(其余功能正常):${e.message}`);
    });
  }
  return _ptyPromise;
}

const router = Router();
const HOME = homedir();
// Claude session ids are UUIDs.
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

/**
 * Active remote-control sessions, keyed by sessionId.
 * Each entry: { term, startedAt, cwd }
 *
 * We host `claude --remote-control --resume <id>` on a hidden pseudo-terminal
 * (node-pty) — exactly how Claude Desktop does it: the process needs isatty()
 * to be true to enter interactive mode and register with Anthropic's relay, but
 * it does NOT need a visible terminal window. Control is relayed through
 * Anthropic (no tunnel/auth exposed from this machine); the GUI keeps showing
 * the session by watching the same on-disk jsonl.
 *
 * IMPORTANT: while an RC session is live, the GUI must NOT spawn `-p` turns for
 * the same sessionId (both would write the same jsonl → corruption). The client
 * locks the composer and shows a "reclaim control" banner.
 */
const active = new Map();

// Kill every hosted RC pty. Without this, a server restart (Ctrl+C / crash)
// leaves the `claude --remote-control` children orphaned — they keep writing
// the session jsonl, and since the in-memory Map is gone, re-activating the
// same sessionId spawns a SECOND writer → corruption. Registered once.
function killAll() {
  for (const e of active.values()) { try { e.term.kill(); } catch {} }
  active.clear();
}
process.once('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => { killAll(); process.exit(0); });
}

// 自检发现「CLI 拒绝激活」时记下原话,供状态端点回话一次。读一次即清:客户端拿去提示
// 过就不再需要,也免得这张表随失败过的 sessionId 无限长。
const failures = new Map();

// CLI 侧拒绝 Remote Control 的提示只印在 pty 里 —— `--remote-control` 是 flag 形态,
// 被拒后照常进交互会话、进程不退出,所以既没有退出码也没有别的信号可用。
// 逐条锚定二进制里的原文(RESEARCH-r5-cli-native.md Q4 已把它们摘全),窄联合而不是
// 泛化成 /Remote Control/:误杀会把本来能用的远程控制掐掉,比漏判更糟,拿不准一律放行。
// 【覆盖】端点(BASE_URL 非 api.anthropic.com)、订阅、长期令牌(setup-token /
//   CLAUDE_CODE_OAUTH_TOKEN)、组织策略 disableRemoteControl、云会话、企业网关、
//   bridge 环境注册失败。
// 【不覆盖】① feature-flag 关闭(DISABLE_TELEMETRY / DO_NOT_TRACK /
//   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC / DISABLE_GROWTHBOOK)—— CLI 不印任何文案;
//   ② 提示被终端折行截断在两行之间;③ 8KB 之后才出现的拒绝。这几类仍会停在"显示已激活"。
// 撇号在不同渲染下有 ' / ’ 两形,组织策略那条断在撇号之前。
// 输出带 ANSI 色码与提示框边框,先剥掉再匹配、再取那一行原话回给用户。
const RC_FAILURE_RE = new RegExp([
  'Remote Control is only available',                  // ANTHROPIC_BASE_URL 指向非官方主机
  'Remote Control requires a claude\\.ai subscription', // API key / 未登录订阅
  'Remote Control requires a full-scope login token',   // setup-token / OAUTH_TOKEN 只有推理权限
  'Remote Control is disabled by your organization',    // 管理策略 disableRemoteControl
  'Remote Control is not available inside a cloud session',
  'Remote Control environments are not available',      // bridge 环境注册被账号拒绝
  'connected through an enterprise cloud gateway',      // 唯一不以 Remote Control 开头的一条
].join('|'));
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export function rcFailureIn(output) {
  const clean = String(output || '').replace(ANSI_RE, '');
  if (!RC_FAILURE_RE.test(clean)) return null;
  const line = clean.split(/\r?\n/).find((l) => RC_FAILURE_RE.test(l)) || '';
  return line.replace(/[│|╭╮╯╰─\s]+/g, ' ').trim().slice(0, 200);
}
// 只扫开头这么多输出:失败提示在启动后不久就印出来,之后都是正常会话内容,扫全程既占
// 内存又抬高误杀概率。
const SCAN_LIMIT = 8 * 1024;

function statusOf(sessionId) {
  const e = active.get(sessionId);
  if (e) return { active: true, startedAt: e.startedAt, cwd: e.cwd };
  const failure = failures.get(sessionId);
  if (failure) {
    failures.delete(sessionId);
    return { active: false, failure };
  }
  return { active: false };
}

// POST /api/remote-control  { sessionId, cwd } — start (or return existing) RC session.
router.post('/remote-control', async (req, res) => {
  try {
    const { sessionId, cwd } = req.body || {};
    if (!UUID_RE.test(String(sessionId || ''))) throw new Error('invalid sessionId');

    if (active.has(sessionId)) {
      return res.json({ ok: true, sessionId, ...statusOf(sessionId), reused: true });
    }
    failures.delete(sessionId); // 新的一次尝试,旧结论作废

    // Remote Control 是 Anthropic 第一方能力:CLI 自 2.1.196 起,`ANTHROPIC_BASE_URL` 指向
    // api.anthropic.com 以外的主机即禁用它(二进制原文:"Remote Control is only available
    // when using Claude via api.anthropic.com."),而 GUI 切任何第三方 provider 都必写这个
    // 变量(中转与 openai 协议都落回环代理)。此前这里不判:pty 里那个 `--remote-control`
    // 交互进程照常起、不退出,失败提示又被 onData 丢掉 → 按钮恒绿「已激活」、输入框锁死,
    // 手机永远接不上。判据与 /api/slash-commands 的 isAnthropic 同源(getAvailableModels
    // 已把回环代理还原成真实 provider 名),顶栏按钮与手打 /rc 两个入口都经过这里。
    let provider = 'Anthropic';
    try { provider = (await getAvailableModels()).provider || 'Anthropic'; } catch {}
    if (provider !== 'Anthropic') {
      throw new Error(`远程控制要求 ANTHROPIC_BASE_URL 指向 api.anthropic.com。当前 provider 为「${provider}」，切回官方 Anthropic 后可开启。`);
    }

    let dir = HOME;
    if (cwd) {
      const real = await realpath(resolve(cwd)).catch(() => null);
      // HOME itself or a path under it. isPathInside 平台无关(用 path.relative),既挡掉
      // startsWith 的旁路('/Users/alice2' 伪装 '/Users/alice'),又修好 Windows 反斜杠路径
      // 永远匹配不上 `HOME + '/'` → 合法 cwd 也被拒的问题。
      // claude 用过的工作区($HOME 之外的项目盘,Windows 常见)同样放行,与文件浏览器同判据。
      if (!real || !(isPathInside(real, HOME) || isKnownClaudeWorkspace(real, resolve(cwd)))) {
        throw new Error('cwd 不在家目录、也不在任何打开过的项目目录内');
      }
      dir = real;
    }

    // Same provider-routing hygiene as the chat spawn (see chat.js): strip
    // inherited official ANTHROPIC_* so the resumed session talks to the
    // provider in settings.json, not a Claude-Desktop-injected official base/token.
    const rcEnv = { ...process.env };
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
      delete rcEnv[k];
    }
    const pty = await loadPty();
    // 平台分支:此前恒用 `process.env.SHELL || '/bin/bash'` + `-lc`,Windows 上 SHELL 为空
    // → 落到不存在的 /bin/bash,pty.spawn 直接抛(ENOENT),手机远程控制在 Windows 主机上
    // 必坏(用户双端 dogfood 场景)。
    //  · POSIX:保持 login shell(-lc)——server 继承的 PATH 比登录 shell 窄,裸 spawn `claude`
    //    会 posix_spawnp 失败;login shell 补齐 Homebrew/版本管理器 shim。
    //  · Windows:无 login shell 概念。用 resolver 找到的 claude 绝对路径直接 spawn(ConPTY
    //    不靠 login shell 补 PATH);.cmd/.bat 经 cmd.exe /c(claudeCommand 已封装)。
    let term;
    if (process.platform === 'win32') {
      const { file, args } = claudeCommand(['--remote-control', '--resume', sessionId]);
      term = pty.spawn(file, args, { name: 'xterm-color', cols: 100, rows: 30, cwd: dir, env: rcEnv });
    } else {
      const shell = process.env.SHELL || '/bin/bash';
      // sessionId 已 UUID 校验,插值安全;cwd 走 pty option(不插值)。
      term = pty.spawn(shell, ['-lc', `claude --remote-control --resume ${sessionId}`], {
        name: 'xterm-color', cols: 100, rows: 30, cwd: dir, env: rcEnv,
      });
    }

    const entry = { term, startedAt: Date.now(), cwd: dir };
    active.set(sessionId, entry);

    // Drain output so the pty buffer never blocks; we don't render it anywhere.
    // 但开头这段要看一眼:provider 门只堵住 base URL 那一条,CLI 还会因订阅 / 长期令牌 /
    // 组织策略 / 云会话 / 企业网关拒绝激活,同样是「印一行提示、进程继续跑」。命中即杀 pty
    // 并从 active 摘掉 —— 状态端点随之变回未激活并带上原话,前端据此解锁,不再谎称
    // 「已激活」。认哪几条、漏哪几类见 RC_FAILURE_RE 上方(feature-flag 那类 CLI 不印文案,
    // 检测不到)。
    let head = '';
    let scanning = true;
    term.onData((chunk) => {
      if (!scanning) return;
      head += chunk;
      if (head.length >= SCAN_LIMIT) scanning = false;
      const failure = rcFailureIn(head);
      if (!failure) return;
      scanning = false;
      failures.set(sessionId, failure);
      try { term.kill(); } catch {}
      active.delete(sessionId);
    });
    term.onExit(() => { active.delete(sessionId); });

    res.json({ ok: true, sessionId, ...statusOf(sessionId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/remote-control/stop  { sessionId } — reclaim control (kill RC pty).
router.post('/remote-control/stop', (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!UUID_RE.test(String(sessionId || ''))) throw new Error('invalid sessionId');
    const e = active.get(sessionId);
    if (e) {
      try { e.term.kill(); } catch {}
      active.delete(sessionId);
    }
    res.json({ ok: true, sessionId, active: false });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/remote-control?sessionId=...  — single status; or list all active ids.
router.get('/remote-control', (req, res) => {
  const { sessionId } = req.query || {};
  if (sessionId) return res.json({ sessionId, ...statusOf(String(sessionId)) });
  res.json({ active: [...active.keys()] });
});

export default router;
