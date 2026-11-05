#!/usr/bin/env node
// 单测:search-recent-enoent-fresh-env —— 全新环境(家目录下 .claude/projects 还没创建)时,
// GET /api/search 与 GET /api/recent-session 不该把「还没有任何会话」当成服务端故障。
// 现象:项目根目录不存在时,两个接口都回 500 {"error":"ENOENT: …"}。
// 期望:/api/search?q=ab → 200 {"q":"ab","hits":[],"truncated":false};/api/recent-session → 404 {"error":"no sessions found"}。
// 契约不变:项目根存在但读不了(EACCES/EPERM)时两个接口仍回 500 且体里有 error 字符串,绝不吞成 200 空命中或 404;
//           目录里有数据时两个接口的正常响应不变;带 projectHash 的 recent-session 在目录不存在时本来就是 404。
// 只通过 HTTP 调 server/routes/search.js 与 server/routes/sessions.js 的默认导出(express Router,按生产同样的方式挂在 /api 下)。
// 家目录指到 mkdtemp 建的临时目录,不碰真实 ~/.claude;七条用例互相独立(每条开头自己把项目根置成需要的状态),逐条打印 ok/FAIL/skip。
// Run: node tests/unit/check-search-recent-enoent-fresh-env.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 家目录必须先于 import 指到临时目录:search.js 在模块加载期就用 homedir() 固定了项目根,晚设就会读到真实目录
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'search-recent-enoent-')));
const home = join(tmpRoot, 'home');
mkdirSync(home);
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows 上 homedir() 读 %USERPROFILE%,不同设沙箱失效
process.env.CGUI_DISABLE_FILE_WATCHER = '1'; // 不让被导入的模块起文件监听(会留句柄、拖住进程)

const claudeDir = join(home, '.claude');
const projectsDir = join(claudeDir, 'projects'); // 两个接口读的项目根

// 清理临时目录:先恢复权限(否则 rmSync 进不去 000 目录)。重复调用无害;'exit' 钩子兜底,中途崩了也不残留
function cleanup() {
  try { chmodSync(projectsDir, 0o755); } catch { /* 目录不存在,忽略 */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 清不掉也别盖住测试结果 */ }
}
process.on('exit', cleanup);

// 环境造不出场景时抛它:t() 打印 skip 与原因,不算失败
class Skip extends Error {}

let passed = 0;
let skipped = 0;
let failed = 0;

// 逐条执行:任何异常(含断言失败)都在这里接住,一条红不影响后面,也不会让未捕获的拒绝崩进程
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (e) {
    if (e instanceof Skip) {
      skipped += 1;
      console.log(`skip ${name}: ${e.message}`);
      return;
    }
    failed += 1;
    // 新版 Node 会在自定义断言信息后追加 "\n\n实际 !== 期望";只取第一行(信息里已写明期望与实际),各版本输出一致、一条失败一行
    const reason = e?.name === 'AssertionError' ? String(e.message).split('\n')[0] : `用例自身异常 ${e?.stack ?? e}`;
    console.log(`FAIL ${name}: ${reason}`);
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
let base = ''; // 服务起来后赋值

// GET 一次,把状态码与体都收下,由各用例自己断言(红要红在断言上,不是崩在这里)。
// 超时 / 连不上也收成 status=null,不让一次挂起的请求把整个测试拖死。
async function get(path) {
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, text, json };
  } catch (e) {
    return { status: null, text: `(请求失败 ${e?.name}: ${e?.message})`, json: undefined };
  }
}

// 断言信息里的「实际是什么」:状态码 + 体(空白压平成一行,过长截断)
const brief = (r) => {
  const body = r.text.replace(/\s+/g, ' ');
  return `${r.status ?? '无响应'} ${body.length > 300 ? `${body.slice(0, 300)}…` : body}`;
};
// 体是 JSON 对象,且 error 是非空字符串
const hasErrorString = (json) => json !== null && typeof json === 'object' && typeof json.error === 'string' && json.error.length > 0;

// 接口约定里的会话文件:恰为一行,以换行结尾
const SESSION_LINE = '{"type":"user","message":{"role":"user","content":"hello needle world"},"timestamp":"2026-11-05T00:00:00.000Z"}\n';

