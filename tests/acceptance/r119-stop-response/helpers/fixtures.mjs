// r119 界面验收的夹具:隔离 HOME、**长会话**(几十~几百轮 + 大量工具结果)与**短会话**各一批、
// PATH 上的假 claude(持续吐字的桩)。
// 依据只有 .devflow/BRIEF-r119.md 与 .devflow/INTERFACE-r119.md;没看实现代码。
//   node helpers/fixtures.mjs     # run.sh 会先跑这一步
// 规模可用环境变量调(修前复现不出来就加大):
//   R119_LONG_TURNS(默认 150)  R119_LONG_RESULT_CHARS(默认 4000)  R119_LONG_TOOL_CHARS(默认 1200)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R119_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const fakeCtlDir = () => path.join(homeDir(), 'fake-claude');
export const fakebinDir = () => suitePath('.artifacts', 'fakebin');
export const WORKSPACE_RAW = path.join(suiteDir, '.artifacts', 'runtime-data', 'fixture-workspace');
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

export const LONG_TURNS = Number(process.env.R119_LONG_TURNS || 150);
export const LONG_RESULT_CHARS = Number(process.env.R119_LONG_RESULT_CHARS || 4000);
export const LONG_TOOL_CHARS = Number(process.env.R119_LONG_TOOL_CHARS || 1200);
export const SHORT_TURNS = 2;

// 会话 id 必须是十六进制 UUID(侧栏只列合法 id 的会话);每条夹具会话只在一个用例的一轮里用一次
// (回合跑完后应用会改会话标题,行文字会变,用完就不按标记找它了)。
const sidOf = (n) => `a119${String(n).padStart(4, '0')}-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;
export const NAV = { sid: sidOf(999), mark: 'R119NAVMARK' };
export const B = { sid: sidOf(998), mark: 'R119BMARK' };
export const MARK = { b: B.mark };

/** 长会话池(每条做大,只建一次,多个用例各拿一条)。 */
export const LONGS = Array.from({ length: 18 }, (_, i) => ({
  sid: sidOf(100 + i), mark: `R119LONG${String(i + 1).padStart(2, '0')}MK`, turns: LONG_TURNS, long: true,
}));
/** 短会话池(新建级别的历史:2 轮,没有大工具输出)。 */
export const SHORTS = Array.from({ length: 18 }, (_, i) => ({
  sid: sidOf(300 + i), mark: `R119SHORT${String(i + 1).padStart(2, '0')}MK`, turns: SHORT_TURNS, long: false,
}));
export const longBatch = (n, k = 3) => LONGS.slice(n * k, n * k + k);
export const shortBatch = (n, k = 3) => SHORTS.slice(n * k, n * k + k);

const base = (sid, cwd) => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '' });
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const text = (t) => ({ type: 'text', text: t });

// 假的 Bash 输出:按行铺开(每行都是 DOM 里的文本行,渲染代价接近真实工具输出)
function toolOutput(turn, chars) {
  const line = (i) => `  src/module${i % 40}/file${i}.ts:${100 + (i % 900)}  expect(received).toEqual(expected) // Object.is equality  case ${turn}-${i}`;
  const head = `$ npm test -- --reporter=verbose packages/pkg-${turn}\n`;
  const body = [];
  let size = head.length;
  for (let i = 0; size < chars; i += 1) { const l = `${line(i)}\n`; body.push(l); size += l.length; }
  return head + body.join('') + `\n${body.length} lines of output (exit code 1)`;
}

function assistantText(turn) {
  return `第 ${turn} 轮的分析:先看失败用例的分布,再判断是断言写错还是实现有问题;`
    + `这里给出结论与下一步计划,包含一段较长的说明文字,用来接近真实助手回复的体积。`
    + `\n\n要点:\n1. 失败集中在解析层\n2. 输入里有多余空行\n3. 需要一个回归用例\n`;
}

