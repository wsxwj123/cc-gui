// r143 界面验收的夹具:隔离 HOME、一个夹具项目 + 若干夹具会话(NAV 把项目打开进侧栏 / B 与 POOL 用来
// 观察"搜索期间被过滤、清空后恢复")、PATH 上的假 claude。
// 结构照抄 r118-switch-back/helpers/fixtures.mjs(只改前缀与数量),依据是 .devflow/PLAN-r143-sidebar-search.md。
//   node helpers/fixtures.mjs     # run.sh 会先跑这一步
// 工作目录(夹具项目的 cwd)放在本套件 .artifacts 里:实测 cwd 在 /private/tmp 下的项目不进侧栏。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R143_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const fakeCtlDir = () => path.join(homeDir(), 'fake-claude');
export const fakebinDir = () => suitePath('.artifacts', 'fakebin');
export const WORKSPACE_RAW = path.join(suiteDir, '.artifacts', 'runtime-data', 'fixture-workspace');
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

// 会话 id 必须是十六进制 UUID(侧栏只列合法 id 的会话)。
// NAV 专门用来"把项目打开进侧栏"(不跑回合);B 是搜索期间应当被过滤掉的那条别的会话;
// POOL 供 S2 点搜索结果行用(每次搜索一个唯一标记,命中项唯一)。
const sidOf = (n) => `a143${String(n).padStart(4, '0')}-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;
export const NAV = { sid: sidOf(99), mark: 'R143NAVMARK' };
export const B = { sid: 'a1430004-0000-4000-8000-0000000000b4', mark: 'R143BMARK' };
export const MARK = { b: B.mark };
export const POOL = Array.from({ length: 6 }, (_, i) => ({ sid: sidOf(i + 1), mark: `R143S${String(i + 1).padStart(2, '0')}MARK` }));

// S5c 用的一组(专门测"过滤态说明行数的是谁"):CNT 三条**标题**含同一个词;
// CNT_MSG_ONLY 一条**标题不含**、只有助手那句回复里含 —— 消息搜索能搜到它,
// 但计数口径是"标题匹配"⇒ 说明行应当说 3 条,不是 4 条。口径见 TEST-PLAN §6.4。
// CNT_ARCH 第 4 条**标题也含同一个词、但已归档**(服务端标记文件 `<sid>.jsonl.archived`,
// 见 server/routes/sessions.js:692)⇒ 计数口径里的"未归档"那一半(S5d 用)。
const CNT_TOKEN = 'R143CNTMARK';
export { CNT_TOKEN };
export const CNT = Array.from({ length: 3 }, (_, i) => ({ sid: sidOf(21 + i), mark: `${CNT_TOKEN} 第${i + 1}条` }));
export const CNT_MSG_ONLY = { sid: sidOf(29), mark: 'R143MSGMARK', token: CNT_TOKEN };
export const CNT_ARCH = { sid: sidOf(24), mark: `${CNT_TOKEN} 已归档的那条` };

export const TEXT = { bReply: 'R143B 这是别的会话里的旧回复。' };
// 假 CLI 在一个回合里吐的三段文字(本套件不跑回合,保留给"以后要跑回合"的用例;测试与假 CLI 共用同一组构造器)。
export const live = {
  chunk1: (sid, prompt) => `R143-CHUNK1 ${sid.slice(0, 8)} 收到:${prompt}`,
  chunk2: (sid) => `R143-CHUNK2 ${sid.slice(0, 8)} 这是切回来之后才吐的第二块。`,
  final: (sid) => `R143-FINAL ${sid.slice(0, 8)} 这一轮结束了。`,
};

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

  // 普通夹具:标题 = 第一句用户话,回复里也带同一个标记。
  for (const { sid, mark } of [NAV, B, ...POOL, ...CNT]) {
    fs.writeFileSync(path.join(proj, `${sid}.jsonl`),
      sessionLines(sid, cwd, `${mark} 先来一句话`, `${mark} 收到,这是这条会话里已有的旧回复。`));
  }
  // S5c 的"只有消息命中"那条:**标题**(= 第一句用户话)里没有 CNT 词,只有助手回复里有
  // ⇒ 消息搜索搜得到它,但"标题匹配"的计数不该把它算进去。
  fs.writeFileSync(path.join(proj, `${CNT_MSG_ONLY.sid}.jsonl`),
    sessionLines(CNT_MSG_ONLY.sid, cwd, `${CNT_MSG_ONLY.mark} 先来一句话`,
      `${CNT_MSG_ONLY.token} 只在这条会话的消息正文里出现,标题里没有这个词。`));
  // S5d 的"标题匹配但已归档"那条:JSONL 照写,额外放一个服务端认的归档标记文件
  // (空文件 = 已归档,见 server/routes/sessions.js:678-706)。
  fs.writeFileSync(path.join(proj, `${CNT_ARCH.sid}.jsonl`),
    sessionLines(CNT_ARCH.sid, cwd, `${CNT_ARCH.mark} 先来一句话`,
      `${CNT_ARCH.mark} 收到,这条会话已被归档(标题仍含计数词,不该被算进「匹配 N 条会话」)。`));
  fs.writeFileSync(path.join(proj, `${CNT_ARCH.sid}.jsonl.archived`), '');

  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${suitePath('helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return { home, cwd, proj };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildFixtures();
  console.log(`[r143] 夹具就绪:HOME=${r.home} 项目=${r.cwd}`);
}