// 每条用例开头调用,把项目根置成需要的状态,不依赖前一条留下的东西:
//   absent = 连 .claude 都不存在(全新环境);data = 有项目 -demo-ws 与会话 sess-1;locked = 目录存在但权限 000
function resetProjectsRoot(state) {
  try { chmodSync(projectsDir, 0o755); } catch { /* 目录不存在,忽略 */ } // 前一条若留下 000 目录,先恢复才删得掉
  rmSync(claudeDir, { recursive: true, force: true });
  if (state === 'absent') return;
  mkdirSync(projectsDir, { recursive: true });
  if (state === 'data') {
    const projectDir = join(projectsDir, '-demo-ws');
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, 'sess-1.jsonl'), SESSION_LINE);
  } else if (state === 'locked') {
    chmodSync(projectsDir, 0o000);
  } else {
    throw new Error(`未知的项目根状态 ${state}`);
  }
}

// 造「存在但读不了」的项目根。造不出(win32 / root / 文件系统不认权限位)就 Skip,不算失败
function makeLockedRoot() {
  if (process.platform === 'win32') {
    throw new Skip('win32 的 chmod 造不出无权限目录(接口约定:win32 跳过)');
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Skip('当前是 root(uid 0),不受目录权限位限制,读得到 000 目录,造不出无权限场景');
  }
  resetProjectsRoot('locked');
  try {
    readdirSync(projectsDir);
  } catch (e) {
    if (e?.code === 'EACCES' || e?.code === 'EPERM') return; // 确实读不了,场景造成功
    throw e; // 其他错误说明夹具本身有问题,按用例自身异常报
  }
  throw new Skip('chmod 000 后仍读得了目录(文件系统不遵守权限位),造不出无权限场景');
}
// 用例收尾必须先恢复权限,才能继续或删除
const unlockProjectsRoot = () => { try { chmodSync(projectsDir, 0o755); } catch { /* 没建出来,忽略 */ } };

// 与生产 server/index.js 同样的挂法:两个路由都挂在 /api 下。不 mock 任何内部层
const express = (await import('express')).default;
const searchRouter = (await import('../../server/routes/search.js')).default;
const sessionsRouter = (await import('../../server/routes/sessions.js')).default;

const app = express();
app.use(express.json());
app.use('/api', searchRouter);
app.use('/api', sessionsRouter);
const server = await new Promise((resolve, reject) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
  s.once('error', reject);
});
base = `http://127.0.0.1:${server.address().port}`;

