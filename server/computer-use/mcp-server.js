#!/usr/bin/env node
// cc-gui computer use —— MCP stdio server(macOS v1)。
//
// 零依赖:协议就是换行分隔的 JSON-RPC 2.0,方法 initialize / tools/list / tools/call
// 手写即可,不拖 @modelcontextprotocol/sdk 的依赖树 —— 本文件会被 Claude CLI 从任意
// cwd 直接 spawn,零依赖 = 不存在 node_modules 解析风险。
//
// 执行层:Python 子进程(cu_helper.py,venv 位于 ~/.claude-gui/cu-runtime)。
//
// 契约要点(INTERFACE「桌面操控与Codex对齐」R14–R19):
//   * 副作用工具必须带 actionId(1–64 位字母/数字/_/-)、target{bundleId,pid,windowId}、
//     snapshotId、foreground;相同 actionId 同参数返回已有回执,异参 CU_ACTION_CONFLICT。
//   * 坐标 = 最近一次 screenshot 的像素坐标;先按原图整数范围判合法,再映射逻辑点。
//   * 目标必须来自当前已授权窗口;授权检查先于目标查找;后台找不到窗口就是失败,
//     绝不「后台失败再全局」。
//   * 未授权全屏时:主屏截图 CU_SCREEN_SCOPE_REQUIRED(零像素);window_list 只报已授权
//     应用的窗口;cursor_position 只报已授权目标范围内的局部坐标。
//   * 每实例最多保留 5 个已完成图片文件,只清本实例的、只清已释放的;别的实例的文件只在
//     超过 STALE_SHOT_MS(远大于任何 helper 超时,不可能在途)后才清,防已退出实例遗留无界增长。
import { createHash, randomBytes } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import { platform, homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  GRANTS_FILE, RUNTIME_DIR, SHOT_DIR, STAMP_FILE, VENV_PY,
  appGranted, readGrants, screenScopeGranted,
} from './cu-common.js';

const IS_MAC = platform() === 'darwin';
const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, 'cu_helper.py');
const PY_DEPS = ['mss', 'pyautogui', 'pyobjc-framework-Cocoa', 'pyobjc-framework-Quartz', 'pyobjc-framework-ApplicationServices'];
const DEPS_STAMP = createHash('sha256').update(PY_DEPS.join('|')).digest('hex');
const SHOT_PREFIX = 'cu-';         // 截图文件名前缀(带实例短标识,便于按实例清理)
const MAX_SHOT_FILES = 5;          // 每实例最多保留的已完成图片文件数(合同第 21 段)
// 别的实例遗留文件的清理阈值:helper 最长超时 155 s,24 h 的文件不可能还在途;取 24 h 而非
// 1 h,是让长时间闲置的存活实例手里的最新截图也基本不被别人清掉(被清只会让它重截,不会误操作)。
const STALE_SHOT_MS = 24 * 60 * 60 * 1000;
const TEXT_MAX_CODE_POINTS = 5000;
const ACTION_KEEP_TERMINAL = 100;  // 最新 100 个终态
const ACTION_TERMINAL_TTL_MS = 60 * 60 * 1000;

// ── 实例身份 ────────────────────────────────────────────────────────────
// 每个 MCP 进程一个 instanceId;snapshotId 里嵌本实例短标识,别的实例一眼能认出
// 「不是我的快照」(合同:CU_STALE_SNAPSHOT 的「来自其他实例」一类)。
const INSTANCE_ID = `cu_${randomBytes(8).toString('hex')}`;
const INSTANCE_SHORT = createHash('sha1').update(INSTANCE_ID).digest('hex').slice(0, 6);
const SNAPSHOT_RE = /^cu_snap_([0-9a-f]{6})_(\d+)$/;

// ── 运行时引导(单飞) ───────────────────────────────────────────────────
let runtimePromise = null;
function ensureRuntime() {
  if (!runtimePromise) {
    runtimePromise = bootstrapRuntime().catch((e) => { runtimePromise = null; throw e; });
  }
  return runtimePromise;
}

async function bootstrapRuntime() {
  if (!IS_MAC) throw new Error('computer use v1 仅支持 macOS(Windows 执行层未实现)');
  if (existsSync(VENV_PY) && existsSync(STAMP_FILE)
    && readFileSync(STAMP_FILE, 'utf8').trim() === DEPS_STAMP) return;
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const py = findPython3();
  if (!py) throw new Error('找不到 python3(需要 3.9+,请安装并确保在 PATH)');
  // VENV_PY 是指向 base 解释器的符号链接:Python 升级后会悬空(existsSync=false)
  // 而 pyvenv.cfg 还在 —— 只判 cfg 会跳过重建,直接走到 pip 必 ENOENT。
  if (!existsSync(VENV_PY) || !existsSync(join(RUNTIME_DIR, 'venv', 'pyvenv.cfg'))) {
    await run(py, ['-m', 'venv', join(RUNTIME_DIR, 'venv')], 180_000);
  }
  await run(VENV_PY, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', ...PY_DEPS], 600_000)
    .catch(async (firstErr) => {
      await run(VENV_PY, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check',
        '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple', ...PY_DEPS], 600_000)
        .catch((mirrorErr) => { throw new Error(`pip 主源与镜像均失败: ${mirrorErr.message} (主源: ${firstErr.message})`); });
    });
  writeFileSync(STAMP_FILE, DEPS_STAMP + '\n');
}

function findPython3() {
  // HOME 在 Windows 上通常没有(那边是 USERPROFILE),旧写法回落 '/tmp' 在 win32 不存在。
  // 用 os.homedir() 兜底:它在两个平台都给真实家目录;`|| '/tmp'` 那层已删——三源全空时
  // homedir() 仍会给值,留着只会让跨平台扫描继续把它当"硬编码 /tmp"命中。
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  for (const cmd of ['python3', '/usr/bin/python3', '/opt/homebrew/bin/python3', `${home}/.pyenv/shims/python3`]) {
    try {
      const r = spawnSync(cmd, ['--version'], { timeout: 5000 });
      if (r.status === 0) return cmd;
    } catch { /* 试下一个 */ }
  }
  return null;
}

