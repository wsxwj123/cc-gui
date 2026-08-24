#!/usr/bin/env node
// r34【单测】:GUI 内更新不再自己毁掉用户的 claude 安装。
//
// 事故:Windows 用户 GUI 内更新一超时/中断,claude.cmd 消失、node_modules 里只剩半解压
// 的包,得整包重下;终端更新从不出事。根因 = /claude-update/stream 的 8 分钟强杀:
// `npm install -g` 非原子(先删旧 bin 链/旧包,再解压 81MB 平台包),慢源下 8 分钟远
// 不够,强杀必然落在「旧的已删、新的没好」的窗口 —— 防挂死保护本身就是损坏的制造者。
//
// 验收点:
//   ①慢提示到点【只推提示、绝不杀】,任务保持 running;
//   ②极限兜底(60 分钟)到点才杀,且错误文案带恢复指引;
//   ③正常收尾 clear 后两个定时器都不再触发;
//   ④withRecoveryHint:npm 渠道命令才追加"重跑一次更新即可补齐";
//   ⑤liveProxy:回环探不通才判死(非回环/无法解析一律信任 —— 判死会删 env,误杀更贵);
//   ⑥源码守卫(字符串断言):8 分钟那条路径上不得再出现 killUpdateTree();
//   ⑦判死后必须把代理从子进程 env 里删掉(只"不注入"= {...process.env} 照样带过去);
//   ⑧spawn 前的取消要有标志兑现;done 帧要带 error;取消按钮要接线。
// 活端口用 6703;死端口取"刚 listen 完就关掉"的临时端口(固定端口可能被本项目 dev
// server 占用造成假红,写法照 check-r26-c2-proxy-probe.mjs)。跑完关干净。
// Run: node tests/unit/check-r34-update-no-kill.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { makeTmpHome, cleanupDirs } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('r34-unit'); // version-check 顶层固化 PREFS_FILE,先隔离 HOME
const LIVE_PORT = 6703;
// 「确定没人听」的端口:起 server 拿到端口号后立刻关(固定 6704 会被 dev server 占 → 假红)
async function closedPort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

