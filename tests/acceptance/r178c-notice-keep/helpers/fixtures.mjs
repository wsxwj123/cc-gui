#!/usr/bin/env node
// r178c-notice-keep 的夹具(全部落在本套件 .artifacts/runtime-data 下,不读用户 profile)。
// 基础夹具(run-isolated.sh 起后端前跑一次):首启浮层「已看过」、PATH 上的假 claude、夹具工作区、一条种子会话(供预检)。
// 每个用例自己再用 seedWorkspace() 现建一个全新的工作区,里面只放一条带本用例独有标记的历史会话(让工作区出现在侧栏里);
// 用例在这个工作区里点「新建会话」发消息,所以新会话的工作目录 = 这个工作区。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function suitePath(...parts) { return path.join(suiteDir, ...parts); }
export function dataRoot() { return suitePath('.artifacts', 'runtime-data'); }
export function homeDir() { return path.join(dataRoot(), 'home'); }
export function guiConfigDir() { return path.join(homeDir(), '.claude-gui'); }
// 夹具工作区不能放在本套件所在的工作树里(路径含 .claude/worktrees/ 会被应用判成「工作树」,侧栏不列),
// 也不能放 /tmp、/private/tmp 下(同样不列):放系统临时目录(macOS 上是 /private/var/folders/…/T)下的 r178c-ws-<标记> 子目录。
export function workspaceDir(tag = 'seed') { return path.join(fs.realpathSync(os.tmpdir()), `r178c-ws-${tag}`); }
export function fakebinDir() { return suitePath('.artifacts', 'fakebin'); }
export function fakeCtlDir() { return path.join(homeDir(), 'fake-claude'); }
export function manifestPath() { return suitePath('.artifacts', 'fixture-manifest.json'); }
export function scenarioPath() { return path.join(fakeCtlDir(), 'scenario.json'); }
// 状态文件按工作区目录名分开(每个用例一个独立工作区):上一个用例遗留的假命令行进程不会写乱下一个用例的读数。
export function statusPath(workspaceName = 'r178c-ws-seed') { return path.join(fakeCtlDir(), `status-${workspaceName}.json`); }

export const SEED = { sid: 'a178c000-0000-4000-8000-000000000001', marker: 'R178CSEEDX' };

const ISO = (min, sec = 0) => new Date(Date.UTC(2026, 10, 13, 9, min, sec)).toISOString();
const encodeProjectDir = (cwd) => cwd.replace(/[/\\]/g, '-');
export function projectDir(tag = 'seed') { return path.join(homeDir(), '.claude', 'projects', encodeProjectDir(workspaceDir(tag))); }
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };

/** 写一条「一轮完整历史」的会话文件(历史正文里不含 R178OK / R178CMAIN / 提示用词,免得干扰数子串)。 */
function writeHistorySession({ sid, marker, label, minute, tag }) {
  const cwd = workspaceDir(tag);
  fs.mkdirSync(cwd, { recursive: true });
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.322', gitBranch: '' };
  const lines = [
    { type: 'summary', summary: `${marker} ${label}`, leafUuid: `leaf-${sid}` },
    { ...base, parentUuid: null, promptId: 'r178c-prompt', type: 'user', isMeta: false, message: { role: 'user', content: `${marker} 历史第 1 条` }, uuid: `u-${sid}`, timestamp: ISO(minute), permissionMode: 'default', promptSource: 'sdk' },
    {
      ...base, parentUuid: `u-${sid}`, type: 'assistant', uuid: `a-${sid}`, timestamp: ISO(minute, 1), effort: 'high', requestId: `req_${sid}`,
      message: { model: 'claude-sonnet-4-6', id: `hist_${sid.slice(-12)}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'R178 历史回复。' }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: USAGE },
    },
  ];
  fs.mkdirSync(projectDir(tag), { recursive: true });
  fs.writeFileSync(path.join(projectDir(tag), `${sid}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** 现建一个全新的工作区(只含一条种子历史会话)。tag 必须每个用例每次运行都不同。 */
export function seedWorkspace(tag) {
  const hex = (s) => Buffer.from(s).toString('hex').padEnd(12, '0').slice(0, 12);
  const seed = { sid: `a178c001-0000-4000-8000-${hex(`s${tag}`)}`, marker: `R178CS${tag}` };
  writeHistorySession({ ...seed, label: '种子', minute: 1, tag });
  return { seed, tag, workspace: workspaceDir(tag), workspaceName: `r178c-ws-${tag}` };
}

/** 场景文件(假命令行每收到一条用户消息读一次)。字段见 README:{ shapes: [...] }。 */
export function writeScenario(scenario) {
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  fs.writeFileSync(scenarioPath(), `${JSON.stringify(scenario)}\n`);
}
export function resetStatus(workspaceName) {
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  fs.writeFileSync(statusPath(workspaceName), `${JSON.stringify({ received: 0, processed: 0 })}\n`);
}
/** 读夹具状态文件;读不到(正在被原子替换的瞬间)返回 null。 */
export function readStatus(workspaceName) {
  try { return JSON.parse(fs.readFileSync(statusPath(workspaceName), 'utf8')); } catch { return null; }
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
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  writeOverlayState();
  writeFakeClaudeShim();
  writeHistorySession({ ...SEED, label: '预检种子', minute: 0, tag: 'seed' });
  resetStatus('r178c-ws-seed');
  writeScenario({ shapes: ['normal'] });
  const manifest = { dataRoot: dataRoot(), home: homeDir(), workspace: workspaceDir('seed'), fakebin: fakebinDir(), seed: SEED };
  fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
  fs.writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(ensureFixtures(), null, 2)}\n`);
}
