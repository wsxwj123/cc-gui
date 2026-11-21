// r207 页面用例的夹具:假家目录里放 4 条各约 30 轮问答的会话 + 假命令行垫片。只服务本套件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const dataRoot = () => process.env.R207_DATA_ROOT || path.join(suiteDir, '.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const fakeCtlDir = () => path.join(homeDir(), 'fake-claude');
export const fakebinDir = () => path.join(dataRoot(), 'fakebin');
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

const sidOf = (n) => `a207000${n}-0000-4000-8000-00000000020${n}`;
/** 会话池:每条只在一个用例里用。TURNS 轮问答;第 i 问 = `<mark> 提问<i>`,第 i 答 = `<mark> 回复<i>`。 */
export const TURNS = 30;
export const POOL = {
  A: { sid: sidOf(1), mark: 'R207AMARK' },   // 用例 6:504
  B: { sid: sidOf(2), mark: 'R207BMARK' },   // 用例 6:500
  C: { sid: sidOf(3), mark: 'R207CMARK' },   // 用例 6:已有消息时后台刷新失败
  D: { sid: sidOf(4), mark: 'R207DMARK' },   // 用例 7:回合结束核对
};
export const lastReplyOf = (mark) => `${mark} 回复${TURNS - 1}`;

function sessionText(sid, cwd, mark) {
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.327', gitBranch: '' };
  const ts = (n) => new Date(Date.UTC(2026, 8, 15, 8, 0, n)).toISOString();
  const lines = [{ type: 'summary', summary: `${mark} 先来一句话`, leafUuid: `${sid}-a${TURNS - 1}` }];
  for (let i = 0; i < TURNS; i += 1) {
    lines.push({ ...base, type: 'user', uuid: `${sid}-u${i}`, parentUuid: i ? `${sid}-a${i - 1}` : null, timestamp: ts(i * 2), message: { role: 'user', content: `${mark} 提问${i}` } });
    lines.push({ ...base, type: 'assistant', uuid: `${sid}-a${i}`, parentUuid: `${sid}-u${i}`, timestamp: ts(i * 2 + 1), requestId: `req_${sid.slice(0, 8)}_${i}`,
      message: { id: `msg_${sid.slice(0, 8)}_${i}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: `${mark} 回复${i}` }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export function buildFixtures() {
  const ws = path.join(dataRoot(), 'ws', 'fixture-workspace');
  fs.mkdirSync(ws, { recursive: true });
  const cwd = fs.realpathSync(ws);
  const home = homeDir();
  const proj = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  for (const d of [proj, path.join(home, '.claude-gui'), fakeCtlDir(), fakebinDir()]) fs.mkdirSync(d, { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: {} }));
  for (const { sid, mark } of Object.values(POOL)) fs.writeFileSync(path.join(proj, `${sid}.jsonl`), sessionText(sid, cwd, mark));
  fs.writeFileSync(path.join(fakeCtlDir(), 'auto-ms'), '300');
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(suiteDir, 'helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return { home, cwd, proj };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildFixtures();
  console.log(`[r207] 夹具就绪:HOME=${r.home} 工作区=${r.cwd}`);
}
