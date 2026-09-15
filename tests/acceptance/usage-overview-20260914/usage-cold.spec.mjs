// 用量总览冷启动验收 U1~U7 + U10(判据见同目录 README / .devflow/BRIEF-20260914-usage-cold.md §4)
//
//   ./run-isolated.sh                 # 本文件(夹具口径,U1~U7 秒级)
//
// 隔离:自己的端口、自己的 HOME(.artifacts/runtime-data/home*)、按 pid 杀进程。
// 只读产品代码,一个字节都不改产品;红是预期结果,不是叫你去改实现。
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { test, group, summary, assertEq, assertTrue, assertLt, firstDiff, diffFields } from './helpers/harness.mjs';
import { ensureFixture, projectsDir, ROOT } from './helpers/fixtures.mjs';
import { mainHome, scratchHome, rmHome, startInstance, stopInstance, getUsage, getUsageConcurrent, cpuMs, cachePath, readCache, writeCache, rmCache, waitForCache, cacheStat, scanProbe, sleep, CACHE_NAME } from './helpers/runtime.mjs';

const PROBE_MODEL = 'claude-opus-9-fixture-probe';   // 造 sig 不一致用的独有模型名
const PROBE_INPUT = 7_000_000;
const ROOT_KEYS_OK = new Set(['total', 'byModel', 'byProject', 'byDay', 'meta']);
const BOOT_QUIET_MS = 13_000;   // 实例启动后到"CPU 噪声带过去"的等待;窗口不许落在前 10 秒里(见 U3a)
const WINDOW_MS = 3000;         // U3a 的观测窗口长度(基线窗口同长)

const fmt = (n, d = 1) => Number(n).toFixed(d);
const instances = [];

/** 起一个实例并登记,跑完统一按 pid 收尾。 */
async function boot(home, label) {
  const inst = await startInstance({ home, label });
  instances.push(inst);
  return inst;
}
async function down(inst) {
  await stopInstance(inst);
  const i = instances.indexOf(inst);
  if (i >= 0) instances.splice(i, 1);
}
/** 兜底:异常退出时按记录下来的 pid 杀干净(绝不按名字杀)。 */
function killAll() {
  for (const inst of instances.splice(0)) {
    try { process.kill(inst.pid, 'SIGKILL'); } catch { /* 已经退了 */ }
  }
}
process.on('exit', killAll);

// ── 0. 夹具 + 基准 ──────────────────────────────────────────────────────
group('0. 夹具与基准');
const { expected, stats, reused } = ensureFixture();
console.log(`[fixture] ${stats.files} 个 jsonl / ${(stats.bytes / 1048576).toFixed(1)}MB / 生成 ${stats.generationMs}ms / ${reused ? '复用清单' : '本次新造'}`);
console.log(`[fixture] 手算期望 total = ${JSON.stringify(expected.total)}`);

const coldHomeA = scratchHome('probe1');            // 无缓存 → 单次冷扫基准
const coldHomeB = scratchHome('probe2');            // 无缓存 → 并发探针(U1)
const probe1 = scanProbe(coldHomeA, 1);
const scanMs = probe1.concurrentMs;
const probeN = scanProbe(coldHomeB, 5);
console.log(`[baseline] 单次冷扫(进程内) ${fmt(scanMs)}ms | 5 并发冷扫 ${fmt(probeN.concurrentMs)}ms, distinctRefs=${probeN.distinctRefs}`);

// 「秒回」阈值:一次全扫的一半。分母取"进程内冷扫"与"服务端冷路径请求"的较小值 ——
// 后者与 U2 量的是同一条 HTTP 路径,拿它当分母才不会因为探测口径不同而放松判据。
let coldMs0 = scanMs;
const fastThreshold = () => Math.min(scanMs, coldMs0) / 2;

