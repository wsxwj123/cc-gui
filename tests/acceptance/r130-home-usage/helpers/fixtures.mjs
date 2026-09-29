// r130 · 夹具:隔离 HOME + 几十字节的小 jsonl + 本地日期/时间换算。
// 依据只有 .devflow/BRIEF-r130.md 与 .devflow/INTERFACE-r130.md;没看实现代码。
// 铁规:所有写文件的路径必须落在本套件 .artifacts 之下,绝不碰真实 ~/.claude、~/.claude-gui。
// 时区:测试进程与实例进程都由 run.sh 注入 TZ=Asia/Shanghai(INTERFACE §0);本文件在被 import 时就核对。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R130_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
/** 断外网预载(复用 r128 的 helper,file:// URL 形式塞进 NODE_OPTIONS)。 */
export const noOutboundUrl = () => pathToFileURL(path.join(WORKTREE, 'tests', 'acceptance', 'r128-checkpoint-perf', 'helpers', 'no-outbound.mjs')).href;
export const TZ = 'Asia/Shanghai';

if (process.env.TZ !== TZ) throw new Error(`r130 测试进程必须 TZ=${TZ}(用 run.sh 跑;当前 TZ=${process.env.TZ || '(未设)'})`);

/** 安全阀:只允许写本套件 .artifacts 之下的路径。 */
export function assertIsolated(p) {
  const real = path.resolve(String(p || ''));
  const allowed = path.resolve(suitePath('.artifacts'));
  const userHome = path.resolve(os.homedir());
  if (!real.startsWith(allowed + path.sep)) throw new Error(`拒绝操作:路径「${real}」不在本套件 .artifacts(${allowed})之下`);
  if (real === userHome || real.startsWith(path.join(userHome, '.claude'))) throw new Error(`拒绝操作:路径「${real}」指向了真实家目录`);
  return real;
}

/** 干净的隔离 HOME:回环免密 + 压掉一次性浮层。projects 目录**不**预建(B5 要"目录缺失"的现场),写第一个会话时才 mkdir。 */
export function buildHome(home) {
  assertIsolated(home);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, '.claude-gui'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), '2026-09-21T00:00:00.000Z');
  return home;
}

/** 每条用例自己的数据根:<R130_DATA_ROOT>/<group>/<slug>/{home,*.log,*.pid} */
export function caseRoot(group, slug) {
  const root = path.join(dataRoot(), group, slug);
  assertIsolated(root);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const home = buildHome(path.join(root, 'home'));
  return { root, home };
}

export const projectsDir = (home) => path.join(home, '.claude', 'projects');
export const cachePath = (home) => path.join(home, '.claude-gui', 'usage-stats-cache.json');
export const PROJ = '-Users-r130-fixture-proj';        // 默认项目目录名(与真 CLI 同形:cwd 非字母数字换成 '-')
/** 会话 id 用十六进制 UUID 形(侧栏只列合法 id 的会话;接口层无所谓,但统一用它)。 */
export const sid = (n) => `c130${String(n).padStart(4, '0')}-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;

/** 文件落点(INTERFACE §0):直属 / 子代理 / workflow 再深一层。 */
export const sessionFile = (home, s, proj = PROJ) => path.join(projectsDir(home), proj, `${s}.jsonl`);
export const subagentFile = (home, s, name, proj = PROJ) => path.join(projectsDir(home), proj, s, 'subagents', `agent-${name}.jsonl`);
export const workflowFile = (home, s, wf, name, proj = PROJ) => path.join(projectsDir(home), proj, s, 'subagents', 'workflows', `wf_${wf}`, `agent-${name}.jsonl`);

/** 写 jsonl:每项是对象(JSON.stringify)或原样字符串(造坏行)。 */
export function writeJsonl(file, records) {
  assertIsolated(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`);
  return file;
}
export function appendJsonl(file, records) {
  assertIsolated(file);
  fs.appendFileSync(file, `${records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`);
}

// ── 记录形状(照 tests/acceptance 里已被产品认出来的夹具形状,只留聚合要看的字段)────────────
let seq = 0;
export const nextUuid = (tag = 'u') => `r130-${tag}-${++seq}-${process.pid}`;
/** 四项 token:[input, output, cacheRead, cacheWrite] → message.usage */
export const usageOf = ([i, o, cr, cw]) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
export const sum4 = ([i, o, cr, cw]) => i + o + cr + cw;
export const STD = [100, 20, 300, 40];    // 基准元组,合计 460

