import { readdir, stat } from 'fs/promises';
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { streamJsonl } from '../utils/jsonl-parser.js';
import { periodFor } from '../utils/pricing-rules.js';
import { localDayKey, localHour, dayKeyOf, computeStreaks, shiftDayKey } from '../utils/usage-calendar.js';
import { isUserMessage } from '../utils/usage-record.js';
import { broadcast } from '../broadcast.js';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// 磁盘缓存:落点与写法沿用 pricing-catalog.js(同一个 ~/.claude-gui 目录、同一套
// version 守卫、读不到就退回冷路径)。_cache 是模块级内存,进程一退就没了 —— 本机
// 6.8GB / 3688 个 jsonl 全盘 parse 要 40 秒,没有这一层,用户每次重启 GUI 打开用量
// 面板都要等一遍。(模块里"数百文件 ≈ 9s"的旧估算写在数据涨 5 倍之前,已过期。)
const CACHE_DIR = join(homedir(), '.claude-gui');
const CACHE_PATH = join(CACHE_DIR, 'usage-stats-cache.json');
// ⚠️ **改聚合口径必须 bump 本版本号**。它守的不只是磁盘缓存的形状:形状没变而口径变了
// (去重规则、meta 语义之类),旧算法落盘的数会被 loadCache 当"形状合法"整份读回,且 sig
// 一致时被判"就是当前数据"标成 stale=false 展示;不 bump 还等不到重算 —— 只有某个 jsonl
// 的 mtime 变了才会触发。bump 一次 = 旧缓存整份作废 —— r130 起不再退回冷路径:上一版(1)的
// 文件形状仍合法,loadCache 先回放它秒回旧值、标 needsRecompute,后台核对时必重算升级(见下)。
// 版本史:1 = 2026-09-14 初版;2 = r130(切日改为进程本地时区、byDay 加 sessions/messages、
// 新增 overview、窗口 30 → 400 天、缓存头加 tz);3 = r131(新增两个根键 byDayModel 与 ranges)。
const CACHE_VERSION = 3;
// 缓存头里记写入进程的时区:切日按进程本地时区,换了时区旧值就是错的 —— 同 sig 也要重算。
const PROCESS_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
// byDay 保留窗口(天):53 周热力图 + 余量;overview 在截断前的全量表上算,不受它影响。
const BYDAY_WINDOW = 400;
// 后台重算冷却(INTERFACE-r130 §B-6):由后台核对触发的重算,距上一次这类重算完成不足此值
// 就不立即重算,记 dirty 并安排一份定时器到冷却结束再核对(期间多次签名变化合并成一次)。
// 冷路径首扫与启动后第一次核对不受限。env 只在模块加载时读一次(与 REVALIDATE_TIMEOUT_MS 同处);
// 0 = 关闭;非法值(非数字、负数、空串)按默认 30 s。首页 + 面板 + chat-done 三个触发源背靠背
// 时,没有它就是每条消息一次 40 s 全量扫描。
const RECOMPUTE_COOLDOWN_MS = (() => {
  const raw = process.env.CGUI_USAGE_RECOMPUTE_COOLDOWN_MS;
  if (raw == null || String(raw).trim() === '') return 30_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
})();

// 全盘 parse 很慢。stale-while-revalidate:有缓存就立即返回(秒回),后台用 mtime
// 签名(文件数+mtimeMs 之和)判断是否有新写入,有才重 parse 刷新。注意:**纯 sig
// 缓存不够** —— 用户常有活跃会话 jsonl 在写,mtime 每秒都变会让 sig 永远 miss;
// 所以必须"先返旧值再后台更新",而不是同步等 sig 命中。用量统计非实时数据,差一个
// 刷新周期(几秒)完全可接受。
// meta.stale:这份 data 是磁盘回放的旧值、后台还没确认它是不是最新 → true;现算的
// 或者后台已复核过 sig 的 → false(前端据此如实说明,不把旧数当新数)。
// needsRecompute:磁盘回放的这份为什么必须重算(不看 sig)——'version' = 旧版文件缺新字段、
// 'tz' = 写入时的时区与现在不同;null = 只按 sig 判。显式枚举而不是 sig=null 哨兵:一眼看出
// 原因,以后再加失效原因只加一个值。重算落地即清。
let _cache = { sig: null, scannedAt: null, needsRecompute: null, data: null };
let _refreshing = false;
let _pending = null;   // 冷路径合流:并发调用共享的同一个 Promise
// 冷却记账:只记【由 revalidate 触发】的重算完成时刻(冷路径首扫不记,故启动后第一次核对
// 永远不受限);定时器在飞 = dirty(签名已变、等冷却结束再核对),同一时刻只有一份。
let _lastBgRecomputeAt = 0;
let _cooldownTimer = null;
// 后台核对的超时兜底。listJsonl / recompute 永不 settle 时(网络挂载、IO 卡死),_refreshing
// 会永久停在 true —— 这是唯一能让 meta.stale 永远挂着、且之后再也没人核对的路径。一次正常
// 的核对(全盘 stat + 至多一次全量 parse,本机冷扫实测 41.8s)远在 5 分钟以内,到点必是卡死;
// 宁可到点后重新发起一次核对(最多多跑一遍),也不能永远不核对。
const REVALIDATE_TIMEOUT_MS = 5 * 60_000;

