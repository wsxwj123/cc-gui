#!/usr/bin/env node
// r108:0.2.373 Windows 审查必修项(启动预热 help 缓存 / MCP 枚举门控+缓存+超时兜底 /
//        cmd.exe 引号规则 / SDK exe 体积下限 / 注册表 PATH 去引号 / 日志走 stderr)。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/INTERFACE-r108-windows-review.md 写,
// 写的时候没看实现、没看 PLAN/RESEARCH/审查报告、没看既有测试的断言正文。
// 只调用 INTERFACE 列出的导出:
//   prompt-cache-env.js : primeHelpCache / cliSupportsFlag
//   routes/mcp.js       : resolveWinCommand / makeTtlCache / withTimeout /
//                         winCmdSpawnSpec / missingCommandHint
//   claude-resolver.js  : resolveSdkClaudeFrom / splitWinPathList / logSdkClaudeOnce
//
// 设计要点:
//  * 【动态 import + 逐条 try/catch】。静态 import 一个还不存在的导出会在 ESM 链接阶段
//    直接抛错、后面一条断言都跑不到;改前必须"每条各自红",才看得出到底缺哪几件。
//  * 本机是 mac,Windows 行为一律靠注入(platform/env/fs/now/probe)模拟;真机才能验的
//    (事件循环真实不阻塞时长、Defender 扫描)不覆盖,见 .devflow/TEST-PLAN-r108.md。
//  * HOME/USERPROFILE 在 import 前改到临时沙箱,本测试绝不读写真实 ~/.claude*。
//  * "进程能自然退出""默认 logger 是谁"这类一次性/全局状态,放子进程里各跑一次,
//    避免同进程内互相消耗 once 语义。
//
// Run: node tests/unit/check-r108-windows-review.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, truncateSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'cgui-r108-'));
const SANDBOX_HOME = join(TMP, 'home');
mkdirSync(SANDBOX_HOME, { recursive: true });
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;

let PASS = 0;
let FAILS = 0;
const failed = [];
async function check(name, fn) {
  try {
    await fn();
    PASS++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    FAILS++;
    failed.push(name);
    const msg = String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ');
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

async function load(rel) {
  try {
    return await import(pathToFileURL(join(ROOT, rel)).href);
  } catch (e) {
    return { __err: e };
  }
}
function need(mod, name) {
  if (!mod || mod.__err) throw new Error(`模块未能导入:${(mod && mod.__err && mod.__err.message) || '未知'}`);
  const f = mod[name];
  if (typeof f !== 'function') throw new Error(`缺少导出 ${name}(当前 typeof=${typeof f})`);
  return f;
}
const urlOf = (rel) => pathToFileURL(join(ROOT, rel)).href;
// 子进程跑一段 ESM 代码:用来验"进程能自然退出""默认 logger 走哪条流"这类全局状态。
function runNode(code, timeoutMs = 10000) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, HOME: SANDBOX_HOME, USERPROFILE: SANDBOX_HOME },
  });
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM';
  return { ...r, timedOut };
}

const cacheEnv = await load('server/utils/prompt-cache-env.js');
const mcp = await load('server/routes/mcp.js');
const resolver = await load('server/utils/claude-resolver.js');

// ══════════════════════════════════════════════════════════════════════════
// A. primeHelpCache —— server/utils/prompt-cache-env.js (INTERFACE §1.2)
//    真实用户视角:启动后第一次发消息不该再卡在同步 spawn claude --help 上。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nA. primeHelpCache 异步预热 help 缓存');

const SNAP = '--system-prompt-snapshot';
const HELP_TEXT = `Usage: claude [options]\n  ${SNAP} <mode>  something\n  --other\n`;
// 每条用独立 key,避免共用同一张 _helpCache 时互相污染。
let keySeq = 0;
const freshPath = (tag) => `C:\\r108\\${tag}-${++keySeq}\\claude.exe`;
function boom() { throw new Error('must not sync-probe'); }

await check('A1 预热成功后 cliSupportsFlag 命中缓存,返回 true 且不再同步 probe', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  const supports = need(cacheEnv, 'cliSupportsFlag');
  const p = freshPath('a1');
  const ok = await prime(p, async () => `  ${SNAP} <mode>`);
  assert.equal(ok, true, 'primeHelpCache 正文非空应 resolve true');
  assert.equal(supports(p, SNAP, boom), true);
});

await check('A2 未预热的另一个路径,同步 probe 仍会被调用(既有行为不变)', async () => {
  const supports = need(cacheEnv, 'cliSupportsFlag');
  const p = freshPath('a2');
  let calls = 0;
  const r = supports(p, SNAP, () => { calls++; return HELP_TEXT; });
  assert.equal(calls, 1, '未预热路径应当同步 probe 一次');
  assert.equal(r, true);
});

await check('A3 预热正文里没有该 flag → cliSupportsFlag 为 false 且不同步 probe', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  const supports = need(cacheEnv, 'cliSupportsFlag');
  const p = freshPath('a3');
  const ok = await prime(p, async () => 'Usage: claude [options]\n  --resume\n');
  assert.equal(ok, true, '正文非空(哪怕不含该 flag)也算预热成功');
  assert.equal(supports(p, SNAP, boom), false);
});

await check('A4 claudePath 为空串 → resolve false 且不 spawn', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  let calls = 0;
  const ok = await prime('', async () => { calls++; return HELP_TEXT; });
  assert.equal(ok, false);
  assert.equal(calls, 0);
});

await check('A5 claudePath 为 null/undefined/数字 → resolve false 且不 spawn,不抛', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  let calls = 0;
  const probe = async () => { calls++; return HELP_TEXT; };
  for (const bad of [null, undefined, 123, {}, []]) {
    const ok = await prime(bad, probe);
    assert.equal(ok, false, `入参 ${JSON.stringify(bad)} 应 resolve false`);
  }
  assert.equal(calls, 0, '脏入参一次都不该 spawn');
});

