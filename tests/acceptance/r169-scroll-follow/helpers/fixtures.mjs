// r169-scroll-follow 夹具：全部写成 Claude Code 会话文件格式，落在本套件 .artifacts/runtime-data 下（不读用户 profile）。
//   A / B / C  60 轮普通会话，每轮回复几百字，内容高度远超一屏
//   L          300 轮短对话（会出现「加载更早」）
//   N          40 轮，测试开始前从未打开过（文件时间最老，不会被「点工作区标题打开最新会话」带出来）
// 五个会话在同一个工作区。每个会话：第 1 轮用户消息与 summary 里放开头标记 BEG，最后一条回复正文里放结束标记 END。
// A / B / C 会被用例往里追加回复，所以每条用例开始前整份重写（refreshSessions），免得历史越滚越长把结束标记挤出首屏加载范围。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function suitePath(...p) { return path.join(suiteDir, ...p); }
export const dataRoot = () => suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const guiConfigDir = () => path.join(homeDir(), '.claude-gui');
export const fakebinDir = () => suitePath('.artifacts', 'fakebin');
export const fakeCtlDir = () => path.join(homeDir(), 'fake-claude');

export const WS_NAME = 'r169ws';
export const workspaceDir = () => path.join(dataRoot(), WS_NAME);
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

// t0：会话内时间戳与文件修改时间的起点。A 最新、N 最老，保证「点工作区标题打开最新会话」打开的是 A，不会是 N。
const defs = {
  A: { rounds: 60, kind: 'chat', t0: Date.UTC(2026, 10, 7, 9, 0, 0) },
  B: { rounds: 60, kind: 'chat', t0: Date.UTC(2026, 10, 1, 9, 0, 0) },
  C: { rounds: 60, kind: 'chat', t0: Date.UTC(2026, 9, 20, 9, 0, 0) },
  L: { rounds: 300, kind: 'short', t0: Date.UTC(2026, 9, 5, 9, 0, 0) },
  N: { rounds: 40, kind: 'chat', t0: Date.UTC(2026, 9, 1, 9, 0, 0) },
};
export const KEYS = Object.keys(defs);
export const SESSIONS = Object.fromEntries(KEYS.map((k, i) => [k, {
  key: k,
  ...defs[k],
  sid: `a1691${String(i + 1).padStart(3, '0')}-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  beg: `R169BEG${k}Z`,
  end: `R169END${k}Z`,
  wsName: WS_NAME,
  projectHash: encodeProjectDir(workspaceDir()),
}]));

const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };

function sessionWriter(fd, key) {
  const { sid, t0 } = SESSIONS[key];
  const cwd = workspaceDir();
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();
  const common = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: 'r169' };
  let prev = null; let n = 0; let sec = 0;
  const put = (o) => { fs.writeSync(fd, `${JSON.stringify(o)}\n`); };
  const link = (uuid) => { const p = prev; prev = uuid; return p; };
  return {
    summary(text) { put({ type: 'summary', summary: text, leafUuid: `r169-leaf-${key}` }); },
    user(text) {
      n += 1; sec += 1; const uuid = `r169-u-${key}-${n}`;
      put({ ...common, parentUuid: link(uuid), promptId: 'r169-prompt', type: 'user', isMeta: false, message: { role: 'user', content: text }, uuid, timestamp: iso(sec), permissionMode: 'default', promptSource: 'sdk' });
    },
    assistant(block, stop) {
      n += 1; sec += 1; const uuid = `r169-a-${key}-${n}`; const id = `r169_${key}_${n}`;
      put({ ...common, parentUuid: link(uuid), message: { model: 'claude-sonnet-4-6', id, type: 'message', role: 'assistant', content: [block], stop_reason: stop, stop_sequence: null, stop_details: null, usage: USAGE }, apiBlockIndex: 0, requestId: `req_${id}`, type: 'assistant', uuid, timestamp: iso(sec), effort: 'high' });
      return uuid;
    },
  };
}

const filler = (r) => `这是第 ${r} 轮的对话内容，用来凑够几百字的篇幅，让每一轮都占据足够的高度。`.repeat(10);

function sessionFile(key) {
  const d = SESSIONS[key];
  return path.join(homeDir(), '.claude', 'projects', encodeProjectDir(workspaceDir()), `${d.sid}.jsonl`);
}

function writeSession(key) {
  const d = SESSIONS[key];
  const file = sessionFile(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  try {
    const w = sessionWriter(fd, key);
    w.summary(`${d.beg} r169 夹具`);
    for (let r = 1; r <= d.rounds; r += 1) {
      const last = r === d.rounds;
      const body = d.kind === 'short' ? `第 ${r} 轮` : filler(r);
      w.user(r === 1 ? `${d.beg} 第 1 轮：开头` : `第 ${r} 轮提问：${d.kind === 'short' ? '请继续' : '请继续展开说明'}`);
      w.assistant({ type: 'text', text: last ? `第 ${r} 轮回复：全部完成。${d.end}` : `第 ${r} 轮回复：${body}` }, 'end_turn');
    }
  } finally { fs.closeSync(fd); }
  const when = new Date(d.t0 + (d.rounds * 2 + 5) * 1000);
  fs.utimesSync(file, when, when);
}

function writeOverlayState() {
  const version = JSON.parse(fs.readFileSync(suitePath('..', '..', '..', 'package.json'), 'utf8')).version;
  fs.mkdirSync(guiConfigDir(), { recursive: true });
  fs.writeFileSync(path.join(guiConfigDir(), 'prefs.json'), `${JSON.stringify({ releaseNotesSeen: version })}\n`);
  fs.writeFileSync(path.join(guiConfigDir(), 'permission-guide-shown.flag'), `${new Date().toISOString()}\n`);
}

function writeFakeClaudeShim() {
  fs.mkdirSync(fakebinDir(), { recursive: true });
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(suiteDir, 'helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
}

/** 整套重建（run-isolated.sh 起实例前调一次）。 */
export function ensureFixtures() {
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  fs.mkdirSync(workspaceDir(), { recursive: true });
  writeOverlayState();
  writeFakeClaudeShim();
  for (const key of KEYS) writeSession(key);
  return Object.fromEntries(KEYS.map((k) => [k, { sid: SESSIONS[k].sid, bytes: fs.statSync(sessionFile(k)).size }]));
}

/** 把指定会话文件重写回初始状态（用例之间清掉上一条用例追加的回复）。 */
export function refreshSessions(keys) {
  for (const key of keys) writeSession(key);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(ensureFixtures(), null, 2)}\n`);
}