// 启动即读回填。磁盘回放的数据在后台确认 sig 之前一律标 stale=true。分支(r130 INTERFACE §B-1~4 + r131 §B):
//   ① version 3 + tz 等于本进程 + 形状合法(含 overview、byDayModel、ranges)→ 正常回放,只按 sig 核对;
//   ② version 3 + tz 不等 → 回放 + needsRecompute:'tz'(旧值是别的时区切的日,先秒回再必重算);
//   ③ version 1 或 2 + 形状合法(v2 要求 overview,v1 不要求)→ 回放 + needsRecompute:'version'
//      (升级路径:**无论 sig 是否相同都必须重算** —— 旧版文件缺新根键,界面拿到后靠 ranges /
//      byDayModel 显示按范围重算的数字,缺了就退回前端自算兜底。不退回冷路径 = 升级后首屏不用等 40 s);
//   其余(version 0 / 999 / 缺、半截 JSON、缺 data、v3 缺 overview / byDayModel / ranges)一律不信 →
//   冷路径,那份结果随后把坏文件覆盖成合法内容。
// 注意 v3 的三个形状判据:认不出形状就当坏文件,**不能**回放一份看着合法实则缺键的 v3 文件
// (那会让 byDayModel 缺失的响应被标成"就是当前数据")。
function loadCache() {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (typeof parsed?.sig !== 'string' || typeof parsed.scannedAt !== 'number') return;
    const d = parsed.data;
    if (!d?.total || !Array.isArray(d.byModel) || !Array.isArray(d.byProject) || !Array.isArray(d.byDay)) return;
    let needsRecompute = null;
    if (parsed.version === CACHE_VERSION) {
      if (!d.overview || typeof d.overview !== 'object' || Array.isArray(d.overview)) return;
      if (!d.byDayModel || typeof d.byDayModel !== 'object' || Array.isArray(d.byDayModel)) return;
      if (!d.ranges || typeof d.ranges !== 'object' || Array.isArray(d.ranges)) return;
      if (parsed.tz !== PROCESS_TZ) needsRecompute = 'tz';
    } else if (parsed.version === 1 || parsed.version === 2) {
      // v1 没有 overview;v2 有 overview 但没有 byDayModel / ranges。两者都先回放旧值再必重算升级。
      if (parsed.version === 2 && (!d.overview || typeof d.overview !== 'object' || Array.isArray(d.overview))) return;
      needsRecompute = 'version';
    } else {
      return;
    }
    _cache = { sig: parsed.sig, scannedAt: parsed.scannedAt, needsRecompute, data: { ...d, meta: { scannedAt: parsed.scannedAt, stale: true } } };
  } catch { /* 首次运行无缓存文件 / 文件坏或不可读:冷路径起点 */ }
}

function saveCache(sig, scannedAt, data) {
  const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    // 原子替换(写法同 computer-use/cu-common.js 的授权文件):直接 writeFileSync 会先把文件
    // 截到 0,进程若在写完前被杀,下次启动读到半截 JSON —— 守卫能兜住,代价是又付一次 40 秒
    // 冷扫。写临时文件再 rename,任何时刻被杀都只会看到完整旧值或完整新值。
    writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, tz: PROCESS_TZ, sig, scannedAt, data }));
    renameSync(tmp, CACHE_PATH);
  } catch {
    // 目录不可写/路径被占(例如缓存路径本身是个目录):内存态照常服务,落盘失败不许冒到
    // /api/usage 上。顺手删掉本次的临时文件:文件名带 pid,不删就是每次进程启动都往
    // ~/.claude-gui 里留一份几 MB 的半成品,永久堆积。
    try { unlinkSync(tmp); } catch { /* 本来就没写出来 / 也删不掉:已无计可施 */ }
  }
}

loadCache();

// 递归收集项目目录下的所有 jsonl:会话本体在 `<项目>/<sessionId>.jsonl`,子代理的
// transcript 另存在 `<项目>/<sessionId>/subagents/agent-*.jsonl`(workflow 起的 agent
// 还要再深一层 `subagents/workflows/wf_*/`)。
// **只读顶层一层等于一条子代理记录都读不到**:本机实测顶层 1441 个文件里含 sidechain
// 的是 0,深层 2150 个文件全是 —— 子代理那部分花费会整个从统计里消失。
// r130 顺手给每个文件两项【按路径推导】的归属(不读记录里的 sessionId 字段,与 sessionCount 同源):
//   sessionKey:项目目录直属文件 = 文件名去 .jsonl;深层文件 = 项目目录下第一段目录名(子代理与
//              workflow 都归母会话);inSubagentPath:文件在某个 subagents/ 目录之下(任意深度)。
async function walkJsonl(dir, projectName, depth, out, sessionKey = null, inSubagentPath = false) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      await walkJsonl(p, projectName, depth + 1, out, depth === 0 ? e.name : sessionKey, inSubagentPath || e.name === 'subagents');
      continue;
    }
    if (!e.name.endsWith('.jsonl')) continue;
    try {
      const st = await stat(p);
      // depth 0 = 项目目录直属 = 一个会话;更深的是该会话的子代理 transcript,
      // 花的钱要算,但不能让 sessionCount 跟着虚高。
      out.push({
        path: p, projectName, mtimeMs: st.mtimeMs, isSession: depth === 0,
        sessionKey: depth === 0 ? e.name.slice(0, -'.jsonl'.length) : sessionKey,
        inSubagentPath,
      });
    } catch {}
  }
}

