#!/usr/bin/env node
// r113 服务端验收测试:Bug 1(help 缓存空串把快照参数永久关掉)+ Bug 2(--bg 7000 上限
// 套在不经 cmd.exe 的 .exe 装法上)。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/INTERFACE-r113.md 写,没看实现、没看
// PLAN/RESEARCH/审查报告。只调用 INTERFACE 点名的导出与文件路径。
//
// 设计要点:
//  * 【动态 import + 逐条 try/catch】:静态 import 一个还不存在的导出会在 ESM 链接阶段
//    整个文件炸掉,一条断言都跑不到;要的是"改前每条各自红",才看得出缺哪几件。
//  * Windows 行为一律靠注入(platform / probe / probeAsync / now)模拟,不起真进程。
//  * 每条测试自带 fresh key,测试之间无共享可变状态,可任意顺序跑。
//  * 每条标 [修前应红](复现/新契约)或 [修前应绿](回归/不变),文件末尾分类汇总。
//
// Run: node tests/unit/check-r113-server.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'cgui-r113-'));
const SANDBOX_HOME = join(TMP, 'home');
mkdirSync(SANDBOX_HOME, { recursive: true });
process.env.HOME = SANDBOX_HOME;          // 绝不读写真实 ~/.claude*
process.env.USERPROFILE = SANDBOX_HOME;

let PASS = 0;
let FAILS = 0;
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
    const msg = String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ');
    console.log(`  ✗ ${label}\n      ${msg}`);
  }
}
const red = (name, fn) => check('RED', name, fn);
const green = (name, fn) => check('GREEN', name, fn);

async function load(rel) {
  try { return await import(pathToFileURL(join(ROOT, rel)).href); }
  catch (e) { return { __err: e }; }
}
function need(mod, name) {
  if (!mod || mod.__err) throw new Error(`模块未能导入:${(mod && mod.__err && mod.__err.message) || '未知'}`);
  const f = mod[name];
  if (typeof f !== 'function') throw new Error(`缺少导出 ${name}(当前 typeof=${typeof f})`);
  return f;
}
const read = (rel) => { try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; } };
// 源码锁一律在【去注释后】的文本上做:否则实现方写一行注释就能骗过锁。
// 只剥"行首的块注释/行注释"与"前面不含引号或斜杠的行尾注释" —— 通吃式的
// /\/\*[\s\S]*?\*\//g 会被源码里的正则字面量(如 .replace(/\*/g,…))骗成注释起点,
// 一口吃掉半个文件,锁就变成永远绿的空壳(本轮实测 agents.js 被吃掉 52%)。
const stripComments = (s) => s
  .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*\n?/gm, '')
  .replace(/^[ \t]*\/\/[^\n]*\n?/gm, '')
  .replace(/^([^'"`/\n]*?)[ \t]+\/\/[^\n]*$/gm, '$1');
// 取函数体:定位声明 → 跳过参数表(括号配对,容忍解构默认值)→ 花括号配对。
function fnBody(src, declRe) {
  const m = declRe.exec(src);
  if (!m) return '';
  let i = src.indexOf('(', m.index);
  if (i < 0) return '';
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  const open = src.indexOf('{', i);
  if (open < 0) return '';
  depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(open, j + 1); }
  }
  return '';
}

const cacheEnv = await load('server/utils/prompt-cache-env.js');
const winCmd = await load('server/utils/win-cmd.js');
const resolver = await load('server/utils/claude-resolver.js');

// ══════════════════════════════════════════════════════════════════════════
// P. prompt-cache-env.js —— Bug 1(INTERFACE §1)
//    真实用户视角:Windows 冷启动时先发了一条消息(同步探测超时),之后这个进程里
//    --system-prompt-snapshot 就再也不会被加上,缓存命中率悄悄塌回 8%,界面无异常。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nP. help 缓存:同步失败的空串必须能被预热正文覆盖(§1)');

const SNAP = '--system-prompt-snapshot';
const HELP = `Usage: claude [options]\n  ${SNAP} <mode>  toggle snapshot\n  -c, --continue\n`;
let keySeq = 0;
const freshPath = (tag) => `C:\\r113\\${tag}-${++keySeq}\\claude.exe`;
function boom() { throw new Error('不该再同步探测'); }
const T0 = 1_000_000;

await red('P1 导出 HELP_MISS_TTL_MS,取值是正整数', async () => {
  const ttl = cacheEnv?.HELP_MISS_TTL_MS;
  assert.equal(typeof ttl, 'number', `缺少导出 HELP_MISS_TTL_MS(当前 typeof=${typeof ttl})`);
  assert.equal(Number.isInteger(ttl) && ttl > 0, true, `HELP_MISS_TTL_MS 必须是正整数,实际 ${ttl}`);
});

await red('P2 交接三步(§1.5):同步探测抛错 → 预热正文覆盖 → supports 恢复 true 且不再同步探', async () => {
  const supports = need(cacheEnv, 'cliSupportsFlag');
  const prime = need(cacheEnv, 'primeHelpCache');
  const p = freshPath('p2');
  assert.equal(supports(p, '--snap', () => { throw new Error('timeout'); }), false, '第一步:同步探测失败应返回 false');
  let asyncCalls = 0;
  const ok = await prime(p, async () => { asyncCalls++; return `  ${SNAP} <mode>`; });
  assert.equal(asyncCalls, 1, '第二步:预热必须真的探一次(空串不是"已有正文")');
  assert.equal(ok, true, '第二步:预热拿到正文应 resolve true');
  assert.equal(supports(p, SNAP, boom), true, '第三步:正文已入表,应返回 true 且不再同步探测');
});

await green('P3 反向用例:预热拿到空串 → prime 返回 false(index.js 该打 miss 不打 ok)', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  assert.equal(await prime(freshPath('p3'), async () => ''), false);
});

await green('P4 §1.4 表①:首次预热探到空串 → false,探测 1 次', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  let calls = 0;
  const p = freshPath('p4');
  const r = await prime(p, async () => { calls++; return ''; }, () => T0);
  assert.equal(r, false);
  assert.equal(calls, 1);
});

