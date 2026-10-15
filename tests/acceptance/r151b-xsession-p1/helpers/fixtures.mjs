// r151b 夹具:临时 HOME(不碰真实的 ~/.claude、~/.claude-gui)+ 假 claude 控制目录 + 工作区 + 会话记录。
// 结构参照 r151a 的同名文件。run.sh 在起实例之前跑一次本文件(建 HOME、写 claude 垫片);
// 用例运行时用这里的工具摆场景(落会话记录、建工作区)。
//
// claude 垫片(<数据根>/fakebin/claude)按会话的工作目录分流:
//   目录名以 real- 开头(ws/real-*)→ 本机真实 claude CLI,模型请求强制打到本地假接口的 real 车道,
//       配置目录 = 临时 HOME 下的 .claude,不读 CLAUDE.md;GUI 若经 --settings / settings.json 给了模型接口设置,垫片拒绝运行(防止被改道到真实 provider)。
//   其它目录 → 假 claude(helpers/fake-claude.mjs)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R151B_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const ctlDir = () => process.env.R151B_CTL || path.join(homeDir(), 'fake-claude');
export const fakebinDir = () => path.join(dataRoot(), 'fakebin');
export const mockDir = () => path.join(dataRoot(), 'mock');
/** 工作区根:在工作树里(放在 /private/tmp 下的项目不进侧栏列表)。 */
export const wsRoot = () => path.join(dataRoot(), 'ws');
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

