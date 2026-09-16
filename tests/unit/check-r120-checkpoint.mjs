#!/usr/bin/env node
// r120 接口层验收测试:回滚检查点不再吃爆磁盘
//
// 本文件是【黑盒验收测试】:只依据 .devflow/BRIEF-r120.md 与 .devflow/INTERFACE-r120.md,
// 没看 server/client 实现代码、没看 PLAN、没看 git 历史。
//
// 站在真实用户角度:用户的工作目录被整份拷进 ~/.claude/gui/checkpoints/,只增不减、
// 界面里删不掉、删了会话也不清。下面每条分别盯住"该停的不停""该删的不删""看不见"。
//
// 本机事实(探针已核实,写在这里省得下一个人重探):
//  * cwd 必须落在 $HOME 内,否则 400 {"error":"path outside $HOME"};大目录夹具因此建在
//    隔离 HOME 里面(不会去碰真实 ~/.claude,也不会把几十 G 写进用户目录)。
//  * 工作目录里有 .git 时,checkpoints 仓把它当 gitlink 存,**不拷贝内容** → 体积不涨,
//    反而掩盖缺陷。所以 R1 的"大目录"刻意不含任何 .git。
//  * 服务端子进程 spawn git 时继承当前 process.env(见 .devflow/INTERFACE-r120.md R1:
//    阈值"读环境变量或设置项"),因此本文件用 process.env 注入 CGUI_CHECKPOINT_MAX_* 等;
//    若实现换了变量名,这些用例会红,是预期的"红",不是测试写错。
//  * restore-file 的"路径"字段实现只认绝对路径(试过 path/paths/file/files/relativePath
//    全被判 invalid)→ R6 的 restore-file 用例一律传绝对路径。
//  * 未知/空会话的 resolve 现在是 400(git log 空仓),不是干净空列表;R2 的"列表与磁盘一致"
//    断言因此只对已存在的会话查询,不越界去定义未知会话的语义。
//
// 设计:每条一个断言主题,互不依赖、可任意顺序跑;阈值/上限一律用可注入配置给,不动默认值。
// 每条标 [修前应红] / [修前应绿];本条测试自身把 red/green 归类为"期望",实际红绿看输出。
//
// Run: node tests/unit/check-r120-checkpoint.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync, truncateSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = '/private/tmp/claude-501';
mkdirSync(SCRATCH, { recursive: true });
const TMP = mkdtempSync(join(SCRATCH, 'cgui-r120-cp-'));
const HOME = join(TMP, 'home');
mkdirSync(HOME, { recursive: true });
const WORK = join(HOME, 'work');
mkdirSync(WORK, { recursive: true });
const PORT = 6021;                                    // 硬编码非默认端口,绝不碰 6677/6689/6710

// —— 可注入配置(实现读环境变量或设置项;子进程继承本 env)——
process.env.HOME = HOME;                              // 绝不读写真实 ~/.claude*
process.env.USERPROFILE = HOME;
process.env.PORT = String(PORT);
process.env.CGUI_DISABLE_FILE_WATCHER = '1';
// 体积安全阀:小目录夹具几十 KB,阈值给 64 KB
process.env.CGUI_CHECKPOINT_MAX_BYTES = '65536';
process.env.CGUI_CHECKPOINTS_MAX_BYTES = '65536';
// 自动清理:条数上限 3、保留时长 30 天(测试期间不触发时间维)
process.env.CGUI_CHECKPOINT_MAX_COUNT = '3';
process.env.CGUI_CHECKPOINTS_MAX_COUNT = '3';
process.env.CGUI_CHECKPOINT_RETENTION_DAYS = '30';
process.env.CGUI_CHECKPOINTS_RETENTION_DAYS = '30';
// 允许测试用极小保留时长(如 1ms)触发时间维清理
process.env.CGUI_ALLOW_TINY_CHECKPOINT_RETENTION = '1';

