#!/usr/bin/env node
// r142 / T-3 —— 回归范围跑一遍(§6.0:回归范围 = 既有 12 个 check-cu-* + 两套 acceptance + R13 的两条静态约束)。
//
// 这个文件不新增断言,只负责**把回归面钉成一条命令**,免得每次靠记忆挑测试:
//   · 12 个 check-cu-*(8 个 check-cu-* + 4 个 check-q8-cu-*)
//   · check-q8-atomic-write(R13:PY_DEPS 字面量 / Q8-09c 的 STAMP_FILE allowlist / Q8-09d)
//   · check-r116-tool-result-shape(它用 mcp__ccgui-computer-use__screenshot 当样例工具名)
// **修前必须全绿**(这些是既有行为,不是本次验收项);修后任何一条红 = 回归。
//
// acceptance 那两套(cu-batch-20260911 / cu-grant-ui-20260913)要起隔离实例 + 真桌面,不在本文件里跑:
// 它们的跑法与端口约束见 TEST-PLAN §「回归范围」——本机 6700-6999 被 r140 占用时不许跑。
//
// 跑法:node tests/unit/check-cu-r142-regression.mjs [--only cu-]
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';

const SUITE = [
  'check-cu-actions.mjs',
  'check-cu-helper-u16.mjs',
  'check-cu-keys.mjs',
  'check-cu-mapping.mjs',
  'check-cu-protocol.mjs',
  'check-cu-shots.mjs',
  'check-cu-sigterm-release.mjs',
  'check-cu-stdin-args.mjs',
  'check-q8-cu-argv.mjs',
  'check-q8-cu-fallback-failure.mjs',
  'check-q8-cu-scope.mjs',
  'check-q8-cu-timeout.mjs',
  'check-q8-atomic-write.mjs',
  'check-r116-tool-result-shape.mjs',
];

const results = [];
for (const file of SUITE) {
  if (only && !file.includes(only)) continue;
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(HERE, file)], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0;
  results.push({ file, ok, status: r.status, ms: Date.now() - started, tail: out.trim().split('\n').slice(-2).join(' | ') });
  console.log(`${ok ? '✓' : '✗'} ${file} (${Date.now() - started}ms)${ok ? '' : `\n    ${results.at(-1).tail.slice(0, 400)}`}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n== check-cu-r142-regression 汇总 ==`);
console.log(`${results.length} 个回归测试,绿 ${results.length - failed.length},红 ${failed.length}`);
if (failed.length) console.log(`红的:${failed.map((f) => `${f.file}(exit ${f.status})`).join(', ')}`);
process.exit(failed.length ? 1 : 0);
