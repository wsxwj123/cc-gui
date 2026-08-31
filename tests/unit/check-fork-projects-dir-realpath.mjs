#!/usr/bin/env node
// fork 路由 PROJECTS_DIR 软链基准护栏。锁住的行为:
//   ① HOME 位于软链路径(macOS 测试夹具 temp HOME 落 /var → 实为 /private/var)时,
//      fork 不得恒 400——修前 PROJECTS_DIR 未 realpath 而包含校验对目标 realpath,
//      两侧基准分裂,startsWith 恒假(B48 类用例不可达的底层原因)。
//   ② 修复不放松安全门:projectHash 目录若是指向 projects 外的软链,仍必须 400。
//   ③ 正常(无软链)路径行为零变化:合法 fork 照常 200。
// 全程用临时目录构造软链 HOME,不碰真实 ~/.claude。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, sep } from 'node:path';
import express from 'express';

// 软链夹具与 $HOME 语义都是 POSIX 的;该 bug 本身就是 macOS /var→/private/var 场景。
if (process.platform === 'win32') {
  console.log('check-fork-projects-dir-realpath: skipped on win32 (POSIX symlink fixture)');
  process.exit(0);
}

// mac 的 os.tmpdir() 本身是软链形态(/var/folders/…),先解到 real 基准再自建可控软链。
const base = mkdtempSync(join(realpathSync(tmpdir()), 'fork-realpath-'));
const realHome = join(base, 'real-home');
const linkHome = join(base, 'link-home');
const hash = '-test-proj';
const projDir = join(realHome, '.claude', 'projects', hash);
mkdirSync(projDir, { recursive: true });
symlinkSync(realHome, linkHome);

const SID = '11111111-2222-3333-4444-555555555555';
writeFileSync(join(projDir, `${SID}.jsonl`), [
  JSON.stringify({ type: 'user', uuid: 'u1', sessionId: SID, message: { content: [{ type: 'text', text: 'Q' }] } }),
  JSON.stringify({ type: 'assistant', uuid: 'a1', sessionId: SID, message: { content: [{ type: 'text', text: 'A' }] } }),
].join('\n') + '\n');

// 逃逸负向用例:projects 下的软链 hash 指向 projects 外。
const outside = join(base, 'outside');
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, `${SID}.jsonl`), '{}\n');
symlinkSync(outside, join(realHome, '.claude', 'projects', 'evil-hash'));

const origHome = process.env.HOME;
const origProfile = process.env.USERPROFILE;
process.env.HOME = linkHome; // POSIX 上 os.homedir() 优先读 $HOME,必须在 import fork.js 之前设好
process.env.USERPROFILE = linkHome; // r49 守卫:动 HOME 必同动 USERPROFILE(Windows 的 homedir 来源)
assert.equal(homedir(), linkHome, 'precondition: homedir() follows $HOME');

// ── 修前形态取证:软链 HOME 下,未 realpath 的 PROJECTS_DIR 与 realpath 后的目标基准分裂 ──
{
  const rawProjectsDir = join(linkHome, '.claude', 'projects');       // 修前 PROJECTS_DIR 形态
  const realDir = realpathSync(join(rawProjectsDir, hash));           // 包含校验对目标做 realpath 后的形态
  const brokenCheck = realDir === rawProjectsDir || realDir.startsWith(rawProjectsDir + sep);
  assert.equal(brokenCheck, false, 'pre-fix shape: containment check false under symlinked HOME (= the 400)');
}

const { default: forkRouter } = await import('../../server/routes/fork.js');
const app = express();
app.use(express.json());
app.use('/api', forkRouter);
const server = app.listen(0);
const port = server.address().port;
const post = async (body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/fork`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

try {
  // ── ① 软链 HOME 下合法 fork 必须通过(修前此处恒 400 invalid projectHash) ──
  const ok = await post({ sessionId: SID, projectHash: hash });
  assert.equal(ok.status, 200, `symlinked HOME: fork must pass, got ${ok.status} ${JSON.stringify(ok.body)}`);
  assert.ok(ok.body.newSessionId, 'symlinked HOME: returns newSessionId');
  assert.ok(existsSync(join(projDir, `${ok.body.newSessionId}.jsonl`)), 'forked file lands in real projects dir');

  // ── ② 安全门未放松:软链逃逸 hash 仍 400 ──
  const evil = await post({ sessionId: SID, projectHash: 'evil-hash' });
  assert.equal(evil.status, 400, 'symlink escaping projects dir must still be rejected');
  assert.equal(evil.body.error, 'invalid projectHash');

  // ── ③ 不存在的 hash 仍 400(realpath 失败路径不变) ──
  const miss = await post({ sessionId: SID, projectHash: '-no-such' });
  assert.equal(miss.status, 400, 'nonexistent hash still 400');
} finally {
  server.close();
  process.env.HOME = origHome;
  if (origProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origProfile;
  rmSync(base, { recursive: true, force: true });
}

console.log('check-fork-projects-dir-realpath: all assertions passed');
