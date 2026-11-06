// r154-ui-live-line 验收套件的会话夹具（全部落在本套件 .artifacts/runtime-data 下，不读用户 profile）。
// 记录形态抄自 r152a-fold-tool-title / stripfold-20260913 的夹具（只读参考）；内容是本套件自造的。
// 每个用例独占一条"带一个历史回合"的会话：直播回合会往转写里追加，用例之间互不共用、可任意顺序跑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function suitePath(...parts) { return path.join(suiteDir, ...parts); }
export function dataRoot() { return suitePath('.artifacts', 'runtime-data'); }
export function homeDir() { return path.join(dataRoot(), 'home'); }
export function guiConfigDir() { return path.join(homeDir(), '.claude-gui'); }
export function workspaceDir() { return path.join(dataRoot(), 'fixture-workspace'); }
export function fakebinDir() { return suitePath('.artifacts', 'fakebin'); }
export function fakeCtlDir() { return path.join(homeDir(), 'fake-claude'); }
export function manifestPath() { return suitePath('.artifacts', 'fixture-manifest.json'); }

// l1…l15 对应行为 L1…L15；u1…u5 对应 ui-live-line-v2 的 U1–U5。
// 每条各占一条会话（L5/L6/L7/L13/L14 在同一条会话里先后跑两轮，轮与轮之间有 resetCtl）。
export const KEYS = [...Array.from({ length: 15 }, (_, i) => `l${i + 1}`), 'u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
export const SESSIONS = Object.fromEntries(KEYS.map((k, i) => [k, {
  sid: `a1540${String(i + 1).padStart(3, '0')}-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  marker: `R154MARK${k.toUpperCase()}X`, // 以 X 收尾：R154MARKL1X 不会是 R154MARKL11X 的子串
}]));

export const histAnchor = (key) => `R154-${key} 历史回合收尾。`;
export const histTool = (key) => `${key} 历史回合工具`;

const th = (text) => ({ k: 'think', text });
const tx = (text) => ({ k: 'text', text });
const tl = (name, input) => ({ k: 'tool', name, input });
const histBlocks = (key) => [th(`${key} 历史思考。`), tl('Bash', { command: 'ls', description: histTool(key) }), tx(histAnchor(key))];

const ISO = (min, sec = 0) => new Date(Date.UTC(2026, 10, 5, 9, min, sec)).toISOString();
const encodeProjectDir = (cwd) => cwd.replace(/[/\\]/g, '-');
export function projectDir() { return path.join(homeDir(), '.claude', 'projects', encodeProjectDir(workspaceDir())); }
const sessionFile = (sid) => path.join(projectDir(), `${sid}.jsonl`);
const base = (sid, cwd) => ({
  parentUuid: null, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid,
  version: '2.1.267', gitBranch: 'fix/r154-ui-live-line',
});

function writeSession(key) {
  const { sid, marker } = SESSIONS[key];
  const cwd = workspaceDir();
  const lines = [{ type: 'summary', summary: `${marker} r154 夹具`, leafUuid: `r154-leaf-${key}` }];
  lines.push({
    ...base(sid, cwd), promptId: 'r154-prompt', type: 'user', isMeta: false,
    message: { role: 'user', content: `${marker} 第 1 轮：历史` },
    uuid: `r154-u-${key}`, timestamp: ISO(0), permissionMode: 'default', promptSource: 'sdk',
  });
  histBlocks(key).forEach((b, k) => {
    const id = `r154_${key}_${k}`;
    const block = b.k === 'think' ? { type: 'thinking', thinking: b.text, signature: 'r154-sig' }
      : b.k === 'text' ? { type: 'text', text: b.text }
        : { type: 'tool_use', id: `toolu_${id}`, name: b.name, input: b.input };
    lines.push({
      ...base(sid, cwd),
      message: {
        model: 'claude-sonnet-4-6', id, type: 'message', role: 'assistant', content: [block],
        stop_reason: b.k === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null, stop_details: null,
        usage: { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 },
      },
      apiBlockIndex: 0, requestId: `req_${id}`, type: 'assistant', uuid: `r154-a-${id}`, timestamp: ISO(0, k + 1), effort: 'high',
    });
    if (b.k === 'tool') {
      lines.push({
        ...base(sid, cwd), promptId: 'r154-prompt', type: 'user', isMeta: false, toolUseResult: '（夹具）输出',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: '（夹具）输出' }] },
        uuid: `r154-tr-${id}`, timestamp: ISO(0, k + 1), toolUseID: `toolu_${id}`,
      });
    }
  });
  let prev = null; // 真实转写是一条 uuid 链
  const out = lines.map((l) => {
    const line = { ...l };
    if (prev !== null && 'parentUuid' in line) line.parentUuid = prev;
    if (line.uuid) prev = line.uuid;
    return line;
  });
  fs.mkdirSync(path.dirname(sessionFile(sid)), { recursive: true });
  fs.writeFileSync(sessionFile(sid), `${out.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** 首启浮层的「已看过」（与被测行为无关，与同批其它验收套件同一套做法）。 */
function writeOverlayState() {
  const version = JSON.parse(fs.readFileSync(suitePath('..', '..', '..', 'package.json'), 'utf8')).version;
  fs.mkdirSync(guiConfigDir(), { recursive: true });
  fs.writeFileSync(path.join(guiConfigDir(), 'prefs.json'), `${JSON.stringify({ releaseNotesSeen: version })}\n`);
  fs.writeFileSync(path.join(guiConfigDir(), 'permission-guide-shown.flag'), `${new Date().toISOString()}\n`);
}

/** PATH 上的假 claude：一个 shell 薄壳，转交给本套件 helpers/fake-claude.mjs。 */
function writeFakeClaudeShim() {
  fs.mkdirSync(fakebinDir(), { recursive: true });
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(suiteDir, 'helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
}

/** 每次整套重建（会话很小；直播用例会往转写里追加，不重建的话第二遍就脏了）。 */
export function ensureFixtures() {
  fs.mkdirSync(workspaceDir(), { recursive: true });
  fs.mkdirSync(projectDir(), { recursive: true });
  fs.mkdirSync(fakeCtlDir(), { recursive: true });
  writeOverlayState();
  writeFakeClaudeShim();
  for (const k of KEYS) writeSession(k);
  const manifest = {
    dataRoot: dataRoot(), home: homeDir(), workspace: workspaceDir(), fakebin: fakebinDir(), fakeCtl: fakeCtlDir(),
    sessions: Object.fromEntries(Object.entries(SESSIONS).map(([k, v]) => [k, v.sid])),
    markers: Object.fromEntries(Object.entries(SESSIONS).map(([k, v]) => [k, v.marker])),
  };
  fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
  fs.writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(ensureFixtures(), null, 2)}\n`);
}
