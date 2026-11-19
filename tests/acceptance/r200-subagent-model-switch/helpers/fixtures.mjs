#!/usr/bin/env node
// r200-subagent-model-switch 的夹具(全部落在本套件 .artifacts/runtime-data 与系统临时目录下,不读用户 profile)。
// 基础夹具(run-isolated.sh 起后端前跑一次):首启浮层「已看过」、PATH 上的假 claude、一条种子会话(供预检)。
// 每个用例自己建一个全新工作区:
//   seedWorkspace(tag)        只放一条普通历史会话(直播用例:点开它再「新建会话」,由假命令行跑一回合)
//   seedStatic(tag, opts)     直接把「主会话 + 子代理转写」铺成文件(历史用例:等价于假命令行早就把转写写好,再刷新页面打开)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { subIds, writeSubagentFiles, mainFallbackRecord } from './transcripts.mjs';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function suitePath(...parts) { return path.join(suiteDir, ...parts); }
export function dataRoot() { return suitePath('.artifacts', 'runtime-data'); }
export function homeDir() { return path.join(dataRoot(), 'home'); }
export function guiConfigDir() { return path.join(homeDir(), '.claude-gui'); }
// 工作区不能放 /tmp、/private/tmp 下(应用不列),也不能放在工作树里:用系统临时目录(物理路径)下的 r200-ws-<标记>。
export function workspaceDir(tag = 'seed') { return path.join(fs.realpathSync(os.tmpdir()), `r200-ws-${tag}`); }
export function fakebinDir() { return suitePath('.artifacts', 'fakebin'); }
export function fakeCtlDir() { return path.join(homeDir(), 'fake-claude'); }
export function manifestPath() { return suitePath('.artifacts', 'fixture-manifest.json'); }
export function scenarioPath(workspaceName) { return path.join(fakeCtlDir(), `scenario-${workspaceName}.json`); }

export const SEED = { sid: 'a2000000-0000-4000-8000-000000000001', marker: 'R200SEEDX' };

const encodeProjectDir = (cwd) => cwd.replace(/[/\\]/g, '-');
export function projectDir(tag = 'seed') { return path.join(homeDir(), '.claude', 'projects', encodeProjectDir(workspaceDir(tag))); }
const iso = (offsetSec) => new Date(Date.now() - 900_000 + offsetSec * 1000).toISOString();
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const sidFor = (tag, n) => `a200${n}000-0000-4000-8000-${crypto.createHash('sha1').update(`s${tag}${n}`).digest('hex').slice(0, 12)}`;

