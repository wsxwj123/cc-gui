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

// 快速遍历:只 stat 不读内容,返回 [{ path, projectName, mtimeMs }] + 签名。
async function listJsonl() {
  let projectDirs;
  try { projectDirs = await readdir(PROJECTS_DIR, { withFileTypes: true }); }
  catch { return { files: [], sig: 'none' }; }
  const files = [];
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const projectPath = join(PROJECTS_DIR, dir.name);
    let names;
    try { names = (await readdir(projectPath)).filter((f) => f.endsWith('.jsonl')); }
    catch { continue; }
    for (const name of names) {
      try {
        const st = await stat(join(projectPath, name));
        files.push({ path: join(projectPath, name), projectName: dir.name, mtimeMs: st.mtimeMs });
      } catch {}
    }
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

  {
    for (const fileInfo of jsonlFiles) {
      const dir = { name: fileInfo.projectName };
      try {
        // 流式逐行聚合,不全量驻留(长会话 jsonl 可达数万行,旧版 limit:5000 截断会漏计)。
        // W8:按 message.id 去重 —— 同一 API 调用的流式分片在 jsonl 里可能落多条
        // assistant 记录(usage 相同),不去重会成倍虚算。sidechain(子代理)同理排除。
        const seenIds = new Set();
        await streamJsonl(fileInfo.path, (record) => {
          if (record.type !== 'assistant') return;
          if (record.isSidechain || record.parentToolUseId) return;
          const usage = record.message?.usage;
          if (!usage) return;
          const mid = record.message?.id;
          if (mid) {
            if (seenIds.has(mid)) return;
            seenIds.add(mid);
          }

          const model = record.message?.model || 'unknown';
          const input = usage.input_tokens || 0;
          const output = usage.output_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;
          const cacheWrite = usage.cache_creation_input_tokens || 0;
          const day = record.timestamp ? record.timestamp.slice(0, 10) : 'unknown';

          totalInput += input;
          totalOutput += output;
          totalCacheRead += cacheRead;
          totalCacheWrite += cacheWrite;

          // By model
          if (!byModel[model]) byModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
          byModel[model].input += input;
          byModel[model].output += output;
          byModel[model].cacheRead += cacheRead;
          byModel[model].cacheWrite += cacheWrite;
          byModel[model].calls++;

          // By project
          if (!byProject[dir.name]) byProject[dir.name] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
          byProject[dir.name].input += input;
          byProject[dir.name].output += output;
          byProject[dir.name].cacheRead += cacheRead;
          byProject[dir.name].cacheWrite += cacheWrite;
          byProject[dir.name].calls++;

          // By day
          if (!byDay[day]) byDay[day] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
          byDay[day].input += input;
          byDay[day].output += output;
          byDay[day].cacheRead += cacheRead;
          byDay[day].cacheWrite += cacheWrite;
          byDay[day].calls++;
        });
        sessionCount++;
      } catch {
        // skip unreadable files
      }
    }
  }

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