await red('P5 §1.4 表②:失败后 TTL-1 毫秒再预热 → false 且不重探', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  const ttl = cacheEnv?.HELP_MISS_TTL_MS;
  assert.equal(typeof ttl, 'number', '缺少导出 HELP_MISS_TTL_MS');
  let calls = 0;
  const p = freshPath('p5');
  await prime(p, async () => { calls++; return ''; }, () => T0);
  const r = await prime(p, async () => { calls++; return HELP; }, () => T0 + ttl - 1);
  assert.equal(r, false, 'TTL 内应直接返回 false');
  assert.equal(calls, 1, 'TTL 内不该重探');
});

await red('P6 §1.4 表③:失败后正好到 TTL → 重探并写正文,返回 true(失败结论不永久化)', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  const ttl = cacheEnv?.HELP_MISS_TTL_MS;
  assert.equal(typeof ttl, 'number', '缺少导出 HELP_MISS_TTL_MS');
  let calls = 0;
  const p = freshPath('p6');
  await prime(p, async () => { calls++; return ''; }, () => T0);
  const r = await prime(p, async () => { calls++; return HELP; }, () => T0 + ttl);
  assert.equal(r, true, 'TTL 到点应重探并拿到正文');
  assert.equal(calls, 2, 'TTL 到点必须真的重探一次');
});

await red('P7 §1.4 表④:已有正文后再预热 → true 且不再探测', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  const ttl = cacheEnv?.HELP_MISS_TTL_MS;
  assert.equal(typeof ttl, 'number', '缺少导出 HELP_MISS_TTL_MS');
  let calls = 0;
  const p = freshPath('p7');
  await prime(p, async () => { calls++; return ''; }, () => T0);
  await prime(p, async () => { calls++; return HELP; }, () => T0 + ttl);
  const r = await prime(p, async () => { calls++; return HELP; }, () => T0 + ttl + 1);
  assert.equal(r, true);
  assert.equal(calls, 2, '正文表命中不该再探');
});

await green('P8 §1.4-1:已有非空正文的路径,预热不再 spawn', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  const p = freshPath('p8');
  let calls = 0;
  const first = await prime(p, async () => { calls++; return HELP; });
  const second = await prime(p, async () => { calls++; return HELP; });
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(calls, 1);
});

await red('P9 §1.4-2 在飞标记:并发两次预热同一路径,只探一次', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  const p = freshPath('p9');
  let calls = 0;
  const slow = () => { calls++; return new Promise((r) => setTimeout(() => r(HELP), 20)); };
  const [a] = await Promise.all([prime(p, slow, () => T0), prime(p, slow, () => T0)]);
  assert.equal(calls, 1, '第二次重入必须被在飞标记短路(§1.4-2:不 spawn、不写记录)');
  assert.equal(a, true, '第一次拿到正文应 true');
});

await red('P9b §1.4-2 在飞标记:并发的第二次预热返回 false(返回时正文表还没正文)', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  const p = freshPath('p9b');
  const slow = () => new Promise((r) => setTimeout(() => r(HELP), 20));
  const [, b] = await Promise.all([prime(p, slow, () => T0), prime(p, slow, () => T0)]);
  assert.equal(b, false, '返回时正文表里还没有正文 → 按 §1.4「true ⟺ 返回时有正文」应为 false');
});

await red('P9c §1.4-2/§1.3-3:在飞标记不是失败记录 —— 被短路的第二次预热不写记录,同步探测照常', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  const supports = need(cacheEnv, 'cliSupportsFlag');
  const p = freshPath('p9c');
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = prime(p, () => gate, () => T0);                 // 预热挂起中 = 在飞
  const second = await prime(p, async () => HELP, () => T0);
  assert.equal(second, false, '在飞期间的第二次预热应直接 false 且不 spawn');
  let syncCalls = 0;
  const sync = supports(p, SNAP, () => { syncCalls++; return HELP; }, () => T0);
  assert.equal(syncCalls, 1,
    '在飞标记若被写成失败记录,同步侧会被 §1.3-2 短路 —— §1.4-2 要求"不写任何记录",§1.3-3 要求在飞不挡同步探测');
  assert.equal(sync, true, '同步探到正文应返回 true');
  release(HELP);
  await first;
});

await red('P10 §1.4-3 跨来源:同步失败(sync 记录)不挡预热 —— TTL 内的预热照样探 1 次并成功', async () => {
  const supports = need(cacheEnv, 'cliSupportsFlag');
  const prime = need(cacheEnv, 'primeHelpCache');
  const ttl = cacheEnv?.HELP_MISS_TTL_MS;
  assert.equal(typeof ttl, 'number', '缺少导出 HELP_MISS_TTL_MS');
  const p = freshPath('p10');
  assert.equal(supports(p, SNAP, () => { throw new Error('timeout'); }, () => T0), false, '同步探测失败应 false');
  let calls = 0;
  const inTtl = await prime(p, async () => { calls++; return HELP; }, () => T0 + ttl - 1);
  assert.equal(calls, 1, 'sync 来源的失败记录不得挡住预热(v2:同步失败只挡同步侧)');
  assert.equal(inTtl, true, '预热探到正文应 resolve true');
});

await red('P10b §1.4 跨来源两方向:sync 记录不挡预热;prime 记录在 TTL 内挡预热', async () => {
  const supports = need(cacheEnv, 'cliSupportsFlag');
  const prime = need(cacheEnv, 'primeHelpCache');
  const ttl = cacheEnv?.HELP_MISS_TTL_MS;
  assert.equal(typeof ttl, 'number', '缺少导出 HELP_MISS_TTL_MS');
  // 方向一:同步失败写 sync 记录 → 紧接着(T0+1)的预热必须真的探
  const a = freshPath('p10b-sync');
  assert.equal(supports(a, '--x', () => { throw new Error('timeout'); }, () => T0), false);
  let aCalls = 0;
  assert.equal(await prime(a, async () => { aCalls++; return HELP; }, () => T0 + 1), true,
    'sync 记录不挡预热');
  assert.equal(aCalls, 1, 'sync 记录不挡预热:必须真的探一次');
  // 方向二:预热自己失败写 prime 记录 → TTL 内的预热必须被挡
  const b = freshPath('p10b-prime');
  let bCalls = 0;
  assert.equal(await prime(b, async () => { bCalls++; return ''; }, () => T0), false);
  assert.equal(await prime(b, async () => { bCalls++; return HELP; }, () => T0 + ttl - 1), false,
    'prime 记录在 TTL 内必须挡住预热');
  assert.equal(bCalls, 1, 'prime 记录在 TTL 内不该重探');
});