function run(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* 已退出 */ } reject(new Error(`命令超时: ${file} ${args[0]}`)); }, timeoutMs);
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${file} 退出码 ${code}: ${(stderr || stdout).slice(-400)}`));
    });
  });
}

// ── helper 调用 ────────────────────────────────────────────────────────
const activeHelpers = new Set(); // 在跑的 helper 子进程:server 被杀时逐个杀掉,别留孤儿
const HELPER_KILL_GRACE_MS = 2000; // 超时先 SIGTERM,留这么久让 helper 补发抬起事件,仍不退再 SIGKILL
async function runHelper(args, { timeoutMs = 20_000, input } = {}) {
  await ensureRuntime();
  // 文本/窗口标题只经 stdin(input → JSON,helper 侧 --stdin-json)传,绝不进 argv:
  // 进程表全机可读(ps 能看到明文),且 '-' 开头的值在 argv 里会被 argparse 当成选项
  const p = spawn(VENV_PY, [HELPER, ...args], { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  activeHelpers.add(p);
  if (input !== undefined) {
    p.stdin.on('error', () => { /* helper 没读完就退出(EPIPE):结果以 exit/stdout 为准 */ });
    p.stdin.end(JSON.stringify(input));
  }
  let stdout = '', stderr = '';
  let timedOut = false;
  let killTimer = null;
  // 不能一上来就 SIGKILL:它不可捕获,落在按下/抬起之间就会残留按住的修饰键/鼠标键
  // (合同 CU_TIMEOUT 承诺不留)。SIGTERM 让 helper 补发抬起后自退,宽限后仍在才强杀。
  const timer = setTimeout(() => {
    timedOut = true;
    try { p.kill('SIGTERM'); } catch { /* 已退出 */ }
    killTimer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* 已退出 */ } }, HELPER_KILL_GRACE_MS);
  }, timeoutMs);
  const done = () => { clearTimeout(timer); clearTimeout(killTimer); activeHelpers.delete(p); };
  return new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (e) => { done(); reject(e); });
    p.on('exit', () => {
      done();
      if (timedOut) {
        // 稳定错误码(helperFailure 认 code 不认文案);被终止后的 stdout 不可信,一律按超时报
        reject(Object.assign(new Error(`helper 超时(${timeoutMs}ms): ${args[0]}`), { code: 'CU_TIMEOUT' }));
        return;
      }
      const line = stdout.trim().split('\n').filter(Boolean).pop() || '';
      try {
        const j = JSON.parse(line);
        if (j.ok === false && !j.__soft) reject(new HelperError(j.error || 'helper 失败', j));
        else resolve(j);
      } catch {
        reject(new Error(`helper 输出不可解析: ${(line || stderr).slice(0, 200)}`));
      }
    });
  });
}

class HelperError extends Error {
  constructor(message, payload) {
    super(message);
    this.payload = payload || {};
  }
}

function helperTimeoutMs(kind, extraMs = 0) {
  // 合同第 21 段:动作 20 秒;文字 30000+25×字符数,上限 155000ms;doctor 60 秒。
  if (kind === 'type') return Math.min(155_000, 30_000 + 25 * extraMs);
  if (kind === 'doctor') return 60_000;
  return 20_000 + extraMs;
}

// ── 错误码与信封 ────────────────────────────────────────────────────────
// 工具执行失败 -> MCP {isError:true, content:[文本], structuredContent:{ok:false,code,actionId?,state}}
export function fail(code, { actionId, state: st = 'failed', message, extra = {} } = {}) {
  const text = message || DEFAULT_MESSAGES[code] || code;
  const structuredContent = { ok: false, code, state: st, ...extra };
  if (actionId !== undefined) structuredContent.actionId = actionId;
  return { isError: true, content: [{ type: 'text', text }], structuredContent };
}

const DEFAULT_MESSAGES = {
  CU_INVALID_ARGUMENT: '参数非法(见字段说明);未执行任何动作。',
  CU_INVALID_COORDINATE: '坐标不是原图内的合法整数像素;未投递。',
  CU_SCREENSHOT_REQUIRED: '没有可用的截图映射:请先对本实例调用 screenshot,或带上有效的 snapshotId。',
  CU_STALE_SNAPSHOT: 'snapshotId 已失效(被新截图取代、来自其他实例或文件已清理);请重新截图,不按新前台猜坐标。',
  CU_APP_NOT_ALLOWED: '目标应用未被授权。请先通过 cc-gui 的 POST /api/computer-use/grants 接口授权该应用(按 bundleId)后重试;图形界面尚未提供授权入口。',
  CU_TARGET_NOT_FOUND: '找不到目标窗口(bundleId/pid/windowId 需来自 window_list 的已授权窗口)。',
  CU_TARGET_LOOKUP_FAILED: '窗口查询失败;未投递任何动作。',
  CU_PERMISSION_REQUIRED: '缺少系统权限(屏幕录制/辅助功能);未投递任何动作。',
  CU_DISPATCH_FAILED: '投递失败;未执行全局点击,真实指针/焦点/内容不变。',
  CU_BACKGROUND_UNSUPPORTED: '该目标当前不接受后台输入,且本调用未显式要求前台;未动用户前台。',
  CU_TARGET_CHANGED: '目标与当前焦点不符;未动用户前台。',
  CU_SCREEN_SCOPE_REQUIRED: '需要用户独立勾选「允许主屏全部可见内容」;本次不返回任何屏幕像素。',
  CU_INSTANCE_CHANGED: 'instanceId 与本实例不符(旧进程/其他实例的请求);零投递。',
  CU_ACTION_CONFLICT: '相同 actionId 的已有请求参数不同;未登记、未投递。',
  CU_ACTION_NOT_FOUND: '该 actionId 在本实例从未登记过,不能推断它是否执行过。',
  CU_ACTION_EXPIRED: '该 actionId 的终态已超出本实例保留窗口(最新 100 个终态 / 最多 1 小时);不能自动重试。',
  CU_UNSUPPORTED_KEY: '不支持的键或键组合;整串在投递前拒绝,没有部分按键。',
  CU_BUSY: '等待队列已满(32);本次动作未登记、未投递。',
  CU_TIMEOUT: '动作超时;已结束相关 helper,不留按下的修饰键,也不自动重试。',
  CU_INTERRUPTED: '用户已停止操控或接管;未开始的动作不执行。',
  CU_RUNTIME_UNAVAILABLE: '计算机使用运行时尚未就绪(首次调用工具时自动准备);失败原因见文本。',
};

function ok(actionId, method, target, verification, text, extra = {}) {
  const structuredContent = {
    ok: true, actionId, method, target, verification, state: verification, ...extra,
  };
  const content = [];
  if (extra.image) {
    content.push({ type: 'image', data: extra.image.data, mimeType: extra.image.mimeType });
    delete structuredContent.image;
  }
  content.push({ type: 'text', text });
  return { isError: false, content, structuredContent };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function codePointLength(text) {
  return Array.from(text).length;
}

// ── 键名解析(合同第 19 段) ──────────────────────────────────────────────
const MODIFIER_ALIASES = {
  cmd: 'cmd', command: 'cmd',
  option: 'option', opt: 'option', alt: 'option',
  ctrl: 'ctrl', control: 'ctrl',
  shift: 'shift',
};
const MODIFIER_FLAGS = { shift: 1 << 17, ctrl: 1 << 18, option: 1 << 19, cmd: 1 << 20 };
const KEY_ALIASES = {
  up: 'arrow_up', down: 'arrow_down', left: 'arrow_left', right: 'arrow_right',
  arrow_up: 'arrow_up', arrow_down: 'arrow_down', arrow_left: 'arrow_left', arrow_right: 'arrow_right',
  escape: 'escape', esc: 'escape',
  return: 'return', enter: 'enter',
  tab: 'tab', space: 'space',
  backspace: 'backspace', delete: 'backspace', // 合同:delete 是 backspace 的别名(向后删)
};
const KEYCODES = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13,
  e: 14, r: 15, y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23,
  '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33,
  i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44,
  n: 45, m: 46, '.': 47, '`': 50,
  tab: 48, space: 49, backspace: 51, escape: 53, return: 36, enter: 76,
  arrow_left: 123, arrow_right: 124, arrow_down: 125, arrow_up: 126,
};

/**
 * 解析按键串。整串先完整解析,任何一处不合法都拒绝(不产生部分按键)。
 * 返回 {ok:true, mods:[...], key, keycode, flags, unicode} 或 {ok:false}。
 */
export function parseKeySpec(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false };
  const parts = raw.split('+');
  if (parts.some((p) => p === '')) return { ok: false };        // "cmd+" / "+a"
  const mods = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    const mod = MODIFIER_ALIASES[parts[i].toLowerCase()];
    if (!mod) return { ok: false };                              // "a+b" / "meta+a"
    if (mods.includes(mod)) return { ok: false };                // "cmd+cmd+a"
    mods.push(mod);
  }
  if (mods.length !== parts.length - 1) return { ok: false };
  const rawKey = parts[parts.length - 1];
  const lower = rawKey.toLowerCase();
  let key = KEY_ALIASES[lower];
  let unicode = null;
  if (!key && /^[a-z]$/.test(lower)) {
    key = lower;
    if (/^[A-Z]$/.test(rawKey)) { if (!mods.includes('shift')) mods.push('shift'); }
    unicode = rawKey.length === 1 ? rawKey : lower;
  } else if (!key && /^[0-9]$/.test(lower)) {
    key = lower;
    unicode = lower;
  }
  if (!key) return { ok: false };                                // "f13" / "unknown_key"
  if (key === 'enter') key = 'return';                           // 数字键盘回车与回车同义(语义上都是换行)
  const keycode = KEYCODES[key];
  if (keycode === undefined) return { ok: false };
  let flags = 0;
  for (const mod of mods) flags |= MODIFIER_FLAGS[mod];
  // 单字符键:带 cmd/ctrl 时按"真实快捷键"投递(不塞 unicode,避免变成插入文字);
  // 其余情况用 unicode 直投,大小写/中文/emoji 都原样。
  const isChar = /^[a-z0-9]$/.test(key);
  if (isChar && (mods.includes('cmd') || mods.includes('ctrl'))) unicode = null;
  return { ok: true, mods, key, keycode, flags, unicode, isChar };
}

