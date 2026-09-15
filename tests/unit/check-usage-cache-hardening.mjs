#!/usr/bin/env node
// 用量统计磁盘缓存的加固锁(server/services/usage-stats.js,2026-09-14 加固批):
//   ① **sig==='none' 不重算**(S4):listJsonl 读不到 projects 目录时返回 sig:'none'。那是
//      "这次读不到",不是"数据变了" —— 照常比对会走 recompute([], 'none'),把空账标
//      stale=false 并写进磁盘,用户看到"0 花费且很新"。目录不可读期间必须保留旧值。
//   ② **落盘原子写**(S1):临时文件 + renameSync。直接 writeFileSync 先 O_TRUNC 截到 0,
//      进程若死在写中间,下次启动读到半截 JSON → 守卫兜住但重付一次 40 秒冷扫。
//   ③ **rename 失败要清临时文件**:临时文件名带 pid,不清理就是每次启动留一份几 MB 的
//      半成品,pid 不复用 → 无界堆积。
// S3(_refreshing 的 5 分钟看门狗)是定时器兜底,不看表等不到触发,故只能靠代码审阅;
// 能黑盒测的是上面三条。
// 直接 import 真模块(PROJECTS_DIR / CACHE_DIR 在模块顶层由 homedir() 求值,故先设 HOME
// 再用带 query 的 import 拿全新实例,绕开 ESM 缓存与模块内的 _cache)。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const homes = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cachePathOf = (home) => join(home, '.claude-gui', 'usage-stats-cache.json');
const tmpLeftovers = (home) => {
  try { return readdirSync(join(home, '.claude-gui')).filter((n) => n.endsWith('.tmp')); }
  catch { return []; }
};
/** 造一个 HOME:tree 的键是 .claude/projects 下的相对路径。 */
function makeHome(tree = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cgui-usage-hard-'));
  homes.push(home);
  for (const [rel, lines] of Object.entries(tree)) {
    const abs = join(home, '.claude', 'projects', rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, lines.join('\n') + '\n');
  }
  return home;
}
async function statsFor(home, tag) {
  process.env.HOME = home;
  process.env.USERPROFILE = home; // Windows 上 homedir() 读 %USERPROFILE%,不设沙箱就失效
  const { getUsageStats } = await import(`../../server/services/usage-stats.js?case=${tag}`);
  return getUsageStats;
}
const rec = (id, input, output = 0) => JSON.stringify({
  type: 'assistant',
  timestamp: '2026-08-04T00:00:00.000Z',
  message: { id, model: 'fixture-model', stop_reason: 'end_turn', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});

try {
  // ── ① 磁盘缓存有值、但 projects 目录读不到(sig==='none')→ 不许重算成空账 ──────
  const noProjects = makeHome();   // 故意没有 .claude/projects
  mkdirSync(join(noProjects, '.claude-gui'), { recursive: true });
  writeFileSync(cachePathOf(noProjects), JSON.stringify({
    version: 1, sig: '7:123456', scannedAt: 111,
    data: { total: { input: 999, output: 9, cacheRead: 0, cacheWrite: 0, sessionCount: 1 }, byModel: [], byProject: [], byDay: [] },
  }));
  const noneSigStats = await statsFor(noProjects, 'sig-none');
  const replay = await noneSigStats();
  assert.equal(replay.meta.stale, true, '磁盘回放的数在核对前必须标 stale');
  assert.equal(replay.total.input, 999, '磁盘回放应给出缓存里的数');

  await sleep(400);   // 让后台核对(listJsonl 失败 → sig:'none')跑完
  const after = await noneSigStats();
  assert.equal(after.total.input, 999, "sig==='none' 时不许用空账覆盖:目录读不到 ≠ 数据变成 0");
  assert.equal(after.meta.stale, true, "跳过本轮核对 → stale 保持 true(如实说明,不假装最新)");
  const disk = JSON.parse(readFileSync(cachePathOf(noProjects), 'utf8'));
  assert.equal(disk.sig, '7:123456', "空账不许落盘覆盖缓存(否则重启后用户看到 0 花费且很新)");
  assert.equal(disk.data.total.input, 999);

  // ── ② 正常冷扫:落盘用临时文件 + rename,成功路径不留残渣 ─────────────────
  const withData = makeHome({ 'demo/s1.jsonl': [rec('m1', 100, 10)] });
  const atomicStats = await statsFor(withData, 'atomic');
  const cold = await atomicStats();
  assert.equal(cold.total.input, 100, '冷扫基准:夹具就一条记录');
  assert.equal(cold.meta.stale, false, '现算的数 stale 必须是 false');
  const cache = JSON.parse(readFileSync(cachePathOf(withData), 'utf8'));
  assert.equal(cache.version, 1);
  assert.equal(cache.data.total.input, 100, '落盘内容 = 刚算出来的那份');
  assert.ok(typeof cache.sig === 'string' && cache.sig !== 'none', '真实目录的 sig 不是 none');
  assert.deepEqual(tmpLeftovers(withData), [], 'rename 成功后临时文件应当已经不在');

  // ── ③ 缓存路径被占成目录(rename 必失败):不抛、不留临时文件、内存态照常 ────
  rmSync(cachePathOf(withData), { force: true });
  mkdirSync(cachePathOf(withData));   // 占位成目录 → renameSync 必然 EISDIR
  appendFileSync(join(withData, '.claude', 'projects', 'demo', 's1.jsonl'), rec('m2', 100, 10) + '\n');
  let converged = false;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const cur = await atomicStats();
    if (cur.total.input === 200) { converged = true; break; }
    await sleep(50);
  }
  assert.ok(converged, 'mtime 变了必须触发后台重算(否则下面那条断言是空转)');
  assert.deepEqual(tmpLeftovers(withData), [], 'rename 被拒时不许把临时文件留在 ~/.claude-gui(每次启动留一份 = 无界堆积)');

  console.log('check-usage-cache-hardening: PASS');
} finally {
  for (const h of homes) { try { rmSync(h, { recursive: true, force: true }); } catch {} }
}
// 模块顶层有 10s 的预热 setTimeout(未 unref),不显式退出会让进程空等。
process.exit(0);
