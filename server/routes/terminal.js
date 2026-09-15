import { Router } from 'express';
import { randomBytes } from 'crypto';
import { realpath, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { isPathInside, isKnownClaudeWorkspace } from '../utils/safe-path.js';
import { loadPty } from './remote-control.js';

// 内置终端:node-pty ↔ 浏览器 xterm.js 的 WS 桥。
// 复用现有 /ws 连接(WebSocketServer 带 path 过滤,同 server 再挂第二个 wss 抢不到
// upgrade),按消息类型 `term-*` 分流 —— 白捡现成的 verifyClient 鉴权(本地免密/远端
// 要 token),终端帧与主 socket 的 ping/model 消息互不干扰。
//
// v3 生命周期(首批 R01 身份/分离合同,接口见 .devflow/INTERFACE.md「终端与代码块」):
//   - 每个存活 shell 维护 generation(从 1 递增)与 resumeToken(高熵敏感凭据,
//     绑定 terminalId+generation,不进日志/DOM)。旧代际的迟到帧一律 TERM_STALE。
//   - term-open 无 token = 新建/同连接幂等;跨连接不凭 id 接管 → TERM_TOKEN_REQUIRED,
//     拒绝不杀原任务。重连必须 term-open {id,generation,resumeToken}。
//   - 面板收起/卸载/ws 断开 = detach:进程与环形缓冲保留(≤200KiB,seq 单调),
//     新连接凭 token 原子接管并按序回放,不重复不乱序。
//   - 显式 term-close 才杀进程并撤销能力。自然 exit 撤销 resume 能力(旧 token 再
//     resume → TERM_TOKEN_REVOKED),留只读终态记录(≤4 项/各 200KiB/6h):归属
//     连接可 term-restart 在同一 id 上开新 generation(新 pid/新 token),记录已
//     过期则 TERM_NOT_FOUND("记录已过期,请新建终端")。
//   - 畸形 JSON/未知 term-* 帧 → term-error TERM_INVALID_MESSAGE(可解析 id 则回显)。
//   - 并发上限 4(含分离态),满额 TERM_LIMIT 明确拒绝,不淘汰用户终端。
//
// 帧协议(客户端 → 服务端):
//   { type:'term-open',    id, cols, rows, cwd? }                 新建(幂等)
//   { type:'term-open',    id, generation, resumeToken }          重连/接管
//   { type:'term-in',      id, generation, data }                 键入(含粘贴,可大)
//   { type:'term-resize',  id, generation, cols, rows }           xterm 视口变化
//   { type:'term-detach',  id, generation }                       收起/卸载(进程保留)
//   { type:'term-restart', id, generation }                       已退出代际重开可交互 shell
//   { type:'term-close',   id, generation }                       显式结束该 shell
// 服务端 → 客户端:
//   term-opened {id,generation,pid,cwd,reused,state,resumeToken,lastSeq,
//                replayFromSeq,replayToSeq,truncated} / term-out {id,generation,seq,data,replay} /
//   term-detached {id,generation,reason} / term-exit {id,generation,exitCode} /
//   term-closed {id,generation} / term-error {id,code,error}

const router = Router();
const HOME = homedir();
// ponytail: 上限 4 个并发终端(含分离态),防脚本失控狂开;真需要多开再放
const MAX_TERMINALS = 4;
const DETACH_BUF_MAX = 200 * 1024; // 分离/在线输出环形缓冲上限(回放用)
// 分离终端最长保留 6h(自最后分离起;合同:不能按创建时间提前到期,也不能靠改大上限藏问题)。
// CCGUI_TERM_DETACH_MAX_MS 只给单测加速这条到期路径用,默认 6h 不变。
const MAX_DETACHED_AGE_MS = Number(process.env.CCGUI_TERM_DETACH_MAX_MS) > 0
  ? Number(process.env.CCGUI_TERM_DETACH_MAX_MS)
  : 6 * 60 * 60 * 1000;
const OPEN_TIMEOUT_MS = 15_000; // term-open 最长 15s,超时 TERM_OPEN_TIMEOUT
const ATTACH_CONFLICT_WINDOW_MS = 1_000; // 附着后该窗口内的他连接同 token resume 视为并发冲突
const EXITED_KEEP = 4; // 自然退出只读记录条数上限(各 200KiB,见 DETACH_BUF_MAX)
const MAX_EXITED_AGE_MS = 6 * 60 * 60 * 1000; // 退出记录最长保留 6h(自退出起)

// id -> { id, generation, pid, term, ws|null, cwd, cols, rows, resumeToken,
//         seq, buf:[{seq,data}], bufBytes, bufTruncated, detachedAt, startedAt,
//         lastAttachAt }
// 已退出/被显式关闭的条目即刻移出 Map(能力随之撤销),terminals 只含存活 shell。
const terminals = new Map();
// 自然退出的只读终态记录(不计入 MAX_TERMINALS):支持"重新连接"在同一 id 上开新
// generation,并保留最后附着连接的归属;最多 EXITED_KEEP 项,超过 6h 移除。
const exitedTerminals = new Map();
// 正在创建中的 id(open 与 restart 共用):realpath/loadPty 是 await 点,两个相同 id 的
// 并发请求若都放行会 spawn 出两个 PTY、后注册的 entry 覆盖先注册的(前者进程失联)。
const openingIds = new Set();

function killAll() {
  for (const e of terminals.values()) { try { e.term.kill(); } catch {} }
  terminals.clear();
}
process.once('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => { killAll(); process.exit(0); });
}

function send(ws, obj) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {}
}

