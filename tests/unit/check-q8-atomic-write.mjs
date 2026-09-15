#!/usr/bin/env node
// Q8 审查项 9(非原子落盘,且同仓写法散弹):
//   a. pricing-catalog.js 直接 writeFileSync 目标文件 → 崩溃截断 = 全部最后有效价一次丢光(修前应红)
//   b. usage-issue-log.js 同型(修前应红)
//   c. 守卫:server/services、server/computer-use、server/utils 下不得再出现"裸 writeFile(Sync) 直写非临时路径"
//      —— 既有的几处历史债显式列入 allowlist(不在本批范围),新增落盘点必须走"写临时文件 + rename"(修前应红:
//      两处本批文件在列)
// 测法:给 fs 的写/改名函数装观察器(不改行为),再动态 import 产品模块;判据 = 目标路径从未被直写、且经 rename 到达。
// 跑法:node tests/unit/check-q8-atomic-write.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport, waitFor } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const base = join(HERE, 'q8-helpers', '.artifacts', 'atomic');
fs.rmSync(base, { recursive: true, force: true });
const home = join(base, 'home');
fs.mkdirSync(join(home, '.claude-gui'), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CGUI_USAGE_ISSUES_PATH = join(home, '.claude-gui', 'usage-issues.json');

// ── fs 观察器:记录每次写文件/改名的目标,行为原样透传 ───────────────────
const writes = [];
const renames = [];
function observe(obj, name, kind) {
  const real = obj[name];
  obj[name] = function observed(...args) {
    if (kind === 'write') writes.push({ fn: name, target: String(args[0]) });
    else renames.push({ fn: name, from: String(args[0]), target: String(args[1]) });
    return real.apply(this, args);
  };
}
observe(fs, 'writeFileSync', 'write');
observe(fs, 'writeFile', 'write');
observe(fs.promises, 'writeFile', 'write');
observe(fs, 'renameSync', 'rename');
observe(fs, 'rename', 'rename');
observe(fs.promises, 'rename', 'rename');
syncBuiltinESMExports();

// 离线:任何抓取都失败(本测试只关心落盘方式)
globalThis.fetch = async () => { throw new TypeError('fetch failed (q8 offline stub)'); };

const pc = await import('../../server/services/pricing-catalog.js');
const uil = await import('../../server/services/usage-issue-log.js');
const report = makeReport('check-q8-atomic-write');

function assertAtomic(target, label) {
  assert.ok(fs.existsSync(target), `${label} 没有落盘: ${target}`);
  JSON.parse(fs.readFileSync(target, 'utf8'));
  const direct = writes.filter((w) => w.target === target);
  const landed = renames.filter((r) => r.target === target && r.from !== target);
  assert.equal(direct.length, 0, `${label} 被直接 writeFile 覆盖 ${direct.length} 次(${direct.map((d) => d.fn).join(',')}):进程写到一半被杀 = 半截 JSON,下次启动当空`);
  assert.ok(landed.length >= 1, `${label} 没有经 rename 到达(应先写临时文件再 rename)`);
}

await report.check('Q8-09a', 'pricing-catalog 落盘必须原子(写临时文件 + rename,目标文件从不被直写)', 'red', async () => {
  const target = join(home, '.claude-gui', 'pricing-catalog.json');
  const r = pc.startRefresh(['deepseek-official']);
  await waitFor(() => pc.getRefresh(r.refreshId).run?.status !== 'running', { timeoutMs: 20_000 });
  assertAtomic(target, 'pricing-catalog.json');
});

await report.check('Q8-09b', 'usage-issue-log 落盘必须原子(写临时文件 + rename,目标文件从不被直写)', 'red', async () => {
  uil.recordUsageIssue({ messageId: 'q8-msg-1', model: 'q8-model', codes: ['USAGE_INVALID'], raw: { input_tokens: -1 }, sent: { input_tokens: 0 }, at: Date.now() });
  assertAtomic(uil.USAGE_ISSUE_FILE, 'usage-issues.json');
});

// ── 守卫:锁住"新增落盘点必须走同一机制" ───────────────────────────────
// 历史债(本批范围之外、修前就存在)显式登记,新增一处裸写就红;修复本批两处后这张表不需要动。
const ALLOWLIST = new Set([
  'server/services/auth.js::CONFIG_PATH',            // 鉴权配置(历史债,非本批)
  'server/services/model-resolver.js::CLAUDE_SETTINGS', // 写 ~/.claude/settings.json(历史债,非本批)
  'server/computer-use/mcp-server.js::STAMP_FILE',   // 64 字节 stamp,截断只会触发重装,可自愈
  'server/utils/claude-resolver.js::OVERRIDE_FILE',  // claude 路径覆盖(历史债,非本批)
]);
const TEMP_HINT = /tmp|temp|staging|partial/i;
const CALL_RE = /\bwriteFile(?:Sync)?\(\s*([^,]+?)\s*,/g;

function bareWrites() {
  const hits = [];
  for (const dir of ['server/services', 'server/computer-use', 'server/utils']) {
    for (const f of fs.readdirSync(join(ROOT, dir))) {
      if (!f.endsWith('.js')) continue;
      const file = join(ROOT, dir, f);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*')) return;
        for (const m of t.matchAll(CALL_RE)) {
          const arg = m[1].trim();
          if (TEMP_HINT.test(arg)) continue;
          hits.push({ file: relative(ROOT, file), line: i + 1, arg, key: `${relative(ROOT, file)}::${arg}` });
        }
      });
    }
  }
  return hits;
}

await report.check('Q8-09c', '守卫:services/computer-use/utils 下的裸 writeFile 直写点必须全部在历史债 allowlist 里(本批两处不在列 → 应红)', 'red', async () => {
  const hits = bareWrites();
  const offenders = hits.filter((h) => !ALLOWLIST.has(h.key));
  assert.deepEqual(offenders.map((h) => `${h.file}:${h.line} writeFile(${h.arg})`), [],
    `以下落盘点直写目标文件(应改为写临时文件 + rename):\n${offenders.map((h) => `  ${h.file}:${h.line}  writeFile(${h.arg}, …)`).join('\n')}`);
});

await report.check('Q8-09d', '守卫自检:扫描器确实能看见同目录已做对的两处(usage-stats / cu-common 写的是临时文件)', 'green', async () => {
  const src = (p) => fs.readFileSync(join(ROOT, p), 'utf8');
  assert.match(src('server/services/usage-stats.js'), /writeFileSync\(tmp,/, 'usage-stats 应写 tmp 再 rename');
  assert.match(src('server/computer-use/cu-common.js'), /writeFileSync\(tmp,/, 'cu-common 应写 tmp 再 rename');
  const hits = bareWrites();
  assert.ok(!hits.some((h) => h.file === 'server/services/usage-stats.js'), 'usage-stats 不该被判成裸写');
  assert.ok(!hits.some((h) => h.file === 'server/computer-use/cu-common.js'), 'cu-common 不该被判成裸写');
});

process.exit(report.finish());