// 快速遍历:只 stat 不读内容,返回 [{ path, projectName, mtimeMs, isSession, sessionKey, inSubagentPath }] + 签名。
async function listJsonl() {
  let projectDirs;
  try { projectDirs = await readdir(PROJECTS_DIR, { withFileTypes: true }); }
  catch { return { files: [], sig: 'none' }; }
  const files = [];
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    await walkJsonl(join(PROJECTS_DIR, dir.name), dir.name, 0, files);
  }
  const sig = files.length + ':' + files.reduce((s, f) => s + f.mtimeMs, 0);
  return { files, sig };
}

/**
 * Aggregate usage stats across all sessions.
 * Returns per-model, per-project, and per-day breakdowns.
 */
export async function getUsageStats() {
  // 有缓存(内存或刚读回的磁盘值):立即返回 + 后台按 sig 判断是否刷新
  // (避免活跃会话 mtime 抖动导致永远重算)。
  if (_cache.data) {
    revalidate();
    return _cache.data;
  }
  // 首次无缓存:合流 —— N 个并发调用共享同一个 Promise,只扫一遍、返回**同一个
  // 对象引用**。这不只是省事:每个并发各扫一遍时,用户"加载中关面板再打开"就是
  // 又一次全盘扫描(修前实测 5 并发扫 5 遍)。预热定时器与首次打开也靠它不互相踩。
  if (!_pending) {
    _pending = (async () => {
      const { files, sig } = await listJsonl();
      return recompute(files, sig);
    })().finally(() => { _pending = null; });
  }
  return _pending;
}

// 后台核对 sig:数据真的变了才重算并广播。sig 一致 = 手上这份就是当前数据,只需把
// "可能略旧"的标记落回 false(磁盘回放期间它是 true)。同一时刻只跑一次,别的请求
// 直接拿现成数据。
function revalidate() {
  if (_refreshing) return;
  _refreshing = true;
  // 到点强制复位,保证标志一定回得来;那次卡死的核对若之后自己活了,它照常走完自己的
  // then/finally(重复复位无害),大不了多算一遍。
  const watchdog = setTimeout(() => { _refreshing = false; }, REVALIDATE_TIMEOUT_MS);
  watchdog.unref?.();   // 不因这个定时器拖住进程退出
  listJsonl()
    .then(({ files, sig }) => {
      // sig==='none' = listJsonl 这次读不到 projects 目录(权限/IO/挂载掉了),不是"数据变了"。
      // 照常比对就会走 recompute([], 'none'):空账被标 stale=false 并写进磁盘,用户看到的是
      // "0 花费且很新"。跳过本轮;目录恢复后下一发请求自然重新核对,不需要重试机制。
      // (v1 / 异时区的回放同样等目录恢复才升级:目录读不到 ≠ 可以拿空账升级。)
      if (sig === 'none') return undefined;
      if (!_cache.needsRecompute && sig === _cache.sig) {
        if (_cache.data) _cache.data.meta.stale = false;
        return undefined;
      }
      // 需要重算(签名变了 / 回放的值本身就得重算)。冷却:距上一次由本函数触发的重算完成不足
      // RECOMPUTE_COOLDOWN_MS 就先不算 —— 如实标 stale(手上这份已知不是最新),安排到冷却结束再
      // 核对一次。_lastBgRecomputeAt 为 0 = 本进程还没做过后台重算(启动后第一次核对),不受限。
      if (RECOMPUTE_COOLDOWN_MS > 0 && _lastBgRecomputeAt > 0) {
        const wait = _lastBgRecomputeAt + RECOMPUTE_COOLDOWN_MS - Date.now();
        if (wait > 0) {
          if (_cache.data) _cache.data.meta.stale = true;
          scheduleCooldownRevalidate(wait);
          return undefined;
        }
      }
      return recompute(files, sig).then(() => { _lastBgRecomputeAt = Date.now(); });
    })
    .catch(() => {})   // 后台失败不碰已返回的响应,下个请求自然再试
    .finally(() => { clearTimeout(watchdog); _refreshing = false; });
}