await green('P11 §1.3-1:正文表命中 → 不调用 probe(哨兵)', async () => {
  const supports = need(cacheEnv, 'cliSupportsFlag');
  const p = freshPath('p11');
  assert.equal(supports(p, SNAP, () => HELP), true);
  assert.equal(supports(p, '--continue', boom), true, '第二次问别的 flag 不该再探');
});

await green('P12 §1.3-2:失败表有记录(哪怕注入的 now 已远超 TTL)→ false 且不 probe', async () => {
  const supports = need(cacheEnv, 'cliSupportsFlag');
  const ttl = Number(cacheEnv?.HELP_MISS_TTL_MS) || 60_000;
  const p = freshPath('p12');
  assert.equal(supports(p, SNAP, () => { throw new Error('boom'); }, () => T0), false);
  assert.equal(supports(p, '--continue', boom, () => T0 + ttl * 10), false,
    '同步探测每条路径整个进程内最多一次');
});

await green('P13 §1.3-3:probe 返回空串/非字符串 → false 且不抛', async () => {
  const supports = need(cacheEnv, 'cliSupportsFlag');
  for (const bad of [() => '', () => null, () => undefined, () => 42, () => ({})]) {
    assert.equal(supports(freshPath('p13'), SNAP, bad), false, `probe 返回 ${String(bad())} 应 false`);
  }
});

await green('P14 §1.3:脏 claudePath(null/undefined/数字/数组/对象/字符串数字)不抛,返回布尔', async () => {
  const supports = need(cacheEnv, 'cliSupportsFlag');
  for (const bad of [null, undefined, 0, 123, [], {}, '123']) {
    assert.equal(typeof supports(bad, SNAP, () => HELP), 'boolean', `claudePath=${JSON.stringify(bad)}`);
  }
});

await green('P15 §1.4:脏 claudePath → resolve false 且 probeAsync 零调用', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  let calls = 0;
  const probe = async () => { calls++; return HELP; };
  for (const bad of ['', null, undefined, 123, {}, []]) {
    assert.equal(await prime(bad, probe), false, `claudePath=${JSON.stringify(bad)} 应 false`);
  }
  assert.equal(calls, 0);
});

await green('P16 §1.4:probeAsync 同步抛/异步抛 → 永不 reject,resolve false', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  for (const pr of [() => { throw new Error('sync boom'); }, async () => { throw new Error('async boom'); }]) {
    assert.equal(await prime(freshPath('p16'), pr), false, 'probe 抛错一律 resolve false');
  }
});

await red('P16b §1.4-3:probeAsync 返回非字符串(undefined/null/数字)→ false,不当正文入表', async () => {
  const prime = need(cacheEnv, 'primeHelpCache');
  const supports = need(cacheEnv, 'cliSupportsFlag');
  for (const pr of [async () => undefined, async () => null, async () => 42]) {
    const p = freshPath('p16b');
    assert.equal(await prime(p, pr), false, `probeAsync 返回 ${String(await pr())} 应 false`);
    assert.equal(supports(p, SNAP, boom), false, '非字符串不得被当成 help 正文缓存');
  }
});

await green('P17 §1.1:_resetSnapFlagCache 同时清空正文表与失败表', async () => {
  const supports = need(cacheEnv, 'cliSupportsFlag');
  const reset = need(cacheEnv, '_resetSnapFlagCache');
  const pText = freshPath('p17-text');
  const pFail = freshPath('p17-fail');
  supports(pText, SNAP, () => HELP);                       // 正文表
  supports(pFail, SNAP, () => { throw new Error('x'); });   // 失败表
  reset();
  let textCalls = 0; let failCalls = 0;
  supports(pText, SNAP, () => { textCalls++; return HELP; });
  supports(pFail, SNAP, () => { failCalls++; return HELP; });
  assert.equal(textCalls, 1, 'reset 后正文表该空,应重新探测');
  assert.equal(failCalls, 1, 'reset 后失败表该空,应重新探测');
});

await green('P18 §1.6 正则不变:`--system-prompt` 不被 `--system-prompt-snapshot` 前缀命中', async () => {
  const supports = need(cacheEnv, 'cliSupportsFlag');
  assert.equal(supports(freshPath('p18'), '--system-prompt', () => `  ${SNAP} <mode>`), false);
});

await green('P19 §1.6 正则不变:描述正文里的 `--system-prompt or` 不算支持', async () => {
  const supports = need(cacheEnv, 'cliSupportsFlag');
  const help = 'Usage: claude\n  --foo   use --system-prompt or something else\n';
  assert.equal(supports(freshPath('p19'), '--system-prompt', () => help), false);
});

await green('P20 §1.6 正则不变:`  -c, --continue` 里探 --continue 仍 true(别名前缀)', async () => {
  const supports = need(cacheEnv, 'cliSupportsFlag');
  assert.equal(supports(freshPath('p20'), '--continue', () => '  -c, --continue         resume\n'), true);
});

await green('P21 §1.6 不变:snapshotFlagOn(\'\', true) 恒 false(空路径不支持)', async () => {
  const fn = need(cacheEnv, 'snapshotFlagOn');
  assert.equal(fn('', true), false);
});

await green('P22 §1.6 不变:六个既有导出签名仍在', async () => {
  for (const n of ['cliSupportsSnapshotFlag', 'snapshotFlagOn', 'applyPromptCacheEnv',
    'resolvePromptCacheOn', 'normalizePromptCacheMode', 'promptCacheMemoEquals']) {
    assert.equal(typeof cacheEnv?.[n], 'function', `既有导出 ${n} 不该被挪走`);
  }
});