/** 期望的文本状态转移;返回 null 表示这个键的效果无法从文本状态预测。 */
export function expectedAfter(before, spec) {
  if (!before || !before.readable) return null;
  const text = before.text;
  const start = Number.isInteger(before.selStart) ? before.selStart : text.length;
  const end = Number.isInteger(before.selEnd) ? before.selEnd : start;
  const caret = start === end ? start : Math.min(start, end);
  const replace = (ins) => ({ text: text.slice(0, start) + ins + text.slice(end), selStart: start + ins.length, selEnd: start + ins.length });
  const move = (pos) => ({ text, selStart: Math.max(0, Math.min(text.length, pos)), selEnd: Math.max(0, Math.min(text.length, pos)) });
  const { mods, key, isChar } = spec;
  if (mods.includes('cmd') || mods.includes('ctrl')) {
    if (mods.length === 1 && mods[0] === 'cmd' && key === 'a') return { text, selStart: 0, selEnd: text.length };
    return null; // 拷贝/粘贴/自定义快捷键:文本状态不可预测
  }
  if (key === 'arrow_left') return move(caret - 1);
  if (key === 'arrow_right') return move(caret + 1);
  if (key === 'arrow_up' || key === 'arrow_down') return null;
  if (key === 'backspace') {
    if (start !== end) return { text: text.slice(0, start) + text.slice(end), selStart: start, selEnd: start };
    if (caret === 0) return { text, selStart: 0, selEnd: 0 };
    return { text: text.slice(0, caret - 1) + text.slice(caret), selStart: caret - 1, selEnd: caret - 1 };
  }
  if (key === 'return') return replace('\n');
  if (key === 'tab') return replace('\t');
  if (key === 'space') return replace(' ');
  if (key === 'escape') return null;
  if (isChar) return replace(spec.unicode || key);
  return null;
}

function sameState(a, b) {
  if (!a || !b) return false;
  if (a.readable !== b.readable) return false;
  if (!a.readable) return false;
  return a.text === b.text && a.selStart === b.selStart && a.selEnd === b.selEnd;
}

// ── 实例状态:动作登记表 + 快照表 ───────────────────────────────────────
const state = {
  actions: new Map(),      // actionId -> { paramsKey, status, receipt, at, done }
  terminalOrder: [],       // 终态 actionId 顺序(用于淘汰)
  expired: new Map(),      // actionId -> 过期时间(区分 EXPIRED 与 NOT_FOUND)
  snapshots: new Map(),    // snapshotId -> { imgW, imgH, logicalW, logicalH, bounds, displayId, file, at }
  lastSnapshotId: null,
  seq: 0,
  appInfo: new Map(),      // bundleId -> {installed, path, name}
  queueLen: 0,
  stopped: false,          // 用户停止操控(本实例)
};

function pruneActions(now = Date.now()) {
  while (state.terminalOrder.length > ACTION_KEEP_TERMINAL) {
    const id = state.terminalOrder.shift();
    const entry = state.actions.get(id);
    if (entry && entry.done) {
      state.actions.delete(id);
      state.expired.set(id, now);
    }
  }
  for (const [id, entry] of state.actions) {
    if (entry.done && now - entry.at > ACTION_TERMINAL_TTL_MS) {
      state.actions.delete(id);
      state.expired.set(id, now);
    }
  }
  // expired 标记本身也有上限,避免无限留 id
  if (state.expired.size > 500) {
    const cut = state.expired.size - 500;
    let i = 0;
    for (const key of state.expired.keys()) {
      state.expired.delete(key);
      i += 1;
      if (i >= cut) break;
    }
  }
}

function canonicalParams(name, args) {
  const norm = (value) => {
    if (Array.isArray(value)) return value.map(norm);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = norm(value[key]);
      return out;
    }
    return value;
  };
  return JSON.stringify({ tool: name, args: norm(args || {}) });
}

// ── 授权与目标 ──────────────────────────────────────────────────────────
async function appInstalled(bundleId) {
  if (state.appInfo.has(bundleId)) return state.appInfo.get(bundleId);
  let info = { installed: false, path: null, name: null };
  try {
    const r = await runHelper(['app-info', '--bundle-id', bundleId], { timeoutMs: 15_000 });
    info = { installed: Boolean(r.installed), path: r.path || null, name: r.name || null };
  } catch (e) {
    if (e instanceof HelperError) info = { installed: false, path: null, name: null };
    else throw e;
  }
  state.appInfo.set(bundleId, info);
  return info;
}

async function listWindows() {
  const r = await runHelper(['windows'], { timeoutMs: 15_000 });
  return { frontmost: r.frontmost || null, windows: r.windows || [] };
}

function findTargetWindow(windows, target) {
  return windows.find((w) => w.pid === target.pid && Number(w.id) === target.windowId
    && w.bundleId === target.bundleId) || null;
}

/** 目标解析:①授权 ②窗口查找。返回 {ok:true, window} 或失败码。 */
async function resolveTarget(target) {
  const grants = readGrants();
  const info = await appInstalled(target.bundleId);
  if (info.installed && !appGranted(grants, target.bundleId)) {
    return { ok: false, code: 'CU_APP_NOT_ALLOWED' };
  }
  let listing;
  try {
    listing = await listWindows();
  } catch (e) {
    return { ok: false, code: 'CU_TARGET_LOOKUP_FAILED', detail: String(e.message || e).slice(0, 200) };
  }
  const win = findTargetWindow(listing.windows, target);
  if (!win) return { ok: false, code: 'CU_TARGET_NOT_FOUND' };
  if (!appGranted(grants, win.bundleId)) return { ok: false, code: 'CU_APP_NOT_ALLOWED' };
  return { ok: true, window: win, grants };
}

// ── 快照 ────────────────────────────────────────────────────────────────
function nextSnapshotId() {
  state.seq += 1;
  return `cu_snap_${INSTANCE_SHORT}_${state.seq}`;
}

function snapshotUsable(snap) {
  return Boolean(snap && snap.file && existsSync(snap.file));
}

/**
 * 解析本次动作使用的截图映射。
 * 返回 {mapping} 或 {earlyError} (必须先报,不用再查目标) 或 {deferredError}
 * (snapshotId 本实例从未签发 -> 无法判定映射;如果目标本身就不存在,先报目标问题)。
 */
function resolveSnapshot(snapshotId) {
  if (snapshotId === undefined) {
    const snap = state.lastSnapshotId ? state.snapshots.get(state.lastSnapshotId) : null;
    if (!snapshotUsable(snap)) return { earlyError: 'CU_SCREENSHOT_REQUIRED' };
    return { mapping: snap };
  }
  const latest = state.lastSnapshotId ? state.snapshots.get(state.lastSnapshotId) : null;
  if (snapshotId === state.lastSnapshotId && snapshotUsable(latest)) return { mapping: latest };
  const owned = state.snapshots.get(snapshotId);
  if (owned || (SNAPSHOT_RE.test(snapshotId) && SNAPSHOT_RE.exec(snapshotId)[1] === INSTANCE_SHORT)
      || (SNAPSHOT_RE.test(snapshotId) && SNAPSHOT_RE.exec(snapshotId)[1] !== INSTANCE_SHORT)) {
    // 本实例签发过但不是最新 / 本实例签发的文件已被清理 / 其他实例的 snapshotId
    return { earlyError: 'CU_STALE_SNAPSHOT' };
  }
  return { deferredError: 'CU_STALE_SNAPSHOT' };
}

function mapPoint(snap, x, y) {
  const lx = Math.round(snap.bounds.x + (x * snap.logicalW) / snap.imgW);
  const ly = Math.round(snap.bounds.y + (y * snap.logicalH) / snap.imgH);
  return [lx, ly];
}

/** 坐标:JSON 类型不对 -> CU_INVALID_ARGUMENT;是数字但不合法 -> CU_INVALID_COORDINATE。 */
function checkCoordinateArg(value, name) {
  if (typeof value !== 'number') return { code: 'CU_INVALID_ARGUMENT', message: `${name} 必须是数字(JSON number)。` };
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return { code: 'CU_INVALID_COORDINATE', message: `${name}=${JSON.stringify(value)} 不是合法像素整数(需 0≤v 的整数);未投递。` };
  }
  return null;
}

function checkCoordinateBounds(value, limit, name) {
  if (value >= limit) {
    return { code: 'CU_INVALID_COORDINATE', message: `${name}=${value} 超出原图范围(合法范围 0–${limit - 1});未投递。` };
  }
  return null;
}

