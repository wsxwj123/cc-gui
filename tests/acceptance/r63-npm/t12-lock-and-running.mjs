#!/usr/bin/env node
// r63-npm【并发 + 幂等 + 判据顺序】§2.2 S4/S5/S5b + §2.4 排他锁 + 陈旧残留自清。
// 场景:用户在两个终端各敲了一次 cc-gui;或者上一次安装被 Cmd+C/SIGKILL 打断,留下锁目录;
//      或者应用正开着就去升级。这几件事凑一起最容易把 20MB 备份永久留在 ~/Applications。
// Run: node tests/acceptance/r63-npm/t12-lock-and-running.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { V, fakeInstall, runLauncher, macPayload, preinstallApp, appVersion, strays, node, run, t, skip, done } from './lib.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  skip('t12 全部用例', '锁/进程检测只能在 darwin/arm64 真机跑');
  done('t12 并发与运行态');
}
const PAY = macPayload('good-' + V);
const DEAD = 999999; // 超出 macOS PID 上限,process.kill(pid,0) 必然 ESRCH
const mk = (inst, name) => { const p = path.join(inst.home, 'Applications', name); fs.mkdirSync(p, { recursive: true }); return p; };

await t('S5 有别人正在装(锁目录的 pid 还活着)→ 码 8,不动应用', () => {
  const inst = fakeInstall({ payload: PAY });
  preinstallApp(inst, '0.2.100');
  mk(inst, `.cc-gui-lock-${process.pid}`); // 本测试进程一定活着
  const r = runLauncher(inst);
  assert.equal(r.code, 8, '实际:\n' + r.all);
  assert.ok(r.stderr.includes('另一个 cc-gui 安装正在进行中，请等它结束后再试。'), 'stderr:\n' + r.stderr);
  assert.ok(r.stderr.includes('删掉 ~/Applications/.cc-gui-lock-* 后重试'), '得给用户一条自救路径');
  assert.equal(appVersion(inst.appRoot), '0.2.100', '拿不到锁却把应用换了');
});

await t('陈旧锁(pid 已死)不该拦人:自清后照常安装', () => {
  const inst = fakeInstall({ payload: PAY });
  mk(inst, `.cc-gui-lock-${DEAD}`);
  const r = runLauncher(inst);
  assert.notEqual(r.code, 8, '上次被 SIGKILL 留下的锁把用户永久拦死了:\n' + r.all);
  assert.ok(r.stdout.includes('正在安装'), 'stdout:\n' + r.stdout);
});

await t('陈旧残留自清:死 pid 的 npm/old/lock 目录被回收', () => {
  const inst = fakeInstall({ payload: PAY });
  for (const n of [`.cc-gui-npm-${DEAD}`, `.cc-gui-old-${DEAD}`, `.cc-gui-lock-${DEAD}`]) mk(inst, n);
  runLauncher(inst);
  assert.deepEqual(strays(inst), [], '死进程留下的中间目录没被回收(20MB 备份会一直躺着)');
});

await t('【反向】自清只碰名字严格匹配的目录,别的一律不动', () => {
  const inst = fakeInstall({ payload: PAY });
  const keep = ['.cc-gui-lock-abc', '.cc-gui-backup', '.cc-gui-old-', '.hidden-stuff', 'MyApp.app'];
  for (const n of keep) mk(inst, n);
  mk(inst, `.cc-gui-old-${process.pid}`); // 活 pid:也不许动
  runLauncher(inst);
  for (const n of keep) assert.ok(fs.existsSync(path.join(inst.home, 'Applications', n)), '误删了 ' + n);
  assert.ok(fs.existsSync(path.join(inst.home, 'Applications', `.cc-gui-old-${process.pid}`)), '活进程的中间目录被别人删了');
});

await t('判据顺序:已装同版 + 有活锁 → 走 S4 打开,不该报码 8', () => {
  const inst = fakeInstall({ payload: PAY });
  preinstallApp(inst, V);
  mk(inst, `.cc-gui-lock-${process.pid}`);
  const r = runLauncher(inst);
  assert.ok(r.code === 0 || r.code === 7, '版本已一致时不该去抢安装锁,实际码 ' + r.code + '\n' + r.all);
  assert.ok(r.stdout.includes('已是最新，正在打开…'), 'stdout:\n' + r.stdout);
});