/** 一条夹具会话的 jsonl 文本:轮次结构 = user →(assistant 文字+工具调用)→(工具结果)→ assistant 收尾。 */
function sessionLines(sid, cwd, { turns, long, label }) {
  const b = base(sid, cwd);
  const ts = (n) => new Date(Date.UTC(2026, 8, 15, 8, 0, 0) + n * 1000).toISOString();
  const lines = [{ type: 'summary', summary: label.slice(0, 40), leafUuid: `${sid}-u1` }];
  let parent = null;
  let clock = 0;
  const push = (o) => lines.push({ ...b, timestamp: ts(clock++), ...o });
  const assistant = (uuid, parentUuid, content, stop) => push({
    type: 'assistant', uuid, parentUuid, requestId: `req_${sid.slice(0, 8)}_${uuid}`,
    message: { id: `msg_${uuid}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content, stop_reason: stop, stop_sequence: null, usage: USAGE },
  });
  for (let i = 1; i <= turns; i += 1) {
    const uu = `${sid}-u${i}`;
    push({ type: 'user', uuid: uu, parentUuid: parent, message: { role: 'user', content: `${label} 第 ${i} 轮:继续排查这个失败,把相关的实现和用例都看一遍。` } });
    const au = `${sid}-a${i}`;
    const toolId = `toolu_${sid.slice(0, 8)}_${i}`;
    if (long) {
      const cmd = `npm test -- --reporter=verbose packages/pkg-${i} | tail -n ${Math.ceil(LONG_TOOL_CHARS / 100)}`;
      assistant(au, uu, [text(assistantText(i)), { type: 'tool_use', id: toolId, name: 'Bash', input: { command: cmd, description: `跑第 ${i} 轮相关的测试` } }], 'tool_use');
      const tu = `${sid}-t${i}`;
      push({
        type: 'user', uuid: tu, parentUuid: au,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: toolOutput(i, LONG_RESULT_CHARS), is_error: false }] },
      });
      const fu = `${sid}-f${i}`;
      assistant(fu, tu, [text(`${label} 第 ${i} 轮的结论:定位到解析层的空行处理,已记下下一步;这一轮到此为止。`)], 'end_turn');
      parent = fu;
    } else {
      assistant(au, uu, [text(`${label} 第 ${i} 轮:看了下,这里没什么问题,直接给结论。`)], 'end_turn');
      parent = au;
    }
  }
  // 末尾一条 user 之外,加一条结束标记(便于人工肉眼看夹具是否被完整读入)
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export function buildFixtures() {
  fs.mkdirSync(WORKSPACE_RAW, { recursive: true });
  const cwd = fs.realpathSync(WORKSPACE_RAW);   // 与服务端起假 CLI 时子进程拿到的 cwd 一致(防软链差异)
  const home = homeDir();
  const proj = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  for (const d of [proj, path.join(home, '.claude-gui'), fakeCtlDir(), fakebinDir()]) fs.mkdirSync(d, { recursive: true });

  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));

  let bytes = { long: 0, short: 0 };
  for (const s of [{ sid: NAV.sid, mark: NAV.mark, turns: 1, long: false }, { sid: B.sid, mark: B.mark, turns: 1, long: false }, ...LONGS, ...SHORTS]) {
    const body = sessionLines(s.sid, cwd, { turns: s.turns, long: !!s.long, label: s.mark });
    fs.writeFileSync(path.join(proj, `${s.sid}.jsonl`), body);
    if (s.long) bytes.long += body.length; else bytes.short += body.length;
  }

  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${suitePath('helpers', 'fake-claude.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return { home, cwd, proj, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildFixtures();
  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)}MB`;
  console.log(`[r119] 夹具就绪:HOME=${r.home} 项目=${r.cwd}`);
  console.log(`[r119] 长会话:${LONGS.length} 条 × ${LONG_TURNS} 轮(工具结果 ${LONG_RESULT_CHARS} 字符)共 ${mb(r.bytes.long)};`
    + `短会话:${SHORTS.length} 条 × ${SHORT_TURNS} 轮共 ${mb(r.bytes.short)}`);
}
