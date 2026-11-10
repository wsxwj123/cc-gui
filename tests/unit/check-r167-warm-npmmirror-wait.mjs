#!/usr/bin/env node
// r167:发版 CI 的「Warm npmmirror」改成「等官方源生效、再催国内镜像同步,并盯到镜像追平」。
//
// 背景(0.2.458 实测):publish-npm 发完三个包就立刻催镜像同步,可大分包在官方源上要 10–60 分钟才可见
// (0.2.454:darwin 晚 10 分钟、win32 晚 55 分钟;0.2.458:两个都晚整整 60 分钟)。催得太早,镜像只拿到当时已可见的主包,
// 两个平台分包缺失 → 走镜像装 npm 渠道的用户报「没找到当前平台的安装包」,要人手动补同步(0.2.458 就是事后补的)。
// 修法:预热逻辑拆成 scripts/warm-npmmirror.sh,每 60 秒一轮,对每个包:镜像已有 → 完成;官方源已有才催;
// 催过 5 分钟还没追上再催;催的请求本身失败不算催过;总上限 2 小时;超时打印缺哪些、退出 1(步骤 continue-on-error,不弄红任务)。
//
// 锁的事:
//   静态(读工作流与脚本)
//     W1 工作流「Warm npmmirror」步骤:排在「Publish to npm」之后;if 守卫、continue-on-error: true 不变;run 调脚本;
//        步骤级 env 给镜像地址;有 timeout-minutes。
//     W2 脚本存在、bash 开头、只用 bash 3.2 就有的写法(开发机 macOS 自带 3.2,单测要在它上面真跑;CI 的 ubuntu 是 bash 5)。
//     W3 脚本默认总等待上限小于步骤 timeout-minutes(留 ≥ 10 分钟余量):否则步骤先被强杀,看不到脚本自己的超时说明。
//   行为(假 curl / sleep / date 搭「假世界」,假时钟,真跑脚本,不碰网络;假件在 tests/unit/r167-helpers/fake-bin)
//     B1  分包 20 分半钟后才在官方源可见(不对齐轮询格点):此前一次都不催;一可见(下一轮)就催;镜像追平即停;不拖沓。
//     B2  镜像慢(催后 13 分钟才追平):每个包隔 5 分钟补催一次,追平后不再催。
//     B3  官方源始终没有:到上限放弃(退出非 0),一次都没催,报出缺哪些包。
//     B4  只有主包可见:只催主包,分包不催;到上限放弃。
//     B5  镜像开局就有三个包:一次不催、不等待,立刻成功。
//     B6  前几次请求超时:不中断,恢复后照常催、照常收尾。
//     B7  催同步的请求本身失败(超时):不算催过,下一轮(≤ 1 个间隔)就重试。
//     B7b 催同步收到的不是成功响应(HTTP 5xx / 代理错误页:curl 退出码为 0,但响应体没有 "ok":true):同样不算催过,下一轮重试。
//         (真实网络实测发现:没加 --fail 时 HTTP 502 的 curl 退出码也是 0,只看退出码会把它记成「催过」,干等 5 分钟。)
//     B8  包页面判据只认 versions 表:官方源 dist-tags / time 先提到新版本但 versions 里还没有,不算可见;带缩进的 JSON 也认。
//     B9  镜像对没同步过的包返回 404:照常催、追平后成功。
//     B10 参数错误(找不到 npm-packages.json / 包列表为空):立刻报错退出,不联网、不等待。
//     B11 请求形态:PUT 用 %2F、包页面 GET 用 %2f(线上验证过的写法);默认地址正确;两个环境变量名脚本认。
//
// 跑法:node tests/unit/check-r167-warm-npmmirror-wait.mjs        (保留现场排查:R167_KEEP=1)
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'warm-npmmirror.sh');
const FAKE_BIN = join(HERE, 'r167-helpers', 'fake-bin');
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash'; // macOS:3.2.x;Linux:5.x
const report = makeReport('check-r167-warm-npmmirror-wait');

