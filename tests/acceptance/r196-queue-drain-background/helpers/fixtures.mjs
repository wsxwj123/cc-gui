// r196 夹具(结构照 r140 的夹具,精简;只服务本套件)。
// 会话池里每条会话只在一个用例里跑一轮(回合跑完应用会改标题,侧栏行文字会变),NAV 只用来把工作区打开进侧栏,永不跑回合。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R196_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const fakeCtlDir = () => path.join(homeDir(), 'fake-claude');
export const fakebinDir = () => suitePath('.artifacts', 'fakebin');
export const WORKSPACE_RAW = path.join(suiteDir, '.artifacts', 'runtime-data', 'fixture-workspace');
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

const sidOf = (n) => `a196${String(n).padStart(4, '0')}-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;
export const NAV = { sid: sidOf(99), mark: 'R196NAVMARK' };
/** 会话池:按用例各取一组,不重复使用。 */
// r208:历史回复里的模型。下标 >= 22 的会话里,奇数下标(Q 类)用「乙」,其余用「甲」,这样 W 组用例里 A(甲)与 Q(乙)的模型徽章不同;
// 下标 36 的会话带 2 次更早的压缩(C4)。下标 < 22 的会话与 r196 原用例完全不变。
export const MODEL_JIA = 'claude-sonnet-4-6';
export const MODEL_YI = 'claude-opus-4-5';
export const POOL = Array.from({ length: 40 }, (_, i) => ({
  sid: sidOf(i + 1), mark: `R196S${String(i + 1).padStart(2, '0')}MARK`,
  model: (i >= 22 && i % 2 === 1) ? MODEL_YI : MODEL_JIA, compacts: i === 36 ? 2 : 0,
}));
export const OLD_REPLY = '这是这条会话里已有的旧回复';
export const oldReplyOf = (mark) => `${mark} 收到,${OLD_REPLY}。`;

function sessionLines(sid, cwd, mark, model = 'claude-sonnet-4-6', compacts = 0) {
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.327', gitBranch: '' };
  const ts = (n) => new Date(Date.UTC(2026, 8, 15, 8, 0, n)).toISOString();
  const parent = `${sid}-u0`;
  const lines = [
    { type: 'summary', summary: `${mark} 先来一句话`, leafUuid: parent },
    { ...base, type: 'user', uuid: parent, parentUuid: null, timestamp: ts(0), message: { role: 'user', content: `${mark} 先来一句话` } },
    { ...base, type: 'assistant', uuid: `${sid}-a1`, parentUuid: parent, timestamp: ts(1), requestId: `req_${sid.slice(0, 8)}_1`,
      message: { id: `msg_${sid.slice(0, 8)}_1`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: oldReplyOf(mark) }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ];
  // 更早的压缩:每次 = 一条 system/compact_boundary + 一条 isCompactSummary 的 user(摘要),后面各跟一问一答
  let prev = `${sid}-a1`; let n = 2;
  for (let k = 1; k <= compacts; k += 1) {
    const b = `${sid}-cb${k}`; const s = `${sid}-cs${k}`; const u = `${sid}-cu${k}`; const a = `${sid}-ca${k}`;
    lines.push({ ...base, type: 'system', subtype: 'compact_boundary', uuid: b, parentUuid: null, logicalParentUuid: prev, content: 'Conversation compacted', isMeta: false, level: 'info', timestamp: ts(n), compactMetadata: { trigger: 'manual', preTokens: 1000 } });
    lines.push({ ...base, type: 'user', uuid: s, parentUuid: b, isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: ts(n + 1), message: { role: 'user', content: `This session is being continued from a previous conversation. Summary: ${mark} 第${k}次压缩的摘要。` } });
    lines.push({ ...base, type: 'user', uuid: u, parentUuid: s, timestamp: ts(n + 2), message: { role: 'user', content: `${mark} 压缩后的第${k}句话` } });
    lines.push({ ...base, type: 'assistant', uuid: a, parentUuid: u, timestamp: ts(n + 3), requestId: `req_${sid.slice(0, 8)}_c${k}`,
      message: { id: `msg_${sid.slice(0, 8)}_c${k}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: `${mark} 压缩后的第${k}条回复。` }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    prev = a; n += 4;
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export function buildFixtures() {
  fs.mkdirSync(WORKSPACE_RAW, { recursive: true });
  const cwd = fs.realpathSync(WORKSPACE_RAW);
  const home = homeDir();
  const proj = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  for (const d of [proj, path.join(home, '.claude-gui'), fakeCtlDir(), fakebinDir()]) fs.mkdirSync(d, { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  for (const { sid, mark, model, compacts } of [NAV, ...POOL]) fs.writeFileSync(path.join(proj, `${sid}.jsonl`), sessionLines(sid, cwd, mark, model, compacts));
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${suitePath('helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return { home, cwd, proj };
}

// ---- 读会话文件(判定"进了哪条会话、几次"的最终依据) ----
export const fixtureCwd = () => fs.realpathSync(WORKSPACE_RAW);
export const projDir = () => path.join(homeDir(), '.claude', 'projects', encodeProjectDir(fixtureCwd()));
export const transcriptPath = (sid) => path.join(projDir(), `${sid}.jsonl`);
export function readTranscript(sid) {
  try {
    return fs.readFileSync(transcriptPath(sid), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
/** 会话文件里任意一行提到 text 的行数。 */
export const transcriptMentions = (sid, text) => readTranscript(sid).filter((l) => JSON.stringify(l).includes(text)).length;
/** 会话文件里「用户消息」行(type=user,正文是字符串或带 text 块)提到 text 的行数。 */
export const userLineCount = (sid, text) => readTranscript(sid).filter((l) => {
  if (l.type !== 'user') return false;
  const c = l.message && l.message.content;
  const t = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('') : '');
  return t.includes(text);
}).length;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildFixtures();
  console.log(`[r196] 夹具就绪:HOME=${r.home} 工作区=${r.cwd}`);
}
