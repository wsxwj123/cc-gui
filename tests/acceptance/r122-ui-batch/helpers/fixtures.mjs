// r122 界面小改一批 · 验收夹具:隔离 HOME + 夹具会话 + PATH 上的假 claude。
// 依据只有 .devflow/BRIEF-r122.md 与 .devflow/INTERFACE-r122.md;没看实现代码。
//   node helpers/fixtures.mjs     # run.sh 会先跑这一步(数据根由 R122_DATA_ROOT 给)
//
// 夹具会话(记录形态照抄 tests/acceptance/stripfold-20260913 里已被产品认出来的那份形状):
//   FOLD  已结束的历史会话,3 轮,每轮 = 思考 → 工具 → 思考 → 工具 → 中间正文 → 工具 → 思考 → 工具 → 最终正文
//         → 段序 [group, text, group, text];INTERFACE A4/A5/A6/A7/A8/A10 的载体。
//   PLAIN 已结束的历史会话,2 轮纯正文(没有任何过程块)→ data-strip-state 应为 none(开关与它无关)。
//   POOL  短会话池:每条"真回合"用例各拿一条自己的(INTERFACE A9),用例之间不共享可变状态。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R122_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const fakeCtlDir = () => path.join(homeDir(), 'fake-claude');
export const fakebinDir = () => suitePath('.artifacts', 'fakebin');
export const WORKSPACE_RAW = path.join(suiteDir, '.artifacts', 'runtime-data', 'fixture-workspace');
export const PROJECT_NAME = 'fixture-workspace';
/** 与真 CLI 同口径:cwd 里非字母数字一律换成 '-'。 */
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

