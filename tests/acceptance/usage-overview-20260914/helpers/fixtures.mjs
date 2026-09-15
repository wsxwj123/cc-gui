// 合成夹具:一份"几 MB、秒级跑完"的 ~/.claude/projects,外加一份**独立手算**的期望值表。
//
// 为什么要有期望值表:U4 只做「新旧两次跑出来的结果是否逐字段相等」,如果算账逻辑本身
// 错了,两次会一起错、U4 照样绿。所以这里在写字节的同一个循环里登记期望值 —— 每写一条
// 记录要么计入、要么显式标为「不该被计入的重复副本」,并写明理由。
//
// 布局(全部确定性,无随机):
//   <home>/.claude/projects/-p00..-p23 / s000..s042.jsonl        <- 24 项目 × 43 会话 = 1032
//   <home>/.claude/projects/-p00/s000/subagents/agent-{a,b}.jsonl
//   <home>/.claude/projects/-p00/s001/subagents/agent-{a,b}.jsonl  <- 4 个子代理转写(算钱不算会话)
//
// 基准记录元组(input/output/cacheRead/cacheWrite = 1000/200/5000/100)贯穿全夹具,
// 使期望值可手算;另有三类特殊记录在下面逐条注明。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.join(suiteDir, '.artifacts', 'runtime-data');
export const homeDir = () => path.join(ROOT, 'home');
export const projectsDir = () => path.join(homeDir(), '.claude', 'projects');
const manifestPath = () => path.join(ROOT, 'fixture-manifest.json');

export const PROJECT_COUNT = 24;
export const SESSIONS_PER_PROJECT = 43;
export const RECORDS_PER_FILE = 25;      // 每个文件里"算数的那条"的条数(重复副本替换其中最后一条)
const STD = { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 100 };
export const MODELS = ['claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805', 'deepseek-v3.2'];
export const DAYS = ['2026-09-14', '2026-09-13', '2026-09-12', '2026-09-11', '2026-09-10'];
export const FIXTURE_VERSION = 4;        // 改夹具布局/条数/期望值表(含新增的逐行锚点)必须 +1,否则会复用旧清单

const projName = (i) => `-p${String(i).padStart(2, '0')}`;
const modelFor = (i) => (i < 12 ? MODELS[0] : (i < 18 ? MODELS[1] : MODELS[2]));

// 重复 message.id 的三个案例(跨文件去重规则:留 token 总量最大的那条,与出现顺序无关)。
// 每个案例的两条记录各自落在哪个文件、谁的 tuple 是什么,都写在文件末尾的注释里。
const DUP = [
  // a:先出现的副本小(630),后出现在别的文件里的是基准 tuple(6300)-> 应当留后者
  { id: 'dup_a', loser: { at: [0, 1], u: { input: 100, output: 20, cacheRead: 500, cacheWrite: 10 }, why: '总量 630 < 6300' }, winner: { at: [5, 3], u: STD, why: '总量 6300' } },
  // b:先出现的大(7000),后出现的才是基准 tuple(6300)-> 应当留前者("不是先到先得")
  { id: 'dup_b', winner: { at: [1, 2], u: { input: 5000, output: 2000, cacheRead: 0, cacheWrite: 0 }, why: '总量 7000' }, loser: { at: [9, 7], u: STD, why: '总量 6300 < 7000' } },
  // c:逐字节完全相同的跨文件抄本(续接/分叉会话的真实形态)-> 只算一次
  { id: 'dup_c', winner: { at: [2, 3], u: STD, why: '两副本逐字节相同,留任一' }, loser: { at: [13, 11], u: STD, why: '与前一副本完全相同' } },
];

const dupAt = new Map(); // "p,s" -> { id, role }
for (const d of DUP) {
  dupAt.set(d.winner.at.join(','), { id: d.id, role: 'winner' });
  dupAt.set(d.loser.at.join(','), { id: d.id, role: 'loser' });
}
// 两条例外记录(不在基准循环里,单独追加;都不是重复副本,必须各算一次)
const NO_ID_AT = [23, 42];     // 没有 message.id -> 无从去重,直接计入(不进 bestById)
const NO_TS_AT = [7, 10];      // 没有 timestamp -> 落到 byDay 的 'unknown' 桶

