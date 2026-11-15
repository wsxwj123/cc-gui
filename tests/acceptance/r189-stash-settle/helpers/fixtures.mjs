// r189 界面验收的夹具:隔离 HOME、夹具会话(NAV 导航用 / B 切走用 / S1..S7 各用例专用)、PATH 上的假 claude。
// 依据只有接口文件;从 r118-switch-back/helpers/fixtures.mjs 派生。
//   node helpers/fixtures.mjs     # run.sh 会先跑这一步
// 工作目录(夹具项目的 cwd)放在本套件 .artifacts 里:cwd 在 /tmp 下的项目不进侧栏。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R189_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const fakeCtlDir = () => path.join(homeDir(), 'fake-claude');
export const fakebinDir = () => suitePath('.artifacts', 'fakebin');
export const WORKSPACE_RAW = path.join(suiteDir, '.artifacts', 'runtime-data', 'fixture-workspace');
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
/** 会话记录目录(= 工作区记录目录)。 */
export const projDir = () => path.join(homeDir(), '.claude', 'projects', encodeProjectDir(fs.realpathSync(WORKSPACE_RAW)));
export const transcriptPath = (sid) => path.join(projDir(), `${sid}.jsonl`);

// 会话 id 必须是十六进制 UUID(侧栏只列合法 id 的会话)。
const sidOf = (n) => `a189${String(n).padStart(4, '0')}-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;
export const NAV = { sid: sidOf(99), mark: 'R189NAVMARK' };
export const B = { sid: sidOf(98), mark: 'R189BMARK' };
/** 第 n 个被测会话(n 从 1 起);每个用例用自己的一条,用完不复用。 */
export const S = (n) => ({ sid: sidOf(n), mark: `R189S${String(n).padStart(2, '0')}MARK` });
export const S_COUNT = 8;

// 假 CLI 在回合里吐的文字。测试和假 CLI 共用同一组构造器。
export const live = {
  chunk1: (userText) => `R189-CHUNK1 回应「${userText}」`,
  chunk2: (userText) => `R189-CHUNK2 第二块「${userText}」`,
  final: (userText) => `R189-FINAL 回复「${userText}」`,
};
export const FILLER = {
  user: (i) => `R189 追加用户消息 ${i}`,
  reply: (i) => `R189 追加回复 ${i}`,
  noticeSummary: (i) => `后台任务完成 ${i}`,
};

const base = (sid, cwd) => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '' });

export function assistantRecord({ sid, cwd, uuid, parentUuid, timestamp, text }) {
  return { ...base(sid, cwd), type: 'assistant', uuid, parentUuid, timestamp, requestId: `req_${uuid.slice(0, 12)}`,
    message: { id: `msg_${uuid.slice(0, 12)}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
}
export function userRecord({ sid, cwd, uuid, parentUuid, timestamp, content, extra = {} }) {
  return { ...base(sid, cwd), type: 'user', uuid, parentUuid, timestamp, message: { role: 'user', content }, ...extra };
}

function sessionLines(sid, cwd, mark) {
  const ts = (n) => new Date(Date.UTC(2026, 8, 15, 8, 0, n)).toISOString();
  const u0 = `${sid}-u0`;
  return [
    { type: 'summary', summary: `${mark} 先来一句话`, leafUuid: u0 },
    userRecord({ sid, cwd, uuid: u0, parentUuid: null, timestamp: ts(0), content: `${mark} 先来一句话` }),
    assistantRecord({ sid, cwd, uuid: `${sid}-a1`, parentUuid: u0, timestamp: ts(1), text: `${mark} 收到,这是这条会话里已有的旧回复。` }),
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export function buildFixtures() {
  fs.mkdirSync(WORKSPACE_RAW, { recursive: true });
  const cwd = fs.realpathSync(WORKSPACE_RAW);
  const home = homeDir();
  const proj = projDir();
  for (const d of [proj, path.join(home, '.claude-gui'), fakeCtlDir(), fakebinDir()]) fs.mkdirSync(d, { recursive: true });

  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));

  const all = [NAV, B, ...Array.from({ length: S_COUNT }, (_, i) => S(i + 1))];
  for (const { sid, mark } of all) fs.writeFileSync(path.join(proj, `${sid}.jsonl`), sessionLines(sid, cwd, mark));

  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${suitePath('helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return { home, cwd, proj };
}

/** 读会话文件里最后一条带 uuid 的记录的 uuid(追加记录接在它后面)。 */
export function lastUuidOf(file) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return null; }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trim()) continue;
    try { const o = JSON.parse(lines[i]); if (o && o.uuid) return o.uuid; } catch { /* 半行 */ }
  }
  return null;
}

/**
 * 往会话文件追加 pairs 组「X / 回复」记录(X = 用户消息 或 任务通知)。时间从现在起逐条 +1ms,晚于此前所有记录。
 * 返回最后一条回复的文字。
 */
export function appendFiller(sid, kind, pairs = 130) {
  const file = transcriptPath(sid);
  const cwd = fs.realpathSync(WORKSPACE_RAW);
  let parent = lastUuidOf(file);
  let t = Date.now();
  const out = [];
  for (let i = 0; i < pairs; i += 1) {
    const uuid = crypto.randomUUID();
    if (kind === 'user') {
      out.push(userRecord({ sid, cwd, uuid, parentUuid: parent, timestamp: new Date(t).toISOString(), content: FILLER.user(i) }));
    } else {
      out.push(userRecord({ sid, cwd, uuid, parentUuid: parent, timestamp: new Date(t).toISOString(),
        content: `<task-notification>\n<task-id>t${i}</task-id>\n<status>completed</status>\n<summary>${FILLER.noticeSummary(i)}</summary>\n</task-notification>`,
        extra: { origin: { kind: 'task-notification', producer: 'session-task', runId: `run-${i}` } } }));
    }
    t += 1; parent = uuid;
    const au = crypto.randomUUID();
    out.push(assistantRecord({ sid, cwd, uuid: au, parentUuid: parent, timestamp: new Date(t).toISOString(), text: FILLER.reply(i) }));
    t += 1; parent = au;
  }
  fs.appendFileSync(file, out.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return FILLER.reply(pairs - 1);
}

/** B6 用:追加 1 条任务通知 + 1 条回复。 */
export function appendNoticeAndReply(sid, tag) {
  const file = transcriptPath(sid);
  const cwd = fs.realpathSync(WORKSPACE_RAW);
  const parent = lastUuidOf(file);
  const nu = crypto.randomUUID();
  const t = Date.now();
  const lines = [
    userRecord({ sid, cwd, uuid: nu, parentUuid: parent, timestamp: new Date(t).toISOString(),
      content: `<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>后台任务完成 ${tag}</summary>\n</task-notification>`,
      extra: { origin: { kind: 'task-notification', producer: 'session-task', runId: `run-${tag}` } } }),
    assistantRecord({ sid, cwd, uuid: crypto.randomUUID(), parentUuid: nu, timestamp: new Date(t + 1).toISOString(), text: `R189 通知后的回复 ${tag}` }),
  ];
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return `R189 通知后的回复 ${tag}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildFixtures();
  console.log(`[r189] 夹具就绪:HOME=${r.home} 项目=${r.cwd}`);
}