// ── 工具 schema ─────────────────────────────────────────────────────────
const COORD_NOTE = '坐标一律使用【最近一次 screenshot 返回图像的像素坐标】,左上角为 (0,0);服务端自动映射为屏幕逻辑坐标。';
const TARGET_NOTE = 'target 必须是当前已授权窗口(window_list 只列已授权应用的窗口):bundleId/pid/windowId 三字段都要给。';
const ACTION_NOTE = 'actionId 由调用方提供(1–64 位字母/数字/_/-),相同 actionId 同参数重试返回已有回执,异参 CU_ACTION_CONFLICT。';

const targetSchema = {
  type: 'object',
  description: TARGET_NOTE,
  properties: {
    bundleId: { type: 'string', description: '目标应用 bundleId(如 com.apple.TextEdit)' },
    pid: { type: 'integer', description: '目标进程 pid' },
    windowId: { type: 'integer', description: '目标窗口 id(CGWindowID,来自 window_list)' },
  },
  required: ['bundleId', 'pid', 'windowId'],
};

const commonActionProps = () => ({
  actionId: { type: 'string', description: ACTION_NOTE },
  target: targetSchema,
  snapshotId: { type: 'string', description: '截图身份(来自 screenshot 回执)。省略 = 用本实例最近一次有效截图。' },
  foreground: { type: 'boolean', description: '只有显式 true 才允许全局事件(会影响用户前台);省略与 false 同义 = 后台定向投递。' },
  instanceId: { type: 'string', description: 'MCP 实例身份(initialize 回执的 instanceId)。' },
});

const xyProps = {
  x: { type: 'integer', description: '截图像素 X' },
  y: { type: 'integer', description: '截图像素 Y' },
};

const TOOLS = [
  {
    name: 'screenshot',
    description: '截取画面。不带 target 时截主屏,必须先由用户勾选「允许主屏全部可见内容」,否则 CU_SCREEN_SCOPE_REQUIRED 且不返回任何像素。'
      + '回执给出 snapshotId 与图像精确像素尺寸 imgW×imgH——后续坐标工具都以这张图的像素为准。' + COORD_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        max_width: { type: 'integer', description: '返回图像最大宽度像素(默认 1600,0=原始分辨率)。坐标始终按实际返回的图像尺寸计。' },
        target: targetSchema,
      },
    },
  },
  {
    name: 'window_list',
    description: '列出【已授权应用】的前台层窗口(id/pid/bundleId/标题/bounds/displayId,逻辑坐标)。未授权应用的窗口连标题也不返回。被动查询,不动焦点/鼠标。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cursor_position',
    description: '查询鼠标光标位置。未授权全屏范围时只在已授权目标窗口内返回局部坐标,其他位置返回 CU_SCREEN_SCOPE_REQUIRED。被动查询,零干扰。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'doctor',
    description: '环境自检:屏幕录制/辅助功能/运行时/各应用授权的分别状态。被动,不激活窗口、不输入。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'action_status',
    description: '只读查询某个 actionId 在本实例的状态(queued/running/dispatched/verified/unknown/failed/cancelled)与已有回执。从未登记 CU_ACTION_NOT_FOUND,超出保留窗口 CU_ACTION_EXPIRED;都不代表"未执行"。',
    inputSchema: {
      type: 'object',
      properties: {
        actionId: { type: 'string', description: ACTION_NOTE },
        instanceId: { type: 'string', description: 'MCP 实例身份。' },
      },
      required: ['actionId'],
    },
  },
  {
    name: 'left_click',
    description: '在 (x,y) 单击左键。默认后台定向投递到 target 窗口(不抢前台、不动用户光标);找不到窗口就是 CU_TARGET_NOT_FOUND,绝不退化成全局点击。只有 foreground:true 才走全局事件(会打断用户前台)。'
      + COORD_NOTE + ACTION_NOTE,
    inputSchema: { type: 'object', properties: { ...commonActionProps(), ...xyProps }, required: ['actionId', 'target', 'x', 'y'] },
  },
  {
    name: 'double_click',
    description: '在 (x,y) 双击左键。前后台策略同 left_click。' + COORD_NOTE + ACTION_NOTE,
    inputSchema: { type: 'object', properties: { ...commonActionProps(), ...xyProps }, required: ['actionId', 'target', 'x', 'y'] },
  },
  {
    name: 'right_click',
    description: '在 (x,y) 单击右键(上下文菜单)。前后台策略同 left_click。' + COORD_NOTE + ACTION_NOTE,
    inputSchema: { type: 'object', properties: { ...commonActionProps(), ...xyProps }, required: ['actionId', 'target', 'x', 'y'] },
  },
  {
    name: 'drag',
    description: '从 (x1,y1) 按住左键拖到 (x2,y2)。默认后台定向投递到 target;foreground:true 才走全局(影响前台)。' + COORD_NOTE + ACTION_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        ...commonActionProps(),
        x1: { type: 'integer' }, y1: { type: 'integer' }, x2: { type: 'integer' }, y2: { type: 'integer' },
      },
      required: ['actionId', 'target', 'x1', 'y1', 'x2', 'y2'],
    },
  },
  {
    name: 'scroll',
    description: '在 (x,y) 滚轮滚动。direction: up/down(默认 down);amount: 行数(默认 3,正整数)。默认后台定向投递到 target。' + COORD_NOTE + ACTION_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        ...commonActionProps(),
        ...xyProps,
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'integer' },
      },
      required: ['actionId', 'target', 'x', 'y'],
    },
  },
  {
    name: 'type',
    description: '把文本输入 target 窗口的文本元素(后台直接写入目标自己,不抢前台、无全局事件),并用读回原文验证;读不回时回执 verification=unknown,不声称输入成功。上限 5000 个 Unicode 码点,空串成功且零动作。' + ACTION_NOTE,
    inputSchema: {
      type: 'object',
      properties: { ...commonActionProps(), text: { type: 'string' } },
      required: ['actionId', 'target', 'text'],
    },
  },
  {
    name: 'key',
    description: '按快捷键/单键,如 "cmd+c"、"return"、"escape"、"arrow_left"。支持字母/数字、return/enter、escape/esc、tab、space、backspace/delete、up/down/left/right(=arrow_*),修饰符 cmd/command、option/alt、ctrl/control、shift 用 + 连接(大小写忽略)。整串先校验再投递:非法键不产生部分按键。已投递的组合键以目标光标/选择/文本状态验证,读不回就报 unknown。' + ACTION_NOTE,
    inputSchema: {
      type: 'object',
      properties: { ...commonActionProps(), keys: { type: 'string' } },
      required: ['actionId', 'target', 'keys'],
    },
  },
];

const SIDE_EFFECT_TOOLS = new Set(['left_click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key']);

// ── 动作登记 + 串行队列 ─────────────────────────────────────────────────
let toolQueue = Promise.resolve();
const MAX_WAITING = 32;

function actionStatusOf(receipt) {
  if (!receipt) return 'unknown';
  // 失败回执自己标了 unknown(可能已部分投递)时,action_status 与回执口径一致,不报 failed
  if (receipt.isError) return receipt.structuredContent?.state === 'unknown' ? 'unknown' : 'failed';
  const v = receipt.structuredContent?.verification;
  if (v === 'verified') return 'verified';
  if (v === 'unknown') return 'unknown';
  return 'dispatched';
}

function helperFailure(error, actionId) {
  const message = String(error?.message || error).slice(0, 300);
  if (error instanceof HelperError) {
    const payload = error.payload || {};
    if (payload.code === 'UNREADABLE' || payload.reason === 'permission') {
      return fail('CU_PERMISSION_REQUIRED', { actionId, message: `${DEFAULT_MESSAGES.CU_PERMISSION_REQUIRED} (${payload.code || payload.reason})` });
    }
    return fail('CU_DISPATCH_FAILED', { actionId, message: `${message}` });
  }
  if (error?.code === 'CU_TIMEOUT' || /超时|timeout/i.test(message)) {
    return fail('CU_TIMEOUT', { actionId, message: `${DEFAULT_MESSAGES.CU_TIMEOUT} (${message})` });
  }
  return fail('CU_DISPATCH_FAILED', { actionId, message });
}

