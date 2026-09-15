// CG-R03 / CG-R04 / CG-R05:依赖不可用时的降级(INTERFACE §B 失败表 + I4/G5)。
//
// 这三条要的是"运行时未就绪 / helper 卡住 / helper 输出不是 JSON"的环境,而真实运行时目录
// (os.userInfo().homedir 下的 ~/.claude-gui/cu-runtime)在隔离实例上**不可隔离**,
// 也绝不能挪操作者正在用的那一份。做法(合同 §F CG-R03 允许的"用无 venv 的数据根"):
// 把 server/ 整棵树复制到本套件 .artifacts 下,只改副本里的两处环境参数 ——
//   ① cu-common.js 的运行时目录 → 本套件 .artifacts/controlled-runtime(里面的 venv/stamp 由本用例摆);
//   ② cu_helper.py → 一个受控的假 helper(apps 睡 60s;app-info 打印 not-json)。
// 被测的路由文件 server/routes/computer-use.js 与工作树里的**逐字节相同**(beforeAll 里核对 sha256),
// 所以验的仍是产品代码,只是把它放进了一个受控环境。
import { test, expect } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

import path from 'node:path';
import { userInfo } from 'node:os';
import { artifacts, api, startInstance, stopInstance, sleep, EnvironmentBlocked, worktree } from './helpers/harness.mjs';
import { expandCandidates, openCuGrants } from './helpers/ui.mjs';

const brokenRoot = path.join(artifacts, 'broken');
const brokenServer = path.join(brokenRoot, 'server');
const controlledRuntime = path.join(artifacts, 'controlled-runtime');
const helperPath = path.join(brokenServer, 'computer-use', 'cu_helper.py');
const FAKE_HELPER = [
  'import sys, time',
  "if 'app-info' in sys.argv:",
  "    print('not-json')",
  'else:',
  '    time.sleep(60)',
  '',
].join('\n');

let inst = null;
const PID_FILE = path.join(artifacts, 'broken-instance.pid');

/** 上一个 worker 若死在半路(Playwright 失败后会换 worker,钩子重跑),按记录的 pid 收掉它自己那份实例。 */
function reclaimPreviousInstance() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    // 身份核对:命令行里必须真的是本套件副本的 server —— 绝不误杀别人的进程
    const cmd = String(spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout || '');
    if (pid && cmd.includes(brokenServer)) process.kill(pid, 'SIGKILL');
  } catch { /* 没有记录/已经退了 */ }
  fs.rmSync(PID_FILE, { force: true });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 6700-6799 里挑一个当前空闲的端口(硬拒用户实例端口)。
 * 用 lsof 看有没有听众,不用"自己 bind 一下试试" —— node 的 net 默认带 SO_REUSEADDR,
 * 在 macOS 上对着别人的 0.0.0.0 绑定还能成功,探出来是假的(实测踩过)。
 * 从随机起点往后扫,降低与并行跑着的其它套件撞同一个端口的概率。
 */
function pickFreePort() {
  const start = 6700 + Math.floor(Math.random() * 50);
  for (let port = start; port <= 6799; port += 1) {
    if (port === 6677 || port === 6689) continue;
    const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    if (!String(out.stdout || '').trim()) return port;
  }
  throw new EnvironmentBlocked('6700-6799 没有空闲端口');
}

function controlledVenvPresent() {
  return fs.existsSync(path.join(controlledRuntime, 'venv', 'bin', 'python3'))
    && fs.existsSync(path.join(controlledRuntime, 'venv.stamp'));
}

/** 摆出 venv + stamp(runtimeReady 为真),python 用真实 venv 的解释器(只读符号链接)。 */
function plantControlledVenv() {
  fs.mkdirSync(path.join(controlledRuntime, 'venv', 'bin'), { recursive: true });
  const real = path.join(userInfo().homedir, '.claude-gui', 'cu-runtime', 'venv', 'bin', 'python3');
  if (!fs.existsSync(real)) {
    throw new EnvironmentBlocked(`找不到可用的 venv python(期望 ${real});先把 computer use 运行时准备好再跑这三条`);
  }
  const link = path.join(controlledRuntime, 'venv', 'bin', 'python3');
  fs.rmSync(link, { force: true });
  fs.symlinkSync(real, link);
  fs.writeFileSync(path.join(controlledRuntime, 'venv.stamp'), 'cgui-grant-ui fixture\n');
}

