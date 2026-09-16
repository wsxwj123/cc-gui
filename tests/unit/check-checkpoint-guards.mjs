#!/usr/bin/env node
// 白盒补充单测(r120):回滚点占用治理里三条最容易写错、黑盒又不好钉死的逻辑。
// 与锁定的 check-r120-checkpoint.mjs 互补,不改它、不重复它:
//   1) 体积安全阀的**阈值边界**(正好等于阈值 = 放行,超一个字节 = 跳过)
//   2) 清理/删除之后 meta.json 与 git log **严格一致**(列了就必须打得开,反之亦然)
//   3) 路径前缀校验确实挡得住越界 sessionId(`../` 拼接不得删到 CHECKPOINTS_ROOT 之外)
// 夹具全在隔离 HOME 里,稀疏文件,单次运行总写 < 5 MB。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, truncateSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = '/private/tmp/claude-501';
mkdirSync(SCRATCH, { recursive: true });
const TMP = mkdtempSync(join(SCRATCH, 'cgui-cpguards-'));
const HOME = join(TMP, 'home');
const WORK = join(HOME, 'work');
mkdirSync(WORK, { recursive: true });
const PORT = 6031;                                  // 非默认端口,不碰 6677/6689/6710

const LIMIT = 200_000;                              // 阈值 200 KB,边界用例好造
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.PORT = String(PORT);
process.env.CGUI_DISABLE_FILE_WATCHER = '1';
process.env.CGUI_CHECKPOINT_MAX_BYTES = String(LIMIT);
process.env.CGUI_CHECKPOINTS_MAX_COUNT = '2';       // 条数上限 2,清理用例好触发
process.env.CGUI_CHECKPOINTS_RETENTION_DAYS = '30';

const CHECKPOINTS_DIR = join(HOME, '.claude', 'gui', 'checkpoints');
const sid = (n) => `12000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let PASS = 0; let FAILS = 0; const failed = [];
async function check(name, fn) {
  try { await fn(); PASS += 1; console.log(`  ✓ ${name}`); }
  catch (e) {
    FAILS += 1; failed.push(name);
    console.log(`  ✗ ${name}\n      ${String((e && e.message) || e).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

const BASE = `http://127.0.0.1:${PORT}`;
async function req(method, url, body, timeoutMs = 60_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + url, {
      method, signal: ctl.signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, text, json };
  } finally { clearTimeout(timer); }
}

/** 目录字节数:只 stat,不读内容(与实现同口径)。 */
function dirBytes(dir) {
  const r = spawnSync('du', ['-sk', dir], { encoding: 'utf8' });
  return r.status === 0 ? Number(r.stdout.trim().split(/\s+/)[0]) * 1024 : 0;
}
const snapDir = (id) => join(CHECKPOINTS_DIR, id);
function realShas(id) {
  const dir = snapDir(id);
  if (!existsSync(dir)) return [];
  const r = spawnSync('git', ['--git-dir', dir, 'log', '--format=%H'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}
const META_FILE = (id) => join(snapDir(id), 'meta.json');
const metaShas = (id) => {
  const f = META_FILE(id);
  if (!existsSync(f)) return [];
  try { return (JSON.parse(readFileSync(f, 'utf8')).entries || []).map((e) => e.sha); }
  catch { return []; }
};

/** 造一个"逻辑大小正好 bytes"的工作目录:1 个稀疏填充文件(几乎不占盘)。 */
function makeDir(name, fileBytes) {
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'filler.bin');
  writeFileSync(f, '');
  truncateSync(f, fileBytes);
  writeFileSync(join(dir, 'note.txt'), 'hello\n');   // 一个真实小文件,保证快照有内容
  return dir;
}

let child = null;
async function bootServer() {
  child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    cwd: TMP, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => { log += b; });
  child.stderr.on('data', (b) => { log += b; });
  for (let i = 0; i < 120; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return log;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`隔离实例没起来(端口 ${PORT})\n${log.slice(-2000)}`);
}

const post = (body) => req('POST', '/api/checkpoints', body);

// ══════════════════════════════════════════════════════════════════════════
await bootServer();
console.log(`[cp-guards] 隔离实例就绪:${BASE}(阈值 ${LIMIT} B)`);