/** 副作用工具统一入口:参数校验 -> actionId 去重/冲突 -> 排队串行执行。 */
async function runAction(name, args, body) {
  const actionId = args.actionId;
  if (typeof actionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(actionId)) {
    return fail('CU_INVALID_ARGUMENT', {
      message: 'actionId 必须由调用方提供,1–64 位字母/数字/_/-;零投递。',
    });
  }
  if (args.instanceId !== undefined && args.instanceId !== INSTANCE_ID) {
    return fail('CU_INSTANCE_CHANGED', { actionId });
  }
  const target = args.target;
  const targetOk = isPlainObject(target)
    && typeof target.bundleId === 'string' && target.bundleId.length > 0
    && Number.isInteger(target.pid) && target.pid > 0
    && Number.isInteger(target.windowId) && target.windowId > 0;
  if (!targetOk) {
    return fail('CU_INVALID_ARGUMENT', {
      actionId,
      message: 'target 必须同时给出 bundleId(非空)、pid(正整数)、windowId(正整数);零投递。',
    });
  }
  if (args.foreground !== undefined && typeof args.foreground !== 'boolean') {
    return fail('CU_INVALID_ARGUMENT', { actionId, message: 'foreground 只能是布尔值(true 才允许全局事件);零投递。' });
  }
  if (args.snapshotId !== undefined && (typeof args.snapshotId !== 'string' || args.snapshotId.length === 0)) {
    return fail('CU_INVALID_ARGUMENT', { actionId, message: 'snapshotId 必须是非空字符串;零投递。' });
  }
  const paramsKey = canonicalParams(name, args);
  const existing = state.actions.get(actionId);
  if (existing) {
    if (existing.paramsKey !== paramsKey) return fail('CU_ACTION_CONFLICT', { actionId });
    if (existing.done) return existing.receipt;
    return existing.promise;
  }
  pruneActions();
  const waiting = [...state.actions.values()].filter((a) => !a.done).length;
  if (waiting >= MAX_WAITING) return fail('CU_BUSY', { actionId });

  const entry = { paramsKey, status: 'queued', at: Date.now(), done: false, receipt: null, promise: null };
  state.actions.set(actionId, entry);
  entry.promise = toolQueue
    .catch(() => { /* 前一个动作失败不断链 */ })
    .then(async () => {
      entry.status = 'running';
      let receipt;
      try {
        receipt = await body({ target, foreground: args.foreground === true, actionId });
      } catch (error) {
        receipt = helperFailure(error, actionId);
      }
      entry.receipt = receipt;
      entry.status = actionStatusOf(receipt);
      entry.done = true;
      entry.at = Date.now();
      state.terminalOrder.push(actionId);
      pruneActions();
      return receipt;
    });
  toolQueue = entry.promise.catch(() => {});
  return entry.promise;
}

// ── 通用前置:坐标 + 快照 + 目标 ─────────────────────────────────────────
/** 坐标类动作的公共前置。返回 {lx, ly, window, mapping} 或 {receipt}。 */
async function prepareCoordAction(args, target, actionId, pairs) {
  for (const [name, value] of pairs) {
    const err = checkCoordinateArg(value, name);
    if (err) return { receipt: fail(err.code, { actionId, message: err.message }) };
  }
  const snap = resolveSnapshot(args.snapshotId);
  if (snap.earlyError) return { receipt: fail(snap.earlyError, { actionId }) };
  if (snap.mapping) {
    for (const [name, value] of pairs) {
      const err = checkCoordinateBounds(value, name.startsWith('x') ? snap.mapping.imgW : snap.mapping.imgH, name);
      if (err) return { receipt: fail(err.code, { actionId, message: err.message }) };
    }
  }
  const resolved = await resolveTarget(target);
  if (!resolved.ok) {
    return { receipt: fail(resolved.code, { actionId, extra: resolved.detail ? { detail: resolved.detail } : {} }) };
  }
  if (snap.deferredError) return { receipt: fail(snap.deferredError, { actionId }) };
  if (!snap.mapping) return { receipt: fail('CU_SCREENSHOT_REQUIRED', { actionId }) };
  return { snap: snap.mapping, window: resolved.window, grants: resolved.grants };
}

function targetDescriptor(window) {
  return { bundleId: window.bundleId, pid: window.pid, windowId: Number(window.id), title: window.title };
}

/** 显式前台动作前:目标必须就是当前前台应用,否则 CU_TARGET_CHANGED(未动用户前台)。 */
function focusMatches(window, frontmost) {
  return Boolean(frontmost) && frontmost.pid === window.pid;
}

// ── 工具实现 ────────────────────────────────────────────────────────────
async function toolScreenshot(args) {
  const maxWidth = args.max_width === undefined ? 1600 : args.max_width;
  if (typeof maxWidth !== 'number' || !Number.isInteger(maxWidth) || maxWidth < 0) {
    return fail('CU_INVALID_ARGUMENT', { message: 'max_width 必须是非负整数(0 = 原始分辨率);未截图。' });
  }
  if (args.target !== undefined) {
    return fail('CU_BACKGROUND_UNSUPPORTED', {
      message: '按应用/窗口截图尚未验证(capabilities.screenshotTarget=unverified):本次不返回任何像素,也不拿前台其他应用顶替。',
    });
  }
  if (!screenScopeGranted(readGrants())) {
    return fail('CU_SCREEN_SCOPE_REQUIRED', {
      message: '主屏截图需要用户独立勾选「允许主屏全部可见内容」;本次不返回任何像素(按应用授权不隐含全屏授权)。',
    });
  }
  state.seq += 1;
  const snapshotId = nextSnapshotId();
  mkdirSync(SHOT_DIR, { recursive: true });
  const base = join(SHOT_DIR, `${SHOT_PREFIX}${INSTANCE_SHORT}-${state.seq}`);
  const r = await runHelper(['screenshot', '--out', `${base}.png`, '--format', 'jpeg', '--max-width', String(maxWidth)],
    { timeoutMs: helperTimeoutMs('screenshot', 10_000) });
  const file = r.path || `${base}.jpg`;
  if (!r.pixel || !r.pixel.w) throw new Error('截图缺少尺寸信息');
  const logicalW = r.logical?.w || Math.round(r.pixel.w / (r.scale || 2));
  const logicalH = r.logical?.h || Math.round(r.pixel.h / (r.scale || 2));
  const snap = {
    imgW: r.pixel.w, imgH: r.pixel.h, logicalW, logicalH,
    bounds: r.bounds || { x: 0, y: 0, w: logicalW, h: logicalH },
    displayId: r.displayId ?? null, file, at: Date.now(),
  };
  state.snapshots.set(snapshotId, snap);
  state.lastSnapshotId = snapshotId;
  pruneShots();
  const mime = String(r.mime || '').startsWith('image/jpeg') ? 'image/jpeg' : 'image/png';
  const b64 = readFileSync(file).toString('base64');
  const receipt = ok(args.actionId ?? null, 'capture', { kind: 'display', displayId: snap.displayId }, 'not-applicable',
    `主屏截图 ${r.pixel.w}x${r.pixel.h} 像素;屏幕逻辑尺寸 ${logicalW}x${logicalH};snapshotId=${snapshotId}。`
    + '后续坐标工具用这张图的像素坐标(左上角 (0,0)),服务端自动折算。',
    {
      snapshotId, imgW: r.pixel.w, imgH: r.pixel.h, logicalBounds: snap.bounds,
      displayId: snap.displayId, createdAt: new Date(snap.at).toISOString(),
      image: { data: b64, mimeType: mime },
    });
  return receipt;
}

/**
 * 保留策略(纯函数,便于单测):按 mtime 新→旧排序,返回应删除的文件名。
 * 只处理本实例前缀的文件 —— 别的实例的文件不参与按数量淘汰(只按 STALE_SHOT_MS 过期清)。
 */
export function shotsToPrune(entries, keep = MAX_SHOT_FILES) {
  return [...entries].sort((a, b) => b.at - a.at).slice(keep).map((e) => e.f);
}

/**
 * 每实例最多留 5 个已完成图片文件;只清自己的、只清已释放的(读进内存后不再引用)。
 * 顺带清别的实例超过 STALE_SHOT_MS 的遗留文件:实例退出后没有别人会清它的文件,
 * 只清自己前缀会让 shots/ 随会话数无界增长;按 mtime 判,新鲜的(可能在途)一个不动。
 */
function pruneShots() {
  try {
    const now = Date.now();
    const mine = [];
    for (const f of readdirSync(SHOT_DIR)) {
      if (!f.startsWith(SHOT_PREFIX) || !/\.(png|jpe?g)$/i.test(f)) continue;
      let at;
      try { at = statSync(join(SHOT_DIR, f)).mtimeMs; } catch { continue; } // 已被并发清理
      if (f.startsWith(`${SHOT_PREFIX}${INSTANCE_SHORT}-`)) mine.push({ f, at });
      else if (now - at > STALE_SHOT_MS) {
        try { unlinkSync(join(SHOT_DIR, f)); } catch { /* 已被并发清理 */ }
      }
    }
    for (const name of shotsToPrune(mine)) {
      try { unlinkSync(join(SHOT_DIR, name)); } catch { /* 已被并发清理 */ }
    }
  } catch { /* 目录不存在等:不因清理失败影响本次截图 */ }
}