await green('P23 §1.6 不变:同步探测 execFileSync + timeout 2000,异步 execFile + timeout 8000', async () => {
  const src = stripComments(read('server/utils/prompt-cache-env.js'));
  assert.ok(src.length > 0, 'prompt-cache-env.js 读不到');
  assert.match(src, /execFileSync/, '同步探测不再是 execFileSync');
  assert.match(src, /timeout:\s*2000/, '同步探测 2000ms 超时被改');
  assert.match(src, /timeout:\s*8000/, '异步探测 8000ms 超时被改');
  assert.match(src, /claudeExecSpec\(/, '探测不再经 claudeExecSpec');
});

// ══════════════════════════════════════════════════════════════════════════
// W. win-cmd.js —— Bug 2(INTERFACE §2/§3)
//    真实用户视角:Windows 上用官方安装器(claude.exe)的人,7001 字符的后台任务
//    在 0.2.372 能派发,0.2.375 被一律拒 400;而 .cmd 装法里塞满引号的 prompt
//    展开后 14000 字符照样撞 cmd 的 8191,却被放行。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nW. --bg 长度守卫按"是否真经 cmd.exe + 展开后长度"判(§2/§3)');

const CMD_BIN = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
const EXE_BIN = 'C:\\Users\\me\\.local\\bin\\claude.exe';
const BG_ARGS = (p) => ['--bg', p, '--permission-mode', 'acceptEdits'];

await red('W1 spawnViaCmdExe:win32 + .cmd/.BAT → true(大小写不敏感)', async () => {
  const fn = need(winCmd, 'spawnViaCmdExe');
  assert.equal(fn('C:\\npm\\claude.cmd', 'win32'), true);
  assert.equal(fn('C:\\npm\\claude.BAT', 'win32'), true);
});

await red('W2 spawnViaCmdExe:win32 + .exe/无扩展名/裸名 → false(不经 cmd.exe)', async () => {
  const fn = need(winCmd, 'spawnViaCmdExe');
  assert.equal(fn('C:\\Users\\me\\.local\\bin\\claude.exe', 'win32'), false, '.exe 直执行');
  assert.equal(fn('C:\\npm\\claude', 'win32'), false, '无扩展名 shim 直执行');
  assert.equal(fn('claude', 'win32'), false, '裸名直执行');
});

await red('W3 spawnViaCmdExe:非 win32 一律 false', async () => {
  const fn = need(winCmd, 'spawnViaCmdExe');
  assert.equal(fn('C:\\npm\\claude.cmd', 'darwin'), false);
  assert.equal(fn('/usr/local/bin/claude', 'darwin'), false);
  assert.equal(fn('/usr/local/bin/claude.cmd', 'linux'), false);
});

await red('W4 spawnViaCmdExe:脏 binPath(null/undefined/空串/数字/对象/数组)→ false 且不抛', async () => {
  const fn = need(winCmd, 'spawnViaCmdExe');
  for (const bad of [null, undefined, '', 42, {}, [], true]) {
    assert.equal(fn(bad, 'win32'), false, `binPath=${JSON.stringify(bad)}`);
  }
});

await red('W5 spawnViaCmdExe:platform 缺省时取 process.platform', async () => {
  const fn = need(winCmd, 'spawnViaCmdExe');
  assert.equal(fn('C:\\npm\\claude.cmd'), process.platform === 'win32',
    '默认 platform 必须是 process.platform');
});

await red('W6 WIN_CMD_LINE_MAX === 8191(cmd.exe 命令行上限)', async () => {
  assert.equal(winCmd?.WIN_CMD_LINE_MAX, 8191);
});

await red('W7 winCmdLineBudget:非 win32 → {viaCmd:false,length:0,over:false},超长也不判超', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  const max = winCmd?.WIN_CMD_LINE_MAX;
  assert.deepEqual(fn('/usr/local/bin/claude', BG_ARGS('a'.repeat(50_000)), { platform: 'darwin' }),
    { viaCmd: false, length: 0, limit: max, over: false, newline: false });
});

await red('W8 winCmdLineBudget:win32 + .exe → 恒 over:false(Bug 2 回归本体)', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  const max = winCmd?.WIN_CMD_LINE_MAX;
  assert.deepEqual(fn(EXE_BIN, BG_ARGS('a'.repeat(7001)), { platform: 'win32' }),
    { viaCmd: false, length: 0, limit: max, over: false, newline: false }, '.exe 不经 cmd.exe,7001 字符必须能派发');
  assert.equal(fn(EXE_BIN, BG_ARGS('a'.repeat(30_000)), { platform: 'win32' }).over, false);
});

await red('W9 winCmdLineBudget:win32 + 无扩展名 shim / 未解析到路径 → 恒 over:false', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  assert.equal(fn('C:\\npm\\claude', BG_ARGS('a'.repeat(9000)), { platform: 'win32' }).over, false);
  assert.equal(fn('', BG_ARGS('a'.repeat(9000)), { platform: 'win32' }).over, false, '路径解析失败不按长度拒');
});

await red('W10 winCmdLineBudget §2.3 表:空 prompt → length 107,不超', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  const r = fn(CMD_BIN, BG_ARGS(''), { platform: 'win32' });
  assert.equal(r.viaCmd, true);
  assert.equal(r.length, 107);
  assert.equal(r.over, false);
});

await red('W11 winCmdLineBudget §2.3 表:7000 个 a → length 7107,不超(旧守卫在这错拒)', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  const r = fn(CMD_BIN, BG_ARGS('a'.repeat(7000)), { platform: 'win32' });
  assert.equal(r.length, 7107);
  assert.equal(r.over, false);
});

await red('W12 winCmdLineBudget §2.3 表:7001 个 a → length 7108,不超(回归本体)', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  const r = fn(CMD_BIN, BG_ARGS('a'.repeat(7001)), { platform: 'win32' });
  assert.equal(r.length, 7108);
  assert.equal(r.over, false);
});

