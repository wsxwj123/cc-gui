// r170 夹具:临时 HOME(不碰真实的 ~/.claude、~/.claude-gui)+ 工作区 + 600 条纯文本历史 jsonl。
// 照 r151l-history-pagination/helpers/fixtures.mjs 的做法:本套件不跑回合,claude 垫片只回应 --version;
// 会话内容全部由 seedHistory() 直接写 jsonl(user/assistant 交替,600 条 = 300 轮,每条正文带唯一序号)。
// 工作区放在 .artifacts/runtime-data/ws 下(不能在 /tmp、/private/tmp 下:那类路径的工作区不会出现在侧栏)。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const fakebinDir = () => suitePath('.artifacts', 'fakebin');
export const wsRoot = () => path.join(dataRoot(), 'ws');
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

const guiDir = () => path.join(homeDir(), '.claude-gui');
const claudeDir = () => path.join(homeDir(), '.claude');

/** run.sh 起实例前调一次:临时 HOME 的基础文件 + 只回应版本查询的 claude 垫片。 */
export function buildBase() {
  for (const d of [guiDir(), claudeDir(), path.join(claudeDir(), 'projects'), wsRoot(), fakebinDir()]) fs.mkdirSync(d, { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(guiDir(), 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }, null, 2));
  fs.writeFileSync(path.join(guiDir(), 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(guiDir(), 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.writeFileSync(path.join(claudeDir(), 'settings.json'), JSON.stringify({ env: {} }, null, 2));
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, '#!/bin/sh\ncase "$1" in\n  --version|-v|version) echo "2.1.296 (Claude Code)"; exit 0;;\nesac\nexit 0\n');
  fs.chmodSync(shim, 0o755);
}

export const uniq = (tag) => `${tag}${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
/** 第 index 条消息的正文(0 起;偶数 = user,奇数 = assistant)。 */
export const historyText = (tag, index) => `R170-${tag}-H${String(index).padStart(3, '0')}`;

const baseOf = (S) => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: S.cwd, sessionId: S.sid, version: '2.1.296', gitBranch: '' });
const T0 = Date.parse('2026-10-01T08:00:00.000Z');
const USAGE = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function userLine(S, index, parentUuid) {
  return { ...baseOf(S), type: 'user', uuid: `${S.sid}-m${index}`, parentUuid, timestamp: new Date(T0 + index * 1_000).toISOString(), message: { role: 'user', content: historyText(S.tag, index) } };
}
function assistantLine(S, index, parentUuid) {
  return {
    ...baseOf(S), type: 'assistant', uuid: `${S.sid}-m${index}`, parentUuid, timestamp: new Date(T0 + index * 1_000).toISOString(),
    requestId: `req_${S.sid.slice(0, 8)}_${index}`,
    message: {
      id: `msg_${S.sid.slice(0, 8)}_${index}`, type: 'message', role: 'assistant', model: 'r170-chat',
      content: [{ type: 'text', text: historyText(S.tag, index) }], stop_reason: 'end_turn', stop_sequence: null, usage: USAGE,
    },
  };
}

/** 落一份 count 条(偶数)的会话。返回 { sid, cwd, file, projectHash, title, tag, count, texts, next, lastUuid }。 */
export function seedHistory(name, { count = 600 } = {}) {
  if (count % 2 !== 0) throw new Error('seedHistory: count 必须是偶数');
  const tag = uniq(name);
  const sid = crypto.randomUUID();
  const cwd = (() => { const d = path.join(wsRoot(), `r170-${tag}`); fs.mkdirSync(d, { recursive: true }); return fs.realpathSync(d); })();
  const proj = path.join(claudeDir(), 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(proj, { recursive: true });
  const S = { sid, cwd, file: path.join(proj, `${sid}.jsonl`), projectHash: encodeProjectDir(cwd), title: `R170 ${tag} ${count}`, tag, count };
  const lines = [{ type: 'summary', summary: S.title, leafUuid: `${sid}-m${count - 1}` }];
  for (let i = 0; i < count; i += 1) lines.push(i % 2 === 0 ? userLine(S, i, i ? `${sid}-m${i - 1}` : null) : assistantLine(S, i, `${sid}-m${i - 1}`));
  fs.writeFileSync(S.file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  S.texts = Array.from({ length: count }, (_, i) => historyText(tag, i));
  S.next = count;
  S.lastUuid = `${sid}-m${count - 1}`;
  return S;
}

/** 往会话文件末尾追加 n 条合法记录(user/assistant 交替,接在上一条后面)。返回新消息正文数组。 */
export function appendMessages(S, n) {
  const texts = [];
  const out = [];
  for (let k = 0; k < n; k += 1) {
    const index = S.next;
    const line = index % 2 === 0 ? userLine(S, index, S.lastUuid) : assistantLine(S, index, S.lastUuid);
    out.push(JSON.stringify(line));
    texts.push(historyText(S.tag, index));
    S.lastUuid = line.uuid;
    S.next += 1;
  }
  fs.appendFileSync(S.file, out.join('\n') + '\n');
  return texts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildBase();
  console.log(`[r170] 夹具就绪:HOME=${homeDir()}`);
}
