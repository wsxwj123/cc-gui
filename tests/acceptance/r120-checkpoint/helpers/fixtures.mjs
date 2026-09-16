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

export function build() {
  const home = homeDir();
  const ws = workspace();
  fs.mkdirSync(path.join(home, '.claude-gui'), { recursive: true });
  // network.json 钉成回环免密:公开版会自愈成 0.0.0.0+随机密码(会写盘、会去占 6677)
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.mkdirSync(ws, { recursive: true });
  for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(ws, `note-${i}.txt`), `内容 ${i}\n`);

  const { sid, mark } = SESSION;
  const proj = path.join(home, '.claude', 'projects', encodeProjectDir(ws));
  fs.mkdirSync(proj, { recursive: true });
  const b = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: ws, sessionId: sid, version: '2.1.267', gitBranch: '' };
  const lines = [
    { type: 'summary', summary: mark, leafUuid: `${sid}-u1` },
    { ...b, type: 'user', uuid: `${sid}-u1`, parentUuid: null, timestamp: '2026-09-15T08:00:00.000Z', message: { role: 'user', content: `${mark} 看一下这个项目的回滚点。` } },
    {
      ...b, type: 'assistant', uuid: `${sid}-a1`, parentUuid: `${sid}-u1`, timestamp: '2026-09-15T08:00:01.000Z',
      message: {
        id: 'msg_r120_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: `${mark} 好的,先看一眼。` }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  ];
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { home, ws, proj, sid, mark };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = build();
  console.log(`[r120] 夹具就绪:HOME=${r.home}`);
  console.log(`[r120] 工作目录=${r.ws};会话=${r.sid}(${r.mark})`);
}