await red('W13 winCmdLineBudget §2.3 表:6999 个引号 → 展开 14105,判超(旧守卫在这错放)', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  const r = fn(CMD_BIN, BG_ARGS('"'.repeat(6999)), { platform: 'win32' });
  assert.equal(r.length, 14105, '长度必须按引号展开后算,不是 prompt.length');
  assert.equal(r.over, true);
});

await red('W14 winCmdLineBudget §2.3 边界:8085 个 a → 8192 判超;8084 个 → 8191 不超', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  const over = fn(CMD_BIN, BG_ARGS('a'.repeat(8085)), { platform: 'win32' });
  const edge = fn(CMD_BIN, BG_ARGS('a'.repeat(8084)), { platform: 'win32' });
  assert.equal(over.length, 8192); assert.equal(over.over, true);
  assert.equal(edge.length, 8191); assert.equal(edge.over, false, 'length === limit 不算超');
});

await red('W15 winCmdLineBudget:limit 可注入,over 按注入的 max 判', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  const r = fn(CMD_BIN, BG_ARGS('a'.repeat(200)), { platform: 'win32', max: 100 });
  assert.equal(r.limit, 100);
  assert.equal(r.over, true);
});

await red('W16 winCmdLineBudget:args 非数组当 [];脏入参永不抛', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  const base = fn(CMD_BIN, [], { platform: 'win32' }).length;
  for (const bad of [null, undefined, 'a string', 42, {}]) {
    assert.equal(fn(CMD_BIN, bad, { platform: 'win32' }).length, base, `args=${JSON.stringify(bad)} 应当 []`);
  }
  assert.equal(fn(null, null, null).over, false, 'opts 为 null 也不抛');
  assert.equal(fn(undefined, undefined, undefined).over, false);
});

await red('W17 winCmdLineBudget:返回五个键齐全(v3 含 newline),length 是 CreateProcess 收到的整条命令行长度', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  const spec = need(winCmd, 'winCmdSpawnSpec');
  const args = BG_ARGS('say "hi" D:\\');
  const r = fn(CMD_BIN, args, { platform: 'win32' });
  const s = spec(CMD_BIN, args, {});
  assert.deepEqual(Object.keys(r).sort(), ['length', 'limit', 'newline', 'over', 'viaCmd']);
  assert.equal(r.length, [s.file, ...s.args].join(' ').length, 'length 必须等于 [file,...args].join(" ") 的长度');
});

await red('W18 §3 反向用例:claudeExecSpec 与 spawnViaCmdExe 口径故意不同(无扩展名 shim)', async () => {
  const execSpec = need(resolver, 'claudeExecSpec');
  assert.equal(execSpec('C:\\npm\\claude', ['--help'], 'win32').file, 'cmd.exe',
    'claudeExecSpec 必须仍把无扩展名 shim 交给 cmd 按 PATHEXT 解析(r106)');
  const via = need(winCmd, 'spawnViaCmdExe');
  assert.equal(via('C:\\npm\\claude', 'win32'), false, 'spawnViaCmdExe 对同一路径必须是 false');
});

await green('W19 §2.4 不变:winCmdSpawnSpec 形态(cmd.exe /d /s /c + verbatim)未被改动', async () => {
  const spec = need(winCmd, 'winCmdSpawnSpec');
  const s = spec(CMD_BIN, ['--bg', 'x'], {});
  assert.equal(s.file, 'cmd.exe');
  assert.deepEqual(s.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(s.args.length, 4);
  assert.equal(s.opts.windowsVerbatimArguments, true);
});

await green('W20 §2.4 不变:winCmdSpawnSpec 不改写调用方 opts 对象', async () => {
  const spec = need(winCmd, 'winCmdSpawnSpec');
  const opts = { cwd: 'C:\\proj', env: { A: '1' } };
  const snapshot = JSON.parse(JSON.stringify(opts));
  spec(CMD_BIN, ['--bg', 'x'], opts);
  assert.deepEqual(opts, snapshot, '调用方传入的 opts 被就地改写了');
});

await green('W21 §5.2 不变:引号规则两条(尾部反斜杠翻倍 + 内嵌引号前反斜杠翻倍)', async () => {
  const spec = need(winCmd, 'winCmdSpawnSpec');
  const tokenOf = (a) => spec(CMD_BIN, [a], {}).args[3].slice(1, -1).split(' ').slice(1).join(' ');
  assert.equal(tokenOf('D:\\'), '"D:\\\\"', '结尾反斜杠没翻倍');
  assert.equal(tokenOf('a\\"b'), '"a\\\\""b"', '内嵌引号前的反斜杠没翻倍');
});

// ── §2.3 v3(2026-09-06 契约修订):cmd.exe 在换行处把整条命令行截断,轻则丢掉后面的
//    参数,重则后半行被当成第二条命令执行;引号挡不住,只能在派发前量出来并拒掉。
//    newline 与 over 是并列的两个维度:短 prompt 也能因换行被拒,超长 prompt 也可能没换行。

await red('W22 winCmdLineBudget §2.3v3:win32 + .cmd,args 含 \\n / \\r / \\r\\n → newline:true(与长度无关)', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  const lf = fn(CMD_BIN, BG_ARGS('a\nb'), { platform: 'win32' });
  assert.equal(lf.newline, true, 'LF 换行没被量出来 —— cmd.exe 会在这里截断整条命令行');
  assert.equal(lf.over, false, '这条 prompt 很短,不该判超 —— newline 是与长度并列的第二个维度');
  assert.equal(lf.length > 0, true, '有换行时 length 仍按整条命令行照常算');
  assert.equal(fn(CMD_BIN, BG_ARGS('a\rb'), { platform: 'win32' }).newline, true, 'CR 换行没被量出来');
  assert.equal(fn(CMD_BIN, BG_ARGS('a\r\nb'), { platform: 'win32' }).newline, true, 'CRLF 换行没被量出来');
});

