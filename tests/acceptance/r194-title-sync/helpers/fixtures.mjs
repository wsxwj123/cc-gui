#!/usr/bin/env node
// r194-title-sync 的夹具(全部落在本套件 .artifacts/runtime-data 下,不读用户 profile)。
// run-isolated.sh 起后端前跑一次:首启浮层「已看过」+ 每条用例各自独立的工作区与会话记录 + 偏好文件里的名字 + PATH 上的假 claude。
// 工作区放系统临时目录的真实路径下(不放 /tmp、/private/tmp,也不放本工作树里,否则侧栏不列)。
// 名字都带「用例编号 + 本次运行随机串」,所以「乙」出现过就是出现过,不会和别的用例、别的运行混。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function suitePath(...parts) { return path.join(suiteDir, ...parts); }
export function dataRoot() { return suitePath('.artifacts', 'runtime-data'); }
export function homeDir() { return path.join(dataRoot(), 'home'); }
export function guiConfigDir() { return path.join(homeDir(), '.claude-gui'); }
export function fakebinDir() { return suitePath('.artifacts', 'fakebin'); }
export function fakeCtlDir() { return path.join(homeDir(), 'fake-claude'); }
export function manifestPath() { return suitePath('.artifacts', 'fixture-manifest.json'); }
export function scenarioPath() { return path.join(fakeCtlDir(), 'scenario.json'); }
export function statusPath(workspaceName) { return path.join(fakeCtlDir(), `status-${workspaceName}.json`); }

// 与 Claude Code 一致:工作区绝对路径里所有不是英文字母或数字的字符换成 '-'。
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

export const CASE_IDS = ['t1', 't2', 't3', 't4w', 't4n', 't5w', 't5n', 't6', 't7', 't8'];
const ISO = (min, sec = 0) => new Date(Date.UTC(2026, 10, 18, 9, min, sec)).toISOString();
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };

function writeTranscript({ cwd, sid, userText, answerText, customTitle, withQueueOps }) {
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.322', gitBranch: '' };
  const lines = [];
  if (withQueueOps) {
    lines.push({ type: 'queue-operation', operation: 'enqueue', timestamp: ISO(1), sessionId: sid, content: userText });
    lines.push({ type: 'queue-operation', operation: 'dequeue', timestamp: ISO(1), sessionId: sid });
  }
  lines.push({ ...base, parentUuid: null, promptId: 'r194-prompt', type: 'user', isMeta: false, message: { role: 'user', content: userText }, uuid: `u-${sid}`, timestamp: ISO(2), permissionMode: 'default', promptSource: 'sdk' });
  lines.push({
    ...base, parentUuid: `u-${sid}`, type: 'assistant', uuid: `a-${sid}`, timestamp: ISO(2, 1), effort: 'high', requestId: `req_${sid}`,
    message: { model: 'claude-sonnet-4-6', id: `hist_${sid.slice(-12)}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: answerText }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: USAGE },
  });
  if (customTitle) lines.push({ type: 'custom-title', customTitle, sessionId: sid });
  const dir = path.join(homeDir(), '.claude', 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return path.join(dir, `${sid}.jsonl`);
}

/** 生成全部用例的夹具,返回清单。 */
export function buildCases(nonce) {
  const real = fs.realpathSync(os.tmpdir());
  const customTitles = {};
  const cases = {};
  for (const id of CASE_IDS) {
    const k = `${id}${nonce}`;
    const c = {
      id,
      jia: `甲${k}`, // 会话记录里的名字
      yi: `乙${k}`, // 偏好里记的名字
      bing: `丙${k}`, // 行菜单改名后的名字
      ding: `丁${k}`, // 铅笔改名后的名字
      branch: `甲${k}分支1`,
      wsA: path.join(real, `r194-wa-${k}`),
      wsB: path.join(real, `r194-wb-${k}`),
      sidS: crypto.randomUUID(),
      sidT: crypto.randomUUID(),
      tMarker: `T问${k}`,
    };
    c.wsAName = path.basename(c.wsA);
    c.wsBName = path.basename(c.wsB);
    if (id === 't6') {
      // 会话 R:会话记录里没有名字,偏好里记的名字「乙二」
      c.yi2 = `乙二${k}`;
      c.fileS = writeTranscript({ cwd: c.wsA, sid: c.sidS, userText: `R问${k}`, answerText: 'R194 历史回复。', customTitle: null, withQueueOps: true });
      customTitles[c.sidS] = c.yi2;
    } else {
      c.fileS = writeTranscript({ cwd: c.wsA, sid: c.sidS, userText: `S问${k}`, answerText: 'R194 历史回复。', customTitle: c.jia, withQueueOps: false });
      customTitles[c.sidS] = c.yi;
    }
    if (['t1', 't2', 't3', 't6'].includes(id)) {
      writeTranscript({ cwd: c.wsB, sid: c.sidT, userText: c.tMarker, answerText: 'R194 历史回复。', customTitle: null, withQueueOps: true });
    }
    cases[id] = c;
  }
  return { cases, customTitles };
}

function writeOverlayStateAndPrefs(customTitles) {
  const version = JSON.parse(fs.readFileSync(suitePath('..', '..', '..', 'package.json'), 'utf8')).version;
  fs.mkdirSync(guiConfigDir(), { recursive: true });
  fs.writeFileSync(path.join(guiConfigDir(), 'prefs.json'), `${JSON.stringify({ releaseNotesSeen: version, customTitles })}\n`);
  fs.writeFileSync(path.join(guiConfigDir(), 'permission-guide-shown.flag'), `${new Date().toISOString()}\n`);
}

/** PATH 上的假 claude:一个 shell 薄壳,转交给本套件 helpers/fake-claude.mjs。 */
function writeFakeClaudeShim() {
  fs.mkdirSync(fakebinDir(), { recursive: true });
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(suiteDir, 'helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
}

/** 场景文件:{ "<工作区目录名>": { holdSec: N } }。没写的工作区,每条用户消息立即正常结束。 */
export function setHold(workspaceName, holdSec) {
  let sc = {};
  try { sc = JSON.parse(fs.readFileSync(scenarioPath(), 'utf8')); } catch { /* 没有就从空开始 */ }
  sc[workspaceName] = { holdSec };
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  const tmp = `${scenarioPath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(sc)}\n`);
  fs.renameSync(tmp, scenarioPath());
}
/** 读夹具状态文件;读不到(正在被原子替换的瞬间)返回 null。 */
export function readStatus(workspaceName) {
  try { return JSON.parse(fs.readFileSync(statusPath(workspaceName), 'utf8')); } catch { return null; }
}

export function ensureFixtures() {
  const nonce = crypto.randomBytes(3).toString('hex');
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  fs.writeFileSync(scenarioPath(), '{}\n');
  writeFakeClaudeShim();
  const { cases, customTitles } = buildCases(nonce);
  writeOverlayStateAndPrefs(customTitles);
  // 预检用的种子:t4n 的 S 会话里的问句(全文搜索能搜到)
  const manifest = { nonce, dataRoot: dataRoot(), home: homeDir(), fakebin: fakebinDir(), seedMarker: `S问t4n${nonce}`, cases };
  fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
  fs.writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(ensureFixtures(), null, 2)}\n`);
}