async function toolWindowList() {
  const grants = readGrants();
  let listing;
  try {
    listing = await listWindows();
  } catch (error) {
    return { receipt: fail('CU_TARGET_LOOKUP_FAILED', { message: `窗口查询失败:${String(error.message).slice(0, 200)}` }) };
  }
  const allowed = new Set(Object.keys(grants.apps));
  const windows = listing.windows.filter((w) => allowed.has(w.bundleId));
  const front = listing.frontmost;
  const frontAllowed = Boolean(front) && allowed.has(front.bundleId);
  const frontText = front
    ? (frontAllowed ? `前台应用: ${front.name} (pid ${front.pid});` : '前台应用: (未授权应用,不显示);')
    : '前台应用: (未知);';
  const lines = windows.map((w) => `#${w.id} pid=${w.pid} [${w.bundleId}] ${String(w.title || '').slice(0, 120)} `
    + `(${w.bounds.x},${w.bounds.y} ${w.bounds.w}x${w.bounds.h})`);
  const text = `${frontText}\n窗口 ${windows.length} 个(仅已授权应用,逻辑坐标):\n${lines.join('\n')}`;
  return {
    receipt: {
      isError: false,
      content: [{ type: 'text', text }],
      structuredContent: {
        ok: true, actionId: null, method: 'passive', target: null, verification: 'not-applicable',
        // 模型读的是结构面:未授权前台应用在这里同样不给 pid/name/bundleId(与文本面口径一致,合同 L69)
        state: 'not-applicable', windows, frontmost: frontAllowed ? front : null,
        authorizedApps: [...allowed],
      },
    },
  };
}

async function toolCursor() {
  const grants = readGrants();
  const allow = Object.keys(grants.apps);
  let r;
  try {
    r = await runHelper(['cursor', '--allow-bundle-ids', allow.join(',')], { timeoutMs: 15_000 });
  } catch (error) {
    return { receipt: fail('CU_TARGET_LOOKUP_FAILED', { message: `光标查询失败:${String(error.message).slice(0, 200)}` }) };
  }
  const point = r.point || [0, 0];
  const fullScreen = screenScopeGranted(grants);
  if (!fullScreen && !r.local) {
    return {
      receipt: fail('CU_SCREEN_SCOPE_REQUIRED', {
        message: '光标不在任何已授权目标窗口内,且用户未勾选「允许主屏全部可见内容」:不返回屏幕坐标。',
      }),
    };
  }
  const text = r.local
    ? `光标在已授权目标内:${r.local.bundleId} #${r.local.windowId} 局部坐标 (${r.local.x},${r.local.y})。`
    : `光标屏幕逻辑坐标 (${point[0]},${point[1]})。`;
  return {
    receipt: {
      isError: false,
      content: [{ type: 'text', text }],
      structuredContent: {
        ok: true, actionId: null, method: 'passive', target: null, verification: 'not-applicable',
        // 未授权全屏时结构面同样只留局部坐标:全局坐标能反推窗口在屏幕上的位置(合同 L69)
        state: 'not-applicable', point: fullScreen ? point : null, local: r.local || null,
      },
    },
  };
}

async function toolDoctor() {
  let payload;
  try {
    payload = await runHelper(['doctor'], { timeoutMs: helperTimeoutMs('doctor') });
  } catch (error) {
    return { receipt: fail('CU_RUNTIME_UNAVAILABLE', { message: `自检失败:${String(error.message).slice(0, 200)}` }) };
  }
  const grants = readGrants();
  const perm = (value) => (value === 'ok' ? 'available' : (value === 'denied' ? 'unavailable' : 'unverified'));
  const checks = {
    screenRead: { status: perm(payload.screen_recording), detail: payload.screen_recording_detail || null },
    accessibility: { status: perm(payload.accessibility), detail: payload.accessibility_detail || null },
    runtime: { status: 'available' },
    captureTest: { status: payload.capture_test || 'unknown', detail: payload.capture_test_detail || null },
  };
  const apps = Object.entries(grants.apps).map(([bundleId, entry]) => ({
    bundleId, name: entry.name || bundleId, granted: true, grantedAt: entry.grantedAt || null,
  }));
  const text = [
    `屏幕读取: ${checks.screenRead.status}${checks.screenRead.detail ? ` (${checks.screenRead.detail})` : ''}`,
    `辅助功能: ${checks.accessibility.status}${checks.accessibility.detail ? ` (${checks.accessibility.detail})` : ''}`,
    `运行时: ${checks.runtime.status}`,
    `已授权应用: ${apps.length ? apps.map((a) => `${a.name}(${a.bundleId})`).join(', ') : '(无)'}`,
  ].join('\n');
  return {
    receipt: {
      isError: false,
      content: [{ type: 'text', text }],
      structuredContent: {
        ok: true, actionId: null, method: 'passive', target: null, verification: 'not-applicable',
        state: 'not-applicable', checks,
        permissions: { screen: checks.screenRead, accessibility: checks.accessibility, apps },
        screenScope: screenScopeGranted(grants),
      },
    },
  };
}

async function toolActionStatus(args) {
  const actionId = args.actionId;
  if (typeof actionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(actionId)) {
    return { receipt: fail('CU_INVALID_ARGUMENT', { message: 'actionId 必须是 1–64 位字母/数字/_/-。' }) };
  }
  if (args.instanceId !== undefined && args.instanceId !== INSTANCE_ID) {
    return { receipt: fail('CU_INSTANCE_CHANGED', { actionId }) };
  }
  pruneActions();
  const entry = state.actions.get(actionId);
  if (!entry) {
    const code = state.expired.has(actionId) ? 'CU_ACTION_EXPIRED' : 'CU_ACTION_NOT_FOUND';
    return { receipt: fail(code, { actionId }) };
  }
  const status = entry.done ? entry.status : entry.status;
  return {
    receipt: {
      isError: false,
      content: [{ type: 'text', text: `action ${actionId}: ${status}${entry.done ? ' (终态)' : ' (进行中)'}。` }],
      structuredContent: {
        ok: true, actionId, status, method: 'query', target: null, verification: 'not-applicable',
        state: status, receipt: entry.done ? entry.receipt?.structuredContent || null : null,
      },
    },
  };
}

async function toolClick(name, args, ctx) {
  const kinds = { left_click: { clicks: 1, button: 'left' }, double_click: { clicks: 2, button: 'left' }, right_click: { clicks: 1, button: 'right' } };
  const { clicks, button } = kinds[name];
  const prep = await prepareCoordAction(args, ctx.target, ctx.actionId, [['x', args.x], ['y', args.y]]);
  if (prep.receipt) return prep.receipt;
  const { snap, window } = prep;
  const [lx, ly] = mapPoint(snap, args.x, args.y);
  const descriptor = targetDescriptor(window);
  if (ctx.foreground) {
    const listing = await listWindows();
    if (!focusMatches(window, listing.frontmost)) {
      return fail('CU_TARGET_CHANGED', { actionId: ctx.actionId, extra: { target: descriptor } });
    }
    await runHelper(['click', '--x', String(lx), '--y', String(ly), '--button', button, '--clicks', String(clicks)],
      { timeoutMs: helperTimeoutMs('click') });
    return ok(ctx.actionId, 'foreground', descriptor, 'dispatched',
      `已在全局坐标 (${lx},${ly}) 投递${labelOf(name)};全局事件已影响用户前台,效果需重新截图确认。`, { point: [lx, ly] });
  }
  const inside = lx >= window.bounds.x && lx < window.bounds.x + window.bounds.w
    && ly >= window.bounds.y && ly < window.bounds.y + window.bounds.h;
  await runHelper(['click', '--x', String(lx), '--y', String(ly), '--button', button, '--clicks', String(clicks),
    '--background-pid', String(window.pid)], { timeoutMs: helperTimeoutMs('click') });
  return ok(ctx.actionId, 'background', descriptor, 'dispatched',
    `已后台投递${labelOf(name)}给 ${window.title || window.bundleId}(pid ${window.pid},全局坐标 (${lx},${ly}))`
    + `${inside ? '' : ',注意该点落在目标窗口 bounds 之外'};未影响用户前台,效果需重新截图确认。`,
    { point: [lx, ly] });
}