await red('W23 winCmdLineBudget §2.3v3 反向:不经 cmd.exe 的装法(.exe / 无扩展名 / 非 win32)带换行 → newline 恒 false', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  assert.equal(fn(EXE_BIN, BG_ARGS('a\nb'), { platform: 'win32' }).newline, false,
    '.exe 直执行不经 cmd.exe,多行 prompt 必须照常派发');
  assert.equal(fn('C:\\npm\\claude', BG_ARGS('a\nb'), { platform: 'win32' }).newline, false, '无扩展名 shim 直执行');
  assert.equal(fn('', BG_ARGS('a\nb'), { platform: 'win32' }).newline, false, '路径没解析出来时不按换行拒');
  assert.equal(fn(CMD_BIN, BG_ARGS('a\nb'), { platform: 'darwin' }).newline, false, 'mac 上换行完全不受限');
  assert.equal(fn('/usr/local/bin/claude', BG_ARGS('第一行\n第二行'), { platform: 'linux' }).newline, false);
});

await red('W24 winCmdLineBudget §2.3v3:没有换行的 prompt(空/空格/引号/反斜杠/超长)→ newline:false', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  assert.equal(fn(CMD_BIN, BG_ARGS(''), { platform: 'win32' }).newline, false, '空 prompt');
  assert.equal(fn(CMD_BIN, BG_ARGS('a b'), { platform: 'win32' }).newline, false, '普通带空格的单行任务');
  assert.equal(fn(CMD_BIN, BG_ARGS('say "hi" D:\\'), { platform: 'win32' }).newline, false, '引号与反斜杠不是换行');
  assert.equal(fn(CMD_BIN, [], { platform: 'win32' }).newline, false, '空 args');
  const long = fn(CMD_BIN, BG_ARGS('a'.repeat(9000)), { platform: 'win32' });
  assert.equal(long.over, true, '9000 个 a 展开后必须判超');
  assert.equal(long.newline, false, '判超与换行互不干扰:超长但无换行时 newline 仍是 false');
});

await red('W25 winCmdLineBudget §2.3v3:换行落在任意元素、任意位置都算(不只看 prompt 那一格)', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  const nl = (args) => fn(CMD_BIN, args, { platform: 'win32' }).newline;
  assert.equal(nl(['--bg\n', 'task', '--permission-mode', 'acceptEdits']), true, '换行在第一个元素');
  assert.equal(nl(['--bg', 'task', '--permission-mode', 'acceptEdits\n']), true, '换行在最后一个元素');
  assert.equal(nl(BG_ARGS('\n开头就是换行')), true, '行首换行');
  assert.equal(nl(BG_ARGS('结尾换行\n')), true, '行尾换行');
  assert.equal(nl(BG_ARGS('第一行\n第二行\n第三行')), true, '多处换行');
});

await red('W26 winCmdLineBudget §2.3v3:脏 args(非数组 / 含非字符串元素)不抛,newline 仍是布尔', async () => {
  const fn = need(winCmd, 'winCmdLineBudget');
  for (const bad of [null, undefined, 'a string', 42, {}, true]) {
    assert.equal(typeof fn(CMD_BIN, bad, { platform: 'win32' }).newline, 'boolean', `args=${JSON.stringify(bad)}`);
  }
  const mixed = fn(CMD_BIN, ['--bg', null, 42, undefined, {}, [], true], { platform: 'win32' });
  assert.equal(typeof mixed.newline, 'boolean', '含非字符串元素时 newline 仍必须是布尔');
  assert.equal(mixed.newline, false, '这些元素转成字符串后都不含换行');
  assert.equal(typeof fn(null, null, null).newline, 'boolean', 'binPath/args/opts 全 null 也不抛');
});

// ══════════════════════════════════════════════════════════════════════════
// G. agents.js 守卫契约(§4)+ 源码锁(§7)—— Express 路由进不了 node,只能读源码文本。
//    所有匹配都在【去注释后】的文本上做。
// ══════════════════════════════════════════════════════════════════════════
console.log('\nG. --bg 守卫接线 + 文案(§4)');

const AG = stripComments(read('server/routes/agents.js'));
// 守卫的"前后顺序"必须在 dispatch 路由体内比,不能拿全文件 indexOf —— writeBgHookSettings
// 的函数定义在文件更靠前的位置,拿它当锚点会让顺序断言永远假红。
const DISPATCH_AT = AG.indexOf('background/dispatch');
const AGD = DISPATCH_AT > -1 ? AG.slice(DISPATCH_AT) : '';
const CHAT = stripComments(read('server/routes/chat.js'));
const WINSRC = stripComments(read('server/utils/win-cmd.js'));
const RESOLVERSRC = stripComments(read('server/utils/claude-resolver.js'));
const PCE = stripComments(read('server/utils/prompt-cache-env.js'));
const claudeSpawnBody = fnBody(CHAT, /(?:function|const)\s+claudeSpawn\b/);
const execSpecBody = fnBody(RESOLVERSRC, /(?:function|const)\s+claudeExecSpec\b/);

await green('G0 四个源码文件都读得到(源码锁的前提)', async () => {
  for (const [n, s] of [['agents.js', AG], ['chat.js', CHAT], ['win-cmd.js', WINSRC],
    ['claude-resolver.js', RESOLVERSRC], ['prompt-cache-env.js', PCE]]) {
    assert.ok(s.length > 0, `${n} 读不到或为空`);
  }
});