function baseOf(cwd, sid) { return { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.328', gitBranch: '' }; }
function writeLines(file, lines) {
  // 会话文件里记的工作目录(cwd)必须真实存在,否则侧栏不列这个工作区
  const cwd = lines.find((l) => l && l.cwd)?.cwd;
  if (cwd) fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}
function asstMsg(id, model, content, stop = 'end_turn') {
  return { model, id, type: 'message', role: 'assistant', content, stop_reason: stop, stop_sequence: null, stop_details: null, usage: USAGE };
}

/** 一条「一轮完整历史」的普通会话(供侧栏出现工作区)。 */
function writeHistorySession({ sid, marker, tag, minute }) {
  const cwd = workspaceDir(tag);
  const base = baseOf(cwd, sid);
  const lines = [
    { type: 'summary', summary: `${marker} 种子`, leafUuid: `leaf-${sid}` },
    { ...base, parentUuid: null, promptId: 'r200-prompt', type: 'user', isMeta: false, message: { role: 'user', content: `${marker} 历史第 1 条` }, uuid: `u-${sid}`, timestamp: iso(minute), permissionMode: 'default', promptSource: 'sdk' },
    { ...base, parentUuid: `u-${sid}`, type: 'assistant', uuid: `a-${sid}`, timestamp: iso(minute + 1), effort: 'high', requestId: `req_${sid}`, message: asstMsg(`hist_${sid.slice(-12)}`, 'claude-sonnet-4-6', [{ type: 'text', text: 'R200 历史回复。' }]) },
  ];
  writeLines(path.join(projectDir(tag), `${sid}.jsonl`), lines);
}

/** 直播用例的工作区:只含一条种子历史会话。 */
export function seedWorkspace(tag) {
  const seed = { sid: sidFor(tag, 1), marker: `R200S${tag}` };
  writeHistorySession({ ...seed, tag, minute: 1 });
  return { seed, tag, workspace: workspaceDir(tag), workspaceName: `r200-ws-${tag}`, ...subIds(tag) };
}

/**
 * 历史用例:把主会话与子代理转写直接铺好。
 *   kind: 'sub'(主会话派出一个子代理,前台,即 Agent 调用不带 run_in_background)| 'main-switch'(主会话里有落盘的换模型通知)| 'main-plain'(没有换模型通知)
 *   sub 参数: { models, format, refuse, synthetic, usage, metaModel }
 *   category: 主会话换模型通知的类别('bio' | null = 没有类别)
 */
export function seedStatic(tag, { kind = 'sub', sub = {}, category = 'bio' } = {}) {
  const sid = sidFor(tag, 2);
  const marker = `R200H${tag}`;
  const ids = subIds(tag);
  const cwd = workspaceDir(tag);
  const base = baseOf(cwd, sid);
  const pdir = projectDir(tag);
  const lines = [{ type: 'summary', summary: `${marker} 静态会话`, leafUuid: `leaf-${sid}` }];
  let prev = null;
  const add = (rec, offset) => { const uuid = crypto.randomUUID(); lines.push({ ...base, parentUuid: prev, ...rec, uuid, timestamp: iso(offset) }); prev = uuid; return uuid; };
  const userUuid = add({ promptId: 'r200-prompt', type: 'user', isMeta: false, message: { role: 'user', content: `${marker} 请开始` }, permissionMode: 'default', promptSource: 'sdk' }, 1);
  let doneText = 'R200-MAIN-DONE';
  if (kind === 'sub') {
    const models = sub.models || ['claude-opus-5'];
    const toolUse = { type: 'tool_use', id: ids.toolUseId, name: 'Agent', input: { description: ids.description, prompt: ids.prompt, subagent_type: 'general-purpose', run_in_background: false } };
    add({ type: 'assistant', effort: 'high', requestId: 'req_r200_m1', message: asstMsg(`msg_r200_${tag}_m1`, 'claude-opus-5', [toolUse], 'tool_use') }, 2);
    add({
      type: 'user', message: { role: 'user', content: [{ tool_use_id: ids.toolUseId, type: 'tool_result', content: [{ type: 'text', text: 'R200-SUB-RESULT' }] }] },
      sourceToolAssistantUUID: null,
      toolUseResult: { status: 'completed', agentId: ids.agentId, agentType: 'general-purpose', content: [{ type: 'text', text: 'R200-SUB-RESULT' }], resolvedModel: models[models.length - 1] },
    }, 20);
    add({ type: 'assistant', effort: 'high', requestId: 'req_r200_m2', message: asstMsg(`msg_r200_${tag}_m2`, 'claude-opus-5', [{ type: 'text', text: doneText }]) }, 21);
    writeSubagentFiles({ projectDir: pdir, sid, tag, models, format: sub.format || 'new', refuse: sub.refuse || null, synthetic: Boolean(sub.synthetic), usage: sub.usage, metaModel: sub.metaModel || 'opus' });
  } else {
    doneText = 'R200-AFTER';
    add({ type: 'assistant', effort: 'high', requestId: 'req_r200_b', message: asstMsg(`msg_r200_${tag}_b`, 'claude-opus-5-5', [{ type: 'text', text: 'R200-BEFORE' }]) }, 2);
    if (kind === 'main-switch') {
      const rec = mainFallbackRecord({ sid, cwd, parentUuid: prev, refusedUserMessageUuid: userUuid, category });
      lines.push(rec);
      prev = rec.uuid;
    }
    add({ type: 'assistant', effort: 'high', requestId: 'req_r200_a', message: asstMsg(`msg_r200_${tag}_a`, kind === 'main-switch' ? 'claude-opus-5' : 'claude-opus-5-5', [{ type: 'text', text: doneText }]) }, 41);
  }
  writeLines(path.join(pdir, `${sid}.jsonl`), lines);
  return { seed: { sid, marker }, tag, workspace: cwd, workspaceName: `r200-ws-${tag}`, doneText, ...ids };
}

/** 场景文件(假命令行每收到一条用户消息读一次)。 */
export function writeScenario(workspaceName, scenario) {
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  fs.writeFileSync(scenarioPath(workspaceName), `${JSON.stringify(scenario)}\n`);
}

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
  writeHistorySession({ ...SEED, tag: 'seed', minute: 0 });
  writeScenario('r200-ws-seed', { form: 'normal', text: '好的' });
  const manifest = { dataRoot: dataRoot(), home: homeDir(), workspace: workspaceDir('seed'), fakebin: fakebinDir(), seed: SEED };
  fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
  fs.writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(ensureFixtures(), null, 2)}\n`);
}