function labelOf(name) {
  return { left_click: '单击', double_click: '双击', right_click: '右键单击' }[name] || name;
}

async function toolDrag(args, ctx) {
  const pairs = [['x1', args.x1], ['y1', args.y1], ['x2', args.x2], ['y2', args.y2]];
  for (const [name, value] of pairs) {
    if (value === undefined) {
      return fail('CU_INVALID_ARGUMENT', { actionId: ctx.actionId, message: `drag 需要完整的 ${pairs.map(([n]) => n).join('/')};零投递。` });
    }
  }
  const prep = await prepareCoordAction(args, ctx.target, ctx.actionId, pairs);
  if (prep.receipt) return prep.receipt;
  const { snap, window } = prep;
  const [lx1, ly1] = mapPoint(snap, args.x1, args.y1);
  const [lx2, ly2] = mapPoint(snap, args.x2, args.y2);
  const descriptor = targetDescriptor(window);
  if (ctx.foreground) {
    const listing = await listWindows();
    if (!focusMatches(window, listing.frontmost)) {
      return fail('CU_TARGET_CHANGED', { actionId: ctx.actionId, extra: { target: descriptor } });
    }
    await runHelper(['drag', '--x1', String(lx1), '--y1', String(ly1), '--x2', String(lx2), '--y2', String(ly2)],
      { timeoutMs: helperTimeoutMs('drag', 10_000) });
    return ok(ctx.actionId, 'foreground', descriptor, 'dispatched',
      `已在全局坐标 (${lx1},${ly1})→(${lx2},${ly2}) 投递拖拽;全局事件已影响用户前台,效果需重新观察。`,
      { from: [lx1, ly1], to: [lx2, ly2] });
  }
  await runHelper(['drag', '--x1', String(lx1), '--y1', String(ly1), '--x2', String(lx2), '--y2', String(ly2),
    '--background-pid', String(window.pid)], { timeoutMs: helperTimeoutMs('drag', 10_000) });
  return ok(ctx.actionId, 'background', descriptor, 'dispatched',
    `已后台投递拖拽给 ${window.title || window.bundleId}(pid ${window.pid});未影响用户前台,效果需重新观察。`,
    { from: [lx1, ly1], to: [lx2, ly2] });
}

async function toolScroll(args, ctx) {
  const direction = args.direction === undefined ? 'down' : args.direction;
  if (direction !== 'up' && direction !== 'down') {
    return fail('CU_INVALID_ARGUMENT', { actionId: ctx.actionId, message: 'direction 只能是 up/down;零投递。' });
  }
  const amount = args.amount === undefined ? 3 : args.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return fail('CU_INVALID_ARGUMENT', { actionId: ctx.actionId, message: 'amount 必须是正整数(默认 3);零投递。' });
  }
  const prep = await prepareCoordAction(args, ctx.target, ctx.actionId, [['x', args.x], ['y', args.y]]);
  if (prep.receipt) return prep.receipt;
  const { snap, window } = prep;
  const [lx, ly] = mapPoint(snap, args.x, args.y);
  const descriptor = targetDescriptor(window);
  if (ctx.foreground) {
    const listing = await listWindows();
    if (!focusMatches(window, listing.frontmost)) {
      return fail('CU_TARGET_CHANGED', { actionId: ctx.actionId, extra: { target: descriptor } });
    }
    await runHelper(['scroll', '--x', String(lx), '--y', String(ly), '--direction', direction, '--amount', String(amount)],
      { timeoutMs: helperTimeoutMs('scroll') });
    return ok(ctx.actionId, 'foreground', descriptor, 'dispatched',
      `已在全局坐标 (${lx},${ly}) ${direction === 'up' ? '上' : '下'}滚 ${amount} 行;全局事件已影响用户前台。`, { point: [lx, ly] });
  }
  await runHelper(['scroll', '--x', String(lx), '--y', String(ly), '--direction', direction, '--amount', String(amount),
    '--background-pid', String(window.pid)], { timeoutMs: helperTimeoutMs('scroll') });
  return ok(ctx.actionId, 'background', descriptor, 'dispatched',
    `已后台投递滚轮(${direction} ${amount} 行)给 ${window.title || window.bundleId}(pid ${window.pid});未影响用户前台。`,
    { point: [lx, ly], direction, amount });
}

async function toolType(args, ctx) {
  const text = args.text;
  if (typeof text !== 'string') {
    return fail('CU_INVALID_ARGUMENT', { actionId: ctx.actionId, message: 'text 必须是字符串;零投递。' });
  }
  if (codePointLength(text) > TEXT_MAX_CODE_POINTS) {
    return fail('CU_INVALID_ARGUMENT', {
      actionId: ctx.actionId,
      message: `text 超过 ${TEXT_MAX_CODE_POINTS} 个 Unicode 码点(按码点计,不按 UTF-16 单元);零投递。`,
    });
  }
  const resolved = await resolveTarget(ctx.target);
  if (!resolved.ok) return fail(resolved.code, { actionId: ctx.actionId, extra: resolved.detail ? { detail: resolved.detail } : {} });
  const window = resolved.window;
  const descriptor = targetDescriptor(window);
  if (ctx.foreground) {
    const listing = await listWindows();
    if (!focusMatches(window, listing.frontmost)) {
      return fail('CU_TARGET_CHANGED', { actionId: ctx.actionId, extra: { target: descriptor } });
    }
    if (text === '') {
      return ok(ctx.actionId, 'foreground', descriptor, 'not-applicable', '空串:零动作(未向目标输入任何内容)。', { chars: 0 });
    }
    await runHelper(['type', '--stdin-json', ...(codePointLength(text) > 40 ? ['--fast'] : [])],
      { timeoutMs: helperTimeoutMs('type', codePointLength(text)), input: { text } });
    const after = await readState(window);
    const verified = after.readable && after.text.includes(text);
    return ok(ctx.actionId, 'foreground', descriptor, verified ? 'verified' : 'unknown',
      `已向当前前台目标 ${window.title || window.bundleId} 输入 ${codePointLength(text)} 个字符`
      + `${verified ? '(读回包含原文)' : '(读回无法确认,效果未验证)'}。`, { chars: codePointLength(text) });
  }
  if (text === '') {
    return ok(ctx.actionId, 'background', descriptor, 'not-applicable', '空串:零动作(未向目标写入任何内容)。', { chars: 0 });
  }
  try {
    const r = await runHelper(['ax-type', '--pid', String(window.pid), '--window-id', String(window.id), '--stdin-json'],
      { timeoutMs: helperTimeoutMs('type', codePointLength(text)), input: { title: String(window.title || ''), text } });
    const before = r.before || {};
    const after = r.after || {};
    const verified = Boolean(after.readable) && after.text === r.expected;
    return ok(ctx.actionId, 'background', descriptor, verified ? 'verified' : 'unknown',
      `已向目标 ${window.title || window.bundleId} 写入 ${codePointLength(text)} 个码点`
      + `(方式 ${r.method})${verified ? ',读回与原文逐字符一致' : ',读回与预期不一致或不可读,效果未验证'}。`,
      { chars: codePointLength(text), via: r.method, readback: after.readable ? { length: codePointLength(after.text || '') } : null,
        before: before.readable ? { length: codePointLength(before.text || '') } : null });
  } catch (error) {
    if (error instanceof HelperError && (error.payload?.code === 'UNREADABLE' || error.payload?.reason === 'permission')) {
      // 读不回文本的目标:仍投递事件,但只报 unknown(不声称输入成功)
      try {
        await runHelper(['ax-key', '--pid', String(window.pid), '--window-id', String(window.id), '--stdin-json'],
          { timeoutMs: helperTimeoutMs('type', codePointLength(text)), input: { title: String(window.title || ''), unicode: text } });
      } catch (fallbackError) {
        // 回退投递失败/超时时不能再报"投递 N 个码点"。逐字符投递可能中途断开,进了目标几个字无从得知,
        // 所以 state=unknown(合同:超时/断连已投递者 unknown,不能报 cancelled);code 沿用 helperFailure 的分派
        const failed = helperFailure(fallbackError, ctx.actionId);
        return fail(failed.structuredContent.code, {
          actionId: ctx.actionId,
          state: 'unknown',
          message: `目标文本不可读回,回退投递没有完成(${failed.content[0].text});`
            + '中途断开时可能有部分字符进入目标,效果未知,不自动重试。',
        });
      }
      return ok(ctx.actionId, 'background', descriptor, 'unknown',
        `目标文本不可读回:已向 ${window.title || window.bundleId} 投递 ${codePointLength(text)} 个码点,但无法验证效果(不声称输入成功)。`,
        { chars: codePointLength(text), via: 'events', readback: null });
    }
    return helperFailure(error, ctx.actionId);
  }
}