try {
  // 1 [复现,修复前必红] 项目根不存在 → 搜索回 200 与空命中,不是 500
  await t('目录不存在 → GET /api/search?q=ab 返回 200 与空命中', async () => {
    resetProjectsRoot('absent');
    const r = await get('/api/search?q=ab');
    assert.equal(r.status, 200, `目录不存在时搜索应返回 200,实际 ${brief(r)}`);
    assert.deepEqual(r.json, { q: 'ab', hits: [], truncated: false },
      `目录不存在时搜索的体应为 {"q":"ab","hits":[],"truncated":false},实际 ${brief(r)}`);
  });

  // 2 [复现,修复前必红] 项目根不存在 → recent-session 回 404 no sessions found,不是 500
  await t('目录不存在 → GET /api/recent-session 返回 404 no sessions found', async () => {
    resetProjectsRoot('absent');
    const r = await get('/api/recent-session');
    assert.equal(r.status, 404, `目录不存在时 recent-session 应返回 404,实际 ${brief(r)}`);
    assert.deepEqual(r.json, { error: 'no sessions found' },
      `目录不存在时 recent-session 的体应为 {"error":"no sessions found"},实际 ${brief(r)}`);
  });

  // 3 [回归] 项目根不存在 + 带 projectHash → 本来就是 404 no sessions found,保持不变
  await t('目录不存在 → GET /api/recent-session?projectHash=abc123 仍是 404 no sessions found', async () => {
    resetProjectsRoot('absent');
    const r = await get('/api/recent-session?projectHash=abc123');
    assert.equal(r.status, 404, `目录不存在且带 projectHash 时应返回 404,实际 ${brief(r)}`);
    assert.deepEqual(r.json, { error: 'no sessions found' },
      `目录不存在且带 projectHash 时体应为 {"error":"no sessions found"},实际 ${brief(r)}`);
  });

  // 4 [回归] 项目根存在但权限 000 → 搜索仍是 500 带 error,绝不吞成 200 空命中
  await t('目录无权限(000)→ GET /api/search?q=ab 返回 500 且带 error,不吞成 200', async () => {
    try {
      makeLockedRoot();
      const r = await get('/api/search?q=ab');
      assert.notEqual(r.status, 200, `目录无权限时绝不能吞成 200 空命中,实际 ${brief(r)}`);
      assert.equal(r.status, 500, `目录无权限时搜索应返回 500,实际 ${brief(r)}`);
      assert.ok(hasErrorString(r.json), `500 的体应是带非空 error 字符串的 JSON 对象,实际 ${brief(r)}`);
    } finally {
      unlockProjectsRoot();
    }
  });

  // 5 [回归] 项目根存在但权限 000 → recent-session 仍是 500 带 error,绝不吞成 404
  await t('目录无权限(000)→ GET /api/recent-session 返回 500 且带 error,不吞成 404', async () => {
    try {
      makeLockedRoot();
      const r = await get('/api/recent-session');
      assert.notEqual(r.status, 404, `目录无权限时绝不能吞成 404,实际 ${brief(r)}`);
      assert.equal(r.status, 500, `目录无权限时 recent-session 应返回 500,实际 ${brief(r)}`);
      assert.ok(hasErrorString(r.json), `500 的体应是带非空 error 字符串的 JSON 对象,实际 ${brief(r)}`);
    } finally {
      unlockProjectsRoot();
    }
  });

  // 6 [回归] 有数据 → 搜索命中恰 1 条,字段正确
  await t('目录有数据 → GET /api/search?q=needle 命中恰 1 条,字段正确,truncated 为 false', async () => {
    resetProjectsRoot('data');
    const r = await get('/api/search?q=needle');
    assert.equal(r.status, 200, `有数据时搜索应返回 200,实际 ${brief(r)}`);
    const hits = r.json?.hits;
    assert.ok(Array.isArray(hits), `体里应有数组 hits,实际 ${brief(r)}`);
    assert.equal(hits.length, 1, `搜 needle 应恰好命中 1 条,实际 ${hits.length} 条:${brief(r)}`);
    assert.equal(hits[0].projectHash, '-demo-ws', `命中的 projectHash 应为 "-demo-ws",实际 ${JSON.stringify(hits[0].projectHash)}`);
    assert.equal(hits[0].sessionId, 'sess-1', `命中的 sessionId 应为 "sess-1",实际 ${JSON.stringify(hits[0].sessionId)}`);
    assert.ok(typeof hits[0].snippet === 'string' && hits[0].snippet.includes('needle'),
      `命中的 snippet 应是含 needle 的字符串,实际 ${JSON.stringify(hits[0].snippet)}`);
    assert.equal(r.json.truncated, false, `命中 1 条时 truncated 应为 false,实际 ${JSON.stringify(r.json.truncated)}`);
  });

  // 7 [回归] 有数据 → recent-session 返回该会话
  await t('目录有数据 → GET /api/recent-session 返回 200 与该会话', async () => {
    resetProjectsRoot('data');
    const r = await get('/api/recent-session');
    assert.equal(r.status, 200, `有数据时 recent-session 应返回 200,实际 ${brief(r)}`);
    assert.equal(r.json?.projectHash, '-demo-ws', `projectHash 应为 "-demo-ws",实际 ${brief(r)}`);
    assert.equal(r.json?.sessionId, 'sess-1', `sessionId 应为 "sess-1",实际 ${brief(r)}`);
    assert.equal(typeof r.json?.mtimeMs, 'number', `mtimeMs 应是数字,实际 ${JSON.stringify(r.json?.mtimeMs)}(体 ${brief(r)})`);
  });
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
  cleanup();
}

console.log(`共 ${passed + skipped + failed} 条:通过 ${passed},跳过 ${skipped},失败 ${failed}`);
if (failed === 0) {
  console.log('PASS search-recent-enoent-fresh-env');
} else {
  process.exitCode = 1;
}

// 兜底:汇总后 2 秒内进程还没自然退出,说明被导入的模块留有句柄(定时器/监听),按结果强制退出,免得测试挂住。
// unref 的定时器本身不拖住进程:自然退出时它根本不会触发。
setTimeout(() => {
  console.error('提示:汇总打印后 2 秒进程仍未自然退出(被导入的模块留有句柄),已强制退出');
  process.exit(process.exitCode ?? 0);
}, 2000).unref();
