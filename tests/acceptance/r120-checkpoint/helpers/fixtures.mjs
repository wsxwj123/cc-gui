// r120 界面验收夹具:隔离 HOME + 一个能被侧栏认出来的会话 + 一个工作目录。
// 依据只有 .devflow/BRIEF-r120.md 与 .devflow/INTERFACE-r120.md;没看实现代码。
//   node helpers/fixtures.mjs        # run.sh 会先跑这一步(数据根由 R120_DATA_ROOT 给)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const dataRoot = () => process.env.R120_DATA_ROOT || path.join(suiteDir, '.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const workspace = () => path.join(homeDir(), 'work', 'proj');
export const encodeProjectDir = (p) => p.replace(/[^A-Za-z0-9]/g, '-');

/** 夹具会话:侧栏搜索用的标记 + 合法十六进制 UUID。 */
export const SESSION = { sid: 'a1200000-0000-4000-8000-000000000001', mark: 'R120CHECK' };
/** 大目录会话:工作目录 = <home>/work/big(超阈值)。b1 供 B3 直调接口用;
 *  b2/b3 各供 R7 的一个分支用 —— "每会话只问一次",两个分支必须用不同会话,否则第二条问不出来。 */
export const BIG_SESSION = { sid: 'b1200000-0000-4000-8000-0000000000b1', mark: 'R120BIGMARK' };
export const BIG_NOSAVE = { sid: 'b1200000-0000-4000-8000-0000000000b2', mark: 'R120BIGNOSAVE' };
export const BIG_SAVE = { sid: 'b1200000-0000-4000-8000-0000000000b3', mark: 'R120BIGSAVE' };
export const bigDir = () => path.join(homeDir(), 'work', 'big');

/** 写一条能被侧栏认出来的历史会话(项目目录按 cwd 编码)。 */
function writeSession(home, cwd, { sid, mark, title }) {
  const proj = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(proj, { recursive: true });
  const b = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '' };
  const lines = [
    { type: 'summary', summary: mark, leafUuid: `${sid}-u1` },
    { ...b, type: 'user', uuid: `${sid}-u1`, parentUuid: null, timestamp: '2026-09-15T08:00:00.000Z', message: { role: 'user', content: title } },
    {
      ...b, type: 'assistant', uuid: `${sid}-a1`, parentUuid: `${sid}-u1`, timestamp: '2026-09-15T08:00:01.000Z',
      message: {
        id: `msg_${sid.slice(0, 8)}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: `${mark} 好的,先看一眼。` }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  ];
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return proj;
}

export function build() {
  const home = homeDir();
  const ws = workspace();
  fs.mkdirSync(path.join(home, '.claude-gui'), { recursive: true });
  // network.json 钉成回环免密:公开版会自愈成 0.0.0.0+随机密码(会写盘、会去占 6677)
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.mkdirSync(ws, { recursive: true });
  for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(ws, `note-${i}.txt`), `内容 ${i}\n`);

  const { sid, mark } = SESSION;
  const proj = writeSession(home, ws, { sid, mark, title: `${mark} 看一下这个项目的回滚点。` });
  writeSession(home, bigDir(), { sid: BIG_SESSION.sid, mark: BIG_SESSION.mark, title: `${BIG_SESSION.mark} 这是个很大的数据目录。` });
  writeSession(home, bigDir(), { sid: BIG_NOSAVE.sid, mark: BIG_NOSAVE.mark, title: `${BIG_NOSAVE.mark} 大目录,选不保存。` });
  writeSession(home, bigDir(), { sid: BIG_SAVE.sid, mark: BIG_SAVE.mark, title: `${BIG_SAVE.mark} 大目录,选保存。` });
  return { home, ws, proj, sid, mark, big: bigDir() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = build();
  console.log(`[r120] 夹具就绪:HOME=${r.home}`);
  console.log(`[r120] 工作目录=${r.ws};会话=${r.sid}(${r.mark})`);
}