async function readState(window) {
  try {
    const r = await runHelper(['ax-state', '--pid', String(window.pid), '--window-id', String(window.id), '--stdin-json'],
      { timeoutMs: 15_000, input: { title: String(window.title || '') } });
    return r.state || { readable: false };
  } catch {
    return { readable: false };
  }
}

async function toolKey(args, ctx) {
  const spec = parseKeySpec(args.keys);
  if (!spec.ok) {
    return fail('CU_UNSUPPORTED_KEY', {
      actionId: ctx.actionId,
      message: `"${String(args.keys).slice(0, 40)}" 不是支持的键或键组合(支持字母/数字、return/enter、escape/esc、tab、space、backspace/delete、方向键与 cmd/option/ctrl/shift 组合);整串在投递前拒绝,没有部分按键。`,
    });
  }
  const resolved = await resolveTarget(ctx.target);
  if (!resolved.ok) return fail(resolved.code, { actionId: ctx.actionId, extra: resolved.detail ? { detail: resolved.detail } : {} });
  const window = resolved.window;
  const descriptor = targetDescriptor(window);
  if (ctx.foreground) {
    const listing = await listWindows();
    if (!focusMatches(window, listing.frontmost)) {
      return fail('CU_TARGET_CHANGED', { actionId: ctx.actionId, extra: { target: descriptor } });
    }
    await runHelper(['key', '--keys', args.keys], { timeoutMs: helperTimeoutMs('key') });
    return ok(ctx.actionId, 'foreground', descriptor, 'dispatched',
      `已向当前前台目标 ${window.title || window.bundleId} 投递按键 ${args.keys};全局事件已影响用户前台。`, { keys: args.keys });
  }
  const r = await runHelper(['ax-key', '--pid', String(window.pid), '--window-id', String(window.id),
    '--keycode', String(spec.keycode), '--flags', String(spec.flags), '--stdin-json'],
  { timeoutMs: helperTimeoutMs('key'),
    input: { title: String(window.title || ''), ...(spec.unicode === null ? {} : { unicode: spec.unicode }) } });
  const before = r.before || { readable: false };
  const after = r.after || { readable: false };
  const expectation = expectedAfter(before, spec);
  let verification = 'unknown';
  let note;
  if (!after.readable) {
    note = '目标文本不可读回,无法验证按键效果';
  } else if (!expectation) {
    const changed = !sameState(before, after);
    verification = changed ? 'dispatched' : 'unknown';
    note = changed ? '目标状态有变化,但该组合键的效果无法从文本/选择状态判定' : '目标文本/选择状态没有变化,效果未确认';
  } else if (after.text === expectation.text && after.selStart === expectation.selStart && after.selEnd === expectation.selEnd) {
    verification = 'verified';
    note = '目标光标/选择/文本状态与预期一致';
  } else {
    note = '目标状态与预期不一致,效果未确认';
  }
  // 有确定 AX 等价物的组合(cmd+a=全选)在后台目标上由 helper 补一步实现;回执要说清走的是哪条路
  const viaAx = r.ax_equivalent ? `(该组合的菜单快捷键对后台目标无效,已用 AX 等价方式完成:${r.ax_equivalent})` : '';
  return ok(ctx.actionId, verification === 'unknown' ? 'background' : 'background', descriptor, verification,
    `已向 ${window.title || window.bundleId} 后台投递按键 ${args.keys}(${spec.mods.length ? `${spec.mods.join('+')}+` : ''}${spec.key})${viaAx};${note}。`,
    { keys: args.keys, keycode: spec.keycode, flags: spec.flags, axEquivalent: r.ax_equivalent || null,
      readback: after.readable ? { selStart: after.selStart, selEnd: after.selEnd } : null });
}

// ── JSON-RPC 循环 ───────────────────────────────────────────────────────
function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyErr(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

const TOOL_HANDLERS = {
  screenshot: (args) => toolScreenshot(args),
  window_list: () => toolWindowList(),
  cursor_position: () => toolCursor(),
  doctor: () => toolDoctor(),
  action_status: (args) => toolActionStatus(args),
  left_click: (args) => runAction('left_click', args, (ctx) => toolClick('left_click', args, ctx)),
  double_click: (args) => runAction('double_click', args, (ctx) => toolClick('double_click', args, ctx)),
  right_click: (args) => runAction('right_click', args, (ctx) => toolClick('right_click', args, ctx)),
  drag: (args) => runAction('drag', args, (ctx) => toolDrag(args, ctx)),
  scroll: (args) => runAction('scroll', args, (ctx) => toolScroll(args, ctx)),
  type: (args) => runAction('type', args, (ctx) => toolType(args, ctx)),
  key: (args) => runAction('key', args, (ctx) => toolKey(args, ctx)),
};

async function handleToolCall(id, params) {
  if (!isPlainObject(params) || typeof params.name !== 'string' || params.name.length === 0) {
    replyErr(id, -32602, 'tools/call 需要 params.name(工具名)');
    return;
  }
  const handler = TOOL_HANDLERS[params.name];
  if (!handler) {
    // 合同:不存在工具/方法一律 -32601(未知工具名不能报成参数错)
    replyErr(id, -32601, `未知工具: ${params.name}`);
    return;
  }
  const args = params.arguments === undefined ? {} : params.arguments;
  if (!isPlainObject(args)) {
    replyErr(id, -32602, 'tools/call 的 arguments 必须是对象');
    return;
  }
  let out;
  try {
    out = await handler(args);
  } catch (error) {
    out = fail('CU_DISPATCH_FAILED', { message: String(error?.message || error).slice(0, 300) });
  }
  const receipt = out && typeof out === 'object' && out.receipt ? out.receipt : out;
  reply(id, receipt);
}

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    replyErr(null, -32700, '解析错误:不是合法 JSON');
    return;
  }
  if (!isPlainObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || msg.method.length === 0) {
    // 非法请求:有 id 就回同 id,没有就回 null(标准 JSON-RPC)
    const id = isPlainObject(msg) && 'id' in msg ? msg.id : null;
    if (isPlainObject(msg) && !('id' in msg)) return; // 通知形态的坏消息:不回
    replyErr(id, -32600, '非法请求:需要 jsonrpc:"2.0" 与字符串 method');
    return;
  }
  const isNotification = !('id' in msg);
  const id = isNotification ? undefined : msg.id;
  switch (msg.method) {
    case 'initialize':
      if (isNotification) return;
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'computer-use', version: '1.2.0' },
        instanceId: INSTANCE_ID,
      });
      return;
    case 'ping':
      if (!isNotification) reply(id, {});
      return;
    case 'tools/list':
      if (!isNotification) reply(id, { tools: TOOLS });
      return;
    case 'tools/call':
      if (isNotification) return;
      handleToolCall(id, msg.params).catch((error) => {
        replyErr(id, -32603, `内部错误: ${String(error?.message || error).slice(0, 200)}`);
      });
      return;
    default:
      if (!isNotification) replyErr(id, -32601, `未知方法: ${msg.method}`);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', handleLine);

// server 被 CLI 杀掉时,在跑的 helper(可能正在往目标写文本)必须一起死
function killAllHelpers() {
  for (const p of activeHelpers) { try { p.kill('SIGKILL'); } catch { /* 已退出 */ } }
  activeHelpers.clear();
}
process.on('SIGTERM', () => { killAllHelpers(); process.exit(0); });
process.on('SIGINT', () => { killAllHelpers(); process.exit(0); });
process.on('exit', killAllHelpers);

// 供白盒单测直接 import(不作为 stdin 循环的副作用)
export {
  TOOLS, SIDE_EFFECT_TOOLS, state, resolveSnapshot, mapPoint,
  checkCoordinateArg, checkCoordinateBounds, pruneActions, INSTANCE_ID,
};
export const __instanceId = INSTANCE_ID;
export const __instanceShort = INSTANCE_SHORT;