// ── U1:冷态并发合流(模块级)─────────────────────────────────────────────
group('U1 冷态 N 并发只扫一遍(同一对象引用)');
await test('U1', '冷态 5 并发 getUsageStats() 返回同一个对象引用', () => {
  assertTrue(probe1.total.input > 0, '探针拿到的 total.input 必须是正数(夹具没读到就是环境错)');
  assertTrue(probeN.sameRef, `5 次并发调用返回了 ${probeN.distinctRefs} 个不同对象(未合流:每次各自扫一遍全盘)`);
  return `并发墙钟 ${fmt(probeN.concurrentMs)}ms / 单次冷扫 ${fmt(scanMs)}ms = ${fmt(probeN.concurrentMs / scanMs, 2)}×`;
});

// ── U1b:HTTP 冷态并发(用户真实路径:加载中关面板再打开)────────────────
group('U1b HTTP 冷态并发三发(分母换成同口径的 HTTP 单发冷请求)');
{
  // 【这一版为什么要改分母】上一版拿**另一个进程**里的单次冷扫(探针 scanMs)当分母,而分子是
  // HTTP 三并发。两者各自 ±30%~50% 抖动、互不相关,同一份(已修好的)代码 7 次跑出
  // 0.83 / 1.53 / 0.87 / 1.34 / 1.08 / 1.02× —— 阈值 1.5× 正好压在分布中间,是硬币。
  // 现在分母改成"另一台同样无缓存实例上的一次 HTTP 冷请求",与分子同路径、同夹具、
  // 同机器状态;两者只差"并发数"这一个变量。
  // 不能在同一台实例上先单发再三并发:第一次请求就把缓存填上了,之后的 3 发走热路径,测不到冷态。
  const homeSingle = scratchHome('http-cool-single');
  const instSingle = await boot(homeSingle, 'u1b-single');
  const single = await getUsage();
  const coldHttpMs = single.ms;
  await down(instSingle);
  rmHome(homeSingle);

  const home = scratchHome('http-cool');
  const inst = await boot(home, 'u1b-cold');
  await test('U1b', '冷态 3 并发 /api/usage:内容一致,墙钟 < 同口径单发冷请求的 1.5 倍(合流的权威判据是 U1)', async () => {
    // 分母自检:单发必须真的是冷扫。它若是缓存命中(几十毫秒),比值会被撑大 → 假红。
    assertTrue(single.status === 200 && single.body, `单发基准 HTTP ${single.status}: ${single.text.slice(0, 120)}`);
    assertTrue(coldHttpMs > scanMs * 0.3,
      `单发基准只花 ${fmt(coldHttpMs)}ms,远低于探针的冷扫基准 ${fmt(scanMs)}ms —— 它不是冷路径,分母不成立`);
    const { ms, results } = await getUsageConcurrent(3);
    for (const r of results) assertTrue(r.status === 200, `HTTP ${r.status}: ${r.text.slice(0, 120)}`);
    for (let i = 1; i < results.length; i += 1) {
      const d = firstDiff(results[i].body, results[0].body, `resp[${i}]`);
      assertTrue(!d, `并发响应内容不一致: ${d}`);
    }
    assertTrue(results[0].body.total?.input === expected.total.input, `total.input=${results[0].body.total?.input} != 期望 ${expected.total.input}`);
    // 阈值 1.5×:分母换成同口径之后,两边的分布才第一次可测 ——
    // 合流实测 0.94 / 0.97 / 1.00 / 1.02×,未合流(摘掉合流)实测 2.05 / 2.05 / 2.11 / 2.12×。
    // 1.5× 距两边各 37%,不再跨在抖动带里(旧版跨进程口径下同一份代码能跑出 0.83~1.53×)。
    // 另:未合流时三发的 meta.scannedAt 必然不同(每次重算各产一个时刻),上一条内容断言会先红。
    assertLt(ms, coldHttpMs * 1.5,
      `3 并发墙钟(${fmt(ms)}ms)应小于同口径单发冷请求(${fmt(coldHttpMs)}ms)的 1.5 倍(${fmt(coldHttpMs * 1.5)}ms)`);
    return `3 并发 ${fmt(ms)}ms / 同口径单发冷请求 ${fmt(coldHttpMs)}ms = ${fmt(ms / coldHttpMs, 2)}×`;
  });
  await down(inst);
  rmHome(home);
}