function termError(ws, id, code, error) {
  send(ws, { type: 'term-error', id, code, error: error || code });
}

// xterm 尺寸只认合理整数,坏帧夹回默认,不让单个客户端把 pty 撑爆
function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

function newToken() {
  return randomBytes(24).toString('base64url');
}

const utf8Len = (s) => Buffer.byteLength(s, 'utf8');

// 单块超预算时按 UTF-8 字节截尾,不切破多字节字符(中文不出现半个编码字符):
// 从尾部逐码元收缩,直到字节量落入预算。
function truncateUtf8(str, maxBytes) {
  if (utf8Len(str) <= maxBytes) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (utf8Len(str.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return str.slice(0, lo);
}

// 常驻环形缓冲:在线/分离输出都进,总字节超限丢最旧;单块超预算先截尾。
// 返回本块 seq(该 generation 内严格递增)。
function pushBuf(entry, data) {
  if (utf8Len(data) > DETACH_BUF_MAX) data = truncateUtf8(data, DETACH_BUF_MAX);
  entry.seq += 1;
  entry.buf.push({ seq: entry.seq, data });
  entry.bufBytes += utf8Len(data);
  while (entry.bufBytes > DETACH_BUF_MAX && entry.buf.length > 1) {
    const dropped = entry.buf.shift();
    entry.bufBytes -= utf8Len(dropped.data);
    entry.bufTruncated = true;
  }
  return entry.seq;
}

function openFrame(entry, reused) {
  return {
    type: 'term-opened',
    id: entry.id,
    generation: entry.generation,
    pid: entry.pid,
    cwd: entry.cwd,
    reused: !!reused,
    state: entry.ws ? 'attached' : 'detached',
    resumeToken: entry.resumeToken,
    lastSeq: entry.seq,
    replayFromSeq: entry.buf.length ? entry.buf[0].seq : null,
    replayToSeq: entry.seq,
    truncated: entry.bufTruncated,
  };
}

// 回放 + 在线由同一次附着边界连续提供:opened 先行,随后按 seq 升序补发缓冲。
function replayBuf(ws, entry) {
  for (const item of entry.buf) {
    send(ws, { type: 'term-out', id: entry.id, generation: entry.generation, seq: item.seq, data: item.data, replay: true });
  }
}

// 过期分离终端先清(自 detachedAt 起 6h;不从创建时算);退出记录超过 6h 一并移除
// (移除只读缓冲不影响任何存活终端)。
function sweepExpired() {
  const now = Date.now();
  for (const [tid, e] of terminals) {
    if (!e.ws && e.detachedAt && now - e.detachedAt > MAX_DETACHED_AGE_MS) {
      try { e.term.kill(); } catch {}
      terminals.delete(tid);
      // 留"分离到期"墓碑:重连要能明确回 TERM_EXPIRED(而非"不存在"),
      // 上限与退出记录共用,不占存活终端名额。
      recordExited(e, null, true);
    }
  }
  for (const [tid, e] of exitedTerminals) {
    if (now - e.exitedAt > MAX_EXITED_AGE_MS) exitedTerminals.delete(tid);
  }
}

// 到期不能只靠下一次 open/restart 触发:惰性 sweep 对"分离后无人再访问"的 shell 永不生效,
// 6h 上限形同虚设(实测:把阈值压到 1.5s,分离 6s 后 shell 仍存活、仍计 active)。
// 定时 sweep 与惰性 sweep 并存;unref 不挡进程退出,空表时代价可忽略。
// 间隔取 min(60s, 阈值)(单测把阈值压小时按同一节奏跑),下限 250ms 防空转。
const SWEEP_INTERVAL_MS = Math.max(250, Math.min(60_000, MAX_DETACHED_AGE_MS));
setInterval(sweepExpired, SWEEP_INTERVAL_MS).unref?.();

// 自然退出 / 分离到期:从存活表移出(active 不含已退出),转只读终态记录 —— 保留输出
// 缓冲与"最后附着该代际的连接"归属(term-restart 用);resume 能力即刻撤销。
// expired=true 是分离超龄被回收的墓碑:可重连告知 TERM_EXPIRED,但不提供重启。
function recordExited(entry, exitCode, expired = false) {
  entry.exitCode = exitCode;
  entry.expired = expired;
  entry.exitedAt = Date.now();
  entry.ownerWs = entry.ws;
  entry.ws = null;
  entry.detachedAt = null;
  entry.resumeToken = null; // 旧 token 不能再复活退出进程(resume → TERM_TOKEN_REVOKED)
  exitedTerminals.delete(entry.id);
  exitedTerminals.set(entry.id, entry);
  while (exitedTerminals.size > EXITED_KEEP) {
    exitedTerminals.delete(exitedTerminals.keys().next().value);
  }
}

// ── 重连/接管:term-open {id,generation,resumeToken} ──
function resumeTerminal(ws, msg, id) {
  if (typeof msg.resumeToken !== 'string' || !msg.resumeToken) {
    return termError(ws, id, 'TERM_TOKEN_REQUIRED', '重连缺少 resumeToken,不能凭 id 接管终端');
  }
  const entry = terminals.get(id);
  if (!entry) {
    // 已自然退出:该代际的能力已撤销,旧 token 不能复活退出进程(不能伪装 reused);
    // 继续要用同一 id,走 term-restart。分离超 6h 被回收的是 TERM_EXPIRED。
    const rec = exitedTerminals.get(id);
    if (rec) {
      return rec.expired
        ? termError(ws, id, 'TERM_EXPIRED', '该终端分离已超时被回收;请新建终端')
        : termError(ws, id, 'TERM_TOKEN_REVOKED', '该终端已退出,旧凭据已撤销;请重新连接以新建 shell');
    }
    return termError(ws, id, 'TERM_NOT_FOUND', '终端不存在或已结束,请新建终端');
  }
  if (entry.generation !== msg.generation) {
    return termError(ws, id, 'TERM_STALE', '代际已过期,该终端身份已被更新');
  }
  if (entry.resumeToken !== msg.resumeToken) {
    return termError(ws, id, 'TERM_FORBIDDEN', 'resumeToken 与该终端不匹配');
  }
  // 并发同 token resume 只一个获准:刚被另一连接附着(窗口内)时拒绝后来者,
  // 不杀原任务。超窗的 resume 视为用户显式重连,允许再次接管。
  if (entry.ws && entry.ws !== ws && Date.now() - entry.lastAttachAt < ATTACH_CONFLICT_WINDOW_MS) {
    return termError(ws, id, 'TERM_ATTACH_CONFLICT', '该终端正被另一连接并发重连,请稍后重试');
  }
  const previousWs = entry.ws;
  entry.ws = ws;
  entry.detachedAt = null;
  entry.lastAttachAt = Date.now();
  // 原子接管:旧连接立即失去写入权(收到 takeover 后不能自动夺回;token 不轮换)
  if (previousWs && previousWs !== ws) {
    send(previousWs, { type: 'term-detached', id, generation: entry.generation, reason: 'takeover' });
  }
  send(ws, openFrame(entry, true));
  replayBuf(ws, entry);
}

// 同 id 串行闸:spawn 之前有 await(realpath/loadPty),并发第二个必须看到第一个的结果,
// 否则两个都 spawn、后注册的 entry 覆盖先注册的(前者进程失联:不计 active、killAll
// 杀不到、输出无处去)。新建与重启共用 —— restart 同样走 spawnPty,旧代码只在新建侧设闸,
// 同 id 两帧并发 restart 会双开。
async function withIdGate(ws, id, run) {
  if (openingIds.has(id)) {
    return termError(ws, id, 'TERM_OPEN_CONFLICT', '同 id 终端正在创建中,请稍后重试');
  }
  openingIds.add(id);
  try {
    return await run();
  } finally {
    openingIds.delete(id);
  }
}

// ── 新建:term-open {id,cols,rows,cwd?} ──
async function createTerminal(ws, msg, id, attempt) {
  return withIdGate(ws, id, () => createTerminalLocked(ws, msg, id, attempt));
}

async function createTerminalLocked(ws, msg, id, attempt) {
  sweepExpired();
  const cols = clampInt(msg.cols, 20, 500, 100);
  const rows = clampInt(msg.rows, 5, 200, 30);
  const existing = terminals.get(id);
  if (existing) {
    if (existing.ws === ws) {
      // 同连接重复创建:规范化 cwd/cols/rows 一致才幂等返回原项;异参
      // TERM_OPEN_CONFLICT(尺寸变化应走 term-resize,不接受 open 换参)。
      let expectedDir = HOME;
      if (msg.cwd != null && msg.cwd !== '') {
        expectedDir = await realpath(resolve(msg.cwd)).catch(() => null);
      }
      if (attempt?.timedOut) return; // realpath 拖过了 15s:已回超时,不再补发 opened/回放
      if (existing.cols === cols && existing.rows === rows && (expectedDir === existing.cwd)) {
        send(ws, openFrame(existing, true));
        replayBuf(ws, existing);
        return;
      }
      return termError(ws, id, 'TERM_OPEN_CONFLICT', '同 id 重复 open 但 cwd/尺寸与现终端不一致');
    }
    // 跨连接不凭 id 接管(旧代码此处会杀掉别人的终端 —— R01 缺陷根因之一)
    return termError(ws, id, 'TERM_TOKEN_REQUIRED', '该终端由其他连接持有,重连需携带 resumeToken');
  }
  // 名额判定必须把"正在 spawn 的其它 id"算进来:terminals 要等 spawn 完才登记,只看它
  // 会让两个不同 id 的并发 open(或 open+restart)都看到旧水位、双双通过 → 存活数超
  // MAX_TERMINALS。openingIds 此刻含自己,故用 > 比较;满额明确拒绝,不提前淘汰
  // (淘汰会静默撤销分离终端的 resume 能力)。
  if (terminals.size + openingIds.size > MAX_TERMINALS) {
    return termError(ws, id, 'TERM_LIMIT', `并发终端已达上限(${MAX_TERMINALS}),先关闭一些再开`);
  }
  let dir = HOME;
  if (msg.cwd != null && msg.cwd !== '') {
    if (typeof msg.cwd !== 'string') {
      return termError(ws, id, 'TERM_INVALID_CWD', 'cwd 必须是字符串路径');
    }
    // 与 remote-control 同口径:家目录内或 Claude 用过的已知工作区,别处不放行
    const real = await realpath(resolve(msg.cwd)).catch(() => null);
    if (!real) {
      return termError(ws, id, 'TERM_INVALID_CWD', 'cwd 不存在或不可访问');
    }
    let st = null;
    try { st = await stat(real); } catch {}
    if (!st || !st.isDirectory()) {
      return termError(ws, id, 'TERM_INVALID_CWD', 'cwd 不是目录');
    }
    if (!(isPathInside(real, HOME) || isKnownClaudeWorkspace(real, resolve(msg.cwd)))) {
      return termError(ws, id, 'TERM_FORBIDDEN_CWD', 'cwd 不在家目录、也不在任何打开过的项目目录内');
    }
    dir = real;
  }
  let term;
  try {
    term = await spawnPty({ cols, rows, dir });
  } catch (err) {
    // 同 id 可在修正环境后重试(此处未登记 Map,重试即全新 open)
    return termError(ws, id, 'TERM_UNAVAILABLE', `无法启动 shell:${err.message}`);
  }
  registerTerminal(ws, id, term, { dir, cols, rows, generation: 1, restartFrom: null }, attempt);
}

// 启动 PTY(新建/重启共用):失败抛出,由调用方映射错误码。
async function spawnPty({ cols, rows, dir }) {
  const pty = await loadPty();
  if (process.platform === 'win32') {
    // 交互式 cmd.exe:无参数,不经 claudeCommand;裸名在 winpty 回退路径下不搜 PATH,
    // 照 remote-control 的做法给绝对路径。
    const cmdAbs = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    return pty.spawn(cmdAbs, [], { name: 'xterm-color', cols, rows, cwd: dir, env: process.env });
  }
  // login shell(-l):补齐 Homebrew/版本管理器 shim 的 PATH,与用户手动开终端同体验
  const shell = process.env.SHELL || '/bin/bash';
  // GUI 从 Finder 启动时进程常无 LANG → zsh 落到 C locale → 中文输出/输入全乱码。
  // 终端环境强制 UTF-8 locale(继承进程已有值,缺省兜底 en_US.UTF-8)。
  const termEnv = {
    ...process.env,
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_CTYPE: process.env.LC_CTYPE || 'en_US.UTF-8',
  };
  return pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd: dir, env: termEnv });
}