// 会话 id 必须是十六进制 UUID(侧栏只列合法 id 的会话)。
const sidOf = (n) => `a122${String(n).padStart(4, '0')}-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;

export const FOLD = {
  sid: sidOf(1),
  mark: 'R122FOLDHIST',
  rounds: 3,
  /** 每轮的段序:两段过程(可折)夹两段正文。 */
  segments: ['group', 'text', 'group', 'text'],
  midText: (n) => `R122MID${n} 我先看一下这个文件的实现,确认改动面之后再动手。`,
  finalText: (n) => `R122FINAL${n} 这一轮的改动已经落地:脚本的路径处理改成从自身位置反推仓库根目录。`,
};
export const PLAIN = {
  sid: sidOf(2),
  mark: 'R122PLAINHIST',
  rounds: 2,
  text: (n) => `R122PLAIN${n} 这一轮只有一段正文,没有思考也没有工具调用。`,
};
/** 真回合用例的会话池(一条用例一条,互不干扰)。 */
export const POOL = Array.from({ length: 10 }, (_, i) => ({
  sid: sidOf(10 + i),
  mark: `R122LIVE${String(i + 1).padStart(2, '0')}`,
}));

const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };
const ISO = (min, sec = 0) => new Date(Date.UTC(2026, 8, 20, 9, min, sec)).toISOString();

const base = (sid, cwd) => ({
  parentUuid: null, isSidechain: false, userType: 'external', entrypoint: 'cli',
  cwd, sessionId: sid, version: '2.1.267', gitBranch: '',
});
const userRecord = ({ sid, cwd, uuid, text, at }) => ({
  ...base(sid, cwd), promptId: `r122-prompt-${uuid}`, type: 'user', isMeta: false,
  message: { role: 'user', content: text }, uuid, timestamp: at, permissionMode: 'default', promptSource: 'sdk',
});
const assistantRecord = ({ sid, cwd, id, blocks, at }) => ({
  ...base(sid, cwd),
  message: {
    model: 'claude-sonnet-4-6', id, type: 'message', role: 'assistant', content: blocks,
    stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null, stop_details: null, usage: USAGE,
  },
  apiBlockIndex: 0, requestId: `req_${id}`, type: 'assistant', uuid: `r122-a-${id}`, timestamp: at, effort: 'high',
});
const toolResultRecord = ({ sid, cwd, toolUseId, content, at }) => ({
  ...base(sid, cwd), promptId: 'r122-prompt', type: 'user', isMeta: false, toolUseResult: content,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  uuid: `r122-tr-${toolUseId}`, timestamp: at, toolUseID: toolUseId,
});
const think = (text) => ({ type: 'thinking', thinking: text, signature: 'r122-fixture-signature' });
const text_ = (text) => ({ type: 'text', text });
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });

/** 真实转写是一条 uuid 链(每条记录的 parentUuid = 上一条的 uuid);摘要行没有 uuid,跳过。 */
function writeJsonl(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prev = null;
  const out = lines.map((l) => {
    const line = { ...l };
    if (prev !== null && 'parentUuid' in line) line.parentUuid = prev;
    if (line.uuid) prev = line.uuid;
    return line;
  });
  fs.writeFileSync(file, `${out.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

function foldSessionLines(cwd) {
  const { sid, mark } = FOLD;
  const lines = [{ type: 'summary', summary: `${mark} 含思考与工具调用的已结束会话`, leafUuid: 'r122-leaf-fold' }];
  for (let n = 1; n <= FOLD.rounds; n += 1) {
    const at = (k) => ISO(n * 10, k);
    lines.push(userRecord({ sid, cwd, uuid: `r122-fold-u${n}`, at: at(0), text: `${n === 1 ? `${mark} ` : ''}第 ${n} 轮:帮我把这个脚本的路径处理改一下,然后跑测试。` }));
    const steps = [
      think(`先摸清工作区结构和内容(第 ${n} 轮)`),
      tool(`r122F-${n}-1`, 'Bash', { command: 'ls -la', description: '列出工作区' }),
      think(`目录看清楚了,入口是 scripts/release.sh(第 ${n} 轮)`),
      tool(`r122F-${n}-2`, 'Read', { file_path: '/tmp/r122-fixture/scripts/release.sh' }),
      text_(FOLD.midText(n)),
      tool(`r122F-${n}-3`, 'Edit', { file_path: '/tmp/r122-fixture/scripts/release.sh', old_string: 'ROOT=..', new_string: 'ROOT=$PWD' }),
      think(`改完了,跑一遍测试确认没有回归(第 ${n} 轮)`),
      tool(`r122F-${n}-4`, 'Grep', { pattern: 'ROOT=', path: '/tmp/r122-fixture' }),
      text_(FOLD.finalText(n)),
    ];
    steps.forEach((block, i) => {
      const id = `r122F_r${n}_c${i + 1}`;
      lines.push(assistantRecord({ sid, cwd, id, blocks: [block], at: at(i + 1) }));
      if (block.type === 'tool_use') lines.push(toolResultRecord({ sid, cwd, toolUseId: block.id, content: '(夹具)命令输出', at: at(i + 1) }));
    });
  }
  return lines;
}

function plainSessionLines(cwd) {
  const { sid, mark } = PLAIN;
  const lines = [{ type: 'summary', summary: `${mark} 纯正文的已结束会话`, leafUuid: 'r122-leaf-plain' }];
  for (let n = 1; n <= PLAIN.rounds; n += 1) {
    lines.push(userRecord({ sid, cwd, uuid: `r122-plain-u${n}`, at: ISO(40 + n, 0), text: `${n === 1 ? `${mark} ` : ''}第 ${n} 轮:只回一段话。` }));
    lines.push(assistantRecord({ sid, cwd, id: `r122P_r${n}_c1`, blocks: [text_(PLAIN.text(n))], at: ISO(40 + n, 1) }));
  }
  return lines;
}

function poolSessionLines(s, cwd) {
  return [
    { type: 'summary', summary: `${s.mark} 真回合用例专用`, leafUuid: `${s.sid}-leaf` },
    userRecord({ sid: s.sid, cwd, uuid: `${s.sid}-u1`, at: ISO(50, 0), text: `${s.mark} 先看一眼这个仓库。` }),
    assistantRecord({ sid: s.sid, cwd, id: `r122L_${s.mark}_c1`, blocks: [text_(`${s.mark} 好的,先看一眼。`)], at: ISO(50, 1) }),
  ];
}

export function buildFixtures() {
  fs.mkdirSync(WORKSPACE_RAW, { recursive: true });
  const cwd = fs.realpathSync(WORKSPACE_RAW);   // 与服务端起假 CLI 时子进程拿到的 cwd 一致(防软链差异)
  const home = homeDir();
  const proj = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  for (const d of [proj, path.join(home, '.claude-gui'), fakeCtlDir(), fakebinDir()]) fs.mkdirSync(d, { recursive: true });

  // 钉成回环免密 + 压掉一次性浮层(与 r119/r120/r121 同口径;公开版会自愈成 0.0.0.0+随机密码,会写盘、会去占 6677)
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), '2026-09-21T00:00:00.000Z');
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));

  writeJsonl(path.join(proj, `${FOLD.sid}.jsonl`), foldSessionLines(cwd));
  writeJsonl(path.join(proj, `${PLAIN.sid}.jsonl`), plainSessionLines(cwd));
  for (const s of POOL) writeJsonl(path.join(proj, `${s.sid}.jsonl`), poolSessionLines(s, cwd));

  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${suitePath('helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return { home, cwd, proj };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildFixtures();
  console.log(`[r122] 夹具就绪:HOME=${r.home} 项目=${r.cwd}`);
  console.log(`[r122] 会话:${FOLD.sid}(${FOLD.mark}) / ${PLAIN.sid}(${PLAIN.mark}) + 真回合池 ${POOL.length} 条`);
}