await check('A6 同一路径重复预热 → 第二次直接 true 且不重复 spawn', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  const p = freshPath('a6');
  let calls = 0;
  const first = await prime(p, async () => { calls++; return HELP_TEXT; });
  const second = await prime(p, async () => { calls++; return HELP_TEXT; });
  assert.equal(first, true);
  assert.equal(second, true, '缓存已有该 key 应 resolve true');
  assert.equal(calls, 1, '第二次不该再 spawn');
});

await check('A7 probe 返回空串 → resolve false;且空串也进缓存,再预热不重复 spawn', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  const p = freshPath('a7');
  let calls = 0;
  const first = await prime(p, async () => { calls++; return ''; });
  assert.equal(first, false);
  const second = await prime(p, async () => { calls++; return HELP_TEXT; });
  assert.equal(second, true, '空串也是"缓存里已有该 key"');
  assert.equal(calls, 1, '空串结果已缓存,不该重探');
});

await check('A8 probe 抛错 → 不 reject,resolve false,且把失败当"不支持"缓存', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  const supports = need(cacheEnv, 'cliSupportsFlag');
  const p = freshPath('a8');
  const ok = await prime(p, async () => { throw new Error('spawn ENOENT'); });
  assert.equal(ok, false);
  assert.equal(supports(p, SNAP, boom), false, '失败也应写入 \'\',同步 probe 不该再跑');
});

await check('A9 probe 同步抛错(非 async 函数直接 throw)→ 仍不 reject', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  const p = freshPath('a9');
  const ok = await prime(p, () => { throw new Error('sync boom'); });
  assert.equal(ok, false);
});

await check('A10 probe 返回非字符串/非 Promise → 不 reject,返回布尔', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  for (const weird of [async () => undefined, async () => null, async () => 42, () => 'plain-string-not-promise']) {
    const r = await prime(freshPath('a10'), weird);
    assert.equal(typeof r, 'boolean', 'primeHelpCache 必须 resolve 布尔且永不 reject');
  }
});

await check('A11 不传 probeAsync 时不抛(走默认 execFile,路径不存在则 false)', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  const r = await prime(join(TMP, 'no-such-claude-binary'));
  assert.equal(typeof r, 'boolean');
  assert.equal(r, false, '不存在的可执行文件应按"探测失败"处理');
});

// ══════════════════════════════════════════════════════════════════════════
// B. resolveWinCommand —— server/routes/mcp.js (INTERFACE §3.1)
//    真实用户视角:Windows 上 MCP 起不来时不该把整个 PATH 目录 readdir 一遍(慢+被杀毒拖住)。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nB. resolveWinCommand 枚举兜底 + 平台门控');

// 造一套注入用的假 Windows 目录:只有"文件集合",不落真实磁盘。
function winFs(files) {
  const set = new Set(files.map((f) => f.toLowerCase()));
  const readdirCalls = [];
  return {
    readdirCalls,
    existsSync: (p) => set.has(String(p).toLowerCase()),
    readdirSync: (d) => {
      readdirCalls.push(String(d));
      const pre = `${String(d).toLowerCase()}\\`;
      return files.filter((f) => f.toLowerCase().startsWith(pre)).map((f) => f.slice(pre.length));
    },
  };
}
const D1 = 'C:\\dirA';
const D2 = 'C:\\dirB';
const WIN_ENV = { PATH: `${D1};${D2}` };
const dirTouched = (calls, dir) => calls.some((c) => String(c).toLowerCase() === dir.toLowerCase());
const fileOf = (r) => (r && typeof r === 'object' ? r.file : r);

await check('B1 enumerate=false + 命令不存在 → 返回 null,候选目录一次都没被 readdir', async () => {
  const fn = need(mcp, 'resolveWinCommand');
  const fs = winFs([]);
  const r = fn('nosuchcmd', {
    platform: 'win32', env: WIN_ENV, liveDirs: [D1, D2],
    existsSync: fs.existsSync, readdirSync: fs.readdirSync, enumerate: false,
  });
  assert.equal(r, null);
  assert.equal(dirTouched(fs.readdirCalls, D1), false, `${D1} 不该被 readdir`);
  assert.equal(dirTouched(fs.readdirCalls, D2), false, `${D2} 不该被 readdir`);
});

await check('B2 enumerate=false + 12 个 PATH 目录 → readdirSync 总调用数 ≤2(仅留 pyScripts 例外)', async () => {
  const fn = need(mcp, 'resolveWinCommand');
  const many = Array.from({ length: 12 }, (_, i) => `C:\\p${i}`);
  const fs = winFs([]);
  fn('nosuchcmd', {
    platform: 'win32', env: { PATH: many.join(';') }, liveDirs: many,
    existsSync: fs.existsSync, readdirSync: fs.readdirSync, enumerate: false,
  });
  assert.ok(fs.readdirCalls.length <= 2, `readdirSync 被调用 ${fs.readdirCalls.length} 次:${fs.readdirCalls.slice(0, 6).join(', ')}`);
});

await check('B3 enumerate=false + exists 命中 → 仍按 .exe > .cmd > .bat 取 .exe', async () => {
  const fn = need(mcp, 'resolveWinCommand');
  const fs = winFs([`${D1}\\foo.exe`, `${D1}\\foo.cmd`, `${D1}\\foo.bat`]);
  const r = fn('foo', {
    platform: 'win32', env: WIN_ENV, liveDirs: [D1, D2],
    existsSync: fs.existsSync, readdirSync: fs.readdirSync, enumerate: false,
  });
  assert.equal(fileOf(r), `${D1}\\foo.exe`);
  assert.equal(fs.readdirCalls.length === 0 || !dirTouched(fs.readdirCalls, D1), true, '命中后不该枚举命中目录');
});

await check('B4 enumerate=false + 只有 .cmd 和 .bat → 取 .cmd', async () => {
  const fn = need(mcp, 'resolveWinCommand');
  const fs = winFs([`${D1}\\foo.cmd`, `${D1}\\foo.bat`]);
  const r = fn('foo', {
    platform: 'win32', env: WIN_ENV, liveDirs: [D1, D2],
    existsSync: fs.existsSync, readdirSync: fs.readdirSync, enumerate: false,
  });
  assert.equal(fileOf(r), `${D1}\\foo.cmd`);
});