// 登记新 generation 并公布 opened(新建/重启共用),返回是否登记成功。
// 该次 open/restart 已回过 TERM_OPEN_TIMEOUT(attempt.timedOut)→ 客户端已按失败处理:迟到的 shell
// 不登记、不公布、直接杀掉 —— 登记了就是 attached 态占名额、任何 sweep 都不碰的幽灵 shell。
function registerTerminal(ws, id, term, { dir, cols, rows, generation, restartFrom }, attempt) {
  if (attempt?.timedOut) {
    try { term.kill(); } catch {}
    return false;
  }
  const entry = {
    id, generation, pid: term.pid, term, ws, cwd: dir, cols, rows,
    resumeToken: newToken(), seq: 0, buf: [], bufBytes: 0, bufTruncated: false,
    detachedAt: null, startedAt: Date.now(), lastAttachAt: Date.now(), restartFrom,
  };
  terminals.set(id, entry);
  term.onData((chunk) => {
    const e = terminals.get(id);
    if (!e || e.term !== term) return; // 迟到的旧回调不得写到新条目
    const seq = pushBuf(e, typeof chunk === 'string' ? chunk : String(chunk));
    const live = e.ws;
    if (live) send(live, { type: 'term-out', id, generation: e.generation, seq, data: chunk, replay: false });
  });
  term.onExit(({ exitCode }) => {
    const e = terminals.get(id);
    if (!e || e.term !== term) return; // 旧 generation 的迟到 exit 不得作用于新项
    // 自然退出即撤销能力:移出存活表、转只读记录(旧 token 再 resume → TERM_TOKEN_REVOKED)
    terminals.delete(id);
    recordExited(e, exitCode);
    const live = e.ownerWs;
    if (live) send(live, { type: 'term-exit', id, generation: e.generation, exitCode });
  });
  send(ws, openFrame(entry, false));
  return true;
}

