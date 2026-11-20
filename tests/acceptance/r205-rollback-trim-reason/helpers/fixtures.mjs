#!/usr/bin/env node
// r205-rollback-trim-reason 的夹具(全部落在本套件 .artifacts/runtime-data 下,不读用户 profile)。
// 后端关了目录监听(CGUI_DISABLE_FILE_WATCHER=1),所以所有用例的会话都在 run.sh 起后端「之前」一次性写好(ensureFixtures),
// 每个用例一个独立工作区 + 一条独立会话,会话号前 8 位各不相同(用例 3 按前 8 位在后端 stderr 里找那一行)。
//
// 两种会话形态:
//   plain —— 两轮对话:U1、A1、U2、A2(都是纯文字)。
//   tool  —— 用户消息 UMID 夹在「带 tool_use 的助手消息」和「对应的 tool_result」之间:
//            U1、A1、UASK、ATOOL(tool_use)、UMID(纯文字)、URES(tool_result)、AFIN。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function suitePath(...parts) { return path.join(suiteDir, ...parts); }
export function dataRoot() { return suitePath('.artifacts', 'runtime-data'); }
export function homeDir() { return path.join(dataRoot(), 'home'); }
export function guiConfigDir() { return path.join(homeDir(), '.claude-gui'); }
export function fakebinDir() { return suitePath('.artifacts', 'fakebin'); }
export function fakeCtlDir() { return path.join(homeDir(), 'fake-claude'); }
export function manifestPath() { return suitePath('.artifacts', 'fixture-manifest.json'); }
/** run.sh 把后端的标准输出 / 标准错误输出分别收集到这两个文件。 */
export function serverStderrPath() { return path.join(dataRoot(), 'server.stderr.log'); }
export function serverStdoutPath() { return path.join(dataRoot(), 'server.stdout.log'); }

// 工作区放系统临时目录(macOS 上是 /private/var/folders/…/T)的物理路径下:不能放 /tmp、/private/tmp,也不能在路径含 .claude/worktrees/ 的目录下,否则侧栏不列。
export function workspaceDir(tag) { return path.join(fs.realpathSync(os.tmpdir()), `r205-ws-${tag}`); }
const encodeProjectDir = (cwd) => cwd.replace(/[/\\]/g, '-');
export function projectDir(tag) { return path.join(homeDir(), '.claude', 'projects', encodeProjectDir(workspaceDir(tag))); }

/** settings.json 里的默认模型。 */
export const D = 'claude-opus-4-6';
export const SEED = { sid: '5a050000-0000-4000-8000-000000000000', marker: 'R205SEEDX', tag: 'seed', shape: 'plain' };

// 每个用例一条会话。sid 前 8 位互不相同。marker 出现在会话标题与每条用户消息里。
export const CASES = {
  c1: { tag: 'c1', shape: 'plain', sid: '5a050001-0000-4000-8000-000000000001', marker: 'R205C1' },
  c2: { tag: 'c2', shape: 'tool', sid: '5a050002-0000-4000-8000-000000000002', marker: 'R205C2' },
  c3a: { tag: 'c3a', shape: 'plain', sid: '5a050003-0000-4000-8000-000000000003', marker: 'R205C3A' },
  c3b: { tag: 'c3b', shape: 'tool', sid: '5a050004-0000-4000-8000-000000000004', marker: 'R205C3B' },
  c4: { tag: 'c4', shape: 'plain', sid: '5a050005-0000-4000-8000-000000000005', marker: 'R205C4' },
};
for (const c of Object.values(CASES)) {
  c.workspace = workspaceDir(c.tag);
  c.workspaceName = `r205-ws-${c.tag}`;
  c.file = path.join(projectDir(c.tag), `${c.sid}.jsonl`);
  // 要对它点「回退」的那条用户消息(plain 形态是 U2;tool 形态是夹在中间的 UMID)。正文唯一,页面上按它定位。
  c.targetText = c.shape === 'tool' ? `${c.marker} 夹在工具调用中间的用户消息` : `${c.marker} 第二条用户消息`;
}

const ISO = (min, sec = 0) => new Date(Date.UTC(2026, 10, 19, 9, min, sec)).toISOString();
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };

/** 按形态生成会话文件的各行(摘要行 + 记录行,parentUuid 串成一条链)。 */
function buildLines(c) {
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: c.workspace, sessionId: c.sid, version: '2.1.322', gitBranch: '' };
  let n = 0;
  let prev = null;
  let sec = 0;
  const nextId = (kind) => `${kind}-${c.tag}-${(n += 1)}`;
  const user = (content) => {
    const uuid = nextId('u');
    const rec = { ...base, parentUuid: prev, promptId: `r205-${c.tag}`, type: 'user', isMeta: false, message: { role: 'user', content }, uuid, timestamp: ISO(1, (sec += 1)), permissionMode: 'default', promptSource: 'sdk' };
    prev = uuid;
    return rec;
  };
  const assistant = (content, stop) => {
    const uuid = nextId('a');
    const rec = {
      ...base, parentUuid: prev, type: 'assistant', uuid, timestamp: ISO(1, (sec += 1)), effort: 'high', requestId: `req_${uuid}`,
      message: { model: D, id: `msg_${c.tag}_${n}`, type: 'message', role: 'assistant', content, stop_reason: stop, stop_sequence: null, stop_details: null, usage: USAGE },
    };
    prev = uuid;
    return rec;
  };
  const lines = [{ type: 'summary', summary: `${c.marker} 会话`, leafUuid: 'leaf-pending' }];
  if (c.shape === 'plain') {
    lines.push(user(`${c.marker} 第一条用户消息`));
    lines.push(assistant([{ type: 'text', text: 'R205 回复一。' }], 'end_turn'));
    lines.push(user(c.targetText));
    lines.push(assistant([{ type: 'text', text: 'R205 回复二。' }], 'end_turn'));
  } else {
    const toolId = `toolu_r205_${c.tag}`;
    lines.push(user(`${c.marker} 第一条用户消息`));
    lines.push(assistant([{ type: 'text', text: 'R205 回复一。' }], 'end_turn'));
    lines.push(user(`${c.marker} 请执行一个命令`));
    lines.push(assistant([{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'echo r205' } }], 'tool_use'));
    lines.push(user(c.targetText)); // ← 夹在 tool_use 和它的 tool_result 之间
    lines.push(user([{ type: 'tool_result', tool_use_id: toolId, content: 'r205', is_error: false }]));
    lines.push(assistant([{ type: 'text', text: 'R205 命令执行完了。' }], 'end_turn'));
  }
  lines[0].leafUuid = prev;
  return lines;
}

export function writeSession(c) {
  fs.mkdirSync(c.workspace, { recursive: true });
  fs.mkdirSync(path.dirname(c.file), { recursive: true });
  fs.writeFileSync(c.file, `${buildLines(c).map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** 会话文件当前的全部内容(字符串)。 */
export function readTranscript(c) { return fs.readFileSync(c.file, 'utf8'); }

/** 从会话文件里删掉「用户消息正文含 text」的那一行(只改文件,不碰别的),返回删掉的行数。 */
export function deleteUserLineContaining(c, text) {
  const kept = [];
  let removed = 0;
  for (const line of readTranscript(c).split('\n')) {
    if (!line.trim()) continue;
    let o = null;
    try { o = JSON.parse(line); } catch { /* 保留 */ }
    const hit = o && o.type === 'user' && o.message && typeof o.message.content === 'string' && o.message.content.includes(text);
    if (hit) removed += 1; else kept.push(line);
  }
  fs.writeFileSync(c.file, `${kept.join('\n')}\n`);
  return removed;
}

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
  writeSession({ ...SEED, workspace: workspaceDir('seed'), file: path.join(projectDir('seed'), `${SEED.sid}.jsonl`), targetText: `${SEED.marker} 第二条用户消息` });
  for (const c of Object.values(CASES)) writeSession(c);
  const manifest = { dataRoot: dataRoot(), home: homeDir(), fakebin: fakebinDir(), seed: SEED, cases: Object.keys(CASES) };
  fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
  fs.writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(ensureFixtures(), null, 2)}\n`);
}