function clearControlledVenv() {
  fs.rmSync(path.join(controlledRuntime, 'venv'), { recursive: true, force: true });
  fs.rmSync(path.join(controlledRuntime, 'venv.stamp'), { force: true });
}

test.beforeAll(async () => {
  reclaimPreviousInstance();
  // 副本:整棵 server/ 树
  fs.rmSync(brokenRoot, { recursive: true, force: true });
  fs.mkdirSync(brokenRoot, { recursive: true });
  fs.cpSync(path.join(worktree, 'server'), brokenServer, { recursive: true });

  // 被测路由必须与工作树里的逐字节相同(否则验的就不是产品代码了)
  const realRoute = sha256(path.join(worktree, 'server', 'routes', 'computer-use.js'));
  const copyRoute = sha256(path.join(brokenServer, 'routes', 'computer-use.js'));
  expect(copyRoute, '副本里的被测路由必须与工作树里的逐字节相同').toBe(realRoute);

  // ① 运行时目录指到受控目录
  const commonFile = path.join(brokenServer, 'computer-use', 'cu-common.js');
  const src = fs.readFileSync(commonFile, 'utf8');
  const needle = "return join(home || homedir(), '.claude-gui', 'cu-runtime');";
  if (!src.includes(needle)) {
    throw new EnvironmentBlocked(`副本里的 cu-common.js 已不是预期的形态(找不到运行时目录那一行),本套件的受控环境要跟着改`);
  }
  fs.writeFileSync(commonFile, src.replace(needle, `return ${JSON.stringify(controlledRuntime)};`));

  // ② 假 helper
  fs.writeFileSync(helperPath, FAKE_HELPER);

  clearControlledVenv();
  fs.mkdirSync(path.join(artifacts, 'runtime-data', 'home-b'), { recursive: true });
  execFileSync(process.execPath, [path.join(worktree, 'tests/acceptance/cu-grant-ui-20260913/helpers/prepare-home.mjs'),
    path.join(artifacts, 'runtime-data', 'home-b'), worktree], { stdio: 'inherit' });

  const port = await pickFreePort();
  inst = await startInstance({
    home: path.join(artifacts, 'runtime-data', 'home-b'),
    port,
    label: 'broken-runtime',
    entry: path.join(brokenServer, 'index.js'),
  });
  fs.writeFileSync(PID_FILE, String(inst.pid));
  console.log(`   受控实例就绪:${inst.base}(运行时目录 ${controlledRuntime})`);
});

test.afterAll(async () => {
  // 假 helper 可能还在睡(异常路径):按 ps 找到的 pid 杀,绝不用按名字杀的写法
  for (const pid of fakeHelperPids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经退了 */ } }
  await stopInstance(inst);
  fs.rmSync(PID_FILE, { force: true });
});

/** 扫出还活着的假 helper 进程(用绝对路径当特征,只在本套件自己的副本目录里匹配)。 */
function fakeHelperPids() {
  const out = spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
  return String(out.stdout || '').split('\n')
    .filter((line) => line.includes(helperPath))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter(Boolean);
}

test('CG-R03 运行时未就绪:/apps 与 /app-info 回 CU_RUNTIME_UNAVAILABLE(HTTP 200),且不建 venv', async () => {
  clearControlledVenv();
  const before = fs.readdirSync(controlledRuntime);
  const stampBefore = fs.existsSync(path.join(controlledRuntime, 'venv.stamp'));

  for (const p of ['/api/computer-use/apps', '/api/computer-use/app-info?bundleId=com.apple.TextEdit']) {
    const r = await api(p, { base: inst.base });
    expect(r.status, `${p} 必须仍是 200(报告,不是失败请求;不得 5xx)`).toBe(200);
    expect(r.body?.ok, `${p} ok:false`).toBe(false);
    expect(r.body?.code, `${p} 稳定 code`).toBe('CU_RUNTIME_UNAVAILABLE');
    expect(String(r.body?.error || '').length, `${p} 要给出人读原因`).toBeGreaterThan(0);
  }
  expect(fs.readdirSync(controlledRuntime), '运行时目录一个字节都不该被写(更不许建 venv)').toEqual(before);
  expect(controlledVenvPresent()).toBe(false);
  expect(fs.existsSync(path.join(controlledRuntime, 'venv.stamp')), 'stamp 的在场状态不变').toBe(stampBefore);
});