await check('B5 enumerate=false + 只有 .bat → 取 .bat 且 viaCmd 为真', async () => {
  const fn = need(mcp, 'resolveWinCommand');
  const fs = winFs([`${D1}\\foo.bat`]);
  const r = fn('foo', {
    platform: 'win32', env: WIN_ENV, liveDirs: [D1, D2],
    existsSync: fs.existsSync, readdirSync: fs.readdirSync, enumerate: false,
  });
  assert.equal(fileOf(r), `${D1}\\foo.bat`);
  assert.equal(!!(r && r.viaCmd), true, '.bat 必须经 cmd.exe');
});

await check('B6 .exe 命中时 viaCmd 为假(不绕 cmd.exe)', async () => {
  const fn = need(mcp, 'resolveWinCommand');
  const fs = winFs([`${D1}\\foo.exe`]);
  const r = fn('foo', {
    platform: 'win32', env: WIN_ENV, liveDirs: [D1, D2],
    existsSync: fs.existsSync, readdirSync: fs.readdirSync, enumerate: false,
  });
  assert.equal(!!(r && r.viaCmd), false);
});

await check('B7 目录顺序优先于扩展名:dirA 的 .bat 胜过 dirB 的 .exe', async () => {
  const fn = need(mcp, 'resolveWinCommand');
  const fs = winFs([`${D1}\\foo.bat`, `${D2}\\foo.exe`]);
  const r = fn('foo', {
    platform: 'win32', env: WIN_ENV, liveDirs: [D1, D2],
    existsSync: fs.existsSync, readdirSync: fs.readdirSync, enumerate: false,
  });
  assert.equal(fileOf(r), `${D1}\\foo.bat`);
});

await check('B8 enumerate=true + exists 全落空 → 枚举并大小写不敏感命中 FOO.CMD', async () => {
  const fn = need(mcp, 'resolveWinCommand');
  // existsSync 只认精确大小写,exists 会全落空,只有枚举才找得到。
  const files = [`${D1}\\FOO.CMD`];
  const readdirCalls = [];
  const exact = new Set(files);
  const r = fn('foo', {
    platform: 'win32', env: WIN_ENV, liveDirs: [D1, D2], enumerate: true,
    existsSync: (p) => exact.has(String(p)),
    readdirSync: (d) => {
      readdirCalls.push(String(d));
      const pre = `${d}\\`;
      return files.filter((f) => f.startsWith(pre)).map((f) => f.slice(pre.length));
    },
  });
  assert.equal(fileOf(r), `${D1}\\FOO.CMD`);
  assert.equal(dirTouched(readdirCalls, D1), true, '落空后必须枚举兜底');
});

await check('B9 enumerate=true 但 exists 已命中 → 不枚举该目录(枚举只是兜底)', async () => {
  const fn = need(mcp, 'resolveWinCommand');
  const fs = winFs([`${D1}\\foo.exe`]);
  const r = fn('foo', {
    platform: 'win32', env: WIN_ENV, liveDirs: [D1, D2], enumerate: true,
    existsSync: fs.existsSync, readdirSync: fs.readdirSync,
  });
  assert.equal(fileOf(r), `${D1}\\foo.exe`);
  assert.equal(dirTouched(fs.readdirCalls, D1), false, 'exists 命中就不该再枚举');
});

await check('B10 反向:name 含 / 或 \\ 直接返回 null,且完全不碰 fs', async () => {
  const fn = need(mcp, 'resolveWinCommand');
  for (const bad of ['C:\\tools\\foo.exe', 'foo/bar', 'a\\b']) {
    let touched = 0;
    const r = fn(bad, {
      platform: 'win32', env: WIN_ENV, liveDirs: [D1, D2], enumerate: true,
      existsSync: () => { touched++; return true; },
      readdirSync: () => { touched++; return []; },
    });
    assert.equal(r, null, `${bad} 应直接 null`);
    assert.equal(touched, 0, `${bad} 不该触碰 fs`);
  }
});

await check('B11 边界:空串/null/undefined/数字入参不抛', async () => {
  const fn = need(mcp, 'resolveWinCommand');
  for (const bad of ['', null, undefined, 123, {}, []]) {
    const r = fn(bad, {
      platform: 'win32', env: WIN_ENV, liveDirs: [D1, D2], enumerate: false,
      existsSync: () => false, readdirSync: () => [],
    });
    assert.ok(r === null || typeof r === 'object', `入参 ${JSON.stringify(bad)} 应返回 null 或对象,实际 ${typeof r}`);
  }
});

await check('B12 边界:opts 全省略不抛(默认 enumerate 按平台推导)', async () => {
  const fn = need(mcp, 'resolveWinCommand');
  const r = fn('nosuchcmd-r108');
  assert.ok(r === null || typeof r === 'object');
});

await check('B13 不传 enumerate 时在 mac 上默认为 true(既有锁定测试赖此行为)', async () => {
  const fn = need(mcp, 'resolveWinCommand');
  assert.notEqual(process.platform, 'win32', '本条只在非 win32 开发机上有意义');
  const files = [`${D1}\\FOO.CMD`];
  const readdirCalls = [];
  const exact = new Set(files);
  const r = fn('foo', {
    platform: 'win32', env: WIN_ENV, liveDirs: [D1, D2], // 故意不传 enumerate
    existsSync: (p) => exact.has(String(p)),
    readdirSync: (d) => {
      readdirCalls.push(String(d));
      const pre = `${d}\\`;
      return files.filter((f) => f.startsWith(pre)).map((f) => f.slice(pre.length));
    },
  });
  assert.equal(fileOf(r), `${D1}\\FOO.CMD`, 'mac 默认应枚举兜底,否则既有 59 条锁定测试会红');
  assert.equal(dirTouched(readdirCalls, D1), true);
});

