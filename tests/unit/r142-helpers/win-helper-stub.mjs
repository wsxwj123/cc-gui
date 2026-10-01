#!/usr/bin/env node
// r142 测试夹具(2/3):假的 Windows 版 helper 解释器(顶替 venv-win/Scripts/python.exe)。
//
// 它同时扮演两种角色,靠 argv[0] 区分(与 tests/unit/q8-helpers/cu-stub.mjs 同一体例):
//   * `-m venv <dir>` / `-m pip install …` —— 装作建环境/装包成功(绝不真装);
//   * `<HELPER 路径> <子命令> …`      —— 按剧本回一行 JSON,并记录 argv。
//
// 额外能力(为 T-4 释放合同准备):
//   * 每 60ms 往 CU_STUB_HEARTBEAT_DIR 写一个心跳文件 —— 进程被杀后心跳停止,
//     `release-hold` 调用会把"所有心跳里最晚的一次"记进自己的日志行 ⇒ 可以判定"先杀后释放"。
//   * `release-hold` 会记录它拿到的参数/环境,供断言"watcher 确实补发了抬起"。
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const log = process.env.CU_STUB_LOG;
const sigLog = process.env.CU_STUB_SIGLOG;
const beatDir = process.env.CU_STUB_HEARTBEAT_DIR;
const scenarioPath = process.env.CU_STUB_SCENARIO;
const at = () => Date.now();
const record = (obj) => { if (log) fs.appendFileSync(log, `${JSON.stringify({ at: at(), pid: process.pid, ...obj })}\n`); };

// ── 解释器探测形态(`py -3 --version` / `python --version`)─────────────
// PATH 上的 shim 会带 CU_STUB_PYNAME,用来区分产品选中的是哪个候选。
if (argv.includes('--version')) {
  record({ kind: 'py', subcmd: '--version', args: argv, pyname: process.env.CU_STUB_PYNAME || null });
  process.stdout.write('Python 3.12.0\n');
  process.exit(0);
}

// ── venv / pip 形态 ────────────────────────────────────────────────────
if (argv[0] === '-m') {
  record({ kind: 'py', subcmd: `-m ${argv[1]}`, args: argv.slice(1), python: process.argv[1] });
  if (argv[1] === 'venv') {
    // 造出 Windows venv 布局,让后续 VENV_PY 真的存在(否则 prepare 之后仍不可用)
    const dir = argv[2];
    fs.mkdirSync(path.join(dir, 'Scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pyvenv.cfg'), 'home = C:\\Fake\n');
    fs.copyFileSync(process.argv[1], path.join(dir, 'Scripts', 'python.exe'));
    fs.chmodSync(path.join(dir, 'Scripts', 'python.exe'), 0o755);
  }
  process.exit(0);
}

const HELPER = argv[0];
const subcmd = argv[1];
const rest = argv.slice(2);
record({ kind: 'helper', subcmd, args: rest, helper: path.basename(String(HELPER)) });

// 心跳:活着就一直写;被 kill 后自然停。
let beatFile = null;
let beatTimer = null;
if (beatDir) {
  fs.mkdirSync(beatDir, { recursive: true });
  beatFile = path.join(beatDir, `beat-${process.pid}.log`);
  const beat = () => { try { fs.appendFileSync(beatFile, `${at()}\n`); } catch { /* 目录被清掉就算了 */ } };
  beat();
  beatTimer = setInterval(beat, 60);
}
function latestBeatAt() {
  if (!beatDir) return null;
  let max = null;
  for (const f of fs.readdirSync(beatDir)) {
    if (f === `beat-${process.pid}.log`) continue; // 排除自己:要的是"别的进程最后一次心跳"
    const lines = fs.readFileSync(path.join(beatDir, f), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) { const t = Number(line); if (Number.isFinite(t) && (max === null || t > max)) max = t; }
  }
  return max;
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    if (sigLog) fs.appendFileSync(sigLog, `${JSON.stringify({ subcmd, signal: sig, at: at() })}\n`);
    process.exit(0);
  });
}

