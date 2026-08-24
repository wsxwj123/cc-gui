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
//   ⑤liveProxy:探活不通不注入 / 通了才注入(死代理注进去 = 用户看到"更新卡死");
//   ⑥源码守卫(字符串断言):8 分钟那条路径上不得再出现 killUpdateTree()。
// 测试端口只用 6703(活)/6704(死),跑完关干净。
// Run: node tests/unit/check-r34-update-no-kill.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { makeTmpHome, cleanupDirs } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('r34-unit'); // version-check 顶层固化 PREFS_FILE,先隔离 HOME
const LIVE_PORT = 6703;
const DEAD_PORT = 6704; // 全程没人 listen

const NPM_CMD = 'npm install -g @anthropic-ai/claude-code@latest && "$(npm prefix -g)/bin/claude" --version';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let liveServer = null;
try {
  const {
    startUpdateTimers, withRecoveryHint, isNpmRegistryCmd, liveProxy,
    UPDATE_SLOW_NOTICE_MS, UPDATE_HARD_LIMIT_MS, UPDATE_SLOW_NOTICE_LINE, UPDATE_HARD_LIMIT_ERROR,
  } = await import('../../server/routes/version-check.js');

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

  // ④恢复指引只挂在 npm 渠道(native `claude upgrade` 是原子替换,没有半成品问题)
  assert.equal(isNpmRegistryCmd(NPM_CMD), true, 'r34-④: 识别 npm-registry 更新命令');
  assert.equal(isNpmRegistryCmd("'/usr/local/bin/claude' upgrade"), false, 'r34-④: native 命令不算 npm 渠道');
  assert.equal(isNpmRegistryCmd(''), false, 'r34-④: 空命令(尚未解析出)不算');
  assert.ok(/重新运行一次更新即可补齐/.test(withRecoveryHint('已由用户终止', NPM_CMD)),
    'r34-④: npm 渠道的中断必须带恢复指引');
  assert.equal(withRecoveryHint('已由用户终止', 'claude upgrade'), '已由用户终止',
    'r34-④: 非 npm 渠道不加噪音');
  assert.ok(withRecoveryHint(UPDATE_HARD_LIMIT_ERROR, NPM_CMD).startsWith(UPDATE_HARD_LIMIT_ERROR),
    'r34-④: 指引是追加,不覆盖原因');

  // ⑤代理探活分流:不通不注入 / 通了才注入
  {
    assert.equal(await liveProxy(null), null, 'r34-⑤: 没探到代理就是直连');
    assert.equal(await liveProxy(`http://127.0.0.1:${DEAD_PORT}`), null,
      'r34-⑤: 代理不可达必须【不注入】(变异哨兵 —— 删掉探活分流这里必红)');
    assert.equal(await liveProxy('not a url'), null, 'r34-⑤: 代理地址解析不了同样不注入');

    liveServer = createServer();
    await new Promise((r) => liveServer.listen(LIVE_PORT, '127.0.0.1', r));
    const liveUrl = `http://127.0.0.1:${LIVE_PORT}`;
    assert.equal(await liveProxy(liveUrl), liveUrl, 'r34-⑤: 探活通过才注入');
    // 探活器自己抛错也不能"疑罪从有"地注入
    assert.equal(await liveProxy(liveUrl, async () => { throw new Error('boom'); }), null,
      'r34-⑤: 探活失败一律直连');
  }

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
    assert.ok(/if \(deadProxy\) taskPush\(\{ type: 'log', line: `检测到代理 \$\{deadProxy\} 不可达/.test(src),
      'r34-⑥: 探活不通要在流里说明改直连');
    assert.ok(!/const proxyUrl = await detectLocalProxy\(\)\.catch/.test(src),
      'r34-⑥: 喂给终端脚本/子进程的代理不得再用未探活的 detectLocalProxy');
  }
} finally {
  if (liveServer) await new Promise((r) => liveServer.close(r));
  cleanupDirs(TMP_HOME);
}

console.log('PASS check-r34-update-no-kill');