// B14(主会话按判官重要-2 追加):win32 上不传 enumerate 时默认为 false —— 这是必修-2 的开关本身。
// 子进程里在 import 之前把 process.platform 钉成 win32,再用默认参数调用,断言注入的
// readdirSync 只被 pyScripts 的两个父目录用到(≤2 次),候选目录一个都不枚举。
await check('B14 win32 上不传 enumerate 时默认为 false(候选目录不 readdir,只 pyScripts 两父目录)', async () => {
  const code = `
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const m = await import(${JSON.stringify(urlOf('server/routes/mcp.js'))});
    if (typeof m.resolveWinCommand !== 'function') { process.stderr.write('NOEXPORT'); process.exit(7); }
    const env = { USERPROFILE: 'C:\\\\Users\\\\x', APPDATA: 'C:\\\\Users\\\\x\\\\AppData\\\\Roaming', LOCALAPPDATA: 'C:\\\\Users\\\\x\\\\AppData\\\\Local' };
    const live = ['C:\\\\dirA', 'C:\\\\dirB', 'C:\\\\Windows\\\\System32'];
    const readdirCalls = [];
    const readdirSync = (d) => { readdirCalls.push(String(d)); return ['FOO.EXE', 'foo.cmd']; };
    // ① exists 全落空:一个候选目录都不许枚举
    const miss = m.resolveWinCommand('foo', { env, liveDirs: live, existsSync: () => false, readdirSync });
    const missCalls = readdirCalls.filter((d) => live.some((l) => String(d).toLowerCase() === l.toLowerCase()));
    // ② exists 命中 dirB 的 .exe:返回 win32 拼接路径,同样不枚举
    readdirCalls.length = 0;
    const hitPath = 'C:\\\\dirB\\\\foo.exe';
    const hit = m.resolveWinCommand('foo', { env, liveDirs: live, existsSync: (p) => String(p) === hitPath, readdirSync });
    const hitCalls = readdirCalls.filter((d) => live.some((l) => String(d).toLowerCase() === l.toLowerCase()));
    process.stdout.write(JSON.stringify({ miss, missCalls, total: readdirCalls.length, hit, hitCalls }));
  `;
  const r = runNode(code, 12000);
  assert.equal(r.timedOut, false, '子进程超时');
  assert.equal(String(r.stderr).includes('NOEXPORT'), false, '缺少导出 resolveWinCommand');
  assert.equal(r.status, 0, `子进程退出码 ${r.status}: ${String(r.stderr).slice(0, 300)}`);
  const got = JSON.parse(String(r.stdout).trim() || '{}');
  assert.equal(got.miss, null, 'exists 全落空且默认不枚举 → null(不许靠 readdir 捞到 FOO.EXE)');
  assert.deepEqual(got.missCalls, [], `win32 默认不该枚举任何候选目录,实际枚举了:${JSON.stringify(got.missCalls)}`);
  assert.deepEqual(got.hitCalls, [], 'exists 命中后同样不枚举');
  assert.equal(got.hit && got.hit.file, 'C:\\dirB\\foo.exe', 'win32 上用 win32 口径拼路径');
  assert.equal(got.hit && got.hit.viaCmd, false);
});

// ══════════════════════════════════════════════════════════════════════════
// C. makeTtlCache —— server/routes/mcp.js (INTERFACE §3.2)
//    真实用户视角:同一台机上反复起同一个 MCP 时,别每次都重跑 where/PowerShell。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nC. makeTtlCache 30s 结果缓存工厂');

await check('C1 set 后 get 拿回原值', async () => {
  const mk = need(mcp, 'makeTtlCache');
  const c = mk(30000);
  c.set('k', { file: 'C:\\a\\npx.cmd', viaCmd: true });
  assert.deepEqual(c.get('k'), { file: 'C:\\a\\npx.cmd', viaCmd: true });
});

await check('C2 null 是合法可缓存值:get 返回 null 而不是 undefined', async () => {
  const mk = need(mcp, 'makeTtlCache');
  const c = mk(30000);
  c.set('miss', null);
  assert.equal(c.get('miss'), null, '"找不到命令"也要缓存,那才是最贵的路径');
  assert.notEqual(c.get('miss'), undefined);
});

await check('C3 不存在的 key → undefined', async () => {
  const mk = need(mcp, 'makeTtlCache');
  assert.equal(mk(30000).get('never-set'), undefined);
});

await check('C4 注入 now:超过 ttl 后 get 返回 undefined', async () => {
  const mk = need(mcp, 'makeTtlCache');
  let t = 1000;
  const c = mk(30000, () => t);
  c.set('k', 'v');
  t = 1000 + 30001;
  assert.equal(c.get('k'), undefined);
});

await check('C5 注入 now:ttl 内(差 1ms)仍命中', async () => {
  const mk = need(mcp, 'makeTtlCache');
  let t = 1000;
  const c = mk(30000, () => t);
  c.set('k', 'v');
  t = 1000 + 29999;
  assert.equal(c.get('k'), 'v');
});

await check('C6 过期的 null 也返回 undefined(不把过期误当"缓存过的找不到")', async () => {
  const mk = need(mcp, 'makeTtlCache');
  let t = 0;
  const c = mk(1000, () => t);
  c.set('k', null);
  assert.equal(c.get('k'), null);
  t = 5000;
  assert.equal(c.get('k'), undefined);
});

await check('C7 clear() 后全部失效', async () => {
  const mk = need(mcp, 'makeTtlCache');
  const c = mk(30000);
  c.set('a', 1); c.set('b', null);
  c.clear();
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), undefined);
});

await check('C8 同 key 重复 set 覆盖旧值并刷新时间', async () => {
  const mk = need(mcp, 'makeTtlCache');
  let t = 0;
  const c = mk(1000, () => t);
  c.set('k', 'old');
  t = 900;
  c.set('k', 'new');
  t = 1500; // 距首次写 1500ms(已过期),距重写 600ms(未过期)
  assert.equal(c.get('k'), 'new');
});

