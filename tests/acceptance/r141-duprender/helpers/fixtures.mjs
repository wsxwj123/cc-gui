// r141 夹具(由 r118 的 helpers/fixtures.mjs 复制而来,**r118 原目录只读**)。
// 原有夹具一字不动(NAV/B/POOL/EXTRA 的 id 与 mark 都不变,既有用例拿到的会话不变),
// 只在末尾追加 r140 自己的池 + "被 compact/continue 过的老会话"形态 + 读会话文件的工具。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R118_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const fakeCtlDir = () => path.join(homeDir(), 'fake-claude');
export const fakebinDir = () => suitePath('.artifacts', 'fakebin');
export const WORKSPACE_RAW = path.join(suiteDir, '.artifacts', 'runtime-data', 'fixture-workspace');
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

// 会话 id 必须是十六进制 UUID(侧栏只列合法 id 的会话)。
// 为什么这么多条:一个回合跑完后应用会给会话改标题(侧栏行文字变成别的东西),所以**每条夹具会话
// 只在一个用例的一轮里用一次**,用完不再按标记找它。NAV 专门用来"把项目打开进侧栏"(永不跑回合);
// B 是切过去的那个别的会话(永不跑回合)。
const sidOf = (n) => `a118${String(n).padStart(4, '0')}-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;
export const NAV = { sid: sidOf(99), mark: 'R118NAVMARK' };
export const B = { sid: 'a1180004-0000-4000-8000-0000000000b4', mark: 'R118BMARK' };
export const MARK = { b: B.mark };
export const POOL = Array.from({ length: 24 }, (_, i) => ({ sid: sidOf(i + 1), mark: `R118S${String(i + 1).padStart(2, '0')}MARK` }));
/** 第 n 个用例专用的一组会话(n 从 0 起;每个用例拿 3 条,互不相同的轮)。 */
export const batch = (n) => POOL.slice(n * 3, n * 3 + 3);

// r118b 追加的用例专用池:单独一段,不参与上面的 POOL/batch(动 POOL 会改变既有用例拿到的会话)。
export const EXTRA = Array.from({ length: 15 }, (_, i) => ({ sid: sidOf(200 + i), mark: `R118X${String(i + 1).padStart(2, '0')}MARK` }));
export const extraBatch = (n) => EXTRA.slice(n * 3, n * 3 + 3);

export const TEXT = { bReply: 'R118B 这是别的会话里的旧回复。' };
// 假 CLI 在一个回合里吐的三段文字。测试和假 CLI 共用同一组构造器(不会各写一份对不上)。
export const live = {
  chunk1: (sid, prompt) => `R118-CHUNK1 ${sid.slice(0, 8)} 收到:${prompt}`,
  chunk2: (sid) => `R118-CHUNK2 ${sid.slice(0, 8)} 这是切回来之后才吐的第二块。`,
  final: (sid) => `R118-FINAL ${sid.slice(0, 8)} 这一轮结束了。`,
};

// ===================== r141 追加 =====================
// 单独的会话池:不动 POOL/EXTRA(改它们会让既有用例拿到别的会话)。
export const R141 = Array.from({ length: 30 }, (_, i) => ({ sid: sidOf(400 + i), mark: `R141S${String(i + 1).padStart(2, '0')}MARK` }));
/** 第 n 组(3 条 = 3 轮)。 */
export const oldBatch = (n) => R141.slice(n * 3, n * 3 + 3);
/**
 * "被 compact/continue 过的老会话"形态:历史里夹着 compact 边界
 * (system/subtype=compact_boundary + compactMetadata,紧跟一条 user/isCompactSummary=true)。
 * 现场那条约 39MB 的 paperhot 会话就是这种形态 —— 结构照抄真文件(见 .devflow/TEST-PLAN-r140.md 的说明:
 * 只复刻结构,不复刻体积)。
 */
export const OLD = [{ sid: sidOf(500), mark: 'R141OLD1MARK' }, { sid: sidOf(501), mark: 'R141OLD2MARK' }];
export const OLD_COMPACT_SUMMARY = 'R141OLD 这是 compact 之后接上的历史摘要(前面 12 轮已折叠)。';
/** 老会话历史里那几条"早就存在"的助手回复,用来确认历史确实画出来了。 */
export const OLD_HISTORY_REPLY = (i) => `R141OLD 历史回复第 ${i} 条:这条在夹具里就写好了。`;

export const T140 = { bReply: '这是这条会话里已有的旧回复' };   // 与 r118 的 B 会话正文一致(阳性对照用)

// ---- r141 不变量用例专用(R141D 池 + 短块文案)------------------------------------
// 为什么另起一段文案:r141 的"红"必须建立在【弱去重键结构性落空】上 ——
// makePersistedIndex 的弱键是 `type|text.slice(0,80)`,本地副本用 `\n` 拼块、历史用 `''`
// join。若第一块本身 ≥80 字,两边前 80 字完全相同,弱键反而命中(清场成功 = 假绿)。
// DUPCHUNK1 只有 21 字 ⇒ 拼接差异落在第 22 字,恒定在 80 字窗口内。
export const DUP_MARK = 'DUPCHUNK1';
/** 请求里带上它 = 让假 CLI 用短块文案(必须与 DUP_MARK 同源,不许写两处字面量)。 */
export const DUP_PROMPT_MARK = 'R141DUPROUND';
export const QUIET_MARK = 'R141QUIET';
export const dup = {
  chunk1: (sid) => `DUPCHUNK1 ${String(sid).slice(0, 8)} A`,
  chunk2: (sid) => `DUPCHUNK2 ${String(sid).slice(0, 8)} B`,
  final: (sid) => `DUPFINAL ${String(sid).slice(0, 8)} C`,
  /** 一轮的完整正文(本地副本的拼法:`\n` 连接三块)。 */
  full: (sid) => [dup.chunk1(sid), dup.chunk2(sid), dup.final(sid)].join('\n'),
  /** 历史口径的拼法(服务端逐条 push、前端 '' join)。 */
  fullHistory: (sid) => [dup.chunk1(sid), dup.chunk2(sid), dup.final(sid)].join(''),
};
/** r141 不变量用例专用会话池(不动 R141/POOL/EXTRA,既有用例拿到的会话一字不变)。 */
// 20 条:主 spec 用 base+0..base+3,judge1(P-2/J1)用 base+4/base+5,而 R141D_BASE 会按 4 递进
// (0/4/8/…)—— 留够 20 条才不会被越界(idx 越界会以 "reading 'sid'" 这种没信息量的姿势炸)。
export const R141D = Array.from({ length: 20 }, (_, i) => ({ sid: sidOf(600 + i), mark: `R141D${String(i + 1).padStart(2, '0')}MARK` }));

const text = (t) => ({ type: 'text', text: t });

function sessionLines(sid, cwd, userContent, doneText) {
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '' };
  const ts = (n) => new Date(Date.UTC(2026, 8, 15, 8, 0, n)).toISOString();
  const label = typeof userContent === 'string' ? userContent : (userContent.find((b) => b.type === 'text')?.text || '');
  const parent = `${sid}-u0`;
  const lines = [
    { type: 'summary', summary: label.slice(0, 40), leafUuid: parent },
    { ...base, type: 'user', uuid: parent, parentUuid: null, timestamp: ts(0), message: { role: 'user', content: userContent } },
  ];
  const uuid = `${sid}-a1`;
  lines.push({ ...base, type: 'assistant', uuid, parentUuid: parent, timestamp: ts(1), requestId: `req_${sid.slice(0, 8)}_1`,
    message: { id: `msg_${sid.slice(0, 8)}_1`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: doneText }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** r141:老会话形态 —— 12 轮历史 + 一次 compact 边界 + 再 6 轮历史(结构照抄真会话文件)。 */
function oldSessionLines(sid, cwd, mark) {
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '' };
  const ts = (n) => new Date(Date.UTC(2026, 8, 20, 8, 0, n)).toISOString();
  const out = [];
  let n = 0;
  const turn = (i) => {
    const u = `${sid}-u${i}`;
    out.push({ ...base, type: 'user', uuid: u, parentUuid: null, timestamp: ts(n++), message: { role: 'user', content: `${mark || 'R141OLD'} 历史提问第 ${i} 条` } });
    out.push({ ...base, type: 'assistant', uuid: `${sid}-a${i}`, parentUuid: u, timestamp: ts(n++), requestId: `req_old_${i}`,
      message: { id: `msg_old_${i}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: OLD_HISTORY_REPLY(i) }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  };
  out.push({ ...base, type: 'summary', summary: `${mark || 'R141OLD'} 老会话开头(被 compact/continue 过)`, leafUuid: `${sid}-u1`, timestamp: ts(0) });
  for (let i = 1; i <= 12; i += 1) turn(i);
  // compact 边界:真文件里就是 system/compact_boundary + compactMetadata,紧跟一条 isCompactSummary 的 user
  out.push({ ...base, type: 'system', subtype: 'compact_boundary', level: 'info', isMeta: true,
    content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 168000 }, timestamp: ts(n++) });
  out.push({ ...base, type: 'user', uuid: `${sid}-cs`, parentUuid: null, promptId: `${sid}-csp`, isVisibleInTranscriptOnly: true,
    isCompactSummary: true, timestamp: ts(n++), message: { role: 'user', content: OLD_COMPACT_SUMMARY } });
  for (let i = 13; i <= 18; i += 1) turn(i);
  return out.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export function buildFixtures() {
  fs.mkdirSync(WORKSPACE_RAW, { recursive: true });
  const cwd = fs.realpathSync(WORKSPACE_RAW);   // 与服务端起假 CLI 时子进程拿到的 cwd 一致(防软链差异)
  const home = homeDir();
  const proj = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  for (const d of [proj, path.join(home, '.claude-gui'), fakeCtlDir(), fakebinDir()]) fs.mkdirSync(d, { recursive: true });

  // 首启浮层预置成"已看过"(与被测行为无关),网络钉回环(公开版首启会自愈成 0.0.0.0)
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));

  for (const { sid, mark } of [NAV, B, ...POOL, ...EXTRA]) {
    fs.writeFileSync(path.join(proj, `${sid}.jsonl`),
      sessionLines(sid, cwd, `${mark} 先来一句话`, `${mark} 收到,这是这条会话里已有的旧回复。`));
  }
  // r141 追加的会话池(结构与上面完全一致)
  for (const { sid, mark } of R141) {
    fs.writeFileSync(path.join(proj, `${sid}.jsonl`),
      sessionLines(sid, cwd, `${mark} 先来一句话`, `${mark} 收到,这是这条会话里已有的旧回复。`));
  }
  // r140 老会话形态(被 compact 过)
  for (const { sid, mark } of OLD) fs.writeFileSync(path.join(proj, `${sid}.jsonl`), oldSessionLines(sid, cwd, mark));
  // r141 不变量用例池(结构与 R141 完全一致)
  for (const { sid, mark } of R141D) {
    fs.writeFileSync(path.join(proj, `${sid}.jsonl`),
      sessionLines(sid, cwd, `${mark} 先来一句话`, `${mark} 收到,这是这条会话里已有的旧回复。`));
  }

  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${suitePath('helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return { home, cwd, proj };
}

// ---- r141:读会话文件(判定"写串了没有""写了几条"的最终依据,契约 §2) ----
export const fixtureCwd = () => fs.realpathSync(WORKSPACE_RAW);
export const projDir = () => path.join(homeDir(), '.claude', 'projects', encodeProjectDir(fixtureCwd()));
export const transcriptPath = (sid) => path.join(projDir(), `${sid}.jsonl`);
/** 会话文件里的原始行(文件不存在 = [])。 */
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
/** 会话文件里 role 为 role 且正文包含 text 的行数(判定"一条还是两条"用)。 */
export const countTranscriptLines = (sid, role, text) =>
  readTranscript(sid).filter((l) => l.type === role && flatText(l).includes(text)).length;
/** 会话文件里任意一行(含用户消息、摘要、附件)提到 text 的行数。 */
export const transcriptMentions = (sid, text) =>
  readTranscript(sid).filter((l) => JSON.stringify(l).includes(text)).length;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildFixtures();
  console.log(`[r141] 夹具就绪:HOME=${r.home} 项目=${r.cwd}`);
}