let uuidSeq = 0;
function assistantLine({ id, model, day, hour, u, ts }) {
  const rec = {
    type: 'assistant',
    uuid: `u-${uuidSeq++}`,
    timestamp: ts,
    message: { id, model, type: 'message', role: 'assistant', usage: {
      input_tokens: u.input, output_tokens: u.output,
      cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite,
    }, content: [{ type: 'text', text: `${modelFor(0)} 夹具正文 ${'x'.repeat(120)}` }] },
  };
  if (id === undefined) delete rec.message.id;
  if (ts === undefined) delete rec.timestamp;
  return JSON.stringify(rec);
}

/**
 * 磁盘实测:jsonl 文件数与总字节数。用来对账清单里记的 `stats.files/bytes`。
 *
 * 为什么非要对账:U3b 会**就地改夹具**(追加一行,finally 里按长度截断还原)。若进程挂在
 * "追加之后、截断之前"(断言失败后崩、被 Ctrl-C、被 OOM 杀),夹具就永久多一行 —— 之后每次
 * 跑都是无法解释的假红(U6a 手算期望与实际对不上),而且没人会想到去怀疑夹具。清单里本来
 * 就记着这两个数,对一下即可当场判定"磁盘漂移"并重造。
 */
export function measureProjects() {
  let files = 0, bytes = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) { files++; bytes += fs.statSync(p).size; }
    }
  };
  try { walk(projectsDir()); } catch { return null; }
  return { files, bytes };
}