await check('C9 不传 now 时用真实时钟,刚写入立即命中', async () => {
  const mk = need(mcp, 'makeTtlCache');
  const c = mk(30000);
  c.set('k', 'v');
  assert.equal(c.get('k'), 'v');
});

await check('C10 两个实例互不共享数据', async () => {
  const mk = need(mcp, 'makeTtlCache');
  const a = mk(30000); const b = mk(30000);
  a.set('k', 'from-a');
  assert.equal(b.get('k'), undefined);
});

await check('C11 边界:ttl=0 时写入即过期', async () => {
  const mk = need(mcp, 'makeTtlCache');
  let t = 0;
  const c = mk(0, () => t);
  c.set('k', 'v');
  t = 1;
  assert.equal(c.get('k'), undefined);
});

await check('C12 边界:key 为空串/undefined value 不抛', async () => {
  const mk = need(mcp, 'makeTtlCache');
  const c = mk(30000);
  c.set('', 'empty-key');
  assert.equal(c.get(''), 'empty-key');
  c.set('u', undefined);
  assert.equal(c.get('u'), undefined);
});

// ══════════════════════════════════════════════════════════════════════════
// D. withTimeout —— server/routes/mcp.js (INTERFACE §3.3)
//    真实用户视角:保存 MCP 配置时的"绝对路径提示"探测卡住,不该把整个请求拖住。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nD. withTimeout 超时兜底');

await check('D1 promise 先完成 → 返回原值', async () => {
  const fn = need(mcp, 'withTimeout');
  assert.equal(await fn(Promise.resolve('real'), 1500, 'fallback'), 'real');
});

await check('D2 超时 → 返回 fallback', async () => {
  const fn = need(mcp, 'withTimeout');
  const never = new Promise(() => {});
  const t0 = Date.now();
  assert.equal(await fn(never, 60, 'fallback'), 'fallback');
  assert.ok(Date.now() - t0 < 3000, '不该等到天荒地老');
});

await check('D3 promise reject → 也返回 fallback(不抛出)', async () => {
  const fn = need(mcp, 'withTimeout');
  assert.equal(await fn(Promise.reject(new Error('boom')), 1500, ''), '');
});

await check('D4 值是 falsy(0/空串/null)时返回原值而非 fallback', async () => {
  const fn = need(mcp, 'withTimeout');
  assert.equal(await fn(Promise.resolve(0), 1500, 'fb'), 0);
  assert.equal(await fn(Promise.resolve(''), 1500, 'fb'), '');
  assert.equal(await fn(Promise.resolve(null), 1500, 'fb'), null);
});

await check('D5 fallback 省略时超时 resolve 为 undefined,不抛', async () => {
  const fn = need(mcp, 'withTimeout');
  assert.equal(await fn(new Promise(() => {}), 30), undefined);
});

await check('D6 传入非 Promise(裸值)不抛,直接给回该值', async () => {
  const fn = need(mcp, 'withTimeout');
  assert.equal(await fn('plain', 1500, 'fb'), 'plain');
});

await check('D7 基线:只 import mcp.js 的子进程能自然退出(D8 的前提)', async () => {
  const code = `await import(${JSON.stringify(urlOf('server/routes/mcp.js'))}); process.stdout.write('ok');`;
  const r = runNode(code, 12000);
  assert.equal(r.timedOut, false, 'mcp.js 自身留了常驻句柄,D8 的判据不成立');
  assert.equal(r.status, 0, `子进程退出码 ${r.status}: ${String(r.stderr).slice(0, 200)}`);
});

await check('D8 先完成时超时 timer 被清掉:调过 withTimeout(…, 60s) 的进程仍能自然退出', async () => {
  const code = `
    const m = await import(${JSON.stringify(urlOf('server/routes/mcp.js'))});
    if (typeof m.withTimeout !== 'function') { process.stdout.write('NOEXPORT'); process.exit(7); }
    const v = await m.withTimeout(Promise.resolve('ok'), 60000, 'fb');
    if (v !== 'ok') { process.exit(8); }
    process.stdout.write('ok');
  `;
  const r = runNode(code, 12000);
  assert.equal(r.timedOut, false, '进程被 60s 悬挂 timer 拖住了(timer 没清或没 unref)');
  assert.equal(String(r.stdout).includes('NOEXPORT'), false, '缺少导出 withTimeout');
  assert.equal(r.status, 0, `子进程退出码 ${r.status}: ${String(r.stderr).slice(0, 200)}`);
});

// ══════════════════════════════════════════════════════════════════════════
// E. winCmdSpawnSpec —— server/routes/mcp.js (INTERFACE §3.4)
//    真实用户视角:用户名带空格(C:\Users\John Smith)、路径在 Program Files 时,
//    npx.cmd 起的 MCP 不该因为引号被拆坏而"命令找不到"。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nE. winCmdSpawnSpec 经 cmd.exe 的引号规则');

const NPX = 'C:\\Program Files\\nodejs\\npx.cmd';

await check('E1 file 恒为 cmd.exe', async () => {
  const fn = need(mcp, 'winCmdSpawnSpec');
  assert.equal(fn(NPX, ['-y'], {}).file, 'cmd.exe');
  assert.equal(fn('C:\\a\\foo.bat', [], {}).file, 'cmd.exe');
});

await check('E2 args 恒为 4 项且前三项是 /d /s /c', async () => {
  const fn = need(mcp, 'winCmdSpawnSpec');
  const s = fn(NPX, ['-y', 'pkg'], {});
  assert.equal(s.args.length, 4);
  assert.deepEqual(s.args.slice(0, 3), ['/d', '/s', '/c']);
});

await check('E3 INTERFACE §3.4 逐字例子:带空格路径 + 带空格参数', async () => {
  const fn = need(mcp, 'winCmdSpawnSpec');
  const s = fn(NPX, ['-y', 'pkg', 'C:\\Users\\John Smith\\Documents'], {});
  const expected = '"'
    + '"C:\\Program Files\\nodejs\\npx.cmd" "-y" "pkg" "C:\\Users\\John Smith\\Documents"'
    + '"';
  assert.equal(s.args[3], expected);
});

