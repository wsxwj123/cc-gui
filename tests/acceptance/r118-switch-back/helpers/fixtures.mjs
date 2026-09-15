// r118 界面验收的夹具:隔离 HOME、一批夹具会话(NAV 导航用 + B 切换用 + 18 条轮次用)、PATH 上的假 claude。
// 依据只有 .devflow/BRIEF-r118.md 与 .devflow/INTERFACE-r118.md;没看实现。
//   node helpers/fixtures.mjs     # run.sh 会先跑这一步
// 工作目录(夹具项目的 cwd)放在本套件 .artifacts 里:实测 cwd 在 /private/tmp 下的项目不进侧栏。
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

  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${suitePath('helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return { home, cwd, proj };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildFixtures();
  console.log(`[r118] 夹具就绪:HOME=${r.home} 项目=${r.cwd}`);
}
