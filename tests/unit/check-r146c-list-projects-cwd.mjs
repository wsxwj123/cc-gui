#!/usr/bin/env node
// 单测:r146c 裁空会话后项目从项目列表消失(r146b-rollback 里 T4→T0 必红的根因)。
//
// 现象:回退到会话第一条会把该会话的 jsonl 裁得只剩摘要行(没有 cwd 字段),它又恰是该项目里最新修改的
// 文件。server/services/session-reader.js 的 listProjects 只拿"最新的那一个文件"推项目真实路径 → 取不到
// cwd → 退回有损的 decodeProjectHash(路径里的空格 / 点 / 中文都被编成了 -,解不回去)→ 解出的路径不存在
// → isNonProjectPath 当"已删除的目录"整个滤掉:项目连同其余会话一起从列表里消失,打开同项目的会话也失败。
// 这里用真实文件系统复现:临时项目目录路径含空格与点(有损解码必然失败),旧会话头里有 cwd、新会话只有摘要行。
// Run: node tests/unit/check-r146c-list-projects-cwd.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// 不在 /tmp 下(isNonProjectPath 会滤掉 /tmp 与 /private/tmp);macOS 的 tmpdir() 在 /var/folders 下。
const home = realpathSync(mkdtempSync(join(tmpdir(), 'r146c-home-')));
const projReal = realpathSync(mkdtempSync(join(tmpdir(), 'r146c proj.dir-')));
process.env.HOME = home;
process.env.USERPROFILE = home;
let code = 0;
try {
  const projectsDir = join(home, '.claude', 'projects');
  const dir = join(projectsDir, projReal.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const oldF = join(dir, 'a1460000-0000-4000-8000-000000000001.jsonl');
  const newF = join(dir, 'a1460000-0000-4000-8000-000000000002.jsonl');
  writeFileSync(oldF, `${JSON.stringify({ type: 'user', cwd: projReal, sessionId: 'a1460000-0000-4000-8000-000000000001', uuid: 'u1', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: '旧会话的一句话' } })}\n`);
  writeFileSync(newF, `${JSON.stringify({ type: 'summary', summary: '被回退裁空的会话', leafUuid: 'x' })}\n`);
  const t0 = Date.now() / 1000;
  utimesSync(oldF, t0 - 3600, t0 - 3600);   // 旧会话:一小时前
  utimesSync(newF, t0, t0);                 // 被裁空的会话:最新修改
  const { listProjects } = await import(root + 'server/services/session-reader.js');
  const list = await listProjects(projectsDir);
  const hit = list.find((p) => p.path === projReal);
  assert.ok(hit, `项目从列表里消失了(返回 ${JSON.stringify(list.map((p) => p.path))})`);
  console.log('  ✓ 最新会话被裁空(头里没有 cwd)时,项目仍按其余会话的 cwd 列出,路径正确');
  console.log('\n全部通过');
} catch (e) {
  code = 1;
  console.log(`  ✗ ${String(e && e.message || e).split('\n')[0]}\n\n1 项失败`);
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(projReal, { recursive: true, force: true });
}
process.exit(code);