await check('E4 参数内部的双引号翻倍', async () => {
  const fn = need(mcp, 'winCmdSpawnSpec');
  const s = fn('C:\\a\\foo.cmd', ['say "hi"'], {});
  assert.equal(s.args[3], '""C:\\a\\foo.cmd" "say ""hi""""'); // 主会话修正:原期望漏写外层收尾引号(契约 §3.4 首尾各一个外层引号,与 E12 偶数引号一致)
});

await check('E5 & | ^ > 落在自己的引号内、原样保留不转义不删', async () => {
  const fn = need(mcp, 'winCmdSpawnSpec');
  const s = fn('C:\\a\\foo.cmd', ['a&b', 'c|d', 'e^f', 'g>h'], {});
  assert.equal(s.args[3], '""C:\\a\\foo.cmd" "a&b" "c|d" "e^f" "g>h""');
});

await check('E6 args 为空数组 → line 只有命令本身', async () => {
  const fn = need(mcp, 'winCmdSpawnSpec');
  assert.equal(fn(NPX, [], {}).args[3], '""C:\\Program Files\\nodejs\\npx.cmd""');
});

await check('E7 opts 其余字段原样保留,并加上 windowsVerbatimArguments:true', async () => {
  const fn = need(mcp, 'winCmdSpawnSpec');
  const env = { PATH: 'C:\\x' };
  const s = fn(NPX, ['-y'], { env, cwd: 'C:\\work', stdio: 'pipe' });
  assert.equal(s.opts.windowsVerbatimArguments, true);
  assert.equal(s.opts.cwd, 'C:\\work');
  assert.equal(s.opts.stdio, 'pipe');
  assert.equal(s.opts.env, env, 'env 应原样透传(同一引用)');
});

await check('E8 反向:不改写调用方传入的 opts 对象', async () => {
  const fn = need(mcp, 'winCmdSpawnSpec');
  const opts = { cwd: 'C:\\work' };
  fn(NPX, ['-y'], opts);
  assert.equal('windowsVerbatimArguments' in opts, false, '不该污染调用方的 opts');
});

await check('E9 非字符串参数按 String() 转换', async () => {
  const fn = need(mcp, 'winCmdSpawnSpec');
  const s = fn('C:\\a\\foo.cmd', [123, null, undefined, true], {});
  assert.equal(s.args[3], '""C:\\a\\foo.cmd" "123" "null" "undefined" "true""');
});

await check('E10 opts 省略时不抛,仍带 windowsVerbatimArguments:true', async () => {
  const fn = need(mcp, 'winCmdSpawnSpec');
  const s = fn(NPX, ['-y']);
  assert.equal(s.opts.windowsVerbatimArguments, true);
  assert.equal(s.file, 'cmd.exe');
});

await check('E11 边界:args 省略/为 null 时不抛,等价于空参数', async () => {
  const fn = need(mcp, 'winCmdSpawnSpec');
  assert.equal(fn(NPX).args[3], '""C:\\Program Files\\nodejs\\npx.cmd""');
  assert.equal(fn(NPX, null, {}).args[3], '""C:\\Program Files\\nodejs\\npx.cmd""');
});