// S5b:用 `exec -a` 把 argv[0] 改成 <appPath>/Contents/MacOS/CC-GUI,
// 造出一个与真应用在 ps 里长得一模一样的进程(锚定/不锚定的 pgrep 写法都会命中)。
async function fakeRunningApp(inst) {
  const exe = path.join(inst.appRoot, 'Contents/MacOS/CC-GUI');
  const p = spawn('/bin/sh', ['-c', `exec -a ${JSON.stringify(exe)} sleep 30`], { stdio: 'ignore' });
  const stop = () => { try { p.kill('SIGKILL'); } catch {} };
  for (let i = 0; i < 60; i++) { // 等到 pgrep 真能看见它为止,否则用例会随机假绿
    if (run('/usr/bin/pgrep', ['-f', exe]).code === 0) return stop;
    await new Promise((r) => setTimeout(r, 25));
  }
  stop();
  throw new Error('造不出"应用正在运行"的进程,本条无法判定');
}

await t('S5b 需要升级但应用正开着 → 码 5 + 教用户 Cmd+Q,并且不动应用', async () => {
  const inst = fakeInstall({ payload: PAY });
  preinstallApp(inst, '0.2.100');
  const stop = await fakeRunningApp(inst);
  try {
    const r = runLauncher(inst);
    assert.equal(r.code, 5, '实际:\n' + r.all);
    assert.ok(r.stderr.includes(`检测到 CC-GUI 正在运行，无法升级到 v${V}。`), 'stderr:\n' + r.stderr);
    assert.ok(r.stderr.includes('注意关闭窗口只是最小化到托盘'), '不写这句,用户会以为自己已经退出了');
    assert.equal(appVersion(inst.appRoot), '0.2.100', '应用正跑着还去替换 bundle = 运行中的进程被抽掉文件');
  } finally { stop(); }
});

await t('判据顺序:S4(已装同版) 优先于 S5b —— 应用开着也只是把窗口带到前台', async () => {
  const inst = fakeInstall({ payload: PAY });
  preinstallApp(inst, V);
  const stop = await fakeRunningApp(inst);
  try {
    const r = runLauncher(inst);
    assert.notEqual(r.code, 5, '同版本时报"请先退出"是纯骚扰:用户只是想把窗口调出来\n' + r.all);
  } finally { stop(); }
});

await t('判据顺序:S5(锁) 优先于 S5b(应用在跑)', async () => {
  const inst = fakeInstall({ payload: PAY });
  preinstallApp(inst, '0.2.100');
  mk(inst, `.cc-gui-lock-${process.pid}`);
  const stop = await fakeRunningApp(inst);
  try { assert.equal(runLauncher(inst).code, 8, '先确认自己是唯一安装者,再谈目标应用状态'); } finally { stop(); }
});

// ⚠️ 这条是本轮最容易漏的坑:`pgrep -f "<appPath>/Contents/MacOS/"` 会把**另一个 cc-gui 自己
//    那条 pgrep 命令行**当成命中(pgrep 只排除它自己,不排除同时在跑的另一条 pgrep)。
//    于是两个终端同时敲 cc-gui,机器上根本没开 CC-GUI,两个都报"检测到 CC-GUI 正在运行"。
//    本机实测已复现;把它单独钉一条,免得被上面那条笼统的并发用例掩盖。
await t('【并发·反向】机器上没开 CC-GUI 时,两个 cc-gui 同时跑不许互相误判成"应用正在运行"', async () => {
  const inst = fakeInstall({ payload: PAY });
  preinstallApp(inst, '0.2.100');
  const one = () => new Promise((res) => {
    let e = '';
    const c = spawn(process.execPath, [inst.bin], { env: { ...process.env, HOME: inst.home } });
    c.stderr.on('data', (d) => { e += d; });
    c.stdout.resume();
    c.on('exit', (code) => res({ code, e }));
  });
  const rs = await Promise.all([one(), one()]);
  for (const r of rs) assert.notEqual(r.code, 5,
    '误判"应用正在运行"。多半是 pgrep -f 匹配到了另一个进程的 pgrep 命令行本身(需要锚定/排除自己):\n' + r.e);
});

await t('【并发】同时开两个 cc-gui:不许出现安装失败,也不许留残留', async () => {
  const inst = fakeInstall({ payload: PAY });
  const probe = node(['-p', 'require("os").homedir()'], { env: { ...process.env, HOME: inst.home } });
  assert.equal(probe.stdout.trim(), inst.home, 'HOME 隔离失效,拒绝并发写盘');
  const one = () => new Promise((res) => {
    const c = spawn(process.execPath, [inst.bin], { env: { ...process.env, HOME: inst.home }, stdio: 'ignore' });
    c.on('exit', (code) => res(code));
  });
  const codes = await Promise.all([one(), one()]);
  for (const c of codes) assert.ok([0, 7, 8].includes(c), `并发下出现了非预期退出码 ${c}(codes=${codes});6 说明两个进程互相踩了`);
  assert.deepEqual(strays(inst), [], '并发后残留中间目录:' + strays(inst).join(','));
  assert.equal(appVersion(inst.appRoot), V, '并发之后应用应处于确定的新版本状态');
});

done('t12 并发与运行态');
