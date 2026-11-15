#!/usr/bin/env node
// r191-reattach-live-text 的夹具(全部落在本套件 .artifacts/runtime-data 下,不读用户 profile)。
// 基础夹具(run-isolated.sh 起后端前跑一次):首启浮层「已看过」、PATH 上的假 claude、一个预检用的种子工作区。
// 每个用例自己再用 seedWorkspace() 现建一个全新工作区,里面预置一个种子会话:历史里有一轮已结束的回合(一句正文 R191SEED-历史回合收尾)。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function suitePath(...parts) { return path.join(suiteDir, ...parts); }
export function dataRoot() { return suitePath('.artifacts', 'runtime-data'); }
export function homeDir() { return path.join(dataRoot(), 'home'); }
export function guiConfigDir() { return path.join(homeDir(), '.claude-gui'); }
// 夹具工作区不能放在本套件所在的工作树里,也不能放 /tmp、/private/tmp 下(侧栏不列):放系统临时目录(macOS 上 /private/var/folders/…/T)下的子目录。
export function workspaceDir(tag = 'seed') { return path.join(fs.realpathSync(os.tmpdir()), `r191-ws-${tag}`); }
export function fakebinDir() { return suitePath('.artifacts', 'fakebin'); }
export function fakeCtlDir() { return path.join(homeDir(), 'fake-claude'); }
export function manifestPath() { return suitePath('.artifacts', 'fixture-manifest.json'); }
// 状态 / 写盘标志 / 收场文件都按工作区目录名分开(每个用例一个工作区,互不串)。
export function statusPath(ws) { return path.join(fakeCtlDir(), `status-${ws}.json`); }
export function writtenFlagPath(ws, name) { return path.join(fakeCtlDir(), `written-${name}-${ws}`); }
export function abortPath(ws) { return path.join(fakeCtlDir(), `abort-${ws}`); }

export const SEED = { sid: 'a1910000-0000-4000-8000-000000000001', marker: 'R191SEEDX' };

const ISO = (min, sec = 0) => new Date(Date.UTC(2026, 10, 16, 9, min, sec)).toISOString();
const encodeProjectDir = (cwd) => cwd.replace(/[/\\]/g, '-');
export function projectDir(tag = 'seed') { return path.join(homeDir(), '.claude', 'projects', encodeProjectDir(workspaceDir(tag))); }
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };

/** 写种子会话:一轮已结束的回合,一句正文。 */
function writeSeedSession({ sid, marker, tag, minute }) {
  const cwd = workspaceDir(tag);
  fs.mkdirSync(cwd, { recursive: true });
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.322', gitBranch: '' };
  const lines = [{ type: 'summary', summary: `${marker} 种子`, leafUuid: `leaf-${sid}` }];
  let prev = null;
  const push = (l) => { lines.push({ ...l, parentUuid: prev }); prev = l.uuid; };
  push({ ...base, promptId: 'r191-prompt', type: 'user', isMeta: false, message: { role: 'user', content: `${marker} 历史第 1 条` }, uuid: `u-${sid}`, timestamp: ISO(minute), permissionMode: 'default', promptSource: 'sdk' });
  push({
    ...base, type: 'assistant', uuid: `a1-${sid}`, timestamp: ISO(minute, 9), effort: 'high', requestId: 'req_seed_1',
    message: { model: 'claude-sonnet-4-6', id: `seed_1_${sid.slice(-8)}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'R191SEED-历史回合收尾。' }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: USAGE },
  });
  fs.mkdirSync(projectDir(tag), { recursive: true });
  fs.writeFileSync(path.join(projectDir(tag), `${sid}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** 现建一个全新的工作区(只含一条种子会话)。tag 必须每个用例每次运行都不同;会话号取 tag 的哈希,不同用例不会撞号。 */
export function seedWorkspace(tag) {
  const h = crypto.createHash('sha1').update(tag).digest('hex').slice(0, 12);
  const seed = { sid: `a1910001-0000-4000-8000-${h}`, marker: `R191S${tag}` };
  writeSeedSession({ ...seed, tag, minute: 1 });
  const workspaceName = `r191-ws-${tag}`;
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  return { seed, tag, workspace: workspaceDir(tag), workspaceName };
}

/** 读假命令行写的阶段文件(stage);读不到返回 null。 */
export function readStage(ws) {
  try { return JSON.parse(fs.readFileSync(statusPath(ws), 'utf8')).stage; } catch { return null; }
}
/** 夹具的某一段(P0 / P1 / P2)写盘标志在不在。 */
export function writtenFlagExists(ws, name) { return fs.existsSync(writtenFlagPath(ws, name)); }
/** 收场:放一个 abort 文件,假命令行把这一轮尽快正常收尾(免得失败用例遗留的长回合占着后端)。 */
export function abortRound(ws) { try { fs.writeFileSync(abortPath(ws), String(Date.now())); } catch { /* 忽略 */ } }

function writeOverlayState() {
  const version = JSON.parse(fs.readFileSync(suitePath('..', '..', '..', 'package.json'), 'utf8')).version;
  fs.mkdirSync(guiConfigDir(), { recursive: true });
  fs.writeFileSync(path.join(guiConfigDir(), 'prefs.json'), `${JSON.stringify({ releaseNotesSeen: version })}\n`);
  fs.writeFileSync(path.join(guiConfigDir(), 'permission-guide-shown.flag'), `${new Date().toISOString()}\n`);
}

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
  writeSeedSession({ ...SEED, tag: 'seed', minute: 0 });
  const manifest = { dataRoot: dataRoot(), home: homeDir(), workspace: workspaceDir('seed'), fakebin: fakebinDir(), seed: SEED };
  fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
  fs.writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(ensureFixtures(), null, 2)}\n`);
}