// ── G1 阈值边界 ─────────────────────────────────────────────────────────
console.log('\nG1 体积安全阀的阈值边界');
const S_UNDER = sid(1);
const S_OVER = sid(2);
const UNDER = makeDir('under', LIMIT - 8192);       // 正好比阈值小 8 KB
const OVER = makeDir('over', LIMIT + 64 * 1024);    // 正好超阈值 64 KB

await check('G1-1 恰好低于阈值 → 放行(安全阀不许误伤正常项目)', async () => {
  const r = await post({ sessionId: S_UNDER, cwd: UNDER });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.notEqual(r.json.skipped, true, `逻辑大小 ${LIMIT - 8192} < 阈值 ${LIMIT},不该被跳过`);
  assert.ok(r.json.sha, '应返回 sha');
});

await check('G1-2 超过阈值哪怕一点 → 跳过,且带 estimatedBytes/limitBytes 供界面解释', async () => {
  const r = await post({ sessionId: S_OVER, cwd: OVER });
  assert.equal(r.status, 200, '按接口约定不得报错');
  assert.equal(r.json.skipped, true, `逻辑大小 ${LIMIT + 64 * 1024} > 阈值 ${LIMIT},必须跳过`);
  assert.ok(Number.isFinite(r.json.estimatedBytes) && r.json.estimatedBytes > LIMIT,
    `应回报估算值,实际 ${JSON.stringify(r.json.estimatedBytes)}`);
  assert.equal(r.json.limitBytes, LIMIT, '应回报生效的阈值(可配置项真的被读了)');
  assert.ok(typeof r.json.reason === 'string' && r.json.reason.length > 0, '必须给原因');
});

await check('G1-3 被跳过的会话不得在磁盘上留下空仓(否则每跳一次白留一份)', async () => {
  assert.equal(existsSync(snapDir(S_OVER)), false,
    '跳过时若沿途建过影子仓,必须收掉——174 个空目录就是这么堆起来的');
});

// ── G2 清理后 meta 与 git 严格一致 ──────────────────────────────────────
console.log('\nG2 清理/删除后 meta.json 与 git log 一致(条数上限 2)');
const S_TRIM = sid(3);
const TRIM = makeDir('trim', 4096);

await check('G2-1 连拍 5 条后,列表与磁盘双向一致、且收敛到上限以内', async () => {
  for (let i = 0; i < 5; i += 1) {
    writeFileSync(join(TRIM, 'note.txt'), `v${i}\n`);
    const r = await post({ sessionId: S_TRIM, cwd: TRIM });
    assert.equal(r.status, 200, r.text.slice(0, 160));
  }
  const list = (await req('GET', `/api/checkpoints/${S_TRIM}`)).json.entries.map((e) => e.sha);
  const real = realShas(S_TRIM);
  assert.ok(list.length <= 2, `条数应压回上限 2,实际 ${list.length}`);
  assert.deepEqual([...list].sort(), [...real].sort(),
    `列表与磁盘必须逐条对齐\n  列表=${list.join(',')}\n  磁盘=${real.join(',')}`);
  // meta 是列表的来源,同样要对齐
  assert.deepEqual([...metaShas(S_TRIM)].sort(), [...real].sort(), 'meta.json 也必须与 git 一致');
});

await check('G2-2 被清理掉的那些快照,对象是真的从磁盘上没了(不是只从列表里抹掉)', async () => {
  const real = realShas(S_TRIM);
  assert.ok(real.length <= 2, '前置:已收敛');
  // 直接问 git:仓里能数出来的提交数就是磁盘上真实存在的条数
  const r = spawnSync('git', ['--git-dir', snapDir(S_TRIM), 'rev-list', '--all', '--count'],
    { encoding: 'utf8' });
  assert.equal(Number(r.stdout.trim()), real.length,
    `rev-list 数出来的提交数与 log 条数不符 → 有孤儿提交没回收(${r.stdout.trim()} vs ${real.length})`);
});

