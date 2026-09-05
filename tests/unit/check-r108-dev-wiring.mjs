#!/usr/bin/env node
// r108 开发自测(白盒):补 tests/unit/check-r108-windows-review.mjs(黑盒验收)明确没覆盖的
// 三块 —— 见 .devflow/TEST-PLAN-r108.md「明确没覆盖的」第 4/5/6 条:
//   ④ INTERFACE §2 的 server/index.js 启动挂点(要起后端才能黑盒验)
//   ⑤ INTERFACE §3.2 的 resolveMcpCommandWin 本体与缓存 key 拼法(mac 上恒早退,黑盒摸不到)
//   ⑥ INTERFACE §3.4 的 winCmdSpawnSpec 是否真被 spawnMcpCommand 用上
// 这三处在 mac 上都无法用公开接口跑到(要么要起服务、要么被 process.platform 门控),
// 所以用【源码结构断言 + 子进程行为验证】兜底,而不是假装能黑盒测。
//
// Run: node tests/unit/check-r108-dev-wiring.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const mcpSrc = read('server/routes/mcp.js');
const indexSrc = read('server/index.js');
const resolverSrc = read('server/utils/claude-resolver.js');

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fails.push(name); console.log(`  FAIL ${name}\n       ${String(e?.message || e).split('\n').slice(0, 5).join('\n       ')}`); }
}

// ── ⑥ winCmdSpawnSpec 确实被 spawnMcpCommand 用上 ────────────────────────
// check-r106-dev-mcp-command.mjs ⑤ 锁的是旧写法 spawn('cmd.exe', ['/c', resolved, …]),
// INTERFACE §3.4 明令换掉它,那条断言必然失效;这里把【新】接线形态锁住,别让 viaCmd
// 分支哪天又退回裸 ['/c', …](那正是"用户名带空格 → 'C:\Program' 不是内部或外部命令")。
console.log('\n[§3.4] spawnMcpCommand 接线');

// 只看代码行(去掉注释),否则注释里引用的旧写法会把断言带偏。
const codeOnly = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const spawnBody = (() => {
  const from = mcpSrc.indexOf('async function spawnMcpCommand');
  const to = mcpSrc.indexOf('return spawn(resolved, args, opts);', from);
  return codeOnly(mcpSrc.slice(from, to + 40));
})();

