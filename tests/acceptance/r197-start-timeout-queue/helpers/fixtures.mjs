// r197 夹具(搭法照 r140-crosstalk 的 helpers/fixtures.mjs,精简后自成一套,不 import 别的套件)。
// 每条夹具会话只在一个用例里用一次:一个回合跑完后应用会给会话改标题,侧栏/搜索就找不到原标记了。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R197_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const fakeCtlDir = () => path.join(homeDir(), 'fake-claude');
export const fakebinDir = () => suitePath('.artifacts', 'fakebin');
export const WORKSPACE_RAW = path.join(suiteDir, '.artifacts', 'runtime-data', 'fixture-workspace');
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

// 会话 id 必须是十六进制 UUID(侧栏/搜索只认合法 id 的会话)。
const sidOf = (n) => `a197${String(n).padStart(4, '0')}-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;
export const POOL = Array.from({ length: 12 }, (_, i) => ({ sid: sidOf(i + 1), mark: `R197S${String(i + 1).padStart(2, '0')}MARK` }));

// 假命令行一个回合里吐的三段文字(测试和假命令行共用同一组构造器)。
export const live = {
  chunk1: (sid, prompt) => `R197-CHUNK1 ${sid.slice(0, 8)} 收到:${prompt}`,
  chunk2: (sid) => `R197-CHUNK2 ${sid.slice(0, 8)} 这是放开后才吐的第二块。`,
  final: (sid) => `R197-FINAL ${sid.slice(0, 8)} 这一轮结束了。`,
};

function sessionLines(sid, cwd, userText, doneText) {
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '' };
  const ts = (n) => new Date(Date.UTC(2026, 8, 15, 8, 0, n)).toISOString();
  const parent = `${sid}-u0`;
  return [
    { type: 'summary', summary: userText.slice(0, 40), leafUuid: parent },
    { ...base, type: 'user', uuid: parent, parentUuid: null, timestamp: ts(0), message: { role: 'user', content: userText } },
    { ...base, type: 'assistant', uuid: `${sid}-a1`, parentUuid: parent, timestamp: ts(1), requestId: `req_${sid.slice(0, 8)}_1`,
      message: { id: `msg_${sid.slice(0, 8)}_1`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: doneText }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export function buildFixtures() {
  fs.mkdirSync(WORKSPACE_RAW, { recursive: true });
  const cwd = fs.realpathSync(WORKSPACE_RAW);   // 与服务端起假命令行时子进程拿到的 cwd 一致
  const home = homeDir();
  const proj = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  for (const d of [proj, path.join(home, '.claude-gui'), fakeCtlDir(), fakebinDir()]) fs.mkdirSync(d, { recursive: true });

  // 首启浮层预置成"已看过",网络钉回环
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));

  for (const { sid, mark } of POOL) {
    fs.writeFileSync(path.join(proj, `${sid}.jsonl`),
      sessionLines(sid, cwd, `${mark} 先来一句话`, `${mark} 收到,这是这条会话里已有的旧回复。`));
  }
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${suitePath('helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return { home, cwd, proj };
}

// ---- 读会话文件(判定"原文进没进会话""进了几条"的最终依据) ----
export const fixtureCwd = () => fs.realpathSync(WORKSPACE_RAW);
export const projDir = () => path.join(homeDir(), '.claude', 'projects', encodeProjectDir(fixtureCwd()));
export const transcriptPath = (sid) => path.join(projDir(), `${sid}.jsonl`);
export function readTranscript(sid) {
  try {
    return fs.readFileSync(transcriptPath(sid), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const flatText = (m) => {
  const c = m && m.message && m.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
  return '';
};
/** 会话文件里 type 为 role 且正文包含 text 的行数。 */
export const countTranscriptLines = (sid, role, text) =>
  readTranscript(sid).filter((l) => l.type === role && flatText(l).includes(text)).length;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildFixtures();
  console.log(`[R197] 夹具就绪:HOME=${r.home} 工作区=${r.cwd}`);
}