test('CG-R04 helper 卡住:15 秒后回 CU_TIMEOUT,无僵尸进程残留', async () => {
  plantControlledVenv();
  const t0 = Date.now();
  const r = await api('/api/computer-use/apps', { base: inst.base, timeoutMs: 40_000 });
  const ms = Date.now() - t0;
  expect(r.status).toBe(200);
  expect(r.body?.ok).toBe(false);
  expect(r.body?.code).toBe('CU_TIMEOUT');
  expect(ms, `15 秒超时(实测 ${ms}ms)`).toBeGreaterThan(14_000);
  expect(ms, `不该等到 helper 自然结束(实测 ${ms}ms)`).toBeLessThan(30_000);
  await sleep(500);
  expect(fakeHelperPids(), '被 SIGKILL 收尾后不该有残留的 helper 进程(按 pid 核对)').toEqual([]);
});

test('CG-R05 helper 输出不是 JSON:CU_RUNTIME_UNAVAILABLE,error ≤300 字符且不含堆栈', async () => {
  plantControlledVenv();
  const r = await api('/api/computer-use/app-info?bundleId=com.apple.TextEdit', { base: inst.base });
  expect(r.status).toBe(200);
  expect(r.body?.ok).toBe(false);
  expect(r.body?.code).toBe('CU_RUNTIME_UNAVAILABLE');
  const error = String(r.body?.error || '');
  expect(error.length).toBeGreaterThan(0);
  expect(error.length, '错误详情截断到 300 字符以内').toBeLessThanOrEqual(300);
  expect(error).not.toMatch(/Traceback|File "|\n\s+at\s/);
  console.log(`   error=${JSON.stringify(error)}`);
});

test('CG-R11 面板处于「运行时未就绪」态:候选区如实说未就绪,手填路径仍能完成授权', async ({ page }) => {
  // 受控实例(没有 venv)就是那个"运行时未就绪"的环境:页面自己走的 /api 仍在正常实例上,
  // 只把 computer use 那几个端点改道到受控实例 —— 面板拿到的 status 与 /apps 都是真的未就绪。
  clearControlledVenv();
  await page.route('**/api/computer-use/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${inst.base}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  await openCuGrants(page);
  await expandCandidates(page);
  await expect(page.getByTestId('cu-apps-unavailable')).toHaveText('运行时尚未就绪（首次调用工具时自动准备）；可直接手动填写 bundleId。');

  const id = 'com.apple.TextEdit';
  await setGrantViaApiTo(`${inst.base}`, { bundleId: id, granted: false }); // 受控实例自己的授权目录,先复位
  await page.getByTestId('cu-manual-input').fill(id);
  await expect(page.getByTestId('cu-manual-result')).toHaveAttribute('data-state', 'unverified');
  await page.getByTestId('cu-manual-grant').click();
  await expect(page.locator(`[data-testid="cu-grant-row"][data-bundle-id="${id}"]`), '手填 + 授权必须能走通').toBeVisible({ timeout: 15_000 });
  // 交叉核对:写进的是受控实例自己的运行时目录(操作者真实 grants.json 一个字没动)
  const viaHttp = await api('/api/computer-use/grants', { base: inst.base });
  expect(viaHttp.body.apps.map((a) => a.bundleId)).toContain(id);
});

/** 直接给某个 base 的端点发一次 POST(受控实例用)。 */
async function setGrantViaApiTo(base, payload) {
  const r = await api('/api/computer-use/grants', { base, method: 'POST', body: payload });
  if (r.status !== 200 || r.body?.ok !== true) throw new EnvironmentBlocked(`受控实例 POST /grants 失败(HTTP ${r.status})`);
  return r.body;
}