let scenario = {};
try { scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')); } catch { scenario = {}; }

// `hold` 剧本:模拟"helper 已经按下某键、hold 文件已落盘"的状态(层 1/2 的写入顺序由产品负责)。
const holdDir = process.env.CU_STUB_HOLD_DIR;
if (holdDir && scenario[subcmd]?.hold) {
  const target = path.join(holdDir, `hold-${process.pid}.json`);
  const tmp = `${target}.tmp`;
  const body = { version: 1, pid: process.pid, keys: scenario[subcmd].hold, held: scenario[subcmd].hold,
    updatedAt: new Date().toISOString(), at: at() };
  fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`);
  fs.renameSync(tmp, target); // 与 writeGrants 同款:tmp + rename
  record({ kind: 'hold-write', file: path.basename(target), keys: scenario[subcmd].hold });
}

const DEFAULTS = {
  'screen-info': { ok: true, pixel: { w: 1920, h: 1080 }, logical: { w: 1920, h: 1080 }, scale: 1, bounds: { x: 0, y: 0, w: 1920, h: 1080 }, display_id: 1 },
  screenshot: { ok: true, path: '', mime: 'image/jpeg', pixel: { w: 100, h: 50 }, logical: { w: 100, h: 50 }, bounds: { x: 0, y: 0, w: 100, h: 50 }, scale: 1 },
  cursor: { ok: true, point: [0, 0], local: null },
  windows: { ok: true, frontmost: null, windows: [] },
  apps: { ok: true, apps: [] },
  'app-info': { ok: true, installed: true, name: 'Notepad', path: 'C:\\Windows\\System32\\notepad.exe' },
  doctor: { ok: true, platform: 'win32', screen_recording: 'ok', accessibility: 'not-applicable', capture_test: 'ok', dpi_awareness: 'per-monitor-v2', scale: 1, integrity_level: 'medium' },
  'uia-probe': { ok: true, uia: true, comtypes: '1.4.11' },
  'release-hold': { ok: true, released: [] },
};

/**
 * 同一子命令被连续调用时按 `replies` 依次回(阶梯测试必需:第一次 UIA 失败、第二次消息投递成功)。
 * 每次调用都是新进程,所以计数落在 `${scenarioPath}.seq` 这个 append-only 文件里。
 */
function scriptedReply(sub) {
  const list = scenario[sub]?.replies;
  if (!Array.isArray(list) || list.length === 0) return null;
  const seqFile = `${scenarioPath}.seq`;
  let seen = 0;
  try { seen = fs.readFileSync(seqFile, 'utf8').split('\n').filter((l) => l === sub).length; } catch { seen = 0; }
  fs.appendFileSync(seqFile, `${sub}\n`);
  return list[Math.min(seen, list.length - 1)];
}

function emit(obj) { process.stdout.write(`${JSON.stringify(obj)}\n`); }
function finish() {
  if (subcmd === 'screenshot') {
    const out = rest[rest.indexOf('--out') + 1] || '';
    const jpg = String(out).replace(/\.png$/, '.jpg');
    try { fs.mkdirSync(path.dirname(jpg), { recursive: true }); fs.writeFileSync(jpg, Buffer.from('ffd8ffd9', 'hex')); } catch { /* 路径不可写就算了 */ }
    emit({ ...DEFAULTS.screenshot, path: jpg, ...(scenario[subcmd]?.reply || {}) });
    return;
  }
  if (subcmd === 'release-hold') {
    // 把"此刻之前最后一次心跳"记下来:释放发生在心跳停止之后 = 先杀后释放。
    record({ kind: 'release-hold', latestBeatAt: latestBeatAt(), argvKeys: rest });
  }
  const sc = scenario[subcmd];
  const scripted = scriptedReply(subcmd);
  if (scripted) emit(scripted);
  else if (sc?.reply) emit(sc.reply);
  else emit(DEFAULTS[subcmd] || { ok: true });
}

const sleepMs = scenario[subcmd]?.sleepMs || 0;
const exitCode = scenario[subcmd]?.exitCode ?? 0;
if (sleepMs) setTimeout(() => { if (beatTimer) clearInterval(beatTimer); finish(); process.exit(exitCode); }, sleepMs);
else { finish(); if (beatTimer) clearInterval(beatTimer); process.exit(exitCode); }