const CHECKPOINTS_DIR = join(HOME, '.claude', 'gui', 'checkpoints');
const sid = (suffix) => `12000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

// ── 计数 ────────────────────────────────────────────────────────────────
let PASS = 0, FAILS = 0;
const failed = [];
const tally = { RED: { pass: 0, fail: 0 }, GREEN: { pass: 0, fail: 0 } };
const TAG = { RED: '[修前应红]', GREEN: '[修前应绿]' };
async function check(tag, name, fn) {
  const label = `${TAG[tag]} ${name}`;
  try {
    await fn();
    PASS++; tally[tag].pass++;
    console.log(`  ✓ ${label}`);
  } catch (e) {
    FAILS++; tally[tag].fail++;
    failed.push(label);
    const msg = String((e && e.message) || e).split('\n').slice(0, 5).join('\n      ');
    console.log(`  ✗ ${label}\n      ${msg}`);
  }
}
const red = (name, fn) => check('RED', name, fn);
const green = (name, fn) => check('GREEN', name, fn);

// ── HTTP 小工具 ─────────────────────────────────────────────────────────
const BASE = `http://127.0.0.1:${PORT}`;
async function req(method, url, body, timeoutMs = 120_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + url, {
      method,
      signal: ctl.signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON(如 Express 的 HTML 错误页) */ }
    return { status: res.status, text, json };
  } finally { clearTimeout(timer); }
}
const post = (url, body) => req('POST', url, body);
const del = (url) => req('DELETE', url);

// ── 卷内取标记:整棵磁盘子树的字节数(含 .git 对象、meta.json;与 du 口径一致)──
function dirBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = join(d, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) total += statSync(p).size;
        // 符号链接不算(约定:不拷贝链接内容)
      } catch { /* 竞态忽略 */ }
    }
  }
  return total;
}
const snapDir = (sessionId) => join(CHECKPOINTS_DIR, sessionId);
/** 会话挂在隔离 HOME 里的路径(服务端把 HOME 当 $HOME)。 */
const homePath = (p) => p;