await check('G2-3 删单条后 meta 与 git 仍然一致,且被删的那条打得开就说明没删干净', async () => {
  const before = realShas(S_TRIM);
  assert.ok(before.length >= 1, '前置:要有东西可删');
  const victim = before[before.length - 1];         // 最旧那条
  const del = await req('DELETE', `/api/checkpoints/${S_TRIM}/${victim}`);
  assert.equal(del.status, 200, `删单条应 200,实际 ${del.status}: ${del.text.slice(0, 160)}`);
  const real = realShas(S_TRIM);
  assert.ok(!real.includes(victim), '被删的那条磁盘上必须真的没了');
  const list = (await req('GET', `/api/checkpoints/${S_TRIM}`)).json.entries.map((e) => e.sha);
  assert.deepEqual([...list].sort(), [...real].sort(), '删完之后列表与磁盘仍要逐条对齐');
  assert.deepEqual([...metaShas(S_TRIM)].sort(), [...real].sort(), 'meta 与 git 仍要一致');
  // 留下的必须真的能回滚
  const keep = real[0];
  if (keep) {
    const res = await req('POST', `/api/checkpoints/${S_TRIM}/restore`, { sha: keep, cwd: TRIM });
    assert.equal(res.status, 200, `留下的快照必须能回滚,实际 ${res.status}`);
  }
});

// ── G3 路径前缀校验挡越界 sessionId ─────────────────────────────────────
console.log('\nG3 越界 sessionId 挡得住(rm -rf 不许误伤)');
const OUTSIDE = join(HOME, 'work', 'OUTSIDE_MUST_SURVIVE');

await check('G3-1 含 `/` 或 `..` 的 sessionId 一律 400,且不得碰任何目录', async () => {
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(OUTSIDE, 'keep.txt'), 'keep\n');
  const bad = [
    '..', '../..', '..%2f..%2fetc', 'a/b', 'a\\b', '../../work/OUTSIDE_MUST_SURVIVE',
    '.', '', '%2e%2e',
  ];
  for (const b of bad) {
    const url = `/api/checkpoints/${encodeURIComponent(b)}`;
    const r = await req('DELETE', url);
    assert.ok(r.status === 400 || r.status === 404,
      `越界 id ${JSON.stringify(b)} 应 400/404,实际 ${r.status}: ${r.text.slice(0, 120)}`);
  }
  assert.ok(existsSync(join(OUTSIDE, 'keep.txt')), '越界删除不得动到 CHECKPOINTS_ROOT 之外的目录');
});

await check('G3-2 合法的 sessionId 仍然能正常删(白名单不许把正常 id 也挡了)', async () => {
  const S = sid(9);
  const D = makeDir('delok', 4096);
  await post({ sessionId: S, cwd: D });
  assert.ok(realShas(S).length > 0, '前置:先要有快照');
  const r = await req('DELETE', `/api/checkpoints/${S}`);
  assert.equal(r.status, 200, `正常 id 应能删,实际 ${r.status}: ${r.text.slice(0, 160)}`);
  assert.equal(existsSync(snapDir(S)), false, '目录该消失了');
});

await check('G3-3 只删得到目标会话,别的会话目录一个都不许少', async () => {
  const A = sid(10);
  const B = sid(11);
  await post({ sessionId: A, cwd: makeDir('keepA', 4096) });
  await post({ sessionId: B, cwd: makeDir('keepB', 4096) });
  const res = await req('DELETE', `/api/checkpoints-stats`);
  assert.equal(res.status, 404, 'stats 只认 GET');
  const r = await req('DELETE', `/api/checkpoints/${A}`);
  assert.equal(r.status, 200);
  assert.equal(existsSync(snapDir(A)), false, 'A 该没了');
  assert.ok(existsSync(snapDir(B)), 'B 必须原样留着');
  assert.ok(realShas(B).length > 0, 'B 的快照内容也必须在');
});

// ══════════════════════════════════════════════════════════════════════════
try { if (child) process.kill(child.pid, 'SIGKILL'); } catch { /* 已退 */ }
console.log(`\n—— check-checkpoint-guards:${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) { console.log('红的条目:'); for (const n of failed) console.log(`  ✗ ${n}`); }
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(FAILS ? 1 : 0);