await check('E12 反向:参数里不出现"未配对的裸引号"(每个 token 引号成对)', async () => {
  const fn = need(mcp, 'winCmdSpawnSpec');
  const s = fn(NPX, ['a"b', 'c'], {});
  const quotes = (s.args[3].match(/"/g) || []).length;
  assert.equal(quotes % 2, 0, `引号总数应为偶数,实际 ${quotes}:${s.args[3]}`);
});

// ══════════════════════════════════════════════════════════════════════════
// F. missingCommandHint —— server/routes/mcp.js (INTERFACE §3.5)
//    真实用户视角:已经填了绝对路径还被劝"请填写绝对路径"是答非所问。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nF. missingCommandHint 绝对路径分支');

const ABS_HINT = (n) => `找不到 ${n}:该路径不存在或不可执行`;

await check('F1 反斜杠绝对路径 → 精确文案', async () => {
  const fn = need(mcp, 'missingCommandHint');
  const n = 'C:\\tools\\mcp\\server.exe';
  assert.equal(fn(n, 'win32'), ABS_HINT(n));
});

await check('F2 正斜杠路径 → 同一文案', async () => {
  const fn = need(mcp, 'missingCommandHint');
  const n = '/usr/local/bin/uvx';
  assert.equal(fn(n, 'darwin'), ABS_HINT(n));
});

await check('F3 相对路径(含分隔符)也走绝对路径分支', async () => {
  const fn = need(mcp, 'missingCommandHint');
  assert.equal(fn('./bin/foo', 'darwin'), ABS_HINT('./bin/foo'));
});

await check('F4 反向:裸名分支文案不变,不含"该路径不存在或不可执行"', async () => {
  const fn = need(mcp, 'missingCommandHint');
  for (const p of ['win32', 'darwin']) {
    const t = fn('npx', p);
    assert.equal(typeof t, 'string');
    assert.ok(t.length > 0, '裸名也要给提示');
    assert.equal(t.includes('该路径不存在或不可执行'), false, `裸名不该用绝对路径分支文案(${p})`);
    assert.ok(t.includes('npx'), '提示里应带上命令名');
  }
});

await check('F5 边界:空串/null/undefined/数字不抛,返回字符串', async () => {
  const fn = need(mcp, 'missingCommandHint');
  for (const bad of ['', null, undefined, 123]) {
    const t = fn(bad, 'win32');
    assert.equal(typeof t, 'string', `入参 ${JSON.stringify(bad)} 应返回字符串`);
  }
});

await check('F6 边界:platform 省略时绝对路径分支文案不变', async () => {
  const fn = need(mcp, 'missingCommandHint');
  const n = 'C:\\a\\b.exe';
  assert.equal(fn(n), ABS_HINT(n));
});

// ══════════════════════════════════════════════════════════════════════════
// G. resolveSdkClaudeFrom 体积下限 —— server/utils/claude-resolver.js (INTERFACE §4.1)
//    真实用户视角:npm 装 claude 时平台包只下了一半(镜像慢/被杀毒截断),
//    残缺 exe 不该交给 SDK 用,应回落 SDK 自带 CLI。
//    包内 exe 的具体路径不写死:先用注入 fs 从公开接口"探"出来,再按探出的路径造真实文件。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nG. resolveSdkClaudeFrom 截断 exe 体积下限');

const mzBuf = (bytes) => {
  const b = Buffer.alloc(Math.max(4, Math.min(bytes, 65536)));
  b[0] = 0x4d; b[1] = 0x5a; b[2] = 0x90;
  return b;
};
let instSeq = 0;
function mkInstall(bytes) {
  const fn = need(resolver, 'resolveSdkClaudeFrom');
  const base = join(TMP, `inst-${++instSeq}`);
  const hit = join(base, 'npm', 'claude');
  mkdirSync(dirname(hit), { recursive: true });
  writeFileSync(hit, '#!/bin/sh\n');
  const target = fn(hit, { platform: 'win32', existsSync: () => true, readFileSync: () => mzBuf(4) });
  if (typeof target !== 'string' || !target) {
    throw new Error(`无法通过公开接口探出包内 exe 路径(返回 ${JSON.stringify(target)})`);
  }
  mkdirSync(dirname(target), { recursive: true });
  const head = mzBuf(bytes);
  writeFileSync(target, head);
  if (bytes > head.length) truncateSync(target, bytes); // 稀疏文件,不真占盘
  return { hit, target };
}

await check('G1 前置:能从公开接口探出包内 exe 路径', async () => {
  const { target } = mkInstall(1024);
  assert.equal(typeof target, 'string');
  assert.ok(/\.exe$/i.test(target), `探出的路径应以 .exe 结尾:${target}`);
});

await check('G2 真实 MZ 头但只有 1KB + 默认下限(未注入 readFileSync)→ null(回落 SDK 自带)', async () => {
  const fn = need(resolver, 'resolveSdkClaudeFrom');
  const { hit } = mkInstall(1024);
  assert.equal(fn(hit, { platform: 'win32' }), null);
});

await check('G3 同一个 1KB 文件 + 注入 readFileSync → 默认下限为 0,放行', async () => {
  const fn = need(resolver, 'resolveSdkClaudeFrom');
  const { hit, target } = mkInstall(1024);
  const r = fn(hit, { platform: 'win32', readFileSync: () => mzBuf(4) });
  assert.equal(r, target, '注入 readFileSync 的既有 59 条锁定测试必须继续全绿');
});

await check('G4 1KB 文件 + 显式 minExeBytes=512(达标)→ 放行', async () => {
  const fn = need(resolver, 'resolveSdkClaudeFrom');
  const { hit, target } = mkInstall(1024);
  assert.equal(fn(hit, { platform: 'win32', minExeBytes: 512 }), target);
});

await check('G5 1KB 文件 + 显式 minExeBytes=10000(不达标)→ null', async () => {
  const fn = need(resolver, 'resolveSdkClaudeFrom');
  const { hit } = mkInstall(1024);
  assert.equal(fn(hit, { platform: 'win32', minExeBytes: 10000 }), null);
});

await check('G6 真实 6MB 完整 exe + 默认下限 → 放行(正常安装不受影响)', async () => {
  const fn = need(resolver, 'resolveSdkClaudeFrom');
  const { hit, target } = mkInstall(6_000_000);
  assert.equal(fn(hit, { platform: 'win32' }), target);
});

await check('G7 边界:size 恰好等于 minExeBytes → 放行(>= 而非 >)', async () => {
  const fn = need(resolver, 'resolveSdkClaudeFrom');
  const { hit, target } = mkInstall(1024);
  assert.equal(fn(hit, { platform: 'win32', minExeBytes: 4096, statSync: () => ({ size: 4096 }) }), target);
});

await check('G8 边界:size 比 minExeBytes 少 1 字节 → null', async () => {
  const fn = need(resolver, 'resolveSdkClaudeFrom');
  const { hit } = mkInstall(1024);
  assert.equal(fn(hit, { platform: 'win32', minExeBytes: 4096, statSync: () => ({ size: 4095 }) }), null);
});

await check('G9 statSync 抛错(文件被杀毒隔离/权限不足)→ null,不抛', async () => {
  const fn = need(resolver, 'resolveSdkClaudeFrom');
  const { hit } = mkInstall(6_000_000);
  const r = fn(hit, { platform: 'win32', statSync: () => { throw new Error('EPERM'); } });
  assert.equal(r, null);
});

await check('G10 反向:体积达标也不能绕过 PE 头判定(内容不是 exe → null)', async () => {
  const fn = need(resolver, 'resolveSdkClaudeFrom');
  const { hit } = mkInstall(6_000_000);
  const r = fn(hit, { platform: 'win32', readFileSync: () => Buffer.from('this-is-not-a-windows-exe') });
  assert.equal(r, null);
});

await check('G11 反向:非 win32 平台原样返回 hitPath(不做任何 exe 改写)', async () => {
  const fn = need(resolver, 'resolveSdkClaudeFrom');
  const { hit } = mkInstall(1024);
  assert.equal(fn(hit, { platform: 'darwin' }), hit);
  assert.equal(fn(hit, { platform: 'linux', minExeBytes: 999_999_999 }), hit, '非 win32 时体积下限不该生效');
});

await check('G12 边界:hitPath 为空串/null/undefined → null,不抛', async () => {
  const fn = need(resolver, 'resolveSdkClaudeFrom');
  for (const bad of ['', null, undefined]) {
    assert.equal(fn(bad, { platform: 'win32' }), null, `入参 ${JSON.stringify(bad)}`);
  }
});

await check('G13 反向:包内 exe 根本不存在时仍返回 null', async () => {
  const fn = need(resolver, 'resolveSdkClaudeFrom');
  const base = join(TMP, `inst-missing-${++instSeq}`);
  const hit = join(base, 'npm', 'claude');
  mkdirSync(dirname(hit), { recursive: true });
  writeFileSync(hit, '#!/bin/sh\n');
  assert.equal(fn(hit, { platform: 'win32' }), null);
});

// ══════════════════════════════════════════════════════════════════════════
// H. splitWinPathList —— server/utils/claude-resolver.js (INTERFACE §4.2)
//    真实用户视角:注册表里 PATH 条目被人加了引号,不该因此找不到 claude。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nH. splitWinPathList 注册表 PATH 去引号');

await check('H1 按分号切分', async () => {
  const fn = need(resolver, 'splitWinPathList');
  assert.deepEqual(fn('C:\\a;C:\\b'), ['C:\\a', 'C:\\b']);
});

await check('H2 去掉成对首尾引号', async () => {
  const fn = need(resolver, 'splitWinPathList');
  assert.deepEqual(fn('"C:\\Program Files\\Foo\\bin";C:\\b'), ['C:\\Program Files\\Foo\\bin', 'C:\\b']);
});

await check('H3 去掉单侧引号', async () => {
  const fn = need(resolver, 'splitWinPathList');
  assert.deepEqual(fn('"C:\\a;C:\\b"'), ['C:\\a', 'C:\\b']);
});

await check('H4 空条目被过滤(连续分号、结尾分号)', async () => {
  const fn = need(resolver, 'splitWinPathList');
  assert.deepEqual(fn('C:\\a;;C:\\b;'), ['C:\\a', 'C:\\b']);
});

await check('H5 只有引号的条目去引号后为空 → 被过滤', async () => {
  const fn = need(resolver, 'splitWinPathList');
  assert.deepEqual(fn('C:\\a;"";C:\\b'), ['C:\\a', 'C:\\b']);
  assert.deepEqual(fn('"'), []);
  assert.deepEqual(fn('""'), []);
});

await check('H6 先 trim 再去引号,混合形态都规整', async () => {
  const fn = need(resolver, 'splitWinPathList');
  assert.deepEqual(fn('  "C:\\a"  ;  C:\\b ; "C:\\Program Files\\c" '), ['C:\\a', 'C:\\b', 'C:\\Program Files\\c']);
});

await check('H7 反向:路径中间的引号不动(只去首尾)', async () => {
  const fn = need(resolver, 'splitWinPathList');
  assert.deepEqual(fn('C:\\a"b'), ['C:\\a"b']);
});

await check('H8 边界:空串 → 空数组', async () => {
  const fn = need(resolver, 'splitWinPathList');
  assert.deepEqual(fn(''), []);
  assert.deepEqual(fn('   '), []);
  assert.deepEqual(fn(';;;'), []);
});

await check('H9 边界:null/undefined/数字/对象 → 空数组或不抛', async () => {
  const fn = need(resolver, 'splitWinPathList');
  for (const bad of [null, undefined, 123, {}, []]) {
    const r = fn(bad);
    assert.ok(Array.isArray(r), `入参 ${JSON.stringify(bad)} 应返回数组,实际 ${typeof r}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// I. logSdkClaudeOnce 默认走 stderr —— (INTERFACE §4.3)
//    真实用户视角:装机版 stdout 被丢弃,这行日志只有落 stderr 才进 server.log。
//    "once" 是进程级一次性状态,两条各起一个干净子进程,免得互相消耗。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nI. logSdkClaudeOnce 默认 logger');

const RESOLVER_URL = JSON.stringify(urlOf('server/utils/claude-resolver.js'));

await check('I1 不传 log 时默认用 console.error(不是 console.log)', async () => {
  const code = `
    const m = await import(${RESOLVER_URL});
    if (typeof m.logSdkClaudeOnce !== 'function') { process.stderr.write('NOEXPORT'); process.exit(7); }
    let err = 0, out = 0;
    const realErr = console.error, realLog = console.log;
    console.error = () => { err++; };
    console.log = () => { out++; };
    try { m.logSdkClaudeOnce('C:\\\\Users\\\\Bob\\\\claude.exe'); } finally {
      console.error = realErr; console.log = realLog;
    }
    process.stdout.write(JSON.stringify({ err, out }));
  `;
  const r = runNode(code, 12000);
  assert.equal(r.timedOut, false, '子进程超时');
  assert.equal(String(r.stderr).includes('NOEXPORT'), false, '缺少导出 logSdkClaudeOnce');
  assert.equal(r.status, 0, `子进程退出码 ${r.status}: ${String(r.stderr).slice(0, 200)}`);
  const got = JSON.parse(String(r.stdout).trim() || '{}');
  assert.equal(got.err >= 1, true, `默认 logger 应打到 console.error,实际 err=${got.err} out=${got.out}`);
  assert.equal(got.out, 0, '不该打到 console.log(装机版 stdout 被丢弃)');
});

await check('I2 显式传入 log 时用传入的,不碰 console.error', async () => {
  const code = `
    const m = await import(${RESOLVER_URL});
    if (typeof m.logSdkClaudeOnce !== 'function') { process.stderr.write('NOEXPORT'); process.exit(7); }
    let mine = 0, err = 0;
    const realErr = console.error;
    console.error = () => { err++; };
    try { m.logSdkClaudeOnce('C:\\\\Users\\\\Bob\\\\claude.exe', () => { mine++; }); } finally {
      console.error = realErr;
    }
    process.stdout.write(JSON.stringify({ mine, err }));
  `;
  const r = runNode(code, 12000);
  assert.equal(r.timedOut, false, '子进程超时');
  assert.equal(r.status, 0, `子进程退出码 ${r.status}: ${String(r.stderr).slice(0, 200)}`);
  const got = JSON.parse(String(r.stdout).trim() || '{}');
  assert.equal(got.mine >= 1, true, '应调用传入的 log');
  assert.equal(got.err, 0, '传了 log 就不该再走 console.error');
});

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${PASS} 绿 / ${FAILS} 红`);
if (FAILS) console.log(`红:\n  - ${failed.join('\n  - ')}`);
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(FAILS ? 1 : 0);