// 统一成 \n:Windows 上检出的文件可能是 CRLF
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const stripComments = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

// ───────────────────────── 静态:工作流与脚本 ─────────────────────────
const yml = read(join(ROOT, '.github', 'workflows', 'tauri.yml'));

function jobText(name) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i]) || (/^\S/.test(lines[i]) && !/^\s*#/.test(lines[i]))) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}
const stepsOf = (job) => job.split(/^(?=      - )/m).filter((p) => /^      - /.test(p));
const stepName = (s) => (s.match(/^\s*-\s+name:\s*(.+)$/m) || [])[1]?.trim() ?? '';

const publishNpm = jobText('publish-npm');
assert.ok(publishNpm, '前置自证:工作流里应有 publish-npm 任务');
const npmSteps = stepsOf(publishNpm);
assert.ok(npmSteps.length >= 6, `前置自证:publish-npm 任务应切出 ≥ 6 个步骤(实际 ${npmSteps.length})`);
const warmStep = () => npmSteps.find((s) => stepName(s) === 'Warm npmmirror');

await report.check('W1', '工作流「Warm npmmirror」:排在发布之后,调用脚本,守卫 / continue-on-error / 超时 / 镜像地址齐全', 'red', () => {
  const names = npmSteps.map(stepName);
  const iWarm = names.indexOf('Warm npmmirror');
  const iPub = names.indexOf('Publish to npm');
  assert.ok(iPub >= 0, '应有「Publish to npm」步骤');
  assert.ok(iWarm > iPub, `「Warm npmmirror」应排在「Publish to npm」之后(下标 ${iWarm} vs ${iPub})`);
  const s = stripComments(npmSteps[iWarm]);
  assert.ok(/^\s+if:\s*steps\.npmtoken\.outputs\.has == 'true'\s*$/m.test(s), '应保留 if: steps.npmtoken.outputs.has == \'true\' 守卫(没配令牌就跳过)');
  assert.ok(/^\s+continue-on-error:\s*true\s*$/m.test(s), '必须 continue-on-error: true —— 包已经发出去了,镜像迟早会同步,预热失败不许弄红任务');
  assert.ok(/^\s+run:\s*bash scripts\/warm-npmmirror\.sh\s*$/m.test(s), 'run 应是 `bash scripts/warm-npmmirror.sh`');
  assert.ok(/^ {8}env:\s*$/m.test(s) && /^ {10}NPMMIRROR_REGISTRY:\s*https:\/\/registry\.npmmirror\.com\s*$/m.test(s), '步骤级 env 里应给出 NPMMIRROR_REGISTRY: https://registry.npmmirror.com');
  assert.ok(/^\s+timeout-minutes:\s*\d+\s*$/m.test(s), '应有 timeout-minutes(脚本要等很久,给它一个强杀兜底)');
});

await report.check('W2', '脚本 scripts/warm-npmmirror.sh:存在、bash 开头、只用 bash 3.2 就有的写法', 'red', () => {
  assert.ok(existsSync(SCRIPT), '缺少脚本 scripts/warm-npmmirror.sh');
  const t = read(SCRIPT);
  assert.ok(t.startsWith('#!/usr/bin/env bash\n'), '首行应是 #!/usr/bin/env bash');
  const body = stripComments(t);
  const bash4 = [
    [/\b(declare|typeset)\s+-A\b/, '关联数组 declare -A'],
    [/\b(mapfile|readarray)\b/, 'mapfile / readarray'],
    [/\$\{[A-Za-z_][A-Za-z0-9_]*(,,|\^\^)/, '${var,,} / ${var^^} 大小写转换'],
    [/\|&/, '|& 管道合并 stderr'],
    [/\bcoproc\b/, 'coproc'],
    [/\bwait\s+-n\b/, 'wait -n'],
  ];
  for (const [re, what] of bash4) assert.ok(!re.test(body), `不该用 bash 4 才有的写法:${what}`);
});

await report.check('W3', '脚本默认总等待上限小于步骤 timeout-minutes(留 ≥ 10 分钟余量)', 'red', () => {
  assert.ok(existsSync(SCRIPT), '缺少脚本 scripts/warm-npmmirror.sh');
  const t = read(SCRIPT);
  const m = t.match(/WARM_MAX_WAIT_S:-(\d+)/);
  assert.ok(m, '脚本里应有 WARM_MAX_WAIT_S 的默认值(${WARM_MAX_WAIT_S:-秒数})');
  const tm = stripComments(warmStep() || '').match(/^\s+timeout-minutes:\s*(\d+)\s*$/m);
  assert.ok(tm, '工作流「Warm npmmirror」步骤应有 timeout-minutes');
  assert.ok(Number(tm[1]) * 60 >= Number(m[1]) + 600, `步骤 timeout-minutes=${tm[1]} 分钟,脚本默认上限 ${m[1]} 秒:步骤上限应比脚本上限至少多 10 分钟,否则步骤先被强杀`);
});

// ───────────────────────── 行为:假世界里真跑脚本 ─────────────────────────
const START = 1_000_000; // 假时钟起点(秒)
const VER = '0.2.458';
const PKGS = [
  { name: '@wsxwj123/cc-gui-darwin-arm64', key: 'darwin' },
  { name: '@wsxwj123/cc-gui-win32-x64', key: 'win32' },
  { name: '@wsxwj123/cc-gui', key: 'main' },
]; // 与 build-npm-packages.mjs 的发布顺序一致:平台包在前、主包最后
const KEYS = PKGS.map((p) => p.key);

for (const f of ['curl', 'sleep', 'date']) { try { chmodSync(join(FAKE_BIN, f), 0o755); } catch { /* 只读文件系统:忽略 */ } }

const upCfg = (v) => (v === undefined ? '0' : (v === Infinity ? 'never' : String(v)));
const tail = (s) => s.split('\n').filter(Boolean).slice(-6).join(' | ');

function runWarm(opts = {}) {
  const { up = {}, mirrorDelay = 240, mirrorPre = [], failFirst = 0, putFailFirst = 0, putBadFirst = 0, decoy = false, pretty = false,
    mirror404 = false, env = {}, packagesJson, noJson = false } = opts;
  assert.ok(existsSync(SCRIPT), '缺少脚本 scripts/warm-npmmirror.sh');
  const dir = mkdtempSync(join(tmpdir(), 'cgui-r167-'));
  const world = join(dir, 'world');
  mkdirSync(world);
  try {
    writeFileSync(join(world, 'config'), [
      `UP_main=${upCfg(up.main)}`, `UP_darwin=${upCfg(up.darwin)}`, `UP_win32=${upCfg(up.win32)}`,
      `MIRROR_DELAY=${mirrorDelay}`, `MIRROR_PRE="${mirrorPre.join(' ')}"`,
      `FAIL_FIRST=${failFirst}`, `PUT_FAIL_FIRST=${putFailFirst}`, `PUT_BAD_FIRST=${putBadFirst}`,
      `DECOY=${decoy ? 1 : 0}`, `PRETTY=${pretty ? 1 : 0}`, `MIRROR_404=${mirror404 ? 1 : 0}`, `WORLD_VER=${VER}`,
    ].join('\n') + '\n');
    writeFileSync(join(world, 'start'), String(START));
    writeFileSync(join(world, 'now'), String(START));
    writeFileSync(join(world, 'cap'), String(START + Number(env.WARM_MAX_WAIT_S ?? 7200) + 600)); // 假时间越过它 = 脚本跑飞
    const json = join(dir, 'npm-packages.json');
    if (!noJson) {
      writeFileSync(json, JSON.stringify(packagesJson ?? { version: VER, packages: PKGS.map((p) => ({ name: p.name, dir: `npm-dist/${p.key}` })) }));
    }
    const r = spawnSync(BASH, [SCRIPT, json], {
      cwd: dir, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
      env: { PATH: [FAKE_BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), WORLD: world, HOME: dir, ...env },
    });
    const file = (n) => (existsSync(join(world, n)) ? readFileSync(join(world, n), 'utf8') : '');
    const puts = file('puts.log').split('\n').filter(Boolean).map((l) => { const [t, key, status] = l.split(' '); return { t: Number(t), key, status }; });
    const urls = file('urls.log').split('\n').filter(Boolean).map((l) => { const [t, method, url] = l.split(' '); return { t: Number(t), method, url }; });
    return {
      code: r.status, signal: r.signal, out: `${r.stdout || ''}${r.stderr || ''}`,
      puts, urls, calls: file('calls.log').split('\n').filter(Boolean), sleeps: file('sleeps.log').split('\n').filter(Boolean).length,
      elapsed: Number(file('now') || START) - START, runaway: existsSync(join(world, 'runaway')),
    };
  } finally {
    if (!process.env.R167_KEEP) rmSync(dir, { recursive: true, force: true });
  }
}
const putsOf = (r, key) => r.puts.filter((p) => p.key === key);
const noRunaway = (r) => assert.ok(!r.runaway && r.signal === null, `脚本越过假时间上限还没收尾(死循环 / 没按上限退出);输出尾部:${tail(r.out)}`);
const noGapShorter = (ps, min, what) => { for (let i = 1; i < ps.length; i += 1) assert.ok(ps[i].t - ps[i - 1].t >= min, `${what}:相邻两次催同步只隔了 ${ps[i].t - ps[i - 1].t} 秒(应 ≥ ${min})`); };

const canRun = process.platform !== 'win32';
const behavior = (id, title, fn) => (canRun ? report.check(id, title, 'red', fn) : report.skip(id, title, 'red', 'Windows 没有 bash 与 /bin 工具,行为用例只在 macOS / Linux 跑(CI 的 publish-npm 跑在 ubuntu)'));

await behavior('B1', '分包 20 分半钟后才在官方源可见:此前一次都不催,一可见(下一轮)就催,镜像追平即停,不拖沓', () => {
  // 1230 秒不是 60 / 300 的整数倍:真实世界里「可见」的时刻不会对齐轮询格点,这样才测得出轮询间隔是不是 60 秒
  const r = runWarm({ up: { main: 0, darwin: 1230, win32: 1230 }, mirrorDelay: 240 }); // 脚本默认值:每 60 秒一轮、上限 2 小时
  noRunaway(r);
  assert.equal(r.code, 0, `应成功退出,实际 ${r.code};${tail(r.out)}`);
  for (const k of ['darwin', 'win32']) {
    const ps = putsOf(r, k);
    assert.ok(ps.length >= 1, `${k} 应催过同步`);
    assert.ok(ps.every((p) => p.t >= 1230), `${k} 在官方源可见(1230 秒)之前就催了同步:${JSON.stringify(ps)}`);
    assert.ok(ps[0].t <= 1230 + 60, `${k} 官方源一可见就该在下一轮催(应在 1230~1290 秒之间,实际 ${ps[0].t})`);
  }
  assert.equal(putsOf(r, 'main')[0]?.t, 0, '主包一开始就可见,应立刻催');
  for (const k of KEYS) {
    const ps = putsOf(r, k);
    assert.ok(ps.every((p) => p.t < ps[0].t + 240), `${k} 镜像追平(首次催 +240 秒)之后还在催:${JSON.stringify(ps)}`);
  }
  assert.ok(r.elapsed >= 1230 + 240 && r.elapsed <= 1230 + 240 + 120, `应在最后一个包追平(约 1500 秒)后 2 个间隔内收尾,实际总耗时 ${r.elapsed} 秒`);
});

await behavior('B2', '镜像慢(催后 13 分钟才追平):每个包隔 5 分钟补催一次,追平后不再催', () => {
  const r = runWarm({ up: { main: 0, darwin: 0, win32: 0 }, mirrorDelay: 780 });
  noRunaway(r);
  assert.equal(r.code, 0, `应成功退出,实际 ${r.code};${tail(r.out)}`);
  for (const k of KEYS) {
    const ps = putsOf(r, k);
    assert.ok(ps.length >= 2, `${k} 应补催过(镜像 780 秒才追平),实际只催了 ${ps.length} 次`);
    noGapShorter(ps, 300, k);
    for (let i = 1; i < ps.length; i += 1) assert.ok(ps[i].t - ps[i - 1].t <= 360, `${k}:补催太慢,相邻两次隔了 ${ps[i].t - ps[i - 1].t} 秒(应 ≤ 360)`);
    assert.ok(ps.every((p) => p.t < 780), `${k} 镜像追平(780 秒)之后还在催:${JSON.stringify(ps)}`);
  }
  assert.ok(r.elapsed >= 780 && r.elapsed <= 900, `应在镜像追平后 2 个间隔内收尾,实际总耗时 ${r.elapsed} 秒`);
});

await behavior('B3', '官方源始终没有:到上限放弃(退出非 0)、一次都没催、报出缺哪些包', () => {
  const r = runWarm({ up: { main: Infinity, darwin: Infinity, win32: Infinity }, env: { WARM_MAX_WAIT_S: '900' } });
  noRunaway(r);
  assert.notEqual(r.code, 0, `官方源一直没有,应以非 0 退出(让步骤显示警告),实际 ${r.code}`);
  assert.equal(r.puts.length, 0, `官方源没有的包不该催同步(催了也拿不到):${JSON.stringify(r.puts)}`);
  assert.ok(r.elapsed >= 900 && r.elapsed <= 960, `应等满上限 900 秒再放弃,实际总耗时 ${r.elapsed} 秒`);
  for (const p of PKGS) assert.ok(r.out.includes(p.name), `放弃时应报出缺的包 ${p.name};输出尾部:${tail(r.out)}`);
});

await behavior('B4', '只有主包可见:只催主包,分包不催;到上限放弃', () => {
  const r = runWarm({ up: { main: 0, darwin: Infinity, win32: Infinity }, env: { WARM_MAX_WAIT_S: '900' } });
  noRunaway(r);
  assert.notEqual(r.code, 0, `分包一直没有,应以非 0 退出,实际 ${r.code}`);
  assert.equal(putsOf(r, 'darwin').length + putsOf(r, 'win32').length, 0, `官方源没有的分包不该催:${JSON.stringify(r.puts)}`);
  assert.ok(putsOf(r, 'main').length >= 1, '主包可见,应催过');
  assert.ok(r.elapsed >= 900 && r.elapsed <= 960, `应等满上限 900 秒再放弃,实际总耗时 ${r.elapsed} 秒`);
  assert.ok(r.out.includes('@wsxwj123/cc-gui-darwin-arm64') && r.out.includes('@wsxwj123/cc-gui-win32-x64'), `放弃时应报出缺的两个分包;输出尾部:${tail(r.out)}`);
});

await behavior('B5', '镜像开局就有三个包:一次不催、不等待,立刻成功', () => {
  const r = runWarm({ up: { main: 0, darwin: 0, win32: 0 }, mirrorPre: KEYS });
  noRunaway(r);
  assert.equal(r.code, 0, `应成功退出,实际 ${r.code};${tail(r.out)}`);
  assert.equal(r.puts.length, 0, `镜像已有就不该催:${JSON.stringify(r.puts)}`);
  assert.equal(r.sleeps, 0, '镜像已有就不该等待');
  assert.equal(r.elapsed, 0, `应立刻收尾,实际耗时 ${r.elapsed} 秒`);
});

await behavior('B6', '前几次请求超时:不中断,恢复后照常催、照常收尾', () => {
  const r = runWarm({ up: { main: 0, darwin: 0, win32: 0 }, failFirst: 7, mirrorDelay: 240 });
  noRunaway(r);
  assert.equal(r.code, 0, `请求偶发超时不该让脚本中断,应成功退出,实际 ${r.code};${tail(r.out)}`);
  for (const k of KEYS) assert.ok(putsOf(r, k).length >= 1, `${k} 恢复后应催过同步`);
  assert.ok(r.elapsed <= 240 + 60 * 4, `应在恢复后很快收尾,实际总耗时 ${r.elapsed} 秒`);
});

await behavior('B7', '催同步的请求本身失败(超时):不算催过,下一轮(≤ 1 个间隔)就重试', () => {
  const r = runWarm({ up: { main: 0, darwin: 0, win32: 0 }, putFailFirst: 3, mirrorDelay: 240 });
  noRunaway(r);
  assert.equal(r.code, 0, `应成功退出,实际 ${r.code};${tail(r.out)}`);
  for (const k of KEYS) {
    const ps = putsOf(r, k);
    assert.ok(ps.length >= 2, `${k} 第一次催失败后应重试,实际只试了 ${ps.length} 次`);
    assert.equal(ps[0].status, 'fail', `${k} 第一次催应是失败的(假世界设定前 3 次失败)`);
    assert.ok(ps.some((p) => p.status === 'ok'), `${k} 应有成功的催`);
    assert.ok(ps[1].t - ps[0].t <= 60, `${k} 催失败后应在下一轮(≤ 60 秒)重试,实际隔了 ${ps[1].t - ps[0].t} 秒(不该干等 5 分钟)`);
  }
});

await behavior('B7b', '催同步收到的不是成功响应(HTTP 5xx / 代理错误页,curl 退出码仍为 0):不算催过,下一轮重试', () => {
  const r = runWarm({ up: { main: 0, darwin: 0, win32: 0 }, putBadFirst: 3, mirrorDelay: 240 });
  noRunaway(r);
  assert.equal(r.code, 0, `应成功退出,实际 ${r.code};${tail(r.out)}`);
  for (const k of KEYS) {
    const ps = putsOf(r, k);
    assert.ok(ps.length >= 2, `${k} 第一次收到错误响应后应重试,实际只试了 ${ps.length} 次`);
    assert.equal(ps[0].status, 'bad', `${k} 第一次催应收到错误响应(假世界设定前 3 次返回 {"error":"bad gateway"})`);
    assert.ok(ps.some((p) => p.status === 'ok'), `${k} 应有成功的催`);
    assert.ok(ps[1].t - ps[0].t <= 60, `${k} 收到错误响应后应在下一轮(≤ 60 秒)重试,实际隔了 ${ps[1].t - ps[0].t} 秒(不能把 HTTP 错误当成「催过」干等 5 分钟)`);
  }
});

await behavior('B8', '包页面判据只认 versions 表:dist-tags / time 先提到新版本不算可见;带缩进的 JSON 也认', () => {
  const r = runWarm({ up: { main: 0, darwin: 1230, win32: 0 }, decoy: true, pretty: true });
  noRunaway(r);
  assert.equal(r.code, 0, `应成功退出,实际 ${r.code};${tail(r.out)}`);
  const ps = putsOf(r, 'darwin');
  assert.ok(ps.length >= 1, 'darwin 应催过同步');
  assert.ok(ps.every((p) => p.t >= 1230), `darwin 官方源 versions 里还没有新版本(只有 dist-tags / time 提到)时就催了:${JSON.stringify(ps)}`);
  assert.ok(ps[0].t <= 1230 + 60, `darwin 一可见就该催(带缩进的 JSON 也要认出来),首次应在 1230~1290 秒之间,实际 ${ps[0].t}`);
});

await behavior('B9', '镜像对没同步过的包返回 404:照常催,追平后成功', () => {
  const r = runWarm({ up: { main: 0, darwin: 0, win32: 0 }, mirror404: true, mirrorDelay: 240 });
  noRunaway(r);
  assert.equal(r.code, 0, `镜像 404 不该中断,应成功退出,实际 ${r.code};${tail(r.out)}`);
  for (const k of KEYS) assert.equal(putsOf(r, k).length, 1, `${k} 催一次镜像就追平,不该多催:${JSON.stringify(putsOf(r, k))}`);
  assert.ok(r.elapsed <= 240 + 120, `应在镜像追平后 2 个间隔内收尾,实际总耗时 ${r.elapsed} 秒`);
});

await behavior('B10', '参数错误(找不到 npm-packages.json / 包列表为空):立刻报错退出,不联网、不等待', () => {
  const missing = runWarm({ noJson: true });
  noRunaway(missing);
  assert.notEqual(missing.code, 0, '找不到 npm-packages.json 应以非 0 退出');
  assert.ok(missing.out.includes('npm-packages.json'), `报错应点名 npm-packages.json:${tail(missing.out)}`);
  assert.equal(missing.sleeps, 0, '找不到文件不该等待');
  assert.equal(missing.calls.length + missing.puts.length, 0, '找不到文件不该联网');
  const empty = runWarm({ packagesJson: { version: VER, packages: [] } });
  noRunaway(empty);
  assert.notEqual(empty.code, 0, '包列表为空应以非 0 退出');
  assert.equal(empty.sleeps, 0, '包列表为空不该等待');
  assert.equal(empty.calls.length + empty.puts.length, 0, '包列表为空不该联网');
});

await behavior('B11', '请求形态:催同步的 PUT 用 %2F、查包页面的 GET 用 %2f(与线上验证过的写法一致);默认地址正确;环境变量名与工作流一致', () => {
  const PKG_RE = '(cc-gui|cc-gui-darwin-arm64|cc-gui-win32-x64)';
  const r = runWarm({ up: { main: 0, darwin: 0, win32: 0 }, mirrorDelay: 240 });
  noRunaway(r);
  assert.equal(r.code, 0, `应成功退出,实际 ${r.code};${tail(r.out)}`);
  const puts = r.urls.filter((u) => u.method === 'PUT');
  const gets = r.urls.filter((u) => u.method === 'GET');
  assert.ok(puts.length >= 3 && gets.length >= 6, `应催过 3 个包、查过包页面(PUT ${puts.length} 次,GET ${gets.length} 次)`);
  for (const u of puts) assert.match(u.url, new RegExp(`^https://registry\\.npmmirror\\.com/-/package/@wsxwj123%2F${PKG_RE}/syncs$`), `PUT 地址形态不对:${u.url}`);
  for (const u of gets) assert.match(u.url, new RegExp(`^https://registry\\.(npmjs\\.org|npmmirror\\.com)/@wsxwj123%2f${PKG_RE}$`), `GET 地址形态不对:${u.url}`);
  assert.ok(gets.some((u) => u.url.startsWith('https://registry.npmjs.org/')), '应查官方源 https://registry.npmjs.org');
  assert.ok(gets.some((u) => u.url.startsWith('https://registry.npmmirror.com/')), '应查镜像 https://registry.npmmirror.com');
  // 环境变量:工作流步骤 env 给的 NPMMIRROR_REGISTRY、以及 NPM_OFFICIAL_REGISTRY 要被脚本认
  const alt = runWarm({ up: { main: 0, darwin: 0, win32: 0 }, mirrorDelay: 240,
    env: { NPMMIRROR_REGISTRY: 'https://registry.npmmirror.com/alt', NPM_OFFICIAL_REGISTRY: 'https://registry.npmjs.org/alt' } });
  noRunaway(alt);
  assert.equal(alt.code, 0, `改了环境变量也应成功退出,实际 ${alt.code};${tail(alt.out)}`);
  assert.ok(alt.urls.filter((u) => u.method === 'PUT').every((u) => u.url.startsWith('https://registry.npmmirror.com/alt/-/package/')), '催同步应走 NPMMIRROR_REGISTRY');
  assert.ok(alt.urls.filter((u) => u.method === 'GET' && u.url.includes('npmjs.org')).every((u) => u.url.startsWith('https://registry.npmjs.org/alt/')), '查官方源应走 NPM_OFFICIAL_REGISTRY');
  assert.ok(alt.urls.filter((u) => u.method === 'GET' && u.url.includes('npmmirror.com')).every((u) => u.url.startsWith('https://registry.npmmirror.com/alt/')), '查镜像应走 NPMMIRROR_REGISTRY');
});

process.exit(report.finish());
