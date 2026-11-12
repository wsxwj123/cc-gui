// r176-api-error-actions 的夹具(全部落在本套件 .artifacts/runtime-data 下,不读用户 profile)。
// 只放一条很短的历史会话:让夹具工作区出现在侧栏里(用例从它那里「新建会话」,这样新会话的工作目录是固定的)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function suitePath(...parts) { return path.join(suiteDir, ...parts); }
export function dataRoot() { return suitePath('.artifacts', 'runtime-data'); }
export function homeDir() { return path.join(dataRoot(), 'home'); }
export function guiConfigDir() { return path.join(homeDir(), '.claude-gui'); }
export function workspaceDir() { return path.join(dataRoot(), 'fixture-workspace'); }
export function fakebinDir() { return suitePath('.artifacts', 'fakebin'); }
export function fakeCtlDir() { return path.join(homeDir(), 'fake-claude'); }
export function manifestPath() { return suitePath('.artifacts', 'fixture-manifest.json'); }

export const SEED = { sid: 'a1760001-0000-4000-8000-000000000001', marker: 'R176SEEDX' };

const ISO = (min, sec = 0) => new Date(Date.UTC(2026, 10, 7, 9, min, sec)).toISOString();
const encodeProjectDir = (cwd) => cwd.replace(/[/\\]/g, '-');
export function projectDir() { return path.join(homeDir(), '.claude', 'projects', encodeProjectDir(workspaceDir())); }
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };

function writeSeedSession() {
  const { sid, marker } = SEED;
  const cwd = workspaceDir();
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.322', gitBranch: '' };
  const lines = [
    { type: 'summary', summary: `${marker} r176 夹具`, leafUuid: 'r176-leaf-seed' },
    { ...base, parentUuid: null, promptId: 'r176-prompt', type: 'user', isMeta: false, message: { role: 'user', content: `${marker} 历史第 1 条` }, uuid: 'r176-u-seed', timestamp: ISO(0), permissionMode: 'default', promptSource: 'sdk' },
    {
      ...base, parentUuid: 'r176-u-seed', type: 'assistant', uuid: 'r176-a-seed', timestamp: ISO(0, 1), effort: 'high', requestId: 'req_r176_seed',
      message: { model: 'claude-sonnet-4-6', id: 'r176_seed', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'R176 历史回复。' }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: USAGE },
    },
  ];
  fs.mkdirSync(projectDir(), { recursive: true });
  fs.writeFileSync(path.join(projectDir(), `${sid}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** 首启浮层的「已看过」(与被测行为无关)。 */
function writeOverlayState() {
  const version = JSON.parse(fs.readFileSync(suitePath('..', '..', '..', 'package.json'), 'utf8')).version;
  fs.mkdirSync(guiConfigDir(), { recursive: true });
  fs.writeFileSync(path.join(guiConfigDir(), 'prefs.json'), `${JSON.stringify({ releaseNotesSeen: version })}\n`);
  fs.writeFileSync(path.join(guiConfigDir(), 'permission-guide-shown.flag'), `${new Date().toISOString()}\n`);
}

/** PATH 上的假 claude:一个 shell 薄壳,转交给本套件 helpers/fake-claude.mjs。 */
function writeFakeClaudeShim() {
  fs.mkdirSync(fakebinDir(), { recursive: true });
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(suiteDir, 'helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
}

export function ensureFixtures() {
  fs.mkdirSync(workspaceDir(), { recursive: true });
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  writeOverlayState();
  writeFakeClaudeShim();
  writeSeedSession();
  const manifest = { dataRoot: dataRoot(), home: homeDir(), workspace: workspaceDir(), fakebin: fakebinDir(), seed: SEED };
  fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
  fs.writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(ensureFixtures(), null, 2)}\n`);
}