export const REAL_CLI_CANDIDATES = [
  process.env.R151B_REAL_CLAUDE,
  path.join(os.userInfo().homedir, '.npm-global', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
].filter(Boolean);
export const realCliPath = () => REAL_CLI_CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;

export const guiDir = (home = homeDir()) => path.join(home, '.claude-gui');
export const claudeDir = (home = homeDir()) => path.join(home, '.claude');
export const prefsPath = (home = homeDir()) => path.join(guiDir(home), 'prefs.json');
export const xsDir = (home = homeDir()) => path.join(guiDir(home), 'xsession');

/** 建一个 GUI 能直接起的临时 HOME。prefsExtra 合进 prefs.json(用来手写偏好值)。 */
export function buildHome(home, ctl, prefsExtra = {}) {
  for (const d of [guiDir(home), claudeDir(home), path.join(claudeDir(home), 'projects'), ctl, path.join(ctl, 'scripts')]) fs.mkdirSync(d, { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(prefsPath(home), JSON.stringify({ releaseNotesSeen: version, ...prefsExtra }, null, 2));
  fs.writeFileSync(path.join(guiDir(home), 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(guiDir(home), 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.writeFileSync(path.join(claudeDir(home), 'settings.json'), JSON.stringify({ env: {} }, null, 2));
}

function writeShim() {
  const mock = process.env.R151B_MOCK_BASE || 'http://127.0.0.1:0';
  const real = realCliPath() || '/nonexistent/claude';
  const fake = suitePath('helpers', 'fake-claude.mjs');
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const sh = `#!/bin/sh
# r151b claude 垫片(fixtures.mjs 生成)。ws/real-* 目录 → 真 CLI(模型请求只到本地假接口);其它 → 假 claude。
here="$(pwd -P)"
case "$here" in
  */ws/real-*)
    REAL=${q(real)}
    [ -x "$REAL" ] || { echo "[r151b shim] 本机没有真 claude CLI" >&2; exit 98; }
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--settings" ]; then
        v="$a"; [ -f "$v" ] && v="$(cat "$v")"
        case "$v" in *ANTHROPIC_BASE_URL*|*ANTHROPIC_AUTH_TOKEN*|*ANTHROPIC_API_KEY*|*apiKeyHelper*|*CLAUDE_CODE_USE_*) echo "[r151b shim] 拒绝:--settings 带了模型接口设置" >&2; exit 97;; esac
      fi
      case "$a" in --settings=*) echo "[r151b shim] 拒绝:--settings= 形式无法检查" >&2; exit 97;; esac
      prev="$a"
    done
    if grep -qE 'ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|apiKeyHelper|CLAUDE_CODE_USE_' "$HOME/.claude/settings.json" 2>/dev/null; then
      echo "[r151b shim] 拒绝:settings.json 带了模型接口设置" >&2; exit 97
    fi
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY HTTPS_PROXY HTTP_PROXY https_proxy http_proxy ALL_PROXY all_proxy
    export CLAUDE_CONFIG_DIR="$HOME/.claude" ANTHROPIC_BASE_URL=${q(`${mock}/lane/real`)} ANTHROPIC_AUTH_TOKEN=dummy-r151b-real \\
      CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 DISABLE_TELEMETRY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 DISABLE_ERROR_REPORTING=1 NO_PROXY='*'
    exec "$REAL" "$@";;
esac
exec ${q(process.execPath)} ${q(fake)} "$@"
`;
  fs.mkdirSync(fakebinDir(), { recursive: true });
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, sh);
  fs.chmodSync(shim, 0o755);
}

export function buildFixtures() {
  for (const d of [mockDir(), wsRoot()]) fs.mkdirSync(d, { recursive: true });
  buildHome(homeDir(), ctlDir());
  writeShim();
  return { home: homeDir() };
}

/** 建一个工作区目录(每个用例用自己的,互不串)并返回真实路径。名字以 real- 开头 = 真 CLI 会话。 */
export function makeWorkspace(name) {
  const dir = path.join(wsRoot(), name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

export const newSid = () => crypto.randomUUID();
export const uniq = (tag) => `${tag}${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

/**
 * 落一条已落盘的会话记录。opts:
 *   home(默认共享实例的 HOME)、sid、title(summary 行;null = 不写 summary)、firstPrompt(首条提问,默认 = title)、
 *   reply(助手回复文字)、lines(自定义行数组,给了就整体替换默认三行;行里的 cwd/sessionId 自动补)、mtime(Date:记录文件的修改时间)。
 * 返回 { sid, cwd, file, title, reply }。
 */
export function seedSession(name, opts = {}) {
  const home = opts.home || homeDir();
  const sid = opts.sid || newSid();
  const cwd = opts.cwd || makeWorkspace(name);
  const proj = path.join(claudeDir(home), 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(proj, { recursive: true });
  const title = opts.title === undefined ? `R151B ${name}` : opts.title;
  const firstPrompt = opts.firstPrompt === undefined ? (title || '') : opts.firstPrompt;
  const reply = opts.reply || `${title || name} 这是已有的旧回复。`;
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.296', gitBranch: '' };
  // 记录里的时间与文件修改时间一致(给了 mtime 时):无论"最近活动"按哪一个算,先后顺序都相同
  const tEnd = opts.mtime ? new Date(opts.mtime).getTime() : Date.parse('2026-10-01T08:00:01.000Z');
  const tsUser = new Date(tEnd - 1000).toISOString();
  const tsReply = new Date(tEnd).toISOString();
  let lines = opts.lines;
  if (!lines) {
    lines = [
      ...(title === null ? [] : [{ type: 'summary', summary: title, leafUuid: `${sid}-a1` }]),
      { ...base, type: 'user', uuid: `${sid}-u0`, parentUuid: null, timestamp: tsUser, message: { role: 'user', content: firstPrompt } },
      { ...base, type: 'assistant', uuid: `${sid}-a1`, parentUuid: `${sid}-u0`, timestamp: tsReply, requestId: `req_${sid.slice(0, 8)}`,
        message: { id: `msg_${sid.slice(0, 8)}`, type: 'message', role: 'assistant', model: 'r151-chat', content: [{ type: 'text', text: reply }],
          stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } },
    ];
  } else {
    lines = lines.map((l) => (l.type === 'summary' ? l : { ...base, ...l }));
  }
  const file = path.join(proj, `${sid}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (opts.mtime) fs.utimesSync(file, opts.mtime, opts.mtime);
  return { sid, cwd, file, title, reply };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildFixtures();
  console.log(`[r151b] 夹具就绪:HOME=${r.home};真 CLI:${realCliPath() || '无'}`);
}