// ── 主生命周期:U6(无缓存冷路径)→ U2(磁盘回放)→ U4(往返)→ U3(sig 两条)→ U10 ──
let R_fresh = null, coldMs = 0, coldCpuMs = null, u3aLimit = null;

group('U6 无缓存文件 → 走冷路径(行为与今天一致)');
{
  const home = mainHome();
  rmCache(home);
  const inst = await boot(home, 'main-cold');
  const before = cpuMs(inst.pid);
  const r = await getUsage();
  coldCpuMs = before === null ? null : cpuMs(inst.pid) - before;
  coldMs = r.ms;
  coldMs0 = r.ms;
  R_fresh = r.body;
  console.log(`[main] 冷路径请求 ${fmt(r.ms)}ms,服务端 CPU ${coldCpuMs === null ? 'n/a' : `${fmt(coldCpuMs)}ms`}`);

  await test('U0', '隔离实例可用:冷路径 200 且读到夹具(后续所有断言的前提)', () => {
    assertTrue(r.status === 200, `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    assertTrue(r.body && r.body.total, `响应不是预期形状: ${r.text.slice(0, 200)}`);
    assertTrue(r.body.total.input > 0, 'total.input 为 0 —— 夹具没被读到,后面全是假红/假绿');
    return `total.input=${r.body.total.input} sessionCount=${r.body.total.sessionCount}`;
  });
  if (!R_fresh?.total) {
    console.log('\n[中止] 冷路径都拿不到数据,后续用例的前提不成立');
    process.exit(summary('usage-overview-20260914 U1~U7+U10'));
  }

  await test('U6a', '无缓存文件时冷扫结果 = 独立手算期望(total/byModel/byProject/byDay 逐行)', () => {
    assertEq(R_fresh.total, expected.total, 'total');

    // byProject:4 类明细字段逐行锚(手算),不只锚行数 —— 只锚行数时"把 -p07 的数写到 -p13
    // 名下"照样绿,而 U4 的往返比对是"两边一起错",也拦不住。
    const rows = R_fresh.byProject || [];
    assertTrue(rows.length === expected.byProjectLimit,
      `byProject 应截断到 ${expected.byProjectLimit} 行(夹具 ${expected.byProjectCount} 个项目),实际 ${rows.length}`);
    const wantByHash = new Map(expected.byProjectRows.map((r) => [r.hash, r]));
    const seen = new Set();
    for (const row of rows) {
      const want = wantByHash.get(row.hash);
      assertTrue(want, `byProject 里出现夹具根本没有的项目 ${JSON.stringify(row.hash)}`);
      assertTrue(!seen.has(row.hash), `byProject 里项目 ${row.hash} 出现两次`);
      seen.add(row.hash);
      const d = diffFields(row, want, ['input', 'output', 'cacheRead', 'cacheWrite', 'calls'], `byProject[${row.hash}]`);
      assertTrue(!d, `byProject 逐行数值与手算不符: ${d}`);
    }
    // 截断规则(不依赖并列次序):留下的每一行都不比被截掉的差。夹具在第 20/21 名处是并列的
    // (19 个项目 token 数相同),所以只断言这个不依赖次序的性质。
    const minKept = Math.min(...rows.map((r) => r.input + r.output));
    for (const r of expected.byProjectRows.filter((x) => !seen.has(x.hash))) {
      assertTrue(r.input + r.output <= minKept,
        `被截掉的 ${r.hash}(input+output=${r.input + r.output})比留下的最小行(${minKept})还大 —— 截断取错了行`);
    }

    // byDay:日期序列对不代表"每天的数对",逐行按 day 锚数值
    const days = R_fresh.byDay || [];
    assertEq(days.map((d) => d.day), expected.byDay, 'byDay 日期序列');
    assertTrue(days.length === expected.byDayRows.length, `byDay 行数 ${days.length} != ${expected.byDayRows.length}`);
    const wantByDay = new Map(expected.byDayRows.map((r) => [r.day, r]));
    for (const row of days) {
      const want = wantByDay.get(row.day);
      assertTrue(want, `byDay 里出现夹具根本没有的日期 ${JSON.stringify(row.day)}`);
      const d = diffFields(row, want, ['input', 'output', 'cacheRead', 'cacheWrite', 'calls'], `byDay[${row.day}]`);
      assertTrue(!d, `byDay 逐行数值与手算不符: ${d}`);
    }

    const got = [...(R_fresh.byModel || [])].sort((a, b) => (b.input + b.output) - (a.input + a.output));
    const want = [...expected.byModel].sort((a, b) => (b.input + b.output) - (a.input + a.output));
    assertTrue(got.length === want.length, `byModel 行数 ${got.length} != ${want.length}`);
    for (let i = 0; i < want.length; i += 1) {
      // byPeriod 不手算(随计价规则走),只比行合计与条数(避免 firstDiff 因多出键先报形状差)
      const d = diffFields(got[i], want[i], ['model', 'input', 'output', 'cacheRead', 'cacheWrite', 'calls'], `byModel[${i}]`);
      assertTrue(!d, `byModel 明细不一致: ${d}`);
      assertTrue(got[i].byPeriod && typeof got[i].byPeriod === 'object', `byModel 行缺 byPeriod(既有字段形状被改): ${JSON.stringify(got[i]).slice(0, 160)}`);
    }
    return `${expected.byModel.length} 个模型 / ${expected.byDayRows.length} 个日期逐行 / ${rows.length} 个项目逐行(共 ${expected.byProjectCount} 个) / total.input=${expected.total.input}`;
  });

  await test('U6b', '不新增既有字段之外的根字段(只许新增 meta)', () => {
    const extra = Object.keys(R_fresh).filter((k) => !ROOT_KEYS_OK.has(k));
    assertTrue(!extra.length, `根上多出未约定字段: ${extra.join(',')}`);
    return `根字段 ${Object.keys(R_fresh).join(',')}`;
  });

  await test('U6c', '冷扫后落盘缓存(否则 U2 的磁盘回放无从谈起)', async () => {
    const raw = await waitForCache(home);
    assertTrue(raw, `冷扫返回后 8 秒内没出现 ${cachePath(home)}`);
    const parsed = (() => { try { return JSON.parse(raw); } catch { return null; } })();
    assertTrue(parsed && parsed.data, '缓存文件不是合法 JSON 或缺 data');
    return `${CACHE_NAME} ${raw.length}B`;
  });

  await test('U6d', '冷路径不是磁盘回放:meta.stale 必须为 false', () => {
    assertTrue(R_fresh.meta && typeof R_fresh.meta.stale === 'boolean', `响应缺 meta.stale(实际 ${JSON.stringify(R_fresh.meta)})`);
    assertTrue(R_fresh.meta.stale === false, `无缓存文件的冷扫却报 stale=${R_fresh.meta.stale}(把新算的数当旧数);scannedAt=${R_fresh.meta.scannedAt}`);
    assertTrue(typeof R_fresh.meta.scannedAt === 'number' && R_fresh.meta.scannedAt > 0, `meta.scannedAt 应为正数时间戳,实际 ${JSON.stringify(R_fresh.meta.scannedAt)}`);
    return `stale=false scannedAt=${new Date(R_fresh.meta.scannedAt).toISOString()}`;
  });

  await test('U6e', '冷路径确实在做全盘扫描(计时口径自检)', () => {
    assertTrue(coldMs >= scanMs * 0.3, `冷路径只花 ${fmt(coldMs)}ms,远低于基准全扫 ${fmt(scanMs)}ms —— 计时口径或夹具读数有问题,后面的"秒回"断言会变成空断言`);
    return `冷路径 ${fmt(coldMs)}ms vs 基准 ${fmt(scanMs)}ms`;
  });

  await down(inst);
}

// U2 + U4a + U3-match:同一台"刚重启、磁盘缓存与夹具 sig 一致"的实例上连做
let replayBody = null;
group('U2 新进程首请求走磁盘缓存');
{
  const home = mainHome();
  const inst = await boot(home, 'main-replay');
  const r1 = await getUsage();
  replayBody = r1.body;
  await test('U2', '重启后首请求:远快于一次全扫 + meta.stale=true', () => {
    assertTrue(r1.status === 200 && r1.body, `HTTP ${r1.status}: ${r1.text.slice(0, 200)}`);
    // 先报耗时:这条判据的头条是"秒回",元数据只是佐证,顺序反了会让红的信息量变少
    assertLt(r1.ms, fastThreshold(), `重启后首请求 ${fmt(r1.ms)}ms 应 < ${fmt(fastThreshold())}ms(一次全扫的一半;等于全扫说明没走磁盘缓存)`);
    assertTrue(r1.body.meta && r1.body.meta.stale === true, `重启后首请求应回放磁盘值(meta.stale=true),实际 meta=${JSON.stringify(r1.body.meta)}`);
    return `${fmt(r1.ms)}ms(全扫 ${fmt(scanMs)}ms 的 ${fmt(r1.ms / scanMs, 2)}×)`;
  });

  await test('U4a', '持久化往返:total/byModel/byProject/byDay 与冷算结果逐字段相等', () => {
    assertTrue(R_fresh && replayBody, '缺少冷算或回放结果');
    assertTrue(R_fresh.total.input > 0, '冷算结果是空账,比对无意义');
    const keys = ['total', 'byModel', 'byProject', 'byDay'];
    for (const k of keys) {
      const d = firstDiff(replayBody[k], R_fresh[k], `$.${k}`);
      assertTrue(!d, `往返后 ${k} 不一致: ${d}`);
    }
    return `byModel ${replayBody.byModel.length} 行 / byProject ${replayBody.byProject.length} 行 / byDay ${replayBody.byDay.length} 行 全部相等`;
  });

  await test('U3a', '磁盘 sig 与当前一致 → 不触发后台重扫(观测窗口内 CPU 不动 / scannedAt 不前进)', async () => {
    assertTrue(replayBody.meta && typeof replayBody.meta.scannedAt === 'number',
      `U3a 的客观可观测量是 meta.scannedAt,响应里没有: meta=${JSON.stringify(replayBody.meta)}`);
    // scannedAt 从**首次(磁盘回放)请求**那一刻起算,不是从窗口起算:等待期间若有人乱扫,这里也看得见
    const scanned0 = replayBody.meta.scannedAt;
    // ps 拿不到 CPU 时必须当场报环境错 —— null-null 在 JS 里是 0,会静默变成一条空断言
    const cpu = () => {
      const v = cpuMs(inst.pid);
      assertTrue(v !== null, 'ps 拿不到服务端自身 CPU 时间(环境问题,不是产品红)');
      return v;
    };
    // 【观测窗口必须挪出实例启动后的头十几秒】pricing-catalog 的多源定时刷新在启动后本来就在
    // 烧 CPU:实测每 3 秒窗口 60~90ms,而上限公式的地板只有 30ms —— 窗口落在那段里,断言量的是
    // 无关噪声(只要 coldCpuMs 被测成 ~90ms,上限 30ms 立刻在噪声上翻红)。
    const since = Date.now() - inst.spawnedAt;
    if (since < BOOT_QUIET_MS) {
      console.log(`[u3a] 等启动噪声过去(再等 ${fmt((BOOT_QUIET_MS - since) / 1000)}s 再量 CPU)`);
      await sleep(BOOT_QUIET_MS - since);
    }
    // 两段窗口:先量一段空闲基线(本机此刻的噪声底),再量观测窗口。不写死地板值 ——
    // 噪声随机器与时刻变,现量一段最省事也最诚实。
    const b0 = cpu();
    await sleep(WINDOW_MS);
    const baseDelta = cpu() - b0;
    const c0 = cpu();
    await sleep(WINDOW_MS);
    const cpuDelta = cpu() - c0;
    const r2 = await getUsage();
    assertTrue(r2.status === 200, `窗口后请求 HTTP ${r2.status}`);
    const scanCpu = coldCpuMs ?? scanMs;
    // 上限 = max(150ms 地板, 一次全扫 CPU 的一半, 实测基线 + 60ms 余量)。
    // 分离度:重扫一次全盘实测 220~380ms CPU,本机噪声 ≤90ms → 2 倍以上,两边都留得住。
    const limit = Math.max(150, scanCpu / 2, baseDelta + 60);
    u3aLimit = limit;   // U3b 拿它做"这条 CPU 断言看得见一次真重扫吗"的分离度对照
    const scanned1 = r2.body?.meta?.scannedAt;
    assertTrue(scanned1 === scanned0, `scannedAt 从 ${scanned0} 变成 ${scanned1} —— 首次请求之后发生了重算(数据没变不该重扫)`);
    assertLt(cpuDelta, limit, `${fmt(WINDOW_MS / 1000)} 秒窗口内服务端 CPU 涨了 ${fmt(cpuDelta)}ms`
      + `(上限 ${fmt(limit)}ms = max(地板 150, 全扫 CPU ${fmt(scanCpu)} 的一半, 基线 ${fmt(baseDelta)}+60);`
      + `重扫一次约 ${fmt(scanCpu)}ms)`);
    assertLt(r2.ms, fastThreshold(), `窗口后请求 ${fmt(r2.ms)}ms`);
    return `基线 Δ${fmt(baseDelta)}ms / 观测 Δ${fmt(cpuDelta)}ms(上限 ${fmt(limit)}ms)/ scannedAt 未变 / ${fmt(r2.ms)}ms`;
  });

  await down(inst);
}

// U4b:再重启一次仍然一模一样(第二次读盘不重排、不掉精度)
group('U4b 再次重启往返仍相等');
{
  const home = mainHome();
  const inst = await boot(home, 'main-replay2');
  const r = await getUsage();
  await test('U4b', '第二次读盘:total/byModel/byProject/byDay 仍与冷算结果逐字段相等', () => {
    assertTrue(r.status === 200 && r.body, `HTTP ${r.status}`);
    for (const k of ['total', 'byModel', 'byProject', 'byDay']) {
      const d = firstDiff(r.body[k], R_fresh[k], `$.${k}`);
      assertTrue(!d, `第二次往返后 ${k} 不一致: ${d}`);
    }
    return `stale=${r.body.meta?.stale} ${fmt(r.ms)}ms`;
  });
  await down(inst);
}

// U3b:磁盘 sig 与当前不一致 → 触发重扫,但仍秒回
group('U3b 磁盘 sig 不一致 → 后台重扫,首请求仍秒回');
{
  const home = mainHome();
  const target = path.join(projectsDir(), '-p23', 's042.jsonl');
  const sizeBefore = fs.statSync(target).size;
  const cacheMtimeBefore = cacheStat(home)?.mtimeMs;
  // 追加一条独有记录:文件大小与 mtime 都变 → mtime 签名必然变
  const probeLine = JSON.stringify({
    type: 'assistant', uuid: 'u-probe', timestamp: '2026-09-14T14:00:00.000Z',
    message: { id: 'msg_probe_sig', model: PROBE_MODEL, usage: { input_tokens: PROBE_INPUT, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
  fs.appendFileSync(target, probeLine + '\n');
  console.log(`[u3b] 夹具动了:${path.basename(target)} +1 行(${PROBE_MODEL})`);

  const wsMsgs = [];
  const inst = await boot(home, 'main-mismatch');
  const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/ws`);
  ws.on('message', (buf) => { try { wsMsgs.push(JSON.parse(String(buf))); } catch { /* 非 JSON 帧忽略 */ } });
  ws.on('error', () => { /* 连不上不影响 U3b,由 U10 报 */ });
  await sleep(300);

  let firstMs = 0, convergedMs = null, reqCount = 1;
  try {
    await test('U3b', 'sig 不一致时首请求返回旧值仍秒回,随后自动收敛到新值', async () => {
      // 分离度对照(顺带量,不作判据):这一次后台**真的**重扫了。量它烧掉多少 CPU,
      // 与 U3a 的上限比一比 —— 若"真重扫"的 CPU 消耗压在 U3a 上限以下,那条断言就是摆设。
      const cpuBefore = cpuMs(inst.pid);
      const r1 = await getUsage();
      firstMs = r1.ms;
      assertTrue(r1.status === 200 && r1.body, `HTTP ${r1.status}`);
      assertTrue(r1.body.meta && r1.body.meta.stale === true, `应有磁盘回放(meta.stale=true),实际 ${JSON.stringify(r1.body.meta)}`);
      assertLt(r1.ms, fastThreshold(), `首请求 ${fmt(r1.ms)}ms 应 < ${fmt(fastThreshold())}ms`);
      const t0 = Date.now();
      let body = r1.body;
      while (Date.now() - t0 < 10_000) {
        await sleep(250);
        const r = await getUsage();
        reqCount += 1;
        body = r.body;
        if (body?.byModel?.some((m) => m.model === PROBE_MODEL)) { convergedMs = Date.now() - t0; break; }
      }
      assertTrue(convergedMs !== null, `${PROBE_MODEL} 在 10 秒内没出现在 byModel 里(后台重扫没触发或没落数)`);
      const row = body.byModel.find((m) => m.model === PROBE_MODEL);
      assertTrue(row.input === PROBE_INPUT, `新记录 input=${row.input} != ${PROBE_INPUT}`);
      console.log(`[u3b] 收敛耗时 ${convergedMs}ms,收敛前最后一发 stale=${body.meta?.stale}`);
      assertLt(firstMs, fastThreshold(), `首请求 ${fmt(firstMs)}ms`);
      const cpuAfter = cpuMs(inst.pid);
      const rescanCpu = (cpuBefore === null || cpuAfter === null) ? null : cpuAfter - cpuBefore;
      console.log(`[u3b] 这次真重扫的 CPU Δ${rescanCpu === null ? 'n/a' : `${fmt(rescanCpu)}ms`}`
        + `,U3a 的上限是 ${fmt(u3aLimit)}ms(重扫 CPU 必须明显高于上限,那条断言才不是摆设)`);
      return `首请求 ${fmt(firstMs)}ms / ${convergedMs}ms 后收敛(共 ${reqCount} 发)`
        + (rescanCpu === null ? '' : ` / 重扫 CPU Δ${fmt(rescanCpu)}ms vs U3a 上限 ${fmt(u3aLimit)}ms`);
    });

    await test('U10', '[超出判据表 §3.4] 后台重算完成后广播 usage-updated', () => {
      const hit = wsMsgs.find((m) => m?.type === 'usage-updated');
      assertTrue(hit, `未收到 usage-updated 广播(收到 ${wsMsgs.length} 条:${wsMsgs.map((m) => m?.type).join(',') || '无'})`);
      return `收到 ${wsMsgs.filter((m) => m?.type === 'usage-updated').length} 条 usage-updated`;
    });
  } finally {
    try { ws.close(); } catch { /* 已经关了 */ }
    await down(inst);
    // 复原夹具(截断回原长度;mtime 会变 → 之后的用例里服务端会无害地重算一次,内容一致)
    fs.truncateSync(target, sizeBefore);
    console.log(`[u3b] 夹具已复原(${sizeBefore}B),缓存文件 mtime 前=${cacheMtimeBefore}`);
  }
}

// ── U5:坏缓存文件四变体 ────────────────────────────────────────────────
group('U5 坏缓存文件:半截 JSON / 空文件 / 版本不符 / data 缺失');
{
  const home = mainHome();
  const poison = '1234567890';
  const good = readCache(home);
  const variants = [
    { id: 'U5a', name: '半截 JSON(写到一半断电)', text: good ? good.slice(0, Math.floor(good.length / 2)) : '{"version":1,"sig":"x","scannedAt":1,"data":{"tot' },
    { id: 'U5b', name: '空文件(0 字节)', text: '' },
    { id: 'U5c', name: '版本号不符(内容看着完整也不能信)', text: JSON.stringify({ version: 999, sig: 'poisoned', scannedAt: 1, data: { total: { input: Number(poison), output: 0, cacheRead: 0, cacheWrite: 0, sessionCount: 1 }, byModel: [], byProject: [], byDay: [] } }) },
    { id: 'U5d', name: 'data 字段缺失', text: JSON.stringify({ version: 1, sig: 'x', scannedAt: 1 }) },
  ];
  for (const v of variants) {
    writeCache(home, v.text);
    const inst = await boot(home, `u5-${v.id.toLowerCase()}`);
    const r = await getUsage();
    await test(v.id, v.name, async () => {
      assertTrue(r.status === 200 && r.body, `必须不抛错(HTTP 200),实际 ${r.status}: ${r.text.slice(0, 200)}`);
      assertTrue(!r.body.error, `响应带 error 字段: ${r.text.slice(0, 200)}`);
      assertEq(r.body.total, expected.total, `${v.id} 的 total 应退回冷扫结果`);
      assertTrue(!JSON.stringify(r.body).includes(poison), `把坏缓存里的毒值(${poison})当数返回了`);
      const raw = await waitForCache(home);
      const parsed = (() => { try { return JSON.parse(raw); } catch { return null; } })();
      assertTrue(raw === null ? false : raw !== v.text, '坏缓存文件被原样留着 —— 没被合法内容覆盖(判据要求"退回冷路径重扫并覆盖")');
      assertTrue(parsed && parsed.data && typeof parsed.sig === 'string' && typeof parsed.version === 'number',
        `覆盖后的文件不是合法的 {version,sig,scannedAt,data}: ${(raw || '(不存在)').slice(0, 120)}`);
      assertTrue(r.body.meta?.stale === false, `退回冷路径重扫应报 stale=false,实际 ${JSON.stringify(r.body.meta)}`);
      return `${fmt(r.ms)}ms / 覆盖后 ${raw.length}B`;
    });
    await down(inst);
  }
}

// ── U7:缓存目录不可写 / 缓存路径被占成目录 ─────────────────────────────
group('U7 缓存目录不可写 → /api/usage 不能 500');
{
  const home = scratchHome('ro', { roGuiDir: true });
  assertTrue(!fs.existsSync(cachePath(home)), 'U7 前提:缓存文件不存在');
  const inst = await boot(home, 'u7-readonly');
  const r1 = await getUsage();
  const r2 = await getUsage();
  await test('U7a', '~/.claude-gui 只读:两次请求都 200、数据正确、无 error 字段', () => {
    for (const [n, r] of [[1, r1], [2, r2]]) {
      assertTrue(r.status === 200 && r.body, `第 ${n} 次请求 HTTP ${r.status}: ${r.text.slice(0, 200)}`);
      assertTrue(!r.body.error, `第 ${n} 次响应带 error: ${r.text.slice(0, 200)}`);
      assertEq(r.body.total, expected.total, `第 ${n} 次 total`);
    }
    assertTrue(!fs.existsSync(cachePath(home)), '只读目录里不该凭空出现缓存文件');
    assertTrue(r1.body.meta?.stale === false, `第 1 次 meta=${JSON.stringify(r1.body.meta)}`);
    return `${fmt(r1.ms)}ms / ${fmt(r2.ms)}ms`;
  });
  await down(inst);
  rmHome(home);

  // 变体:缓存路径被别的东西占成了目录(EISDIR 读写双失败)
  const home2 = scratchHome('dir');
  fs.mkdirSync(cachePath(home2));
  const inst2 = await boot(home2, 'u7-isdir');
  const r3 = await getUsage();
  await test('U7b', '[超出判据表] 缓存路径是个目录:仍 200 + 数据正确', () => {
    assertTrue(r3.status === 200 && r3.body, `HTTP ${r3.status}: ${r3.text.slice(0, 200)}`);
    assertEq(r3.body.total, expected.total, 'total');
    assertTrue(r3.body.meta?.stale === false, `meta=${JSON.stringify(r3.body.meta)}`);
    return `${fmt(r3.ms)}ms`;
  });
  await down(inst2);
  rmHome(home2);
}

const code = summary('usage-overview-20260914 U1~U7+U10');
console.log(`[artifacts] 夹具与实例日志在 ${ROOT}`);
process.exit(code);