await red('G1 §4.1 判定走 winCmdLineBudget,且喂的是 resolveClaude 解析出的路径', async () => {
  assert.ok(AGD.length > 0, 'agents.js 找不到 background/dispatch 路由');
  assert.match(AGD, /winCmdLineBudget\(/, 'dispatch 路由里没调用 winCmdLineBudget');
  const at = AGD.indexOf('winCmdLineBudget(');
  assert.match(AGD.slice(Math.max(0, at - 500), at + 500), /resolveClaude/,
    '长度判定附近没有 resolveClaude —— 守卫必须按本次真实的 claude 路径判,不是按平台');
});

await red('G2 §4.1 文案含展开后的实际长度(插值,不是写死的 7000)', async () => {
  const line = (AG.split('\n').find((l) => l.includes('改用会话内发送')) || '');
  assert.ok(line.length > 0, '找不到含「改用会话内发送」的文案(r111 §5 口径要求保留)');
  assert.match(line, /\$\{/, '文案里没有插值 —— 实际长度必须是算出来的');
  assert.equal(/prompt\.length/.test(line), false, '文案仍在报 prompt.length,而不是展开后的命令行长度');
});

await green('G3 §4.1 文案含上限数字与"上限"字样,且是 400 JSON error 字段', async () => {
  const at = AG.indexOf('改用会话内发送');
  assert.ok(at > -1, '找不到「改用会话内发送」文案');
  const near = AG.slice(Math.max(0, at - 600), at + 300);
  assert.match(near, /上限/, '文案没写上限');
  assert.match(near, /status\(400\)[\s\S]{0,80}json\(\{\s*error/,
    '超长必须 400 + JSON error 字段(前端 AgentMonitorPanel 只读 error)');
});

await red('G4 §4.1 顺序:长度判定发生在 writeBgHookSettings 之前(拒时不留孤儿文件)', async () => {
  assert.ok(AGD.length > 0, 'agents.js 找不到 background/dispatch 路由');
  const budgetAt = AGD.indexOf('winCmdLineBudget(');
  const hookAt = AGD.indexOf('writeBgHookSettings(');
  assert.ok(budgetAt > -1, 'dispatch 路由里没调用 winCmdLineBudget');
  assert.ok(hookAt > -1, 'dispatch 路由里找不到 writeBgHookSettings(');
  assert.ok(budgetAt < hookAt, `长度判定(${budgetAt})排在 writeBgHookSettings(${hookAt})之后`);
});

await red('G5 §7 不得出现:agents.js 里没有字面量 7000', async () => {
  assert.equal(/\b7000\b/.test(AG), false, 'agents.js 仍有 7000 字面量(平台判据必须收进 spawnViaCmdExe)');
});

await green('G6 §7 不得出现:agents.js 不自带 .(cmd|bat) 正则', async () => {
  assert.equal(/\.\(cmd\|bat\)/.test(AG), false, 'agents.js 自带了 cmd/bat 正则');
});

await red('G7 §7 不得出现:agents.js 没有 prompt.length > 形态的长度守卫', async () => {
  assert.equal(/prompt\.length\s*>/.test(AG), false, '仍按原始 prompt.length 判长度');
});

await green('G8 §4.2 不变:prompt 非字符串/空 → 400「prompt 必填」', async () => {
  assert.match(AG, /prompt 必填/);
  assert.match(AG, /typeof prompt !== 'string' \|\| !prompt\.trim\(\)/);
});

await green('G9 §4.2 不变:单词含 &|<>^ 的守卫文案逐字未改', async () => {
  assert.ok(AG.includes('prompt 含不安全字符(单个词里的 & | < > ^);请用正常任务描述'),
    '注入守卫文案被改动');
  assert.match(AG, /!\/\\s\/\.test\(prompt\.trim\(\)\)[\s\S]{0,40}\/\[&\|<>\^\]\/\.test\(prompt\)/,
    '注入守卫判据被改动');
});

await green('G10 §4.2 不变:派发的是 prompt.trim(),白名单/模型参数仍在', async () => {
  assert.match(AG, /prompt\.trim\(\)/);
  assert.match(AG, /BG_PERMISSION_MODES/);
  assert.match(AG, /safeModelArg/);
});

// ── §4.1 v3 / §7-3 v3(2026-09-06):换行守卫。经 cmd.exe 的装法上,含换行的 prompt
//    会被 cmd 截断,后半段还可能被当第二条命令执行 —— 必须在 writeBgHookSettings 之前
//    拒掉(400),而不是偷偷把换行替换成空格(那是改写用户文本)。

await red('G11 §4.1v3/§7-3:dispatch 读了预算结果的 .newline,且换行判定在 writeBgHookSettings 之前', async () => {
  assert.ok(AGD.length > 0, 'agents.js 找不到 background/dispatch 路由');
  assert.match(AGD, /\.newline\b/,
    'dispatch 路由里没有读 winCmdLineBudget 结果的 .newline —— 换行这条根本没被量出来');
  const nlAt = AGD.indexOf('.newline');
  const hookAt = AGD.indexOf('writeBgHookSettings(');
  assert.ok(hookAt > -1, 'dispatch 路由里找不到 writeBgHookSettings(');
  assert.ok(nlAt < hookAt,
    `换行判定(${nlAt})排在 writeBgHookSettings(${hookAt})之后 —— 被拒时会留下孤儿 hook 设置文件`);
});

await red('G12 §4.1v3 文案:含「换行」与「会话内发送」,且是 400 + JSON error 字段', async () => {
  const line = (AG.split('\n').find((l) => l.includes('换行') && l.includes('会话内发送')) || '');
  assert.ok(line.length > 0, '找不到同时含「换行」与「会话内发送」的 400 文案(用户看不懂为什么被拒)');
  const at = AG.indexOf(line);
  const near = AG.slice(Math.max(0, at - 600), at + 300);
  assert.match(near, /status\(400\)[\s\S]{0,120}json\(\{\s*error/,
    '换行被拒必须是 400 + JSON error 字段(前端 AgentMonitorPanel 只读 error)');
});

// G13 的作用域说明:整文件锁「不得出现 [\r\n]」不可用 —— agents.js 别处早就有与本守卫
// 无关的 [\r\n] 用法(2026-09-06 实测 3 处,HEAD 上就有,那时还没有换行守卫),整文件锁
// 会逼开发去动无关代码。所以拆成两把:字符类锁只管【守卫区】(dispatch 路由起点 →
// writeBgHookSettings 之间,换行判定必须落在这里),谓词形态锁管全文件。
await green('G13 §7-3v3 不得出现:守卫区不自带换行正则/换行字面量(判据必须收在 winCmdLineBudget)', async () => {
  assert.ok(AGD.length > 0, 'agents.js 找不到 background/dispatch 路由');
  const hookAt = AGD.indexOf('writeBgHookSettings(');
  assert.ok(hookAt > -1, 'dispatch 路由里找不到 writeBgHookSettings(');
  const guard = AGD.slice(0, hookAt);        // 换行判定按 §4.1v3 必须落在这一段里
  assert.equal(/\[(?!\^)[^\]\n]*\\[rn][^\]\n]*\]/.test(guard), false,
    '守卫区出现了 [\\r\\n] 这类换行字符类 —— 判据必须来自 winCmdLineBudget 的 newline 字段');
  assert.equal(/['"`]\\[rn]['"`]/.test(guard), false,
    "守卫区出现了 '\\n' 字面量(自己 includes/split 找换行)—— 判据必须收在 winCmdLineBudget");
  assert.equal(/\/[^/\n]*\\[rn][^/\n]*\/[gimsuy]*\s*\.test\(/.test(AG), false,
    'agents.js 里出现了 /…\\n…/.test( 形态的换行判定 —— 又是一处平台判据分叉');
});

console.log('\nL. §7 源码锁');

await red('L1 §7 必须出现:win-cmd.js 导出 spawnViaCmdExe / winCmdLineBudget / WIN_CMD_LINE_MAX', async () => {
  for (const n of ['spawnViaCmdExe', 'winCmdLineBudget', 'WIN_CMD_LINE_MAX']) {
    assert.match(WINSRC, new RegExp(`export[\\s\\S]{0,60}\\b${n}\\b`), `win-cmd.js 没导出 ${n}`);
  }
});

await red('L2 §7 必须出现:chat.js claudeSpawn 体内调 spawnViaCmdExe(', async () => {
  assert.ok(claudeSpawnBody.length > 0, 'chat.js 切不出 claudeSpawn 函数体');
  assert.match(claudeSpawnBody, /spawnViaCmdExe\(/, 'claudeSpawn 没改用 spawnViaCmdExe 判分支');
});

await green('L3 §7 必须出现:claudeSpawn 的 .cmd 分支体一字不改(winCmdSpawnSpec + spawn 三件套)', async () => {
  assert.ok(claudeSpawnBody.length > 0, 'chat.js 切不出 claudeSpawn 函数体');
  assert.ok(claudeSpawnBody.includes('const s = winCmdSpawnSpec(resolved, finalArgs, opts);'),
    '.cmd 分支体被改动');
  assert.ok(claudeSpawnBody.includes('spawn(s.file, s.args, s.opts)'), '.cmd 分支的 spawn 调用被改动');
});

await red('L4 §7 不得出现:claudeSpawn 体内不再有裸的 /\\.(cmd|bat)$/i 正则', async () => {
  assert.ok(claudeSpawnBody.length > 0, 'chat.js 切不出 claudeSpawn 函数体');
  assert.equal(/\\\.\(cmd\|bat\)\$/.test(claudeSpawnBody), false, '平台判据没收进 spawnViaCmdExe');
});

await red('L5 §7 必须出现:prompt-cache-env.js 导出 HELP_MISS_TTL_MS', async () => {
  assert.match(PCE, /export[\s\S]{0,40}\bHELP_MISS_TTL_MS\b/);
});

await red('L6 §7 必须出现:chat.js 有不 await 的 primeHelpCache( 恢复触发点', async () => {
  assert.match(CHAT, /primeHelpCache\(/, 'chat.js 没有恢复触发点');
  assert.equal(/await\s+primeHelpCache\(/.test(CHAT), false, 'primeHelpCache 被 await 了(会阻塞发送)');
});

await red('L7 §1.7 恢复触发点与 snapshotFlagOn 在同一处(±1500 字符内)', async () => {
  const snapAt = CHAT.indexOf('snapshotFlagOn(claudePath');
  const primeAt = CHAT.indexOf('primeHelpCache(');
  assert.ok(snapAt > -1, 'chat.js 找不到 snapshotFlagOn(claudePath …) 调用点');
  assert.ok(primeAt > -1, 'chat.js 找不到 primeHelpCache(');
  assert.ok(Math.abs(primeAt - snapAt) < 1500, `两者相隔 ${Math.abs(primeAt - snapAt)} 字符,不在同一作用域`);
});

await green('L8 §7 不得出现:claude-resolver.js 的 claudeExecSpec 内不得引入 spawnViaCmdExe', async () => {
  assert.ok(execSpecBody.length > 0, 'claude-resolver.js 切不出 claudeExecSpec 函数体');
  assert.equal(/spawnViaCmdExe/.test(execSpecBody), false, '两者口径故意不同,禁止统一(r106)');
  assert.match(execSpecBody, /!\/\\\.exe\$\/i/, 'claudeExecSpec 必须仍是 !/\\.exe$/i 口径');
});

await green('L9 §7 不得出现:prompt-cache-env.js 里没有把空串写进正文表的形态', async () => {
  assert.equal(/_helpCache\.set\(\s*key\s*,\s*''\s*\)/.test(PCE), false, '空串仍会被写进正文表');
  assert.equal(/_helpCache\.set\(\s*key\s*,\s*""\s*\)/.test(PCE), false, '空串仍会被写进正文表');
});

await red('L10 §7 不得出现:primeHelpCache 入口的 _helpCache.has(', async () => {
  const body = fnBody(PCE, /(?:export\s+)?(?:async\s+)?(?:function|const)\s+primeHelpCache\b/);
  assert.ok(body.length > 0, 'prompt-cache-env.js 切不出 primeHelpCache 函数体');
  assert.equal(/_helpCache\.has\(/.test(body), false,
    'primeHelpCache 仍用 has 短路 —— 空串会被当成"已探过",正文永远覆盖不进去(本轮 bug 本体)');
});

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n—— check-r113-server: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
console.log(`   [修前应红] ${tally.RED.pass + tally.RED.fail} 条(现在绿 ${tally.RED.pass} / 红 ${tally.RED.fail})`);
console.log(`   [修前应绿] ${tally.GREEN.pass + tally.GREEN.fail} 条(现在绿 ${tally.GREEN.pass} / 红 ${tally.GREEN.fail})`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
}
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(FAILS ? 1 : 0);