const NPM_CMD = 'npm install -g @anthropic-ai/claude-code@latest && "$(npm prefix -g)/bin/claude" --version';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let liveServer = null;
try {
  const {
    startUpdateTimers, withRecoveryHint, isNpmRegistryCmd, liveProxy, maskProxy,
    UPDATE_SLOW_NOTICE_MS, UPDATE_HARD_LIMIT_MS, UPDATE_SLOW_NOTICE_LINE, UPDATE_HARD_LIMIT_ERROR,
  } = await import('../../server/routes/version-check.js');
  const DEAD_PORT = await closedPort();

  // 常量本身:提示早于兜底,兜底远大于"慢源下 30-60 分钟"的真实耗时
  assert.equal(UPDATE_SLOW_NOTICE_MS, 8 * 60 * 1000, 'r34: 慢提示仍在 8 分钟');
  assert.ok(UPDATE_HARD_LIMIT_MS >= 60 * 60 * 1000, 'r34: 极限兜底不得短于 60 分钟(慢源 81MB 要 30-60 分钟)');

  // ①慢提示只提示不杀(注入短延时;不可能真等 8 分钟)
  {
    const pushed = [];
    let killed = 0;
    const task = { status: 'running', error: '', cmd: NPM_CMD };
    const clear = startUpdateTimers({
      push: (e) => pushed.push(e), kill: () => { killed++; }, task,
      noticeMs: 5, hardMs: 100000,
    });
    await sleep(40);
    clear();
    assert.equal(killed, 0, 'r34-①: 慢提示到点绝不能杀进程(变异哨兵 —— 一旦改回"超时即杀"这里必红)');
    assert.equal(task.status, 'running', 'r34-①: 慢提示不得改变任务状态,任务继续跑');
    assert.equal(task.error, '', 'r34-①: 慢提示不是错误,不得写 task.error');
    assert.equal(pushed.length, 1, 'r34-①: 慢提示只推一帧');
    assert.equal(pushed[0].type, 'log', 'r34-①: 提示走 log 帧(前端只渲染 log/start/error/done)');
    assert.equal(pushed[0].line, UPDATE_SLOW_NOTICE_LINE, 'r34-①: 推的就是慢提示文案');
    assert.ok(/不会自动终止/.test(UPDATE_SLOW_NOTICE_LINE), 'r34-①: 文案要说清不会自动终止');
    assert.ok(/取消/.test(UPDATE_SLOW_NOTICE_LINE) && /半成品/.test(UPDATE_SLOW_NOTICE_LINE),
      'r34-①: 文案要给出「取消」出口并说明取消可能留下半成品');
  }

  // ②极限兜底到点才杀,且错误带恢复指引
  {
    const pushed = [];
    let killed = 0;
    const task = { status: 'running', error: '', cmd: NPM_CMD };
    const clear = startUpdateTimers({
      push: (e) => pushed.push(e), kill: () => { killed++; }, task,
      noticeMs: 5, hardMs: 25,
    });
    await sleep(80);
    clear();
    assert.equal(killed, 1, 'r34-②: 极限兜底必须杀(真挂死的兜底还在)');
    const err = pushed.find((e) => e.type === 'error');
    assert.ok(err, 'r34-②: 杀之前必须先推 error 帧说明为什么');
    assert.ok(/60 分钟/.test(err.error), 'r34-②: 错误文案要说明判定依据');
    assert.ok(/重新运行一次更新即可补齐/.test(err.error), 'r34-②: 被兜底杀掉后必须给恢复指引');
    assert.equal(task.error, err.error, 'r34-②: task.error 与推给前端的文案一致(重开面板对账看得到)');
    assert.ok(pushed.indexOf(err) > 0, 'r34-②: 慢提示在前、终止在后');
  }

  // ③正常收尾:clear 之后两个定时器都哑
  {
    const pushed = [];
    let killed = 0;
    const clear = startUpdateTimers({
      push: (e) => pushed.push(e), kill: () => { killed++; },
      task: { status: 'running', error: '', cmd: NPM_CMD }, noticeMs: 10, hardMs: 20,
    });
    clear();
    await sleep(60);
    assert.equal(pushed.length, 0, 'r34-③: 收尾后不得再推提示(更新已完成还弹"仍在运行"是假消息)');
    assert.equal(killed, 0, 'r34-③: 收尾后不得再杀(会误杀下一次更新的进程)');
  }

  // ②兜底文案要保留旧版给的两个出口(代理/改用终端),别只剩"已终止"
  assert.ok(/确认代理已开后重试,或点「改用终端更新」走官方渠道/.test(UPDATE_HARD_LIMIT_ERROR),
    'r34-②: 兜底文案要给出重试/换终端两个出口');

  // ④恢复指引只挂在 npm 渠道(native `claude upgrade` 是原子替换,没有半成品问题)
  assert.equal(isNpmRegistryCmd(NPM_CMD), true, 'r34-④: 识别 npm-registry 更新命令');
  assert.equal(isNpmRegistryCmd('call npm install -g @anthropic-ai/claude-code@latest && call claude --version'), true,
    'r34-④: Windows 形态(call npm install -g …)同样要识别 —— 事故就发生在 Windows');
  assert.equal(isNpmRegistryCmd("'/usr/local/bin/claude' upgrade"), false, 'r34-④: native 命令不算 npm 渠道');
  assert.equal(isNpmRegistryCmd(''), false, 'r34-④: 空命令(尚未解析出)不算');
  assert.ok(/重新运行一次更新即可补齐/.test(withRecoveryHint('已由用户终止', NPM_CMD)),
    'r34-④: npm 渠道的中断必须带恢复指引');
  assert.equal(withRecoveryHint('已由用户终止', 'claude upgrade'), '已由用户终止',
    'r34-④: 非 npm 渠道不加噪音');
  assert.ok(withRecoveryHint(UPDATE_HARD_LIMIT_ERROR, NPM_CMD).startsWith(UPDATE_HARD_LIMIT_ERROR),
    'r34-④: 指引是追加,不覆盖原因');

  // ⑤代理探活分流:回环探不通才判死;非回环/无法证伪一律信任
  {
    assert.equal(await liveProxy(null), null, 'r34-⑤: 没探到代理就是直连');
    assert.equal(await liveProxy(`http://127.0.0.1:${DEAD_PORT}`), null,
      'r34-⑤: 回环代理不可达必须判死(变异哨兵 —— 删掉探活分流这里必红)');

    liveServer = createServer();
    await new Promise((r) => liveServer.listen(LIVE_PORT, '127.0.0.1', r));
    const liveUrl = `http://127.0.0.1:${LIVE_PORT}`;
    assert.equal(await liveProxy(liveUrl), liveUrl, 'r34-⑤: 探活通过才注入');

    // 误杀防线:判死之后会把代理从子进程 env 里删掉,所以"证不了死"的一律信任 ——
    // 误杀一个能用的代理 = 用户直连挂满 60 分钟兜底,比不探活更糟。
    let probed = false;
    const spy = async (...a) => { probed = true; return false; }; // 探什么都说死
    assert.equal(await liveProxy('http://proxy.corp.example', spy), 'http://proxy.corp.example',
      'r34-⑤: 企业代理(非回环)不探活、原样信任');
    assert.equal(probed, false, 'r34-⑤: 非回环压根不该发探测');
    assert.equal(await liveProxy('http://10.0.0.8:3128', spy), 'http://10.0.0.8:3128',
      'r34-⑤: 局域网代理同样信任');
    assert.equal(await liveProxy('127.0.0.1:7890', spy), '127.0.0.1:7890',
      'r34-⑤: 无 scheme 解析不了 ≠ 死代理,不得判死');
    assert.equal(await liveProxy(liveUrl, async () => { throw new Error('boom'); }), liveUrl,
      'r34-⑤: 探测器自己炸也不能判死(无法证伪 → 信任)');

    // 回环判定要认全三种写法,端口默认按协议(旧代码一律 8080 = 探错端口)
    let seen = null;
    const rec = async (h, p) => { seen = [h, p]; return true; };
    await liveProxy('http://localhost', rec);
    assert.deepEqual(seen, ['localhost', 80], 'r34-⑤: http 隐含端口是 80,不是 8080');
    await liveProxy('https://127.0.0.1', rec);
    assert.deepEqual(seen, ['127.0.0.1', 443], 'r34-⑤: https 隐含端口是 443');
    await liveProxy('http://[::1]:7890', rec);
    assert.deepEqual(seen, ['::1', 7890], 'r34-⑤: IPv6 字面量要剥掉方括号再探');
  }

  // ⑩代理地址进日志/回执前遮罩 userinfo(主机端口保留,便于用户对照)
  assert.equal(maskProxy('http://user:pw@127.0.0.1:7890'), 'http://***@127.0.0.1:7890', 'r34-⑩: 遮罩 user:pass');
  assert.equal(maskProxy('http://127.0.0.1:7890'), 'http://127.0.0.1:7890', 'r34-⑩: 无 userinfo 原样');

  // ⑥源码守卫(字符串断言 —— 定时器接线与 route 内联的 log 提示无法纯函数化)
  {
    const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
    assert.ok(!/8 \* 60 \* 1000\);\s*\n\s*killTimer\.unref/.test(src),
      'r34-⑥: 旧的 8 分钟 killTimer 形态必须消除');
    const noticeBody = src.slice(src.indexOf('const notice = setTimeout'), src.indexOf('const hard = setTimeout'));
    assert.ok(noticeBody.length > 0, 'r34-⑥: 找得到慢提示定时器');
    assert.ok(!/kill\(|killUpdateTree\(/.test(noticeBody),
      'r34-⑥: 慢提示回调里不得出现任何杀进程调用');
    assert.ok(/const clearUpdateTimers = startUpdateTimers\(\)/.test(src),
      'r34-⑥: stream 路由用 startUpdateTimers 接线');
    assert.ok((src.match(/clearUpdateTimers\(\)/g) || []).length >= 3,
      'r34-⑥: 声明 + close/error 两处收尾都要 clear(漏一处会误杀下一次更新)');
    assert.ok(/proxyUrl = await liveProxy\(rawProxy\)/.test(src),
      'r34-⑥: 更新 spawn 前的代理必须过探活');
    assert.ok(!/const proxyUrl = await detectLocalProxy\(\)\.catch/.test(src),
      'r34-⑥: 喂给终端脚本/子进程的代理不得再用未探活的 detectLocalProxy');

    // ⑦【致命】判死之后必须把代理从子进程 env 里删掉。只"不注入"的话,rawProxy 多半就来自
    // server 自己的 env,{...process.env} 原样带给 npm —— 探活等于零效果,日志还撒谎说直连。
    const envBlock = src.slice(src.indexOf('const env = { ...process.env };'), src.indexOf('updateTask.cmd = cmd;'));
    assert.ok(/else if \(deadProxy\)/.test(envBlock), 'r34-⑦: 判死要有独立分支处理 env');
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'npm_config_proxy', 'npm_config_https_proxy']) {
      assert.ok(new RegExp(`'${k}'`).test(envBlock), `r34-⑦: 判死后必须从子进程 env 删掉 ${k}`);
    }
    assert.ok(/delete env\[k\]/.test(envBlock), 'r34-⑦: 真的 delete,不是只跳过注入');
    assert.ok(!/不可达,本次更新直连/.test(src),
      'r34-⑦: 不许说"直连" —— .npmrc 里的代理配置本进程管不到,话不能说满');
    assert.ok(/不再注入代理/.test(src), 'r34-⑦: 日志按事实说"不再注入代理"');
    assert.ok(/maskProxy\(deadProxy\)/.test(src) && /proxy: proxyUrl && maskProxy\(proxyUrl\)/.test(src),
      'r34-⑩: 死代理日志与 start 帧的 proxy 都要遮罩 userinfo');

    // ⑧spawn 前窗口的取消要真兑现(那时 child 还是 null,killUpdateTree 杀不到东西)
    assert.ok(/cancelRequested: false/.test(src), 'r34-⑧: 任务对象要有 cancelRequested');
    assert.ok(/if \(updateTask\.cancelRequested\) \{[\s\S]{0,400}return;/.test(src),
      'r34-⑧: spawn 前必须检查取消标志并直接收尾');
    const cancelIdx = src.indexOf("router.post('/claude-update/cancel'");
    const cancelBody = src.slice(cancelIdx, cancelIdx + 700);
    assert.ok(/killUpdateTree\(\)/.test(cancelBody), 'r34-⑧: cancel 是 r34 后唯一终止口,必须真杀');
    assert.ok(/updateTask\.cancelRequested = true/.test(cancelBody), 'r34-⑧: cancel 要落标志兜住 spawn 前窗口');
    assert.ok(/deferred: !hadChild/.test(cancelBody), 'r34-⑧: 回执要如实区分"已杀"与"记下待兑现"');

    // ③done 帧带 error,否则前端无条件覆盖成"命令退出码 null",恢复指引全丢
    assert.ok(/taskPush\(\{ type: 'done', code, error: updateTask\.error \}\)/.test(src),
      'r34-③: done 帧必须带上 error');

    // 前端接线
    const ui = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
    assert.ok(/claude-update\/cancel/.test(ui), 'r34-⑧: 前端要有取消入口(端点在此之前零 UI 调用)');
    assert.ok(/ev\.error \|\| `命令退出码/.test(ui), 'r34-③: 前端 done 分支优先用服务端给的 error');
    const btnIdx = ui.indexOf('<button onClick={doUpdateCancel}');
    assert.ok(btnIdx > 0, 'r34-⑥: 取消按钮要真的渲染出来');
    const gate = ui.slice(Math.max(0, btnIdx - 260), btnIdx); // 按钮上方的门控条件
    assert.ok(/updateRunning && \(/.test(gate), 'r34-⑥: 取消按钮由 updateRunning 门控');
    assert.ok(!/\{updating && \(/.test(gate),
      'r34-⑥: 不得绑通用忙标志 updating(switchActive/pauseOverride 也置真 → 按钮乱现)');
    assert.ok(!/state\.hasUpdate[\s\S]{0,4000}<button onClick=\{doUpdateCancel\}/.test(ui),
      'r34-⑥: 按钮不能埋在"已装且有新版"分支里 —— 半装时 claude 检测不到会走"未装"分支');
    assert.ok(/更新期间请勿在 GUI 内发消息/.test(ui), 'r34-⑦: 确认文案提示更新期间别发消息(Win 会重锁 claude.exe)');
  }
} finally {
  if (liveServer) await new Promise((r) => liveServer.close(r));
  cleanupDirs(TMP_HOME);
}

console.log('PASS check-r34-update-no-kill');