check('W1 viaCmd 分支走 winCmdSpawnSpec,不再手拼 cmd.exe /c', () => {
  assert.ok(/winCmdSpawnSpec\(resolved, args, opts\)/.test(spawnBody), 'viaCmd 分支没调用 winCmdSpawnSpec');
  assert.ok(/spawn\(s\.file, s\.args, s\.opts\)/.test(spawnBody), '没有把 spec 三件套交给 spawn');
  assert.ok(!/spawn\('cmd\.exe', \['\/c'/.test(spawnBody), '旧的裸 cmd.exe /c 拼法还在');
});

check('W2 非 win32 与 .exe 分支未被波及(仍是直接 spawn)', () => {
  assert.ok(/if \(process\.platform !== 'win32'\) return spawn\(command, args, opts\);/.test(spawnBody), '非 win32 直通被改动');
  assert.ok(/\n  return spawn\(resolved, args, opts\);/.test(spawnBody), '.exe 分支直通被改动');
});

check('W3 windowsVerbatimArguments 只由 winCmdSpawnSpec 一处产生(r110 搬到 utils/win-cmd.js)', () => {
  const winCmdSrc = read('server/utils/win-cmd.js');
  const hits = codeOnly(winCmdSrc).match(/windowsVerbatimArguments/g) || [];
  assert.equal(hits.length, 1, `windowsVerbatimArguments 在 win-cmd.js 代码里出现 ${hits.length} 次,应只在 winCmdSpawnSpec 里`);
  assert.equal((codeOnly(mcpSrc).match(/windowsVerbatimArguments/g) || []).length, 0, 'mcp.js 代码里不该再自己拼 windowsVerbatimArguments');
  assert.match(mcpSrc, /winCmdSpawnSpec/, 'mcp.js 应从 win-cmd.js 导入并 re-export winCmdSpawnSpec');
});

// ── ⑤ resolveMcpCommandWin 缓存 key 拼法 ─────────────────────────────────
// mac 上该函数第一行就 return null(平台门控),黑盒永远走不到缓存逻辑。
console.log('\n[§3.2] resolveMcpCommandWin 30s 缓存');

const winBody = mcpSrc.slice(mcpSrc.indexOf('async function resolveMcpCommandWin'), mcpSrc.indexOf('/**\n * 裸命令名'));

check('W4 key 同时计入 command 与 env 的 PATH/Path', () => {
  const m = winBody.match(/const key = ([^\n]+);/);
  assert.ok(m, '没找到 key 拼装语句');
  assert.ok(/\$\{command\}/.test(m[1]), `key 未计入 command:${m[1]}`);
  assert.ok(/env\?\.PATH \?\? env\?\.Path/.test(m[1]), `key 未按 PATH ?? Path 取值:${m[1]}`);
});

check('W5 key 语义:换命令/换 PATH 都必须错开,PATH 缺失回落 Path', () => {
  // 与源码同一条公式(由 W4 钉住其在源码中确实是这条),这里验它的碰撞性质。
  const keyOf = (command, env) => `${command}\0${String(env?.PATH ?? env?.Path ?? '')}`;
  const P1 = 'C:\\a;C:\\b';
  const P2 = 'C:\\a;C:\\c';
  assert.notEqual(keyOf('npx', { PATH: P1 }), keyOf('uvx', { PATH: P1 }), '不同命令不能共用一条缓存');
  assert.notEqual(keyOf('npx', { PATH: P1 }), keyOf('npx', { PATH: P2 }), '不同 PATH 不能共用(cfg.env 会覆盖 PATH)');
  assert.equal(keyOf('npx', { PATH: P1 }), keyOf('npx', { PATH: P1 }), '同命令同 PATH 必须命中同一条');
  assert.equal(keyOf('npx', { Path: P1 }), keyOf('npx', { PATH: P1 }), 'Windows 的 Path 大小写变体应回落到同一条');
  assert.equal(keyOf('npx', null), keyOf('npx', {}), 'env 缺失/为空视作同一条,不抛');
  // \0 分隔:命令名里不可能有 NUL,故 'a' + PATH 'b' 与 'ab' + PATH '' 不会撞车
  assert.notEqual(keyOf('a', { PATH: 'b' }), keyOf('ab', { PATH: '' }));
});

check('W6 miss 后每条出口都写缓存(null 也缓存,那是最贵的路径)', () => {
  const afterMiss = winBody.slice(winBody.indexOf('const cached = _winCmdCache.get(key)'));
  assert.ok(/_winCmdCache\.set\(key, out\);/.test(afterMiss), '解析完没有写回缓存');
  // 命中检查之后到写缓存之前,不许再有 return —— 否则那条出口的结果永远不进缓存。
  const between = afterMiss.slice(afterMiss.indexOf('\n', afterMiss.indexOf('if (cached !== undefined) return cached;')), afterMiss.indexOf('_winCmdCache.set(key, out);'));
  assert.equal(/\breturn\b/.test(between), false, `miss 路径中途还有提前 return,结果会漏缓存:${between.trim().slice(0, 120)}`);
});

check('W7 命中判据是 !== undefined(不能用 truthy,否则缓存的 null 每次都当没缓存)', () => {
  assert.ok(/if \(cached !== undefined\) return cached;/.test(winBody), '命中判据写法不对');
});

check('W8 TTL 是 30s,且用的是 makeTtlCache', () => {
  assert.ok(/const _winCmdCache = makeTtlCache\(30_000\);/.test(mcpSrc), '缓存实例不是 makeTtlCache(30_000)');
});

check('W9 absCommandHint 的探测套了 1.5s 超时兜底', () => {
  const body = mcpSrc.slice(mcpSrc.indexOf('async function absCommandHint'), mcpSrc.indexOf('async function probeStdioStderr'));
  assert.ok(/withTimeout\(resolveMcpCommandWin\(command\), 1500,/.test(body), 'absCommandHint 没套 withTimeout(…, 1500, …)');
});

// ── ④ server/index.js 启动挂点 ───────────────────────────────────────────
// 要起后端才能黑盒验,本批不起服务;改为锁住挂点的结构性质。
console.log('\n[§2] server/index.js 启动预热挂点');

const listenBody = indexSrc.slice(indexSrc.indexOf('server.listen(PORT, HOST, () => {'));
const primeBlock = listenBody.slice(listenBody.indexOf('primeHelpCache') - 800, listenBody.indexOf('r13-p2-6'));

check('W10 挂点在 listen 回调内,且对两条路径去重后各预热一次', () => {
  assert.ok(listenBody.includes('primeHelpCache'), 'primeHelpCache 不在 listen 回调里');
  assert.ok(/new Set\(\[resolver\.resolveSdkClaude\(\), resolver\.resolveClaude\(\)\?\.path\]\.filter\(Boolean\)\)/.test(primeBlock),
    '没有对 resolveSdkClaude() 与 resolveClaude()?.path 去重 + 过滤空值');
});

check('W11 不阻塞启动:整块是不被 await 的 IIFE,且带 .catch 吞异常', () => {
  assert.ok(/\)\(\)\.catch\(\(e\) => console\.error/.test(primeBlock), 'IIFE 尾部没有 .catch 兜底');
  assert.equal(/^\s*await \(async \(\)/m.test(primeBlock), false, '启动挂点不能被 await(会阻塞 listen 回调)');
  assert.ok(/await primeHelpCache\(p\)\.catch\(\(\) => false\)/.test(primeBlock), '单条预热没有各自吞异常');
});

check('W11b 先 await 异步解析再取同步结果(Windows 首解析不压在事件循环上)', () => {
  assert.ok(/await resolver\.resolveClaudeAsync\(\)\.catch/.test(primeBlock), '没有先走 resolveClaudeAsync 热缓存');
  assert.ok(primeBlock.indexOf('resolveClaudeAsync') < primeBlock.indexOf('resolver.resolveSdkClaude()'),
    'resolveClaudeAsync 必须排在同步 resolveSdkClaude/resolveClaude 之前,否则热缓存无意义');
});

check('W11c 两条路径并行预热(不是串行 await)', () => {
  assert.ok(/await Promise\.all\(paths\.map\(async \(p\) =>/.test(primeBlock), '两条路径没并行预热');
  assert.equal(/for \(const p of paths\)/.test(primeBlock), false, '还在串行 for-await');
});

check('W12 只打一行结果到 stderr,不打 env/密钥', () => {
  assert.ok(/console\.error\(`\[prompt-cache\] help cache primed: \$\{p\} → /.test(primeBlock),
    '结果日志没走 console.error(装机版 stdout 被丢弃)');
  assert.equal(/process\.env|ANTHROPIC|TOKEN|KEY/.test(primeBlock), false, '启动预热日志里出现了环境变量/密钥字样');
});

check('W13 去重语义:同一路径只预热一次,空值全跳过', () => {
  // 与源码同一条表达式(由 W10 钉住);验它在 Windows 两条 key / mac 同一条 key / 全空三种形态下的行为。
  const dedup = (sdk, cli) => [...new Set([sdk, cli].filter(Boolean))];
  assert.deepEqual(dedup('C:\\p\\bin\\claude.exe', 'C:\\p\\claude.cmd'), ['C:\\p\\bin\\claude.exe', 'C:\\p\\claude.cmd'], 'Windows 上两条 key 都要热');
  assert.deepEqual(dedup('/usr/local/bin/claude', '/usr/local/bin/claude'), ['/usr/local/bin/claude'], 'mac 上两者相同,只该热一次');
  assert.deepEqual(dedup(null, undefined), [], '全空则一次都不 spawn');
  assert.deepEqual(dedup(null, '/x/claude'), ['/x/claude'], 'sdk 为空(回落自带 CLI)仍热 CLI 那条');
});

// ── 子进程行为验证:预热永不 reject、不留常驻句柄 ─────────────────────────
console.log('\n[§1.2] primeHelpCache 子进程行为');

function runNode(code, timeoutMs = 15000) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: timeoutMs });
  return { ...r, timedOut: !!(r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM' };
}
const CACHE_URL = JSON.stringify(pathToFileURL(join(ROOT, 'server/utils/prompt-cache-env.js')).href);

check('W14 默认探测打不到的路径:不 reject、不挂住进程(启动挂点靠这个才敢 fire-and-forget)', () => {
  const code = `
    const m = await import(${CACHE_URL});
    const r = await m.primeHelpCache('/nonexistent-r108/claude');
    process.stdout.write(JSON.stringify({ r, t: typeof r }));
  `;
  const out = runNode(code);
  assert.equal(out.timedOut, false, '子进程被默认探测的 8s timer 挂住了');
  assert.equal(out.status, 0, `退出码 ${out.status}: ${String(out.stderr).slice(0, 200)}`);
  assert.deepEqual(JSON.parse(String(out.stdout).trim()), { r: false, t: 'boolean' });
});

check('W15 同步兜底探测超时是 2000(不是 5000)', () => {
  const src = read('server/utils/prompt-cache-env.js');
  const m = src.match(/execFileSync\(spec\.file, spec\.args, \{ timeout: (\d+)/);
  assert.ok(m, '没找到同步探测');
  assert.equal(m[1], '2000', `同步 execFileSync timeout 仍是 ${m[1]}`);
});

check('W15b 竞态正向:同步兜底探到的正文,不许被随后 resolve 的空串覆盖', () => {
  // 启动预热对 80MB exe 跑 --help(最长 8s),期间用户打开设置页 → cliSupportsFlag 同步
  // 探到正文 → 预热超时 resolve '' → 若无条件 set 就把正文冲掉,所有 flag 门控静默失效。
  const code = `
    const m = await import(${CACHE_URL});
    const P = 'C:\\\\race\\\\claude.exe';
    let release;
    const gate = new Promise((r) => { release = r; });
    const priming = m.primeHelpCache(P, () => gate);          // 预热挂起中
    const sync = m.cliSupportsFlag(P, '--system-prompt-snapshot', () => '  --system-prompt-snapshot <mode>');
    release('');                                              // 预热随后超时,拿到空串
    const primed = await priming;
    const after = m.cliSupportsFlag(P, '--system-prompt-snapshot', () => { throw new Error('不该再同步探测'); });
    process.stdout.write(JSON.stringify({ sync, after, primed }));
  `;
  const out = runNode(code);
  assert.equal(out.status, 0, `退出码 ${out.status}: ${String(out.stderr).slice(0, 300)}`);
  const got = JSON.parse(String(out.stdout).trim());
  assert.equal(got.sync, true, '同步兜底本应探到正文');
  assert.equal(got.after, true, '预热的空串把同步探到的正文覆盖掉了(竞态未修)');
  assert.equal(got.primed, true, '缓存里已有正文时,预热应 resolve true');
});

check('W15c 竞态反向(INTERFACE §8):同步兜底先写空串,预热拿到的正文必须能覆盖它', () => {
  // 反向交错:同步兜底 2s 超时先写 '',随后 8s 预热探到真 help 正文。复查若用 has 就会
  // 把正文丢掉 —— flag 门控照样静默失效到重启。口径是「只保留正文」,不是「先到先得」。
  const code = `
    const m = await import(${CACHE_URL});
    const P = 'C:\\\\race2\\\\claude.exe';
    let release;
    const gate = new Promise((r) => { release = r; });
    const priming = m.primeHelpCache(P, () => gate);
    const sync = m.cliSupportsFlag(P, '--system-prompt-snapshot', () => '');   // 同步探测失败 → 写 ''
    release('  --system-prompt-snapshot <mode>');                               // 预热随后探到正文
    const primed = await priming;
    const after = m.cliSupportsFlag(P, '--system-prompt-snapshot', () => { throw new Error('不该再同步探测'); });
    process.stdout.write(JSON.stringify({ sync, after, primed }));
  `;
  const out = runNode(code);
  assert.equal(out.status, 0, `退出码 ${out.status}: ${String(out.stderr).slice(0, 300)}`);
  const got = JSON.parse(String(out.stdout).trim());
  assert.equal(got.sync, false, '同步探测失败时本应按"不支持"处理');
  assert.equal(got.after, true, '预热探到的正文被空串挡下丢弃了(复查用了 has 而不是 get)');
  assert.equal(got.primed, true, '预热成功写入正文应 resolve true');
});

check('W15d 复查用 get 不用 has', () => {
  const src = read('server/utils/prompt-cache-env.js');
  const body = src.slice(src.indexOf('export async function primeHelpCache'));
  assert.ok(/if \(_helpCache\.get\(key\)\) return true;\s*\n\s*_helpCache\.set\(key, help\);/.test(body),
    'await 之后的复查不是 `if (_helpCache.get(key)) return true;`(用 has 会丢掉反向交错的正文)');
});

check('W16 预热与同步探测共用同一张正文表 _helpCache(否则预热白热)', () => {
  const src = read('server/utils/prompt-cache-env.js');
  // r113 契约 v2:失败记录与在飞标记是独立容器,文件里的 Map/Set 不再只有一张 ——
  // 原来的「new Map() 恰好 1 张」计数锁已失效。改锁语义:正文表只声明一处,
  // 且 cliSupportsFlag 与 primeHelpCache 两个函数体都直接读写它。
  const decls = src.match(/(?:const|let|var)\s+_helpCache\s*=/g) || [];
  assert.equal(decls.length, 1, `_helpCache 被声明了 ${decls.length} 处,正文表必须只有一张`);
  const bodyOf = (name) => {
    const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`).exec(src);
    if (!m) return '';
    let i = src.indexOf('(', m.index);
    if (i < 0) return '';
    let d = 0;
    for (; i < src.length; i++) {
      if (src[i] === '(') d++;
      else if (src[i] === ')') { d--; if (d === 0) { i++; break; } }
    }
    const open = src.indexOf('{', i);
    if (open < 0) return '';
    d = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') { d--; if (d === 0) return src.slice(open, j + 1); }
    }
    return '';
  };
  for (const n of ['cliSupportsFlag', 'primeHelpCache']) {
    const body = bodyOf(n);
    assert.ok(body.length > 0, `切不出 ${n} 的函数体(不是 function 声明?)`);
    assert.ok(/_helpCache\./.test(body), `${n} 没有直接读写 _helpCache —— 两者必须共用同一张正文表`);
  }
  assert.ok(/export async function primeHelpCache[\s\S]*?_helpCache\.set\(key, help\);/.test(src), 'primeHelpCache 没写进 _helpCache');
});

// ── §4 claude-resolver 侧的接线 ──────────────────────────────────────────
console.log('\n[§4] claude-resolver 接线');

check('W17 splitWinPathList 被 sync/async 两处 live PATH 解析共用', () => {
  assert.ok(/export function splitWinPathList/.test(resolverSrc), '没有导出 splitWinPathList');
  const uses = resolverSrc.match(/splitWinPathList\(/g) || [];
  assert.ok(uses.length >= 3, `splitWinPathList 只出现 ${uses.length} 次(定义 + 两处调用应 ≥3)`);
  assert.equal(/out\.split\(';'\)\.map\(\(s\) => s\.trim\(\)\)\.filter\(Boolean\)/.test(resolverSrc), false,
    '还有没换成 splitWinPathList 的裸 split(\';\') 解析(那条不会去引号)');
});

check('W18 体积下限:minExeBytes=0 时完全不 stat(注入 fs 的布局根本没落盘)', () => {
  assert.ok(/minExeBytes = readFn \? 0 : 5_000_000/.test(resolverSrc), '默认下限不是「注入 readFileSync 则 0,否则 5MB」');
  assert.ok(/if \(minExeBytes > 0\) \{\s*try \{/.test(resolverSrc), 'stat 没被 minExeBytes>0 门控');
  assert.ok(/const size = statFn\(binTarget\)\.size;/.test(resolverSrc), '没有取 statFn(binTarget).size');
  assert.ok(/\} catch \{ return null; \}/.test(resolverSrc), 'statSync 抛错没按不可用处理');
  assert.ok(/console\.error\(`\[claude-resolver\] 包内 claude\.exe 仅 \$\{size\} 字节/.test(resolverSrc),
    '体积不达标回落时没留日志(静默回落最难排查)');
  assert.ok(/if \(!_smallExeLogged\.has\(binTarget\)\) \{\s*_smallExeLogged\.add\(binTarget\);/.test(resolverSrc),
    '回落日志没按 binTarget 去重(这函数在每次聊天热路径上,坏安装会每条消息刷一行)');
  assert.equal(/process\.env|ANTHROPIC|TOKEN|KEY/.test(resolverSrc.slice(resolverSrc.indexOf('const size = statFn'), resolverSrc.indexOf('return binTarget;'))), false,
    '回落日志里出现了环境变量/密钥字样');
});

check('W19 体积判定排在 PE 头判定之后(体积不能绕过 MZ 判定)', () => {
  const body = resolverSrc.slice(resolverSrc.indexOf('export function resolveSdkClaudeFrom'), resolverSrc.indexOf('function isWinPeFile'));
  assert.ok(body.indexOf('isWinPeFile(binTarget, readFn)') < body.indexOf('statFn(binTarget).size'), 'PE 头判定必须先于体积判定');
});

check('W20 logSdkClaudeOnce:路径行同步落,版本行仍异步(不阻塞事件循环)', () => {
  const body = resolverSrc.slice(resolverSrc.indexOf('export function logSdkClaudeOnce'), resolverSrc.indexOf('claudeCommand 的纯函数内核'));
  assert.ok(/log = console\.error/.test(body), '默认 logger 不是 console.error');
  assert.ok(body.indexOf('log(`[chat] sdk claude: ${key}`)') < body.indexOf('safeExecAsync'), '路径行没有先于 --version 探测同步落盘');
  assert.ok(/safeExecAsync\(spec\.file, spec\.args, 8000, spec\.opts\)/.test(body), '--version 探测被改成同步了(会阻塞事件循环)'); // r110:透传 spec.opts
  assert.equal(/execFileSync/.test(body), false, 'logSdkClaudeOnce 里不该出现同步 spawn');
});

console.log(`\n${pass} 通过 / ${fails.length} 失败`);
if (fails.length) { console.log(`失败:\n  - ${fails.join('\n  - ')}`); process.exit(1); }
console.log('✅ r108 开发自测全过');