// ── 退出后重启:term-restart {id,generation:<已退出代际>} ──
// 同一 id 开新 generation(新 pid / 新 token);只允许最后附着该代际的仍有效连接
// 操作(已断开/分离退出的记录对本机已认证连接开放)。
async function restartTerminal(ws, msg, id, attempt) {
  return withIdGate(ws, id, () => restartTerminalLocked(ws, msg, id, attempt));
}

async function restartTerminalLocked(ws, msg, id, attempt) {
  sweepExpired();
  const live = terminals.get(id);
  if (live) {
    // 同连接重复 restart:返回它已经创建的新项(幂等),不误开第三个 shell
    if (live.ws === ws && live.restartFrom === msg.generation) {
      send(ws, openFrame(live, true));
      replayBuf(ws, live);
      return;
    }
    return termError(ws, id, 'TERM_RESTART_CONFLICT', '该终端仍在运行,不能重启');
  }
  const rec = exitedTerminals.get(id);
  // 无记录 / 分离超龄墓碑:都按"记录已过期,请新建终端"处理(不复活已回收的 shell)
  if (!rec || rec.expired) return termError(ws, id, 'TERM_NOT_FOUND', '终端不存在或记录已过期,请新建终端');
  if (rec.generation !== msg.generation) {
    return termError(ws, id, 'TERM_RESTART_CONFLICT', '代际不匹配(非最后退出代际),拒绝重启');
  }
  if (rec.ownerWs && rec.ownerWs !== ws && rec.ownerWs.readyState === 1) {
    return termError(ws, id, 'TERM_FORBIDDEN', '该退出终端归属其他连接');
  }
  // 同新建:在飞创建的 id 一起占名额(openingIds 含自己)
  if (terminals.size + openingIds.size > MAX_TERMINALS) {
    return termError(ws, id, 'TERM_LIMIT', `并发终端已达上限(${MAX_TERMINALS}),先关闭一些再开`);
  }
  let term;
  try {
    term = await spawnPty({ cols: rec.cols, rows: rec.rows, dir: rec.cwd });
  } catch (err) {
    // 记录先留着:环境修好后可重试,不把一个可重试失败变成 TERM_NOT_FOUND
    return termError(ws, id, 'TERM_UNAVAILABLE', `无法启动 shell:${err.message}`);
  }
  // 先登记成功再撤退出记录:超时作废(registerTerminal 返回 false)时记录同样留着可重试
  if (registerTerminal(ws, id, term, {
    dir: rec.cwd, cols: rec.cols, rows: rec.rows,
    generation: rec.generation + 1, restartFrom: rec.generation,
  }, attempt)) exitedTerminals.delete(id);
}

