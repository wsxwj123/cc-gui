// r151a 夹具:一个临时 HOME(不碰真实的 ~/.claude、~/.claude-gui)+ 假 claude 的控制目录 + 工作区。
// run.sh 在起实例之前跑一次 buildFixtures();用例运行时按需用这里的路径工具摆场景。
// 结构参照 r150-plugins / r149-storage 的同名文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R151A_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const ctlDir = () => process.env.R151A_CTL || path.join(homeDir(), 'fake-claude');
export const fakebinDir = () => suitePath('.artifacts', 'fakebin');
export const mockDir = () => path.join(dataRoot(), 'mock');
/** 工作区根:必须在工作树里(放在 /private/tmp 下的项目不进侧栏列表)。 */
export const wsRoot = () => path.join(dataRoot(), 'ws');
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

export const GUI_DIR = () => path.join(homeDir(), '.claude-gui');
export const CLAUDE_DIR = () => path.join(homeDir(), '.claude');
export const PREFS = () => path.join(GUI_DIR(), 'prefs.json');
export const OVERRIDES = () => path.join(GUI_DIR(), 'provider-overrides.json');
export const CUSTOM_PROVIDERS = () => path.join(GUI_DIR(), 'custom-providers.json');
export const ACTIVE_PROVIDER = () => path.join(GUI_DIR(), 'active-provider.json');
export const SETTINGS = () => path.join(CLAUDE_DIR(), 'settings.json');

export function buildFixtures() {
  const home = homeDir();
  for (const d of [GUI_DIR(), CLAUDE_DIR(), ctlDir(), path.join(ctlDir(), 'scripts'), fakebinDir(), mockDir(), wsRoot()]) fs.mkdirSync(d, { recursive: true });
  // 首启浮层预置成"已看过"(与被测行为无关),网络钉回环(公开版首启会自愈成 0.0.0.0)
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(PREFS(), JSON.stringify({ releaseNotesSeen: version }, null, 2));
  fs.writeFileSync(path.join(GUI_DIR(), 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(GUI_DIR(), 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.writeFileSync(SETTINGS(), JSON.stringify({ env: {} }, null, 2));
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${suitePath('helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return { home };
}

/** 建一个工作区目录(每个用例用自己的,互不串)并返回真实路径。 */
export function makeWorkspace(name) {
  const dir = path.join(wsRoot(), name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

/** 在工作区里落一条历史会话(侧栏搜索用标记找得到它),返回 { sid, cwd, mark }。 */
export function seedSession(name, sid, mark) {
  const cwd = makeWorkspace(name);
  const proj = path.join(CLAUDE_DIR(), 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(proj, { recursive: true });
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.296', gitBranch: '' };
  const lines = [
    { type: 'summary', summary: `${mark} 先来一句话`, leafUuid: `${sid}-u0` },
    { ...base, type: 'user', uuid: `${sid}-u0`, parentUuid: null, timestamp: '2026-10-01T08:00:00.000Z', message: { role: 'user', content: `${mark} 先来一句话` } },
    { ...base, type: 'assistant', uuid: `${sid}-a1`, parentUuid: `${sid}-u0`, timestamp: '2026-10-01T08:00:01.000Z', requestId: `req_${sid.slice(0, 8)}`,
      message: { id: `msg_${sid.slice(0, 8)}`, type: 'message', role: 'assistant', model: 'r151-chat', content: [{ type: 'text', text: `${mark} 这是已有的旧回复。` }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { sid, cwd, mark };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildFixtures();
  console.log(`[r151a] 夹具就绪:HOME=${r.home}`);
}
