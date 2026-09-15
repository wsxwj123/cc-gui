// 进程级冷扫探针(给 U1/U1b 量"一次冷扫"的基准,并验证并发合流是否返回同一对象引用)。
//
//   node helpers/probe.mjs <home> <usageStatsJs 绝对路径> <并发数> <结果 json 路径>
//
// 为什么要独立进程:usage-stats.js 的 _cache 是模块级内存,同一进程里第二次调用
// 拿的是缓存,量不到冷路径。探针进程只读夹具(不写任何东西)。
import fs from 'node:fs';

const [home, statsPath, nRaw, outPath] = process.argv.slice(2);
const n = Math.max(1, Number(nRaw) || 1);
if (!home || !statsPath || !outPath) {
  console.error('用法: node probe.mjs <home> <usageStatsJs> <n> <outJson>');
  process.exit(2);
}

const t0 = performance.now();
const { getUsageStats } = await import(statsPath);
const importMs = performance.now() - t0;

const t1 = performance.now();
const rs = await Promise.all(Array.from({ length: n }, () => getUsageStats()));
const concurrentMs = performance.now() - t1;

fs.writeFileSync(outPath, JSON.stringify({
  n,
  importMs,
  concurrentMs,
  sameRef: rs.every((r) => r === rs[0]),
  distinctRefs: new Set(rs).size,
  total: rs[0].total,
  byModelLen: rs[0].byModel.length,
}));
// 别等模块末尾那个 10 秒预热定时器:不显式退会白挂 10 秒
process.exit(0);
