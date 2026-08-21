#!/usr/bin/env node
// r26-D4【单测】:import-inline 的 EXDEV 跨卷兜底 + stage 泄漏修复(PLAN D4 验收点)。
//   ①moveStageDir:注入 rename 抛 {code:'EXDEV'} → dest 内容完整、stage 不存在(跨卷兜底哨兵);
//   ②注入 rename 抛 {code:'EACCES'} → 原样上抛不吞(只兜 EXDEV 哨兵);
//   ③import-inline 路由真实失败路径(stage 创建后 mkdir(skinsDir) 失败)→ 500 且
//     stage 目录已清(stage 泄漏哨兵;TMPDIR 隔离到 scratch 精确计数);
//   ④正常 import-inline 走通(201,落盘在隔离 HOME 的 skins 目录,回归哨兵)。
// 隔离口径:makeTmpHome 先于 import 路由(SKINS_DIR 模块顶层固化 homedir);
// 端口只用 6703;真实 ~/.claude-gui 零触碰。
// Run: node tests/unit/check-r26-import-inline-exdev.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeTmpHome, cleanupDirs, listenWithRetry, stopServer } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('d4-unit');
// stage 目录落在 os.tmpdir()(每次调用现读 TMPDIR)→ 隔离到 scratch 精确计数
const SCRATCH_TMP = mkdtempSync(join(tmpdir(), 'cgui-r26-d4tmp-'));
process.env.TMPDIR = SCRATCH_TMP;
process.on('exit', () => { try { cleanupDirs(TMP_HOME, SCRATCH_TMP); } catch {} });

const { moveStageDir, SKINS_DIR } = await import('../../server/routes/skins-packs.js');
const express = (await import('express')).default;
const skinsRouter = (await import('../../server/routes/skins-packs.js')).default;

const stageCount = () => readdirSync(SCRATCH_TMP).filter((d) => d.startsWith('cgui-skin-stage-')).length;

// ── ① EXDEV 注入:逐文件拷贝兜底,dest 完整、stage 清 ──
{
  const stage = mkdtempSync(join(SCRATCH_TMP, 'cgui-skin-stage-x-'));
  writeFileSync(join(stage, 'skin.json'), '{"a":1}');
  writeFileSync(join(stage, 'meta.json'), '{"source":"user"}');
  const dest = join(SCRATCH_TMP, 'dest-exdev');
  const exdev = Object.assign(new Error('cross-device'), { code: 'EXDEV' });
  await moveStageDir(stage, dest, async () => { throw exdev; });
  assert.equal(readFileSync(join(dest, 'skin.json'), 'utf8'), '{"a":1}', '① EXDEV 后 dest 内容完整');
  assert.equal(readFileSync(join(dest, 'meta.json'), 'utf8'), '{"source":"user"}', '① EXDEV 后 meta 完整');
  assert.ok(!existsSync(stage), '① EXDEV 兜底后 stage 已清');
}

// ── ② EACCES 注入:原样上抛不吞(只兜 EXDEV)──
{
  const stage = mkdtempSync(join(SCRATCH_TMP, 'cgui-skin-stage-y-'));
  writeFileSync(join(stage, 'skin.json'), '{}');
  const dest = join(SCRATCH_TMP, 'dest-eacces');
  await assert.rejects(
    moveStageDir(stage, dest, async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }),
    (e) => e.code === 'EACCES',
    '② EACCES 原样上抛(不吞、不拷贝)',
  );
  assert.ok(!existsSync(dest), '② 非 EXDEV 不产半截 dest');
  rmSync(stage, { recursive: true, force: true });
}

// ── ③④ 路由级:真实 HTTP 打 import-inline(隔离 HOME + 6703)──
const app = express();
app.use(express.json());
app.use('/api', skinsRouter);
let server = null;
let failure = null;
try {
  server = await listenWithRetry(6703, (p) => app.listen(p, '127.0.0.1'));
  const BASE = 'http://127.0.0.1:6703';
  const post = (body) => fetch(`${BASE}/api/skins/import-inline`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  // ④ 正常 trio 导入走通(先做,证明管线本身没坏)
  const ok = await post({ kind: 'trio', name: 'd4-ok', css: 'body{}', js: 'window.__cguiSkinDispose = () => {};' });
  assert.equal(ok.status, 201, `④ 正常 import-inline 201(实际 ${ok.status})`);
  const okBody = await ok.json();
  assert.ok(existsSync(join(SKINS_DIR, okBody.id, 'skin.json')), '④ 落盘在隔离 HOME 的 skins 目录');
  assert.ok(SKINS_DIR.startsWith(TMP_HOME), '④ SKINS_DIR 在隔离 HOME 下(真实目录零触碰自证)');
  assert.equal(stageCount(), 0, '④ 成功路径 stage 无残留');

  // ③ stage 创建后失败:把 .claude-gui 做成文件 → mkdir(skinsDir) 必炸(ENOTDIR)
  const before = stageCount();
  rmSync(join(TMP_HOME, '.claude-gui'), { recursive: true, force: true }); // ④ 已建出目录,先清
  writeFileSync(join(TMP_HOME, '.claude-gui'), 'block');
  const bad = await post({ kind: 'trio', name: 'd4-fail', css: 'body{}' });
  assert.equal(bad.status, 500, `③ stage 创建后失败应 500(实际 ${bad.status})`);
  assert.equal(stageCount(), before, '③ 失败路径 stage 已清(修前 rename/mkdir 失败即泄漏)');
  rmSync(join(TMP_HOME, '.claude-gui'));
} catch (e) {
  failure = e;
} finally {
  await stopServer(server);
}
if (failure) throw failure;

console.log('PASS check-r26-import-inline-exdev');
