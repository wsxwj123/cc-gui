import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { streamJsonl } from '../utils/jsonl-parser.js';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// 全盘 parse 所有 jsonl 很慢(数百文件 × 5000 行 ≈ 9s)。stale-while-revalidate:有缓存
// 就立即返回(秒回),后台用 mtime 签名(文件数+mtimeMs 之和)判断是否有新写入,有才重
// parse 刷新。注意:**纯 sig 缓存不够** —— 用户常有活跃会话 jsonl 在写,mtime 每秒
// 都变会让 sig 永远 miss;所以必须"先返旧值再后台更新",而不是同步等 sig 命中。
// 用量统计非实时数据,差一个刷新周期(几秒)完全可接受。
let _cache = { sig: null, data: null };
let _refreshing = false;

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
  // 有缓存:立即返回 + 后台按 sig 判断是否刷新(避免活跃会话 mtime 抖动导致永远重算)。
  if (_cache.data) {
    if (!_refreshing) {
      _refreshing = true;
      (async () => {
        try {
          const { files, sig } = await listJsonl();
          if (sig !== _cache.sig) await recompute(files, sig);
        } catch {} finally { _refreshing = false; }
      })();
    }
    return _cache.data;
  }
  // 首次无缓存:同步全盘聚合。
  const { files, sig } = await listJsonl();
  return recompute(files, sig);
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
  const bump = (model, project, day, u) => {
    totalInput += u.input; totalOutput += u.output;
    totalCacheRead += u.cacheRead; totalCacheWrite += u.cacheWrite;
    for (const [bucket, key] of [[byModel, model], [byProject, project], [byDay, day]]) {
      if (!bucket[key]) bucket[key] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
      bucket[key].input += u.input;
      bucket[key].output += u.output;
      bucket[key].cacheRead += u.cacheRead;
      bucket[key].cacheWrite += u.cacheWrite;
      bucket[key].calls++;
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
          const mid = record.message?.id;
          // 没有 message.id 就无从去重(本机 30 万条里只有 1 条),直接计入,
          // 不能拿空串当键 —— 那会把它们全并成一条。
          if (!mid) return bump(model, fileInfo.projectName, day, u);

          const total = u.input + u.output + u.cacheRead + u.cacheWrite;
          const prev = bestById.get(mid);
          if (!prev || total > prev.total) {
            bestById.set(mid, { model, project: fileInfo.projectName, day, total, u });
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
  for (const b of bestById.values()) bump(b.model, b.project, b.day, b.u);

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
  _cache = { sig, data: result };
  return result;
}

// 启动预热:延迟后台跑一次全盘聚合,填充 mtime 缓存,使用户首次进用量面板即秒回
// (否则首次要全盘 parse ≈9s)。不阻塞启动。
setTimeout(() => { getUsageStats().catch(() => {}); }, 10000);
