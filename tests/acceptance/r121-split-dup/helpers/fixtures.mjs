// r121 分屏重复渲染验收夹具:隔离 HOME + 两条不同的夹具会话 + PATH 上的假 claude(可控吐字的桩)。
// 依据只有 .devflow/BRIEF-r121.md 与 .devflow/INTERFACE-r121.md;没看实现代码。
//   node helpers/fixtures.mjs     # run.sh 会先跑这一步(数据根由 R121_DATA_ROOT 给)
// 为什么要两条会话:INTERFACE §C 明确要求"至少两条不同的会话做夹具"(用于"两格看不同会话")。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R121_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const fakeCtlDir = () => path.join(homeDir(), 'fake-claude');
export const fakebinDir = () => suitePath('.artifacts', 'fakebin');
export const WORKSPACE_RAW = path.join(suiteDir, '.artifacts', 'runtime-data', 'fixture-workspace');
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

// 会话 id 必须是十六进制 UUID(侧栏只列合法 id 的会话)。
const sidOf = (n) => `a121${String(n).padStart(4, '0')}-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;

/** 两条普通夹具会话(用于"两格看不同会话"):侧栏搜索用的标记 + 合法十六进制 UUID。 */
export const SESSIONS = [
  { sid: sidOf(1), mark: 'R121DUPONE' },
  { sid: sidOf(2), mark: 'R121DUPTWO' },
];
export const S = SESSIONS[0];
export const T = SESSIONS[1];
/** 会话池:每个用例各拿一条自己的,避免用例之间共享可变状态(上一个用例加了消息不影响下一个)。
 *  每条都写成夹具文件,侧栏搜索能直接找到。 */
export const POOL = Array.from({ length: 8 }, (_, i) => ({
  sid: sidOf(10 + i * 3),
  mark: `R121POOL${String(i + 1).padStart(2, '0')}`,
}));

const base = (sid, cwd) => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '' });
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** 一条简短夹具会话:仅供"打开这条会话"用,历史很短,不干扰计数。 */
function sessionLines(sid, cwd, label) {
  const b = base(sid, cwd);
  const ts = (n) => new Date(Date.UTC(2026, 8, 15, 8, 0, 0) + n * 1000).toISOString();
  const msg = (uuid, parentUuid, role, content) => ({ ...b, timestamp: ts(0), type: role, uuid, parentUuid, message: { role, content } });
  const lines = [
    { type: 'summary', summary: label, leafUuid: `${sid}-u1` },
    msg(`${sid}-u1`, null, 'user', `${label} 先看一眼这个仓库。`),
    {
      ...b, timestamp: ts(1), type: 'assistant', uuid: `${sid}-a1`, parentUuid: `${sid}-u1`,
      message: {
        id: `msg_${sid.slice(0, 8)}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: `${label} 好的,先看一眼。` }], stop_reason: 'end_turn', stop_sequence: null, usage: USAGE,
      },
    },
  ];
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

export function buildFixtures() {
  fs.mkdirSync(WORKSPACE_RAW, { recursive: true });
  const cwd = fs.realpathSync(WORKSPACE_RAW);   // 与服务端起假 CLI 时子进程拿到的 cwd 一致(防软链差异)
  const home = homeDir();
  const proj = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  for (const d of [proj, path.join(home, '.claude-gui'), fakeCtlDir(), fakebinDir()]) fs.mkdirSync(d, { recursive: true });

  // 钉成回环免密 + 压掉一次性浮层(与 r119/r120 同口径;公开版会自愈成 0.0.0.0+随机密码,会写盘、会去占 6677)
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));

  for (const s of [...SESSIONS, ...POOL]) {
    fs.writeFileSync(path.join(proj, `${s.sid}.jsonl`), sessionLines(s.sid, cwd, s.mark));
  }

  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${suitePath('helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return { home, cwd, proj };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildFixtures();
  console.log(`[r121] 夹具就绪:HOME=${r.home} 项目=${r.cwd}`);
  console.log(`[r121] 会话:${SESSIONS.map((s) => `${s.sid}(${s.mark})`).join(' / ')} + 池 ${POOL.length} 条`);
}