// ── 夹具:大目录 / 小目录 ───────────────────────────────────────────────
// 体积不靠写满:1 个稀疏填充的 1 MiB 文件 + 1500 个 4 KB 文件 ≈ 7 MB(单次运行总写 < 10 MB)。
// 刻意不建 .git —— 有 .git 的话 checkpoints 仓只存 gitlink,体积不涨,反而测不出缺陷。
function makeBigDir(name) {
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const filler = join(dir, 'filler.bin');
  writeFileSync(filler, '');
  truncateSync(filler, 1024 * 1024);                  // 稀疏:1 MiB 逻辑大小,几乎不占盘
  const blob = Buffer.alloc(4096, 0x61);
  for (let i = 0; i < 1500; i += 1) writeFileSync(join(dir, `data-${String(i).padStart(4, '0')}.txt`), blob);
  return dir;
}
function makeSmallDir(name, files = 2) {
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < files; i += 1) writeFileSync(join(dir, `note-${i}.txt`), `内容 ${i}\n`);
  return dir;
}
/** 把会话写进"看起来存在"的 transcript,供 DELETE /api/sessions 找得到它。 */
function writeTranscript(sessionId, cwd) {
  const proj = join(HOME, '.claude', 'projects', encodeProjectDir(cwd));
  mkdirSync(proj, { recursive: true });
  const lines = [
    { type: 'summary', summary: 'r120 test', leafUuid: `${sessionId}-u1` },
    {
      type: 'user', uuid: `${sessionId}-u1`, parentUuid: null, sessionId, cwd,
      timestamp: '2026-09-15T08:00:00.000Z', message: { role: 'user', content: 'hello' },
    },
  ];
  writeFileSync(join(proj, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return proj;
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
function shutServer() {
  if (!child) return;
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已退 */ }
  child = null;
}
/** 磁盘上真实存在的快照 sha 集合(直接问 checkpoints 仓,用户"打开得快照"的口径)。 */
function realShas(sessionId) {
  const dir = snapDir(sessionId);
  if (!existsSync(dir)) return [];
  const r = spawnSync('git', ['--git-dir', dir, 'log', '--format=%H'], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}
/** 该会话磁盘上真实的快照条数(不是 git 目录里的文件条目数)。 */
const snapCount = (sessionId) => realShas(sessionId).length;
/** 记录/改一条快照的时间 —— 只有测试注入才有,用户日常不会这么做。 */
const gitRaw = (sessionId, args) => {
  const r = spawnSync('git', ['--git-dir', snapDir(sessionId), ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout.trim();
};

// ══════════════════════════════════════════════════════════════════════════
const serverLog = await bootServer();
console.log(`[r120] 隔离实例就绪:${BASE}(HOME=${HOME})`);

// ── R1 体积安全阀 ───────────────────────────────────────────────────────
console.log('\nR1 体积安全阀');
const BIG = makeBigDir('big');
const SMALL = makeSmallDir('small');
const S_BIG = sid(1);
const S_SMALL = sid(2);

await red('R1-1 大目录(7 MB > 64 KB 阈值)→ 不创建快照,且明确告知被跳过及原因', async () => {
  const listBefore = await req('GET', `/api/checkpoints/${S_BIG}`);
  assert.equal(listBefore.status, 200, '快照列表应可读');
  const before = listBefore.json.entries.length;
  const res = await post('/api/checkpoints', { sessionId: S_BIG, cwd: homePath(BIG) });
  assert.equal(res.status, 200, `按接口约定"不得报错",实际 ${res.status}: ${res.text.slice(0, 200)}`);
  assert.equal(res.json.skipped, true, '超阈值的拍快照必须带可判定的 skipped 标记,不能静默成功');
  assert.ok(typeof res.json.reason === 'string' && res.json.reason.length > 0,
    `必须给出原因(如"目录过大"),实际 reason=${JSON.stringify(res.json.reason)}`);
  const after = await req('GET', `/api/checkpoints/${S_BIG}`);
  assert.equal(after.json.entries.length, before, '被跳过时列表条数必须不变');
  assert.equal(realShas(S_BIG).length, 0, '被跳过时磁盘上不该出现任何快照');
});

await red('R1-2 重复调用仍按"跳过"处理,不会因为跳过而失败(200 + skipped,不累积)', async () => {
  const first = await post('/api/checkpoints', { sessionId: S_BIG, cwd: homePath(BIG) });
  const second = await post('/api/checkpoints', { sessionId: S_BIG, cwd: homePath(BIG) });
  assert.equal(second.status, 200, '反复跳过不得变成错误响应');
  assert.equal(second.json.skipped, true, '第二次超阈值仍应报 skipped');
  assert.equal(first.json.skipped, true, '第一次超阈值就应报 skipped');
  assert.equal(await req('GET', `/api/checkpoints/${S_BIG}`).then((r) => r.json.entries.length), 0,
    '跳过若干次后列表仍为空');
});

await green('R1-3 反向守卫:小目录照常创建快照(安全阀不许误伤)', async () => {
  const res = await post('/api/checkpoints', { sessionId: S_SMALL, cwd: homePath(SMALL) });
  assert.equal(res.status, 200, `小目录拍快照应成功,实际 ${res.status}: ${res.text.slice(0, 200)}`);
  assert.notEqual(res.json.skipped, true, '小目录不得被判定为超阈值', );
  assert.ok(res.json.sha, '创建成功应返回 sha');
  const list = await req('GET', `/api/checkpoints/${S_SMALL}`);
  assert.equal(list.json.entries.length, 1, '小目录不超限时应如实多出一条');
});

// ── R6(前段)既有语义:R1 之后 restore / resolve 照常 ────────────────────
console.log('\nR6 既有行为不变(restore / restore-file / resolve 快照列表)');
const RF = makeSmallDir('restorefile');
const S_RF = sid(3);
await green('R6-1 resolve 取列表第一条:返回的 sha 在列表里、且磁盘上真实存在', async () => {
  const first = await post('/api/checkpoints', { sessionId: S_RF, cwd: homePath(RF) });
  assert.ok(first.json.sha, '先要能拍出快照');
  writeFileSync(join(RF, 'note-0.txt'), '改过了\n');
  const second = await post('/api/checkpoints', { sessionId: S_RF, cwd: homePath(RF) });
  const list = await req('GET', `/api/checkpoints/${S_RF}`);
  const resolved = await req('GET', `/api/checkpoints/${S_RF}/resolve`);
  assert.equal(resolved.status, 200, 'resolve 应照常可用');
  assert.ok(resolved.json.sha, 'resolve 应给出一个 sha');
  assert.ok(list.json.entries.some((e) => e.sha === resolved.json.sha), 'resolve 给的 sha 必须在列表里');
  assert.ok(realShas(S_RF).includes(resolved.json.sha),
    'resolve 给的 sha 必须在磁盘仓里真实存在(不出现"列了打不开")');
  assert.ok([first.json.sha, second.json.sha].includes(resolved.json.sha), 'resolve 只能指向本会话真实拍过的快照');
});

await green('R6-2 restore 把工作目录内容还原到指定快照(语义与时间口径不变)', async () => {
  const list = await req('GET', `/api/checkpoints/${S_RF}`);
  const oldest = list.json.entries[list.json.entries.length - 1];
  assert.equal(readFileSync(join(RF, 'note-0.txt'), 'utf8'), '改过了\n', '前置:文件此刻是改动后的样子');
  const res = await post(`/api/checkpoints/${S_RF}/restore`, { sha: oldest.sha, cwd: homePath(RF) });
  assert.equal(res.status, 200, `restore 应成功,实际 ${res.status}: ${res.text.slice(0, 200)}`);
  assert.equal(res.json.ok, true);
  assert.equal(readFileSync(join(RF, 'note-0.txt'), 'utf8'), '内容 0\n', 'restore 应把文件还原成快照时的内容');
});

await green('R6-3 restore-file 只还原指定文件,别的文件不动', async () => {
  // 拍一张:note-0=内容0、note-1=内容1;然后两个文件都改;只还原 note-0
  const base = await post('/api/checkpoints', { sessionId: S_RF, cwd: homePath(RF) });
  assert.ok(base.json.sha);
  writeFileSync(join(RF, 'note-0.txt'), 'A改\n');
  writeFileSync(join(RF, 'note-1.txt'), 'B改\n');
  const res = await post(`/api/checkpoints/${S_RF}/restore-file`, {
    sha: base.json.sha, cwd: homePath(RF), path: homePath(RF), file: join(RF, 'note-0.txt'),
  });
  assert.equal(res.status, 200, `restore-file 应成功,实际 ${res.status}: ${res.text.slice(0, 200)}`);
  assert.equal(readFileSync(join(RF, 'note-0.txt'), 'utf8'), '内容 0\n', '指定文件应被还原');
  assert.equal(readFileSync(join(RF, 'note-1.txt'), 'utf8'), 'B改\n', '未指定的文件一个字都不许动');
});

// ── R2 自动清理 ─────────────────────────────────────────────────────────
console.log('\nR2 自动清理(条数上限 3)');
const TRIM = makeSmallDir('trim');
const S_TRIM = sid(4);
const LIMIT = 3;
let trimShas = [];
await green('R2-1 前置:连拍 5 条(超过条数上限 3)时,允许实现当场只留窗口内的', async () => {
  for (let i = 0; i < 5; i += 1) {
    writeFileSync(join(TRIM, 'note-0.txt'), `第 ${i} 版\n`);
    const r = await post('/api/checkpoints', { sessionId: S_TRIM, cwd: homePath(TRIM) });
    assert.equal(r.status, 200, `第 ${i + 1} 次拍快照应成功: ${r.text.slice(0, 160)}`);
    if (r.json.sha) trimShas.push(r.json.sha);
  }
  const n = snapCount(S_TRIM);
  assert.ok(n > 0, '拍完之后磁盘上至少要有东西');
});

await green('R2-2 列表里的每一条都快照在磁盘上真实存在(不出现"列了打不开")', async () => {
  const list = await req('GET', `/api/checkpoints/${S_TRIM}`);
  assert.equal(list.status, 200);
  const real = realShas(S_TRIM);
  assert.ok(list.json.entries.length > 0, '列表不该是空的');
  for (const e of list.json.entries) {
    assert.ok(real.includes(e.sha), `列表里的 ${e.sha.slice(0, 10)} 在磁盘仓里找不到 —— 用户会打不开`);
  }
  for (const sha of real) {
    const inList = list.json.entries.some((e) => e.sha === sha);
    assert.ok(inList, `磁盘上的 ${sha.slice(0, 10)} 没出现在列表里 —— 列表与磁盘不一致`);
  }
});

await red('R2-3 超过条数上限的旧快照被回收,条数压回上限以内', async () => {
  const n = snapCount(S_TRIM);
  assert.ok(n <= LIMIT, `条数上限 ${LIMIT},实际磁盘上还有 ${n} 条 —— 空间只涨不跌`);
  const list = await req('GET', `/api/checkpoints/${S_TRIM}`);
  assert.ok(list.json.entries.length <= LIMIT, `列表也应收敛到 ${LIMIT} 条以内,实际 ${list.json.entries.length}`);
});

await green('R2-4 仍被列出的快照 restore 照常可用(清理没把窗口内的删坏)', async () => {
  const list = await req('GET', `/api/checkpoints/${S_TRIM}`);
  const newest = list.json.entries[0];
  assert.ok(newest, '至少应留下最新一条');
  const res = await post(`/api/checkpoints/${S_TRIM}/restore`, { sha: newest.sha, cwd: homePath(TRIM) });
  assert.equal(res.status, 200, `留着的快照必须能回滚,实际 ${res.status}: ${res.text.slice(0, 200)}`);
});

await green('R2-5 反向守卫:没超限时不许乱删(只拍 3 条,一条不少)', async () => {
  const KEEP = makeSmallDir('keep');
  const S_KEEP = sid(5);
  for (let i = 0; i < LIMIT; i += 1) {
    writeFileSync(join(KEEP, 'note-0.txt'), `保留 ${i}\n`);
    const r = await post('/api/checkpoints', { sessionId: S_KEEP, cwd: homePath(KEEP) });
    assert.equal(r.status, 200, r.text.slice(0, 160));
  }
  const list = await req('GET', `/api/checkpoints/${S_KEEP}`);
  assert.equal(list.json.entries.length, LIMIT, `正好到上限,不该被清理,实际剩 ${list.json.entries.length} 条`);
  assert.equal(realShas(S_KEEP).length, LIMIT, '磁盘上也要原样留 3 条');
});

// ── R3 删除入口(接口层) ─────────────────────────────────────────────────
console.log('\nR3 删除入口(接口层)');
await red('R3-1 DELETE /checkpoints/:sessionId 成功:200,列表变空、磁盘目录消失', async () => {
  const D = makeSmallDir('delsession');
  const S = sid(6);
  await post('/api/checkpoints', { sessionId: S, cwd: homePath(D) });
  assert.ok(snapCount(S) > 0, '前置:先要有快照可删');
  const res = await del(`/api/checkpoints/${S}`);
  assert.equal(res.status, 200, `删整会话应 200,实际 ${res.status}: ${res.text.slice(0, 200)}`);
  const list = await req('GET', `/api/checkpoints/${S}`);
  assert.equal(list.json.entries.length, 0, '删完全部快照后列表应清空');
  assert.equal(existsSync(snapDir(S)), false, '磁盘上的会话快照目录应消失(否则空间不会降)');
});

await red('R3-2 DELETE 幂等:同一个会话再删一次仍是 200 或 404,绝不是 500', async () => {
  const S = sid(6);                                   // R3-1 已删过一次
  const res = await del(`/api/checkpoints/${S}`);
  assert.ok([200, 404, 204].includes(res.status), `重复删除不得 500,实际 ${res.status}: ${res.text.slice(0, 200)}`);
  const res2 = await del(`/api/checkpoints/${S}`);
  assert.ok([200, 404, 204].includes(res2.status), `连删多次仍不得 500,实际 ${res2.status}`);
});

await red('R3-3 DELETE 不存在的会话 → 404,且错误体含稳定错误码', async () => {
  const S = sid(97);
  const res = await del(`/api/checkpoints/${S}`);
  assert.equal(res.status, 404, `不存在的会话应 404,实际 ${res.status}: ${res.text.slice(0, 200)}`);
  assert.ok(res.json, '错误体应是 JSON(带稳定错误码),不是 Express 的 HTML 404 页');
  assert.ok(typeof res.json.error === 'string' || typeof res.json.code === 'string',
    `错误体应含 error 或 code 字段,实际 ${res.text.slice(0, 200)}`);
});

await red('R3-4 DELETE 单条快照成功:200,该条消失、其余条目与文件内容不受影响', async () => {
  const D = makeSmallDir('delsha');
  const S = sid(7);
  const maketh = async (v) => {
    writeFileSync(join(D, 'note-0.txt'), `${v}\n`);
    const r = await post('/api/checkpoints', { sessionId: S, cwd: homePath(D) });
    assert.equal(r.status, 200, r.text.slice(0, 160));
    return r.json.sha;
  };
  const shaA = await maketh('A');
  const shaB = await maketh('B');
  const shaC = await maketh('C');
  const bytesBefore = dirBytes(snapDir(S));
  const res = await del(`/api/checkpoints/${S}/${shaB}`);
  assert.equal(res.status, 200, `删单条应 200,实际 ${res.status}: ${res.text.slice(0, 200)}`);
  const list = await req('GET', `/api/checkpoints/${S}`);
  const shas = list.json.entries.map((e) => e.sha);
  assert.ok(!shas.includes(shaB), '被删的那条不该还在列表里');
  assert.ok(shas.includes(shaA) && shas.includes(shaC), '没点的那两条必须原样保留');
  assert.ok(!realShas(S).includes(shaB), '被删的那条磁盘上也要真的没了');
  assert.ok(realShas(S).includes(shaA) && realShas(S).includes(shaC), '其余快照在磁盘上必须真实存在');
  assert.ok(dirBytes(snapDir(S)) < bytesBefore, `删完体积必须变小(前 ${bytesBefore} 字节),否则删了个寂寞`);
  // 其余条目仍可回滚 —— 文件内容按剩下的快照照常还原
  const ok = await post(`/api/checkpoints/${S}/restore`, { sha: shaC, cwd: homePath(D) });
  assert.equal(ok.status, 200, `没删掉的快照仍应能回滚,实际 ${ok.status}: ${ok.text.slice(0, 200)}`);
  assert.equal(readFileSync(join(D, 'note-0.txt'), 'utf8'), 'C\n', '文件应还原成仍保留的那条快照时的内容');
});

await red('R3-5 DELETE 单条时 sha 不存在 → 404', async () => {
  const D = makeSmallDir('delsha404');
  const S = sid(8);
  await post('/api/checkpoints', { sessionId: S, cwd: homePath(D) });
  const res = await del(`/api/checkpoints/${S}/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef`);
  assert.equal(res.status, 404, `不存在的 sha 应 404,实际 ${res.status}: ${res.text.slice(0, 200)}`);
  assert.ok(res.json && (res.json.error || res.json.code), '错误体应含稳定错误码');
  assert.ok(snapCount(S) > 0, '删一条不存在的 sha 不得把整个会话目录连带删掉');
});

// ── R4 删会话连带清理 ───────────────────────────────────────────────────
console.log('\nR4 删会话连带清理');
await red('R4-1 删掉会话后,该会话的快照目录一并消失', async () => {
  const D = makeSmallDir('sessions');
  const S = sid(9);
  const cwd = homePath(D);
  writeTranscript(S, cwd);
  for (let i = 0; i < 2; i += 1) await post('/api/checkpoints', { sessionId: S, cwd });
  assert.ok(snapCount(S) > 0, '前置:该会话先要有快照');
  const res = await del(`/api/sessions/${S}?projectHash=${encodeProjectDir(cwd)}`);
  assert.equal(res.status, 200, `删会话应成功,实际 ${res.status}: ${res.text.slice(0, 200)}`);
  assert.equal(res.json.deleted, true, '应如实回报 deleted');
  assert.equal(existsSync(snapDir(S)), false, '会话没了,它的检查点必须一起清掉 —— 否则空间永远只涨不跌');
});

// ── R5 可见性 ───────────────────────────────────────────────────────────
console.log('\nR5 可见性(占用统计)');
await red('R5-1 GET /checkpoints-stats 返回 totalBytes 与每会话明细', async () => {
  const A = makeSmallDir('statA');
  const B = makeSmallDir('statB');
  const SA = sid(10);
  const SB = sid(11);
  await post('/api/checkpoints', { sessionId: SA, cwd: homePath(A) });
  await post('/api/checkpoints', { sessionId: SA, cwd: homePath(A) });
  await post('/api/checkpoints', { sessionId: SB, cwd: homePath(B) });
  const res = await req('GET', '/api/checkpoints-stats');
  assert.equal(res.status, 200, `统计端点必须存在,实际 ${res.status}: ${res.text.slice(0, 160)}`);
  assert.ok(Number.isFinite(res.json.totalBytes) && res.json.totalBytes > 0, 'totalBytes 应是正数');
  const list = res.json.sessions || res.json.entries || res.json.items;
  assert.ok(Array.isArray(list), `应有每会话明细数组,实际字段:${Object.keys(res.json).join(',')}`);
  const a = list.find((x) => x.sessionId === SA);
  const b = list.find((x) => x.sessionId === SB);
  assert.ok(a, '统计里应能看到会话 A');
  assert.ok(b, '统计里应能看到会话 B');
  assert.equal(a.count, 2, `会话 A 应有 2 条快照,实际 ${a.count}`);
  assert.equal(b.count, 1, `会话 B 应有 1 条快照,实际 ${b.count}`);
  assert.ok(a.bytes > 0 && b.bytes > 0, '每个会话应给出实际占用字节数');
  const sum = list.reduce((n, x) => n + (x.bytes || 0), 0);
  assert.ok(Math.abs(sum - res.json.totalBytes) <= Math.max(4096, sum * 0.2),
    `totalBytes(${res.json.totalBytes}) 应与各会话之和(${sum})对得上`);
});

await red('R5-2 空目录时返回全 0 结构而不是 404', async () => {
  const EMPTY_HOME = join(TMP, 'emptyhome');           // 全新 HOME:一个检查点都没有
  mkdirSync(EMPTY_HOME, { recursive: true });
  const port = PORT + 1;
  const proc = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    cwd: TMP, env: { ...process.env, HOME: EMPTY_HOME, USERPROFILE: EMPTY_HOME, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i += 1) {
      try { up = (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; }
      catch { await new Promise((r) => setTimeout(r, 300)); }
    }
    assert.ok(up, '空 HOME 的隔离实例没起来');
    const res = await fetch(`http://127.0.0.1:${port}/api/checkpoints-stats`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(res.status, 200, `空目录应 200,实际 ${res.status}`);
    const body = await res.json();
    assert.equal(body.totalBytes, 0, '空目录总量应为 0');
    const list = body.sessions || body.entries || body.items;
    assert.ok(Array.isArray(list), '空目录应给空数组而不是缺字段');
    assert.equal(list.length, 0, '空目录不该列出任何会话');
  } finally {
    try { process.kill(proc.pid, 'SIGKILL'); } catch { /* 已退 */ }
  }
});

// ── R6(后段)清理/删除之后,既有语义仍稳 ───────────────────────────────
console.log('\nR6 既有行为不变(清理/删除之后)');
await green('R6-4 删掉一条之后,剩下的快照列表仍与磁盘一致、仍能回滚', async () => {
  const D = makeSmallDir('r6after');
  const S = sid(12);
  const mk = async (v) => {
    writeFileSync(join(D, 'note-0.txt'), `${v}\n`);
    return (await post('/api/checkpoints', { sessionId: S, cwd: homePath(D) })).json.sha;
  };
  const s1 = await mk('one');
  const s2 = await mk('two');
  const list = await req('GET', `/api/checkpoints/${S}`);
  assert.equal(list.json.entries.length, 2, '两条都该在');
  const real = realShas(S);
  for (const e of list.json.entries) assert.ok(real.includes(e.sha), `${e.sha.slice(0, 10)} 应在磁盘上`);
  const res = await post(`/api/checkpoints/${S}/restore`, { sha: s1, cwd: homePath(D) });
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.equal(readFileSync(join(D, 'note-0.txt'), 'utf8'), 'one\n', '旧快照仍应还原正确内容');
  const res2 = await post(`/api/checkpoints/${S}/restore`, { sha: s2, cwd: homePath(D) });
  assert.equal(res2.status, 200, res2.text.slice(0, 200));
  assert.equal(readFileSync(join(D, 'note-0.txt'), 'utf8'), 'two\n', '新快照也仍应还原正确内容');
});

await green('R6-5 列表端点语义不变:该会话照常可列,且列出的每一条都在磁盘上真实存在', async () => {
  const list = await req('GET', `/api/checkpoints/${S_BIG}`);      // R1 里反复拍/反复被跳过的会话
  assert.equal(list.status, 200, '被跳过的会话,列表端点仍应正常应答');
  assert.ok(Array.isArray(list.json.entries), '列表仍应是 {entries:[...]} 的形状');
  const real = realShas(S_BIG);
  for (const e of list.json.entries) {
    assert.ok(real.includes(e.sha), `列表里的 ${e.sha.slice(0, 10)} 在磁盘上找不到 —— 既有语义被改坏了`);
  }
  for (const sha of real) {
    assert.ok(list.json.entries.some((e) => e.sha === sha), `磁盘上的 ${sha.slice(0, 10)} 没被列出`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
shutServer();
console.log(`\n—— check-r120-checkpoint:${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
console.log(`   [修前应红] ${tally.RED.pass + tally.RED.fail} 条(现在绿 ${tally.RED.pass} / 红 ${tally.RED.fail})`);
console.log(`   [修前应绿] ${tally.GREEN.pass + tally.GREEN.fail} 条(现在绿 ${tally.GREEN.pass} / 红 ${tally.GREEN.fail})`);
if (FAILS) { console.log('红的条目:'); for (const n of failed) console.log(`  ✗ ${n}`); }
if (process.env.R120_KEEP_TMP !== '1') { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } }
else console.log(`[r120] 保留夹具目录:${TMP}`);
process.exit(FAILS ? 1 : 0);
