// r151n 分屏图标化 / 粘贴乱码还原 —— 验收夹具。
// 从 r151l-history-pagination/helpers/fixtures.mjs 裁剪:临时 HOME(不碰真实 ~/.claude、~/.claude-gui)
// + 一个工作区 + 一份小历史 jsonl。本套件不跑回合,claude 垫片只回应 --version。
// 种子会话由 seedSession() 直写 jsonl 构造;run.sh 调本文件一次,把 seed.json 交给 spec。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R151N_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const ctlDir = () => process.env.R151N_CTL || path.join(homeDir(), 'fake-claude');
export const fakebinDir = () => path.join(dataRoot(), 'fakebin');
export const wsRoot = () => path.join(dataRoot(), 'ws');
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

export const guiDir = (home = homeDir()) => path.join(home, '.claude-gui');
export const claudeDir = (home = homeDir()) => path.join(home, '.claude');
export const prefsPath = (home = homeDir()) => path.join(guiDir(home), 'prefs.json');

/** 建一个 GUI 能直接起的临时 HOME。prefsExtra 合进 prefs.json。 */
export function buildHome(home, ctl, prefsExtra = {}) {
  for (const d of [guiDir(home), claudeDir(home), path.join(claudeDir(home), 'projects'), ctl, path.join(ctl, 'scripts')]) fs.mkdirSync(d, { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(prefsPath(home), JSON.stringify({ releaseNotesSeen: version, ...prefsExtra }, null, 2));
  fs.writeFileSync(path.join(guiDir(home), 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(guiDir(home), 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.writeFileSync(path.join(claudeDir(home), 'settings.json'), JSON.stringify({ env: {} }, null, 2));
}

/** 只回应版本查询的 claude 垫片;历史读取不启动 CLI。 */
function writeShim() {
  const sh = `#!/bin/sh
case "$1" in
  --version|-v|version) echo "2.1.296 (Claude Code)"; exit 0;;
esac
exit 0
`;
  fs.mkdirSync(fakebinDir(), { recursive: true });
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, sh);
  fs.chmodSync(shim, 0o755);
}

export const newSid = () => crypto.randomUUID();
export const uniq = (tag) => `${tag}${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

/** 第 index 条消息的正文(0 起;偶数 = user,奇数 = assistant)。标题/正文都带唯一 tag,防止多会话串词。 */
export const historyText = (tag, index) => `R151N-${tag}-H${String(index).padStart(3, '0')}`;

/**
 * 构造一份合法的小历史(必须偶数):summary + user/assistant 交替。
 * 每条 assistant 带固定 usage;本套件不看 usage,只是让历史接口形状与真实一致。
 */
export function historyLines({ sid, cwd, tag, count = 6 }) {
  if (count % 2 !== 0) throw new Error(`historyLines: count 必须是偶数(现在是 ${count})`);
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.296', gitBranch: '' };
  const t0 = Date.parse('2026-10-01T08:00:00.000Z');
  const lines = [{ type: 'summary', summary: `R151N ${tag} ${count}`, leafUuid: `${sid}-a${count / 2 - 1}` }];
  for (let i = 0; i < count / 2; i += 1) {
    const mUser = i * 2;
    const mAssistant = mUser + 1;
    lines.push({
      ...base,
      type: 'user',
      uuid: `${sid}-u${i}`,
      parentUuid: i ? `${sid}-a${i - 1}` : null,
      timestamp: new Date(t0 + mUser * 1_000).toISOString(),
      message: { role: 'user', content: historyText(tag, mUser) },
    });
    lines.push({
      ...base,
      type: 'assistant',
      uuid: `${sid}-a${i}`,
      parentUuid: `${sid}-u${i}`,
      timestamp: new Date(t0 + mAssistant * 1_000).toISOString(),
      requestId: `req_${sid.slice(0, 8)}_${String(i).padStart(4, '0')}`,
      message: {
        id: `msg_${sid.slice(0, 8)}_${String(i).padStart(4, '0')}`,
        type: 'message',
        role: 'assistant',
        model: 'r151n-chat',
        content: [{ type: 'text', text: historyText(tag, mAssistant) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
  }
  return lines;
}

/**
 * 落一份小历史会话并返回 { sid, cwd, file, projectHash, title, tag, count, texts, firstText, lastText }。
 * home 默认共享实例的 HOME。
 */
export function seedSession(name, opts = {}) {
  const home = opts.home || homeDir();
  const tag = opts.tag || uniq(name || 'seed');
  const sid = opts.sid || newSid();
  const count = opts.count === undefined ? 6 : opts.count;
  const cwd = opts.cwd || path.join(wsRoot(), `r151n-${tag}`);
  fs.mkdirSync(cwd, { recursive: true });
  const realCwd = fs.realpathSync(cwd);
  const proj = path.join(claudeDir(home), 'projects', encodeProjectDir(realCwd));
  fs.mkdirSync(proj, { recursive: true });
  const lines = historyLines({ sid, cwd: realCwd, tag, count });
  const file = path.join(proj, `${sid}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const texts = Array.from({ length: count }, (_, i) => historyText(tag, i));
  return {
    sid,
    cwd: realCwd,
    file,
    projectHash: encodeProjectDir(realCwd),
    title: `R151N ${tag} ${count}`,
    tag,
    count,
    texts,
    firstText: texts[0],
    lastText: texts[count - 1],
  };
}

function buildFixtures() {
  fs.mkdirSync(wsRoot(), { recursive: true });
  buildHome(homeDir(), ctlDir());
  writeShim();
  const seed = seedSession('s1', { count: 6 });
  const seedFile = path.join(dataRoot(), 'seed.json');
  fs.writeFileSync(seedFile, JSON.stringify(seed, null, 2));
  return seed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const seed = buildFixtures();
  console.log(`[r151n] 夹具就绪:HOME=${homeDir()} seed=${seed.sid} first=${seed.firstText}`);
}