async function handleOpen(ws, msg, id, attempt) {
  // 带任一重连字段(generation/resumeToken)即按重连语义处理(resume 全程同步,不会超时,不需 attempt)
  if (msg.generation != null || msg.resumeToken != null) return resumeTerminal(ws, msg, id);
  return createTerminal(ws, msg, id, attempt);
}

// index.js 的 wss message 处理器按 `term-` 前缀路由到这里。
// 所有拒绝均不杀原任务;out/exit/error 均带原 id/generation,不被新请求换归属。
export function handleTerminalMessage(ws, msg) {
  const id = typeof msg.id === 'string' ? msg.id : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return termError(ws, null, 'TERM_INVALID_ID', '终端 id 非法(需 1-64 位字母/数字/_/-)');
  }
  const entry = terminals.get(id);
  switch (msg.type) {
    case 'term-open':
      // 创建/open 最多 15s:超时 TERM_OPEN_TIMEOUT。spawn 成功即同步公布 opened,
      // 无悬挂窗口;race 只是给 realpath/pty 加载等 IO 兜底。
      // 超时即这次 open 的终局:底层 open 仍会跑完,但 attempt.timedOut 让迟到的成功不登记、
      // 不公布、直接杀掉 shell(见 registerTerminal)—— 报了失败就不许再悄悄成功。
      // 按次标记而非按 id:客户端超时后用同 id 重开,新一次不受旧标记影响。
      {
        const attempt = { timedOut: false, settled: false };
        Promise.race([
          handleOpen(ws, msg, id, attempt).then(() => { attempt.settled = true; }),
          new Promise((r) => setTimeout(r, OPEN_TIMEOUT_MS)).then(() => {
            if (attempt.settled) return;
            attempt.timedOut = true;
            termError(ws, id, 'TERM_OPEN_TIMEOUT', '打开终端超时(15s)');
          }),
        ]).catch(() => {});
      }
      break;
    case 'term-detach': {
      // 面板收起/卸载:进程保留,等重连。无副作用场景(不存在/已分离/非附着者)静默。
      if (!entry || entry.ws !== ws || entry.generation !== msg.generation) return;
      entry.ws = null;
      entry.detachedAt = Date.now();
      send(ws, { type: 'term-detached', id, generation: entry.generation, reason: 'detached' });
      break;
    }
    case 'term-in': {
      if (!entry) return termError(ws, id, 'TERM_NOT_FOUND', '终端不存在,请新建终端');
      if (entry.generation !== msg.generation) return termError(ws, id, 'TERM_STALE', '代际已过期');
      if (typeof msg.data !== 'string') return termError(ws, id, 'TERM_INVALID_INPUT', 'data 必须是字符串,本次零输入');
      if (entry.ws !== ws) return termError(ws, id, 'TERM_FORBIDDEN', '当前连接不拥有该终端');
      try { entry.term.write(msg.data); } catch {}
      break;
    }
    case 'term-resize': {
      if (!entry) return termError(ws, id, 'TERM_NOT_FOUND', '终端不存在,请新建终端');
      if (entry.generation !== msg.generation) return termError(ws, id, 'TERM_STALE', '代际已过期');
      if (entry.ws !== ws) return termError(ws, id, 'TERM_FORBIDDEN', '当前连接不拥有该终端');
      // 夹取后的尺寸必须回写 entry:term-restart 用 rec.cols/rec.rows 重建 PTY,只改 pty
      // 不回写的话,重启出来的 shell 会回到旧尺寸(用户手动调过的窗口大小被丢掉)。
      {
        const cols = clampInt(msg.cols, 2, 1000, 80);
        const rows = clampInt(msg.rows, 2, 500, 24);
        try { entry.term.resize(cols, rows); entry.cols = cols; entry.rows = rows; } catch {}
      }
      break;
    }
    case 'term-restart': {
      // 退出后重启:最多 15s,超时 TERM_OPEN_TIMEOUT(与 open 同口径,超时后迟到的成功同样作废)
      const attempt = { timedOut: false, settled: false };
      Promise.race([
        restartTerminal(ws, msg, id, attempt).then(() => { attempt.settled = true; }),
        new Promise((r) => setTimeout(r, OPEN_TIMEOUT_MS)).then(() => {
          if (attempt.settled) return;
          attempt.timedOut = true;
          termError(ws, id, 'TERM_OPEN_TIMEOUT', '重启终端超时(15s)');
        }),
      ]).catch(() => {});
      break;
    }
    case 'term-close': {
      // 显式关闭才结束 shell 并撤销能力;不存在/已关重复 close 幂等静默
      if (!entry) {
        // 已退出记录:归属连接显式关闭即释放只读记录(不再提供重启/回看)
        const rec = exitedTerminals.get(id);
        if (rec && rec.generation === msg.generation && (!rec.ownerWs || rec.ownerWs === ws)) {
          exitedTerminals.delete(id);
        }
        return;
      }
      if (entry.generation !== msg.generation) return;
      if (entry.ws !== ws) return termError(ws, id, 'TERM_FORBIDDEN', '当前连接不拥有该终端');
      try { entry.term.kill(); } catch {}
      terminals.delete(id);
      send(ws, { type: 'term-closed', id, generation: entry.generation });
      break;
    }
    default:
      termError(ws, id, 'TERM_INVALID_MESSAGE', `未知终端帧类型:${String(msg.type).slice(0, 40)}`);
  }
}