/** 生成夹具(幂等:清单对得上、且磁盘没有漂移,就不重写)。返回 { expected, stats }。 */
export function ensureFixture({ force = false } = {}) {
  const stats = { files: 0, bytes: 0, generationMs: 0 };
  if (!force) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
      if (m.version === FIXTURE_VERSION && fs.existsSync(projectsDir())) {
        const onDisk = measureProjects();
        if (onDisk && onDisk.files === m.stats.files && onDisk.bytes === m.stats.bytes) {
          return { expected: m.expected, stats: m.stats, reused: true };
        }
        console.log(`[fixture] 清单对得上但磁盘已漂移(实测 ${onDisk?.files} 文件 / ${onDisk?.bytes}B,`
          + `清单 ${m.stats.files} / ${m.stats.bytes})—— 上一次跑很可能挂在 U3b 的"追加→截断还原"之间,重造夹具`);
      }
    } catch { /* 没清单或坏了:重造 */ }
  }
  const t0 = Date.now();
  fs.rmSync(path.join(homeDir(), '.claude'), { recursive: true, force: true });
  fs.mkdirSync(projectsDir(), { recursive: true });

  const emptyTotals = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });
  const byModel = {}, byProject = {}, byDay = {};
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessionCount: 0 };
  const skippedLosers = [];
  const bump = (bucket, key, u) => {
    if (!bucket[key]) bucket[key] = emptyTotals();
    const b = bucket[key];
    b.input += u.input; b.output += u.output; b.cacheRead += u.cacheRead; b.cacheWrite += u.cacheWrite; b.calls++;
  };
  // 登记一条"算数的"记录。byPeriod(分时段桶)不手算 —— 它随计价规则走,U4 的往返比对覆盖。
  const count = (model, project, day, u) => {
    total.input += u.input; total.output += u.output;
    total.cacheRead += u.cacheRead; total.cacheWrite += u.cacheWrite;
    bump(byModel, model, u);
    bump(byProject, project, u);
    bump(byDay, day, u);
  };

  const write = (dir, name, lines) => {
    const body = lines.join('\n') + '\n';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
    stats.files++;
    stats.bytes += Buffer.byteLength(body);
  };

  let fileSeq = 0;
  for (let p = 0; p < PROJECT_COUNT; p += 1) {
    const pdir = path.join(projectsDir(), projName(p));
    for (let s = 0; s < SESSIONS_PER_PROJECT; s += 1) {
      const model = modelFor(p);
      const day = DAYS[fileSeq % DAYS.length];
      const hour = fileSeq % 2 ? '02' : '14';
      const ts = `${day}T${hour}:00:00.000Z`;
      const lines = [];
      for (let i = 0; i < RECORDS_PER_FILE; i += 1) {
        const key = `${p},${s}`;
        const dup = i === RECORDS_PER_FILE - 1 ? dupAt.get(key) : null;
        if (dup) {
          if (dup.role === 'winner') { lines.push(assistantLine({ id: dup.id, model, ts, u: STD })); count(model, projName(p), day, STD); }
          else {
            const d = DUP.find((x) => x.id === dup.id);
            lines.push(assistantLine({ id: dup.id, model, ts, u: d.loser.u }));
            skippedLosers.push({ id: dup.id, at: key, u: d.loser.u, why: d.loser.why });
          }
        } else {
          lines.push(assistantLine({ id: `msg_${p}_${s}_${i}`, model, ts, u: STD }));
          count(model, projName(p), day, STD);
        }
      }
      // 每个文件再塞三条"不该被算"的行:非 assistant、无 usage、坏 JSON。
      lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: '夹具提问' } }));
      lines.push(JSON.stringify({ type: 'assistant', message: { id: `nousage_${p}_${s}`, model, content: [] } }));
      lines.push('{"type":"assistant","message":{"id":"broken_');
      if (p === NO_ID_AT[0] && s === NO_ID_AT[1]) {
        // 无 message.id:无从去重 -> 必须直接计入
        lines.push(assistantLine({ model, ts, u: STD }));
        count(model, projName(p), day, STD);
      }
      if (p === NO_TS_AT[0] && s === NO_TS_AT[1]) {
        // 无 timestamp:day 落 'unknown'(不许拿"现在"顶替)
        lines.push(assistantLine({ id: `nots_${p}_${s}`, model, u: STD }));
        count(model, projName(p), 'unknown', STD);
      }
      write(pdir, `s${String(s).padStart(3, '0')}.jsonl`, lines);
      total.sessionCount++;
      fileSeq++;
    }
  }
  // 子代理转写:算钱、不算会话(不在这里 sessionCount++)
  const subRoot = path.join(projectsDir(), projName(0));
  for (const s of [0, 1]) {
    const model = modelFor(0);
    const day = DAYS[(s + 1) % DAYS.length];
    for (const n of ['a', 'b']) {
      const lines = [];
      for (let i = 0; i < RECORDS_PER_FILE; i += 1) {
        lines.push(assistantLine({ id: `sub_${s}_${n}_${i}`, model, ts: `${day}T14:00:00.000Z`, u: STD }));
        count(model, projName(0), day, STD);
      }
      write(path.join(subRoot, `s00${s}`, 'subagents'), `agent-${n}.jsonl`, lines);
    }
  }

  // 逐行锚点:byProject / byDay 的每一行都手算,不只锚行数。
  // 只锚 total / byModel 时,"按项目张冠李戴"(例如把 -p07 的行写到 -p13 名下)能同时骗过
  // U4(往返一致:两边一起错)与 U6a(行数对、日期序列对)—— 行内数值才是判据。
  // 键名与 /api/usage 的响应一致:byProject 行用 hash、byDay 行用 day。
  const toRows = (bucket, keyName) => Object.entries(bucket)
    .map(([k, v]) => ({ [keyName]: k, ...v }))
    .sort((a, b) => (b.input + b.output) - (a.input + a.output));

  const expected = {
    total,
    byModel: Object.entries(byModel).map(([model, v]) => ({ model, ...v })).sort((a, b) => (b.input + b.output) - (a.input + a.output)),
    byDay: DAYS.concat(['unknown']).sort((a, b) => b.localeCompare(a)),
    byProjectRows: toRows(byProject, 'hash'),          // 24 行全部;响应只回前 20 行(截断规则见 note)
    byDayRows: toRows(byDay, 'day'),                   // 6 行(5 天 + unknown)
    byProjectCount: PROJECT_COUNT,                     // /api/usage 只回前 20 行
    byProjectLimit: 20,
    byDayCount: DAYS.length + 1,
    skippedLosers,
    note: 'byPeriod 桶不手算(随计价规则走,U4 的往返比对覆盖);byProject 被截断到 20 行,'
      + '截断规则 = 按 (input+output) 降序取前 20,本夹具在第 20/21 名处有并列(19 个项目 token 相同),'
      + '所以测试对它只做"被截掉的不比留下的多"这种不依赖并列次序的断言。',
  };
  stats.generationMs = Date.now() - t0;
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify({ version: FIXTURE_VERSION, generatedAt: new Date().toISOString(), expected, stats }, null, 2));
  return { expected, stats, reused: false };
}

// 直接跑本文件 = 铺夹具并把期望值表打出来(路径带空格,不能用字符串拼 file:// 比)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = ensureFixture({ force: process.argv.includes('--force') });
  console.log(JSON.stringify({ reused: r.reused, stats: r.stats, expected: r.expected }, null, 2));
}