/** assistant 记录:有 message.usage 才算数;id 缺省自动唯一;ts 传 undefined = 无 timestamp。 */
export function assistant({ id, model = 'claude-sonnet-4-6', ts, uuid, u = STD, sidechain = false, sessionId = 'ignored-session-field' } = {}) {
  const rec = {
    parentUuid: null, isSidechain: sidechain, userType: 'external', cwd: '/Users/r130/fixture/proj', sessionId, version: '2.1.267',
    type: 'assistant', uuid: uuid ?? nextUuid('a'), timestamp: ts,
    message: { id: id ?? nextUuid('msg'), model, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'r130 夹具正文' }], stop_reason: 'end_turn', usage: usageOf(u) },
    requestId: 'req_r130',
  };
  if (ts === undefined) delete rec.timestamp;
  if (id === null) delete rec.message.id;
  if (uuid === null) delete rec.uuid;
  if (model === null) delete rec.message.model;
  return rec;
}
/** user 记录:text(字符串)或 content(数组)二选一;isMeta / sidechain 可控;uuid 传 null = 无 uuid。 */
export function user({ text = '你好,r130', content, ts, uuid, isMeta = false, sidechain = false, sessionId = 'ignored-session-field' } = {}) {
  const rec = {
    parentUuid: null, isSidechain: sidechain, userType: 'external', cwd: '/Users/r130/fixture/proj', sessionId, version: '2.1.267',
    type: 'user', uuid: uuid ?? nextUuid('u'), timestamp: ts, isMeta,
    message: { role: 'user', content: content ?? text },
  };
  if (ts === undefined) delete rec.timestamp;
  if (uuid === null) delete rec.uuid;
  return rec;
}
export const toolResultBlock = (id = 'toolu_r130') => ({ type: 'tool_result', tool_use_id: id, content: '(夹具)工具输出' });

// ── 本地日期 / 时间(进程 TZ=Asia/Shanghai,固定 +08:00,无夏令时)────────────────────────
const pad = (n) => String(n).padStart(2, '0');
export const localDayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** 本地"今天 - n 天"的 YYYY-MM-DD(按本地正午取,永不跨日)。n 可为负(未来日)。 */
export function dayAgo(n) {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n);
  return localDayOf(d);
}
export const today = () => dayAgo(0);
/** 某本地日期的本地 hh:mm → ISO UTC 串(夹具 timestamp 一律 UTC 串,INTERFACE §0)。 */
export const isoAt = (day, hh = 12, mm = 0) => new Date(`${day}T${pad(hh)}:${pad(mm)}:00+08:00`).toISOString();
/** 本地"今天 - n 天"的本地 hh:mm 的 ISO UTC 串。 */
export const tsAgo = (n, hh = 12, mm = 0) => isoAt(dayAgo(n), hh, mm);
/** 本地日期 → 星期(周一=0 … 周日=6)。 */
export const mondayIndex = (day) => (new Date(`${day}T12:00:00+08:00`).getDay() + 6) % 7;
/** 两个 YYYY-MM-DD 之间差几天(a - b)。 */
export const dayDiff = (a, b) => Math.round((Date.parse(`${a}T12:00:00+08:00`) - Date.parse(`${b}T12:00:00+08:00`)) / 86_400_000);

/** 空账 overview(INTERFACE §B-5a 逐字)。 */
export const EMPTY_OVERVIEW = { messages: 0, activeDays: 0, firstDay: null, lastActiveDay: null, currentStreak: 0, longestStreak: 0, hourCounts: Array(24).fill(0), peakHour: null, favoriteModel: null };
// r131:根键新增 byDayModel(day → model → 五项)与 ranges(7d/30d 窗口聚合)。
// 本组用例守的是"根上不许多出约定之外的键",新键进了 r131 的接口契约就该加进白名单。
export const ROOT_KEYS = ['total', 'byModel', 'byProject', 'byDay', 'meta', 'overview', 'byDayModel', 'ranges'];
export const TOTAL_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'sessionCount'];
export const BYDAY_OLD_KEYS = ['day', 'input', 'output', 'cacheRead', 'cacheWrite', 'calls'];
export const BYDAY_KEYS = [...BYDAY_OLD_KEYS, 'sessions', 'messages'];
export const OVERVIEW_KEYS = ['messages', 'activeDays', 'firstDay', 'lastActiveDay', 'currentStreak', 'longestStreak', 'hourCounts', 'peakHour', 'favoriteModel'];
export const dayRow = (body, day) => (body?.byDay || []).find((r) => r.day === day) ?? null;