// 冷却结束后补一次核对。同一时刻只挂一份(期间再多的签名变化都并进这一次);到点时若恰有别的
// 核对在飞,推后 200 ms 再试而不是丢掉 —— 丢掉 = 这批变化要等下一次请求才有人管。
function scheduleCooldownRevalidate(wait) {
  if (_cooldownTimer) return;
  const tick = () => {
    if (_refreshing) { _cooldownTimer = setTimeout(tick, 200); _cooldownTimer.unref?.(); return; }
    _cooldownTimer = null;
    revalidate();
  };
  _cooldownTimer = setTimeout(tick, wait);
  _cooldownTimer.unref?.();   // 不因它拖住进程退出
}

async function recompute(jsonlFiles, sig) {
  // 键是外部字符串(model 来自第三方响应、项目名来自用户目录、day 来自时间戳):普通对象上
  // bucket['__proto__'] / ['constructor'] 会命中原型链(真值 → 跳过初始化 → += 写到 Object.prototype /
  // Object 上,整个进程的对象都多出 NaN 属性直到重启)。null 原型对象没有这条链,'__proto__' 只是普通键;
  // 下面只用 Object.keys / entries 与 bucket[key],不依赖原型方法(2026-09-29 安全审计重要 1)。
  const byModel = Object.create(null);
  const byProject = Object.create(null);
  const byDay = Object.create(null);
  // r131:day → model → 五项。挂在**新的根键** byDayModel 上,不往 byDay 行里塞新键(byDay 行的键集被
  // r130 D1c 逐字锁死)。键同样是外部字符串 → 用 Map,序列化时再摊成 null 原型对象(见 buildByDayModel)。
  const byDayModel = new Map();
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let sessionCount = 0;
  // r130 新桶,**独立于 bump 与三个既有桶**(byModel / byProject 的形状一个字节不动):
  //   dayExtra:day → { users(当天用户消息数), sessions(当天涉及的 sessionKey 集合) };
  //   hourCounts[h]:去重后 assistant 记录本地小时为 h 的条数;userUuids:user 记录按 uuid 跨文件
  //   去重(续接/分叉会话把历史整段抄进新文件,同 assistant 一样会重复);userMessages:全历史条数。
  const dayExtra = new Map();
  const extraOf = (day) => { let x = dayExtra.get(day); if (!x) { x = { users: 0, sessions: new Set() }; dayExtra.set(day, x); } return x; };
  const hourCounts = new Array(24).fill(0);
  // r131:day → 24 小时桶。窗口内的 hourCounts 从这里取(小时只出现在 assistant 记录上,
  // 光靠 byDayModel 还原不出来);与全量 hourCounts 在 noteAssistant 里同一处累加。
  const dayHours = new Map();
  const hoursOf = (day) => { let x = dayHours.get(day); if (!x) { x = new Array(24).fill(0); dayHours.set(day, x); } return x; };
  const userUuids = new Set();
  let userMessages = 0;
  // 一条(去重后的)assistant 记录落账时顺带记小时与会话归属;与 bump 分开写,不碰它的签名。
  const noteAssistant = (day, hour, sessionKey) => {
    if (hour != null) { hourCounts[hour]++; hoursOf(day)[hour]++; }
    extraOf(day).sessions.add(sessionKey);
  };

  // 一次 API 调用在 jsonl 里按 content block 拆成多条 assistant 记录,共用同一个
  // message.id。**它们的 usage 不是相同的**:中间那些 stop_reason 为 null 的记录带的是
  // 还没写完的账(output 常常是 0),只有收尾那条(stop_reason 非 null)是真数。所以按
  // message.id 去重时"留哪一条"是有对错的 —— 留第一条会把整次调用的输出丢掉
  // (本机实测:10.1 万个 id 里 3.9 万个的第一条没写完,先到先得使 output 少算 42%、
  // input 多算 139%、金额少 21%)。这里按【token 总量最大】的那条留,理由:
  //   · 绝大多数情况下等价于"留收尾那条"(本机 10.1 万个 id 里 5 个例外 —— 中间片的
  //     cache_creation 更大时 total 会反超收尾片,代价 ¥2.09 / 0.098%,不值得为它加判据);
  //   · 不依赖记录出现顺序(跨文件时顺序由目录遍历决定,不可靠);
  //   · 整条替换而非逐字段取 max —— 这条最要紧:第三方中转的预检记录写"未走缓存的完整
  //     prompt"、收尾记录写"input 与 cacheRead 拆开",逐字段取 max 等于把同一批 token
  //     数两遍(实测 input 会从真值 1.37 亿被撑到 3.40 亿)。
  // 也不能改成"挑 stop_reason 非 null 的那条":真实数据里存在 stop_reason 为 end_turn
  // 但 usage 全 0 的记录,按 stop_reason 挑会挑到这些零(实测总量少 12 亿 token)。
  // 去重本身**必须跨文件**:续接/分叉会话时 CLI 把历史整段抄进新的 jsonl,同一次调用
  // 因此出现在多个文件里(本机实测 1.4 万个 id 跨文件,其中 99.6% 是逐字节相同的抄本;
  // 剩下 51 个 usage 不一致的,本规则 51/51 全部选中了四个字段都不更小的那条)。
  // 代价是要驻留 id → 最优记录的映射(本机 10.1 万条,+50MB 堆;耗时与逐条累加持平 ——
  // 冷进程实测两版都是 ~7.8s,此前记的"8.6s→14.4s"是同进程连跑两版的测量假象)。
  const bestById = new Map();
  const emptyTotals = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });
  // byModel 行上再按「该条记录自身时间戳落在哪个时段」分三个桶(peak/offPeak/unknown)。
  // 分时段计价的模型(DeepSeek)在面板里因此能各自按档出价;不分时段的模型这列也照给
  // (三桶之和恒等于行合计),面板不必按模型名白名单判。
  /** day → model 的桶,按需建(两层都是 Map:两层的键都来自外部字符串)。
   *  行形状 = 五项 + `byPeriod` 三桶(与根上 byModel 行同形):分时段计价的模型(DeepSeek 一类)
   *  在按范围的图例里也要算得出金额 —— 光有四项 token 的话 aggregateCost 拿不到 byPeriod,
   *  会把"能算的价"显示成「无定价数据」(代码审查 R1 / 安全 新-1)。 */
  const modelRowOf = (day, model, period) => {
    let byModelOfDay = byDayModel.get(day);
    if (!byModelOfDay) { byModelOfDay = new Map(); byDayModel.set(day, byModelOfDay); }
    let row = byModelOfDay.get(model);
    if (!row) {
      row = emptyTotals();
      row.byPeriod = { peak: emptyTotals(), offPeak: emptyTotals(), unknown: emptyTotals() };
      byModelOfDay.set(model, row);
    }
    return { row, slot: period === 'peak' ? row.byPeriod.peak : (period === 'off-peak' ? row.byPeriod.offPeak : row.byPeriod.unknown) };
  };
  const bump = (model, project, day, u, period) => {
    totalInput += u.input; totalOutput += u.output;
    totalCacheRead += u.cacheRead; totalCacheWrite += u.cacheWrite;
    for (const [bucket, key] of [[byModel, model], [byProject, project], [byDay, day]]) {
      if (!bucket[key]) bucket[key] = emptyTotals();
      bucket[key].input += u.input;
      bucket[key].output += u.output;
      bucket[key].cacheRead += u.cacheRead;
      bucket[key].cacheWrite += u.cacheWrite;
      bucket[key].calls++;
      if (bucket === byModel) {
        if (!bucket[key].byPeriod) bucket[key].byPeriod = { peak: emptyTotals(), offPeak: emptyTotals(), unknown: emptyTotals() };
        // periodFor 的 key 是 'peak'/'off-peak',桶名是 peak/offPeak —— 直接拿去当键会
        // 静默落进 unknown(写成 byPeriod[period] 时全部非高峰记录都进 unknown 桶)。
        const bp = bucket[key].byPeriod;
        const slot = period === 'peak' ? bp.peak : (period === 'off-peak' ? bp.offPeak : bp.unknown);
        slot.input += u.input;
        slot.output += u.output;
        slot.cacheRead += u.cacheRead;
        slot.cacheWrite += u.cacheWrite;
        slot.calls++;
      }
    }
    // r131:同一笔(去重后的)记录同时落 day × model —— 图与按范围图例都从这一个桶派生。
    // 必须与三个既有桶用**同一份** u(去重口径、四项 token 完全一致),不许另建一套累加。
    // 该笔记录自身的时间戳落在哪个时段,就同时进那个 byPeriod 桶(与根 byModel 的判据同一个 period)。
    const { row: dm, slot: dmp } = modelRowOf(day, model, period);
    dm.input += u.input; dm.output += u.output;
    dm.cacheRead += u.cacheRead; dm.cacheWrite += u.cacheWrite;
    dm.calls++;
    dmp.input += u.input; dmp.output += u.output;
    dmp.cacheRead += u.cacheRead; dmp.cacheWrite += u.cacheWrite;
    dmp.calls++;
  };
  {
    for (const fileInfo of jsonlFiles) {
      try {
        // 流式逐行,不全量驻留 jsonl 本体(长会话可达数万行,旧版 limit:5000 截断会漏计)。
        // sidechain(子代理)【计入】:子代理的每次调用都是独立的 API 请求、单独计费,
        // 排除等于漏算。原实现把它与分片去重并列成"同理排除",是把两类相反的东西归成
        // 一类:分片是同一次调用的重复记录,子代理是另一次真实调用。
        // (光删掉那行过滤是不够的 —— 子代理 transcript 根本不在顶层,见 walkJsonl。)
        // 与 session-reader.js 排除子代理的相反口径不冲突:那里算的是上下文徽章的
        // 【主回合占用了多少窗口】,子代理另有自己的上下文;此处算的是【一共花了多少钱】。
        // 同一个 isSidechain 标记,两个问题两个答案。
        await streamJsonl(fileInfo.path, (record) => {
          // r130:user 记录只数条数、归天、归会话(判定规则在 utils/usage-record.js;不保留正文)。
          // 用户侧【排除】子代理(isSidechain 或路径含 subagents/):那是主回合派生的,不是用户说的。
          if (record.type === 'user') {
            if (!isUserMessage(record, { inSubagentPath: fileInfo.inSubagentPath })) return;
            const uuid = record.uuid;
            if (uuid) {
              if (userUuids.has(uuid)) return;
              userUuids.add(uuid);
            }
            userMessages++;
            const x = extraOf(localDayKey(record.timestamp) ?? 'unknown');
            x.users++;
            x.sessions.add(fileInfo.sessionKey);
            return;
          }
          if (record.type !== 'assistant') return;
          const usage = record.message?.usage;
          if (!usage) return;

          // 四项一律 Number() 强转:第三方中转往 usage 里写字符串("1234")时,`+=` 会做字符串拼接,
          // 一路污染 total / byDay / byDayModel / ranges 与落盘缓存(安全审计既-1 / r130 待办①)。
          // 非有限值(含字符串数字以外的垃圾)按 0,不让 NaN 传播。
          const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
          const u = {
            input: n(usage.input_tokens),
            output: n(usage.output_tokens),
            cacheRead: n(usage.cache_read_input_tokens),
            cacheWrite: n(usage.cache_creation_input_tokens),
          };
          const model = record.message?.model || 'unknown';
          // r130:切日按**进程本地时区**(旧版取 ISO 串前 10 位 = UTC 日,+08:00 早 8 点前的用量记到
          // 前一天,与用户读"今天"的口径不符);无 / 非法时间戳 → 'unknown'。
          const day = localDayKey(record.timestamp) ?? 'unknown';
          const hour = localHour(record.timestamp);
          // 时段按**该条记录自身的时间戳**判(与逐条消息计价同一个判定函数、同一个时区);
          // 没有可解析时间戳 → unknown 桶(不拿"现在"顶替)。它固定 +08:00(DeepSeek 分时计价契约,
          // pricing-rules.js),与上面按进程时区的 day / hour 是两个口径,在 +08:00 机器上数值一致。
          const period = periodFor(record.timestamp).key;
          const mid = record.message?.id;
          // 没有 message.id 就无从去重(本机 30 万条里只有 1 条),直接计入,
          // 不能拿空串当键 —— 那会把它们全并成一条。
          if (!mid) { bump(model, fileInfo.projectName, day, u, period); noteAssistant(day, hour, fileInfo.sessionKey); return; }

          const total = u.input + u.output + u.cacheRead + u.cacheWrite;
          const prev = bestById.get(mid);
          if (!prev || total > prev.total) {
            bestById.set(mid, { model, project: fileInfo.projectName, day, total, u, period, hour, sessionKey: fileInfo.sessionKey });
          }
        });
        // 只有项目目录直属的 jsonl 才是一个会话;它的子代理 transcript 花费要算,
        // 但不是独立会话,否则"会话数"会被子代理撑成两三倍。
        if (fileInfo.isSession) sessionCount++;
      } catch {
        // skip unreadable files
      }
    }
  }
  // 全部文件读完才结算:一次调用的最优记录可能出现在任意一个文件的任意一行。
  // 去重后的 assistant 记录取胜出那条所在文件的 sessionKey(INTERFACE §A)。
  for (const b of bestById.values()) { bump(b.model, b.project, b.day, b.u, b.period); noteAssistant(b.day, b.hour, b.sessionKey); }

  // byDay 全量表:既有六键(只有 user 记录的天 token 四项与 calls 为 0)+ r130 的 sessions / messages
  // (messages = 当天用户消息 + 当天 calls)。'unknown' 行照旧成行、降序排最前。
  const byDayAll = [...new Set([...Object.keys(byDay), ...dayExtra.keys()])]
    .map((day) => {
      const stats = byDay[day] || emptyTotals();
      const extra = dayExtra.get(day);
      return { day, ...stats, sessions: extra ? extra.sessions.size : 0, messages: (extra ? extra.users : 0) + stats.calls };
    })
    .sort((a, b) => b.day.localeCompare(a.day));
  const byModelRows = Object.entries(byModel)
    .map(([model, stats]) => ({ model, ...stats }))
    .sort((a, b) => (b.input + b.output) - (a.input + a.output));
  // overview 在 400 天窗口**截断前**的全量表上算(INTERFACE §A):活跃日 = 去掉 'unknown' 与未来日
  // (day > 今天;时钟拨错 / 时区切换会造出来,不能让它把"当前连续"顶成假的)后 messages>0 的天。
  const todayKey = dayKeyOf(new Date());
  const activeDaysDesc = byDayAll.filter((r) => r.day !== 'unknown' && r.day <= todayKey && r.messages > 0).map((r) => r.day);
  const { currentStreak, longestStreak } = computeStreaks(activeDaysDesc, todayKey);
  let peakHour = null;
  let peakN = 0;
  hourCounts.forEach((n, h) => { if (n > peakN) { peakN = n; peakHour = h; } });   // 严格大于 = 并列取最小小时
  // 常用模型 = 四项 token 合计最高者(排除无 model 的 'unknown' 与错误/合成消息的 '<synthetic>'),
  // 并列取 id 字符串较小者;都没有 → null。
  // r131 把它抽成函数:ranges 的每个窗口都要用**同一口径**算一遍(不然按范围切换会换出一套
  // 与全量不一致的"常用模型")。
  const pickFavorite = (rows) => {
    let best = null;
    let bestTotal = -1;
    for (const m of rows) {
      if (m.model === 'unknown' || m.model === '<synthetic>') continue;
      const t = m.input + m.output + m.cacheRead + m.cacheWrite;
      if (t > bestTotal || (t === bestTotal && m.model < best)) { bestTotal = t; best = m.model; }
    }
    return best;
  };
  const favoriteModel = pickFavorite(byModelRows);
  const overview = {
    messages: userMessages + byModelRows.reduce((s, m) => s + m.calls, 0),
    activeDays: activeDaysDesc.length,
    firstDay: activeDaysDesc.length ? activeDaysDesc[activeDaysDesc.length - 1] : null,
    lastActiveDay: activeDaysDesc.length ? activeDaysDesc[0] : null,
    currentStreak,
    longestStreak,
    hourCounts,
    peakHour,
    favoriteModel,
  };

  // ── r131:ranges(7 天 / 30 天窗口内的聚合)+ byDayModel ──────────────────────────────
  // 窗口口径 = 含今天的最近 N 个**本地日**:rangeStart(N) = 今天 − (N−1) 天。与前端
  // client/src/utils/homeUsage.js 的 rangeStartKey 必须同一天(N 天 = 今天在内的 N 天)。
  // 只统计 byDayAll(截断前的全量表)里 day ∈ [rangeStart, 今天] 的行:
  //   · 'unknown' 没有日期 → 两边都不计(不是一个"天");
  //   · 未来日(> 今天)不计 —— 与 overview 的 activeDays 同一判据(时钟拨错/时区切换会造出来);
  //   · sessions 用**集合去重**(byDay[].sessions 是每天各自的会话数,跨天直接相加会重复计数);
  //   · 消息 / 活跃天 / 连续 / 高峰时段 / 常用模型全部按窗口内数据重算(a+b=c 可核对)。
  const windowStart = (days) => shiftDayKey(todayKey, -(days - 1));
  const RANGE_DAYS = { '7d': 7, '30d': 30 };
  const accOf = Object.create(null);   // 固定两个字面量键也无妨,但保持全文件同一套写法
  const rangeAcc = (key) => {
    let a = accOf[key];
    if (!a) {
      a = {
        sessions: new Set(), messages: 0, calls: 0, users: 0,
        tokens: emptyTotals(), hourCounts: new Array(24).fill(0), models: Object.create(null),
      };
      accOf[key] = a;
    }
    return a;
  };
  for (const [key, days] of Object.entries(RANGE_DAYS)) {
    const from = windowStart(days);
    const a = rangeAcc(key);
    for (const r of byDayAll) {
      if (r.day === 'unknown' || r.day > todayKey || r.day < from) continue;
      a.messages += r.messages;
      a.calls += r.calls;
      a.tokens.input += r.input; a.tokens.output += r.output;
      a.tokens.cacheRead += r.cacheRead; a.tokens.cacheWrite += r.cacheWrite;
      const extra = dayExtra.get(r.day);
      if (!extra) continue;
      a.users += extra.users;
      for (const s of extra.sessions) a.sessions.add(s);
    }
    // 小时分布与模型分组只累加**窗口内**的 assistant 记录(与 byDayModel 同源、同窗口)
    for (const [day, byModelOfDay] of byDayModel) {
      if (day === 'unknown' || day > todayKey || day < from) continue;
      for (const [model, u] of byModelOfDay) {
        let bucket = a.models[model];
        if (!bucket) { bucket = emptyTotals(); bucket.byPeriod = { peak: emptyTotals(), offPeak: emptyTotals(), unknown: emptyTotals() }; a.models[model] = bucket; }
        bucket.input += u.input; bucket.output += u.output;
        bucket.cacheRead += u.cacheRead; bucket.cacheWrite += u.cacheWrite;
        bucket.calls += u.calls;
        const src = u.byPeriod || {};
        for (const [name, dst] of [['peak', bucket.byPeriod.peak], ['offPeak', bucket.byPeriod.offPeak], ['unknown', bucket.byPeriod.unknown]]) {
          const from2 = src[name];
          if (!from2) continue;
          dst.input += from2.input; dst.output += from2.output;
          dst.cacheRead += from2.cacheRead; dst.cacheWrite += from2.cacheWrite;
          dst.calls += from2.calls;
        }
      }
    }
  }
  // hourCounts 按窗口重算:小时只出现在 assistant 记录上,所以另存一份 day → 24 桶(几 KB),
  // 与全量 hourCounts 同时填(见 noteAssistant)。不这么做就只能拿全量的 hourCounts 去充数 ——
  // 「高峰时段」在 7 天窗口里就成了"全历史的高峰",用户切了范围却看到同一个数。
  for (const [key, days] of Object.entries(RANGE_DAYS)) {
    const from = windowStart(days);
    const a = accOf[key];
    for (const [day, perHour] of dayHours) {
      if (day === 'unknown' || day > todayKey || day < from) continue;
      for (let h = 0; h < 24; h += 1) a.hourCounts[h] += perHour[h];
    }
  }
  const rangeOf = (key) => {
    const a = accOf[key];
    const rows = Object.entries(a.models)
      .map(([model, stats]) => ({ model, ...stats }))
      .sort((x, y) => (y.input + y.output) - (x.input + x.output));
    const days = byDayAll.filter((r) => r.day !== 'unknown' && r.day <= todayKey && r.day >= windowStart(RANGE_DAYS[key]) && r.messages > 0).map((r) => r.day);
    const { currentStreak: cur, longestStreak: longest } = computeStreaks(days, todayKey);
    let ph = null;
    let phN = 0;
    a.hourCounts.forEach((n, h) => { if (n > phN) { phN = n; ph = h; } });
    return {
      sessions: a.sessions.size,
      messages: a.messages,
      input: a.tokens.input,
      output: a.tokens.output,
      cacheRead: a.tokens.cacheRead,
      cacheWrite: a.tokens.cacheWrite,
      calls: a.calls,
      activeDays: days.length,
      firstDay: days.length ? days[days.length - 1] : null,
      lastActiveDay: days.length ? days[0] : null,
      currentStreak: cur,
      longestStreak: longest,
      hourCounts: a.hourCounts,
      peakHour: ph,
      favoriteModel: pickFavorite(rows),
      byModel: rows,
    };
  };
  const ranges = { '7d': rangeOf('7d'), '30d': rangeOf('30d') };
  // byDayModel 的序列化:Map → null 原型嵌套对象(模型名来自第三方响应,'__proto__' 当键会被
  // 普通对象当作原型 setter 吃掉 → 用 Object.create(null) 起手,再逐键赋值)。
  // **窗口与 byDay 一致**:只保留最近 BYDAY_WINDOW 天(+ 'unknown' 占一格),否则有多年历史的机器
  // 上这份数据会无界增长(契约 INTERFACE-r131 §A 写的就是"最多 400 天",安全审计 新-2 抓到这里
  // 实现与注释相反)。截断口径直接复用上面算好的 byDayAll 的排序与切片,两处不可能不一致。
  const byDayWindowDays = new Set(byDayAll.slice(0, BYDAY_WINDOW).map((r) => r.day));
  const byDayModelObj = Object.create(null);
  for (const [day, byModelOfDay] of byDayModel) {
    if (!byDayWindowDays.has(day)) continue;
    const row = Object.create(null);
    for (const [model, stats] of byModelOfDay) row[model] = { ...stats, byPeriod: { peak: { ...stats.byPeriod.peak }, offPeak: { ...stats.byPeriod.offPeak }, unknown: { ...stats.byPeriod.unknown } } };
    byDayModelObj[day] = row;
  }

  const result = {
    total: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite, sessionCount },
    byModel: byModelRows,
    byProject: Object.entries(byProject)
      .map(([hash, stats]) => ({ hash, ...stats }))
      .sort((a, b) => (b.input + b.output) - (a.input + a.output))
      .slice(0, 20),
    byDay: byDayAll.slice(0, BYDAY_WINDOW),
    // 400 天窗口与 byDay 一致:超出窗口的在图上也没有位置。
    byDayModel: byDayModelObj,
    ranges,
    overview,
  };
  const scannedAt = Date.now();
  // scannedAt 语义 = **产生这份 data 的这次 recompute 完成的时刻**:磁盘回放期间保持
  // 原值不变,只有重算落地才前进(测试拿它当"到底重算没重算"的客观信号)。
  // 每次重算都产一个新对象 —— 合流返回的是同一个引用,这里换了就是换了。
  _cache = { sig, scannedAt, needsRecompute: null, data: { ...result, meta: { scannedAt, stale: false } } };
  saveCache(sig, scannedAt, result);
  // 重算落地即广播:前端收到后静默重取,不必等"最多 30 秒"那一轮轮询(磁盘回放期间
  // 看到的是旧值,没有这条广播就只能靠轮询才收敛)。
  broadcast({ type: 'usage-updated' });
  return _cache.data;
}

// 启动预热:延迟后台跑一次全盘聚合,填充 mtime 缓存,使用户首次进用量面板即秒回
// (否则首次要全盘 parse ≈9s)。不阻塞启动。
setTimeout(() => { getUsageStats().catch(() => {}); }, 10000);
