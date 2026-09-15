import { readdir, stat } from 'fs/promises';
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { streamJsonl } from '../utils/jsonl-parser.js';
import { periodFor } from '../utils/pricing-rules.js';
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
// 的 mtime 变了才会触发。bump 一次 = 旧缓存整份作废,退回冷路径重扫。
const CACHE_VERSION = 1;

// 全盘 parse 很慢。stale-while-revalidate:有缓存就立即返回(秒回),后台用 mtime
// 签名(文件数+mtimeMs 之和)判断是否有新写入,有才重 parse 刷新。注意:**纯 sig
// 缓存不够** —— 用户常有活跃会话 jsonl 在写,mtime 每秒都变会让 sig 永远 miss;
// 所以必须"先返旧值再后台更新",而不是同步等 sig 命中。用量统计非实时数据,差一个
// 刷新周期(几秒)完全可接受。
// meta.stale:这份 data 是磁盘回放的旧值、后台还没确认它是不是最新 → true;现算的
// 或者后台已复核过 sig 的 → false(前端据此如实说明,不把旧数当新数)。
let _cache = { sig: null, scannedAt: null, data: null };
let _refreshing = false;
let _pending = null;   // 冷路径合流:并发调用共享的同一个 Promise
// 后台核对的超时兜底。listJsonl / recompute 永不 settle 时(网络挂载、IO 卡死),_refreshing
// 会永久停在 true —— 这是唯一能让 meta.stale 永远挂着、且之后再也没人核对的路径。一次正常
// 的核对(全盘 stat + 至多一次全量 parse,本机冷扫实测 41.8s)远在 5 分钟以内,到点必是卡死;
// 宁可到点后重新发起一次核对(最多多跑一遍),也不能永远不核对。
const REVALIDATE_TIMEOUT_MS = 5 * 60_000;

// 启动即读回填。磁盘回放的数据在后台确认 sig 之前一律标 stale=true。
function loadCache() {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    // 版本号不同 = 形状可能已变,一律不信;半截 JSON / 空文件 / 缺字段的坏文件同样
    // 走不到这里 —— 都退回冷路径重扫,那份结果随后会把坏文件覆盖成合法内容。
    if (parsed?.version !== CACHE_VERSION) return;
    if (typeof parsed.sig !== 'string' || typeof parsed.scannedAt !== 'number') return;
    const d = parsed.data;
    if (!d?.total || !Array.isArray(d.byModel) || !Array.isArray(d.byProject) || !Array.isArray(d.byDay)) return;
    _cache = { sig: parsed.sig, scannedAt: parsed.scannedAt, data: { ...d, meta: { scannedAt: parsed.scannedAt, stale: true } } };
  } catch { /* 首次运行无缓存文件 / 文件坏或不可读:冷路径起点 */ }
}

function saveCache(sig, scannedAt, data) {
  const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    // 原子替换(写法同 computer-use/cu-common.js 的授权文件):直接 writeFileSync 会先把文件
    // 截到 0,进程若在写完前被杀,下次启动读到半截 JSON —— 守卫能兜住,代价是又付一次 40 秒
    // 冷扫。写临时文件再 rename,任何时刻被杀都只会看到完整旧值或完整新值。
    writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, sig, scannedAt, data }));
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
async function walkJsonl(dir, projectName, depth, out) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { await walkJsonl(p, projectName, depth + 1, out); continue; }
    if (!e.name.endsWith('.jsonl')) continue;
    try {
      const st = await stat(p);
      // depth 0 = 项目目录直属 = 一个会话;更深的是该会话的子代理 transcript,
      // 花的钱要算,但不能让 sessionCount 跟着虚高。
      out.push({ path: p, projectName, mtimeMs: st.mtimeMs, isSession: depth === 0 });
    } catch {}
  }
}

// 快速遍历:只 stat 不读内容,返回 [{ path, projectName, mtimeMs, isSession }] + 签名。
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
      if (sig === 'none') return undefined;
      if (sig !== _cache.sig) return recompute(files, sig);
      if (_cache.data) _cache.data.meta.stale = false;
      return undefined;
    })
    .catch(() => {})   // 后台失败不碰已返回的响应,下个请求自然再试
    .finally(() => { clearTimeout(watchdog); _refreshing = false; });
}

async function recompute(jsonlFiles, sig) {
  const byModel = {};
  const byProject = {};
  const byDay = {};
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let sessionCount = 0;

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
          if (record.type !== 'assistant') return;
          const usage = record.message?.usage;
          if (!usage) return;

          const u = {
            input: usage.input_tokens || 0,
            output: usage.output_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            cacheWrite: usage.cache_creation_input_tokens || 0,
          };
          const model = record.message?.model || 'unknown';
          const day = record.timestamp ? record.timestamp.slice(0, 10) : 'unknown';
          // 时段按**该条记录自身的时间戳**判(与逐条消息计价同一个判定函数、同一个时区);
          // 没有可解析时间戳 → unknown 桶(不拿"现在"顶替)。
          const period = periodFor(record.timestamp).key;
          const mid = record.message?.id;
          // 没有 message.id 就无从去重(本机 30 万条里只有 1 条),直接计入,
          // 不能拿空串当键 —— 那会把它们全并成一条。
          if (!mid) return bump(model, fileInfo.projectName, day, u, period);

          const total = u.input + u.output + u.cacheRead + u.cacheWrite;
          const prev = bestById.get(mid);
          if (!prev || total > prev.total) {
            bestById.set(mid, { model, project: fileInfo.projectName, day, total, u, period });
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
  for (const b of bestById.values()) bump(b.model, b.project, b.day, b.u, b.period);

  const result = {
    total: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite, sessionCount },
    byModel: Object.entries(byModel)
      .map(([model, stats]) => ({ model, ...stats }))
      .sort((a, b) => (b.input + b.output) - (a.input + a.output)),
    byProject: Object.entries(byProject)
      .map(([hash, stats]) => ({ hash, ...stats }))
      .sort((a, b) => (b.input + b.output) - (a.input + a.output))
      .slice(0, 20),
    byDay: Object.entries(byDay)
      .map(([day, stats]) => ({ day, ...stats }))
      .sort((a, b) => b.day.localeCompare(a.day))
      .slice(0, 30),
  };
  const scannedAt = Date.now();
  // scannedAt 语义 = **产生这份 data 的这次 recompute 完成的时刻**:磁盘回放期间保持
  // 原值不变,只有重算落地才前进(测试拿它当"到底重算没重算"的客观信号)。
  // 每次重算都产一个新对象 —— 合流返回的是同一个引用,这里换了就是换了。
  _cache = { sig, scannedAt, data: { ...result, meta: { scannedAt, stale: false } } };
  saveCache(sig, scannedAt, result);
  // 重算落地即广播:前端收到后静默重取,不必等"最多 30 秒"那一轮轮询(磁盘回放期间
  // 看到的是旧值,没有这条广播就只能靠轮询才收敛)。
  broadcast({ type: 'usage-updated' });
  return _cache.data;
}

// 启动预热:延迟后台跑一次全盘聚合,填充 mtime 缓存,使用户首次进用量面板即秒回
// (否则首次要全盘 parse ≈9s)。不阻塞启动。
setTimeout(() => { getUsageStats().catch(() => {}); }, 10000);