// WS 收到无法 JSON.parse 的消息(畸形帧):回 TERM_INVALID_MESSAGE,不执行任何动作。
export function handleTerminalInvalidJson(ws) {
  termError(ws, null, 'TERM_INVALID_MESSAGE', '无法解析的 WS 消息(非法 JSON)');
}

// ws 断开(面板关闭/页面刷新/掉线)→ 该连接的终端全部转分离态:进程继续跑、
// 输出进环形缓冲,新连接凭 resumeToken 接管回放。只有显式 term-close / server
// 退出 / 6h 超龄才杀。
export function handleTerminalClose(ws) {
  for (const e of terminals.values()) {
    if (e.ws === ws) {
      e.ws = null;
      e.detachedAt = Date.now();
    }
  }
}

// GET /api/terminal/status — 面板打开前探测 node-pty 可用性(ABI 不匹配时给人话)。
// active 是存活 shell 数,含已分离,不含已退出。
router.get('/terminal/status', async (req, res) => {
  try {
    await loadPty();
    res.json({ available: true, platform: process.platform, active: terminals.size, maxTerminals: MAX_TERMINALS });
  } catch (err) {
    res.json({ available: false, code: 'TERM_UNAVAILABLE', error: err.message, platform: process.platform });
  }
});

export default router;
