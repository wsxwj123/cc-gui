#!/usr/bin/env node
// r202-split-home-model 的夹具(全部落在本套件 .artifacts/runtime-data 下,不读用户 profile)。
// 基础夹具(run.sh 起后端前跑一次):首启浮层「已看过」、settings.json(官方形态,默认模型 D)、PATH 上的假 claude、一条预检种子会话。
// 每个用例用 seedWorkspace() 现建全新工作区,里面只放一条带本用例独有标记的会话 S(一轮完整历史,assistant 的 model = D)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function suitePath(...parts) { return path.join(suiteDir, ...parts); }
export function dataRoot() { return suitePath('.artifacts', 'runtime-data'); }
export function homeDir() { return path.join(dataRoot(), 'home'); }
export function guiConfigDir() { return path.join(homeDir(), '.claude-gui'); }
// 工作区放系统临时目录(macOS 上是 /private/var/folders/…/T)的物理路径下:不能放 /tmp、/private/tmp,也不能在路径含 .claude/worktrees/ 的目录下,否则侧栏不列。
export function workspaceDir(tag = 'seed') { return path.join(fs.realpathSync(os.tmpdir()), `r202-ws-${tag}`); }
export function fakebinDir() { return suitePath('.artifacts', 'fakebin'); }
export function fakeCtlDir() { return path.join(homeDir(), 'fake-claude'); }
export function manifestPath() { return suitePath('.artifacts', 'fixture-manifest.json'); }
export function msgLogPath() { return path.join(fakeCtlDir(), 'messages.jsonl'); }

/** settings.json 里的默认模型 D(一个具体 id)。 */
export const D = 'claude-opus-4-6';
export const SEED = { sid: 'a2020000-0000-4000-8000-000000000001', marker: 'R202SEEDX' };

const ISO = (min, sec = 0) => new Date(Date.UTC(2026, 10, 19, 9, min, sec)).toISOString();
const encodeProjectDir = (cwd) => cwd.replace(/[/\\]/g, '-');
export function projectDir(tag = 'seed') { return path.join(homeDir(), '.claude', 'projects', encodeProjectDir(workspaceDir(tag))); }
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };

/** 写一条「一轮完整历史」的会话文件(摘要行 + user 行 + assistant 行,assistant.message.model = D)。 */
function writeHistorySession({ sid, marker, label, minute, tag }) {
  const cwd = workspaceDir(tag);
  fs.mkdirSync(cwd, { recursive: true });
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.322', gitBranch: '' };
  const lines = [
    { type: 'summary', summary: `${marker} ${label}`, leafUuid: `leaf-${sid}` },
    { ...base, parentUuid: null, promptId: 'r202-prompt', type: 'user', isMeta: false, message: { role: 'user', content: `${marker} 历史第 1 条` }, uuid: `u-${sid}`, timestamp: ISO(minute), permissionMode: 'default', promptSource: 'sdk' },
    {
      ...base, parentUuid: `u-${sid}`, type: 'assistant', uuid: `a-${sid}`, timestamp: ISO(minute, 1), effort: 'high', requestId: `req_${sid}`,
      message: { model: D, id: `hist_${sid.slice(-12)}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'R202 历史回复。' }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: USAGE },
    },
  ];
  fs.mkdirSync(projectDir(tag), { recursive: true });
  fs.writeFileSync(path.join(projectDir(tag), `${sid}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** 现建一个全新的工作区(只含会话 S)。tag 必须每个用例每次运行都不同。 */
export function seedWorkspace(tag) {
  const hex = (s) => Buffer.from(s).toString('hex').padEnd(12, '0').slice(0, 12);
  const seed = { sid: `a2020001-0000-4000-8000-${hex(`s${tag}`)}`, marker: `R202S${tag}` };
  writeHistorySession({ ...seed, label: '会话S', minute: 1, tag });
  return { seed, tag, workspace: workspaceDir(tag), workspaceName: `r202-ws-${tag}` };
}

/** 假命令行的收信日志:{kind:'msg', text, model, effort, cwd} / {kind:'done', text}。按「正文含 marker」过滤。 */
function readLog() {
  try { return fs.readFileSync(msgLogPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
export function receivedMsgs(marker) { return readLog().filter((e) => e.kind === 'msg' && String(e.text).includes(marker)); }
export function doneMsgs(marker) { return readLog().filter((e) => e.kind === 'done' && String(e.text).includes(marker)); }

/** 首启浮层的「已看过」(与被测行为无关)。 */
function writeOverlayState() {
  const version = JSON.parse(fs.readFileSync(suitePath('..', '..', '..', 'package.json'), 'utf8')).version;
  fs.mkdirSync(guiConfigDir(), { recursive: true });
  fs.writeFileSync(path.join(guiConfigDir(), 'prefs.json'), `${JSON.stringify({ releaseNotesSeen: version })}\n`);
  fs.writeFileSync(path.join(guiConfigDir(), 'permission-guide-shown.flag'), `${new Date().toISOString()}\n`);
}

/** 隔离家目录下的 ~/.claude/settings.json:官方形态,默认模型 D(不设 ANTHROPIC_BASE_URL)。 */
function writeSettings() {
  const dir = path.join(homeDir(), '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), `${JSON.stringify({ model: D, env: { ANTHROPIC_MODEL: D } }, null, 2)}\n`);
}

/** PATH 上的假 claude:一个 shell 薄壳,转交给本套件 helpers/fake-claude.mjs。 */
function writeFakeClaudeShim() {
  fs.mkdirSync(fakebinDir(), { recursive: true });
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(suiteDir, 'helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
}

export function ensureFixtures() {
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  writeOverlayState();
  writeSettings();
  writeFakeClaudeShim();
  writeHistorySession({ ...SEED, label: '预检种子', minute: 0, tag: 'seed' });
  const manifest = { dataRoot: dataRoot(), home: homeDir(), workspace: workspaceDir('seed'), fakebin: fakebinDir(), seed: SEED };
  fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
  fs.writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(ensureFixtures(), null, 2)}\n`);
}
