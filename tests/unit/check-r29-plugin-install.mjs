#!/usr/bin/env node
// 单测:r29 Windows 插件安装「not found / out of date」根因修复(server/routes/mcp.js)。
// 根因:ensureOfficialMarketplace 里 `marketplace add`/`update` 都 catch{} 吞错 —— update 失败
// (无代理拉不动 GitHub / git 问题 / 30s 超时)时缓存停在旧 commit 或根本没有,install 必然
// not found,用户只看到最终 install 的错,真实原因(市场刷新失败)被吞。
// 覆盖:① update 失败透出(不再静默)② add 幂等报错仍忽略、其余抛出
//      ③ install not found → 刷新市场重试一次 ④ 重试仍失败 → 完整因果链文案 + 可执行指引
//      ⑤ 刷新本身失败 → 根因直出、不无谓重试 ⑥ 非 not-found 错误原样抛、不触发刷新
//      ⑦ 代理 env 注入(mock detectLocalProxy,不覆盖已有 env)⑧ 接线哨兵。
// 全部 mock run/detect,不碰真实 claude CLI、不碰网络、不读写 ~/.claude。
// Run: node tests/unit/check-r29-plugin-install.mjs
// 变异哨兵(实际验证过红):
//   S1 ensureMarketplace 的 update 改回 try{}catch{} → t1 红(错误重新被吞)
//   S2 installPluginWithRefresh 删掉重试分支 → t3 红(第一次 install 失败即终态)
//   S3 marketplaceProxyEnv 改成无条件覆盖 baseEnv → t7c 红(用户已有 HTTPS_PROXY 被盖)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pluginInstallErrorMessage } from '../../client/src/utils/builtinPlugins.js';

const {
  ensureMarketplace, installPluginWithRefresh, marketplaceProxyEnv, probePluginProxy,
  PLUGIN_CLI_TIMEOUT_MS,
  isMarketplaceAddIdempotent, isMarketplaceStaleError,
  isRetryablePluginNetworkError, sanitizePluginErrorText,
} = await import('../../server/routes/mcp.js');

const MK = 'claude-plugins-official';
const REPO = 'anthropics/claude-plugins-official';
// 记录调用序列的 mock runClaude;fails: { 命令key: Error } 按子串匹配抛错。
const mockRun = (fails = {}) => {
  const calls = [];
  const run = async (args, opts) => {
    calls.push({ args, opts });
    const cmd = args.join(' ');
    for (const [key, err] of Object.entries(fails)) {
      if (cmd.includes(key)) throw err;
    }
    return '';
  };
  return { calls, run };
};
const cliErr = (stderr) => Object.assign(new Error(`Command failed: ${stderr}`), { stderr: Buffer.from(stderr) });
const noProxy = async () => null;

// t1 marketplace update 失败 → 错误透出,带 stderr 原文(不再静默吞掉)
{
  const { run } = mockRun({ 'marketplace update': cliErr('fatal: unable to access github.com: ETIMEDOUT') });
  await assert.rejects(
    () => ensureMarketplace({ repo: REPO, marketplace: MK, run, detect: noProxy }),
    (e) => e.message.includes('刷新插件市场') && e.message.includes('ETIMEDOUT'),
    't1: update 失败必须抛出且带 stderr 原文',
  );
}

// t2 add 的「已存在」幂等报错仍忽略;其余 add 错误抛出
{
  assert.ok(isMarketplaceAddIdempotent(cliErr(`Marketplace "${MK}" already exists`)), 't2: already exists 判幂等');
  assert.ok(!isMarketplaceAddIdempotent(cliErr('fatal: repository not found')), 't2: 真错误不算幂等');
  const { run } = mockRun({ 'marketplace add': cliErr(`Marketplace "${MK}" already exists`) });
  await ensureMarketplace({ repo: REPO, marketplace: MK, run, detect: noProxy }); // 不抛即过
  const { run: run2 } = mockRun({ 'marketplace add': cliErr('fatal: repository not found') });
  await assert.rejects(
    () => ensureMarketplace({ repo: REPO, marketplace: MK, run: run2, detect: noProxy }),
    (e) => e.message.includes('注册插件市场失败') && e.message.includes('repository not found'),
    't2: add 真错误必须抛出',
  );
}

// t3 install 报 not found → 先刷新市场(update 成功)再重试 install,第二次成功
{
  let installN = 0;
  const calls = [];
  const run = async (args, opts) => {
    calls.push(args.join(' '));
    if (args[1] === 'install') {
      installN++;
      if (installN === 1) throw cliErr(`Plugin "code-review" not found in marketplace "${MK}". Your local copy may be out of date`);
    }
    return '';
  };
  await installPluginWithRefresh({ name: 'code-review', marketplace: MK, repo: REPO, run, detect: noProxy });
  assert.deepEqual(calls.map((c) => c.replace(/^.+?plugin /, 'plugin ')), [
    'plugin install code-review@claude-plugins-official',
    'plugin marketplace add anthropics/claude-plugins-official',
    'plugin marketplace update claude-plugins-official',
    'plugin install code-review@claude-plugins-official',
  ], 't3: not found → add(幂等)+update 刷新后重试 install 一次');
  assert.equal(installN, 2, 't3: install 恰两次');
}

// t3b 第三方无 repo 的 stale 回退只能 update 目标市场，不能借用 official repo。
{
  let installN = 0;
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(' '));
    if (args[1] === 'install' && installN++ === 0) throw cliErr('plugin not found in marketplace; local copy is out of date');
    return '';
  };
  await installPluginWithRefresh({
    name: 'third-party-plugin', marketplace: 'third-party-marketplace', run,
    detect: noProxy, baseEnv: {}, probe: async () => false,
  });
  assert.deepEqual(calls, [
    'plugin install third-party-plugin@third-party-marketplace',
    'plugin marketplace update third-party-marketplace',
    'plugin install third-party-plugin@third-party-marketplace',
  ], 't3b: 第三方无repo只刷新目标市场并重试，不add official');
}

// t4 刷新成功但重试仍失败 → 完整因果链文案 + 可执行指引
{
  const { run } = mockRun({
    'install': cliErr(`Plugin "x" not found in marketplace "${MK}". Your local copy may be out of date`),
  });
  await assert.rejects(
    () => installPluginWithRefresh({ name: 'x', marketplace: MK, repo: REPO, run, detect: noProxy }),
    (e) => e.message.includes('安装失败')
      && e.message.includes('已尝试刷新插件市场')
      && e.message.includes('首次错误')
      && e.message.includes('not found')
      && e.message.includes(`claude plugin marketplace update ${MK}`)
      && /网络\/代理/.test(e.message),
    't4: 因果链文案含安装错误+已刷新+手动指引',
  );
}

// t5 刷新本身就失败 → 根因(update 错误)直出,不无谓重试 install
{
  let installN = 0;
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(' '));
    if (args[1] === 'install') { installN++; throw cliErr('not found in marketplace'); }
    if (args.join(' ').includes('marketplace update')) throw cliErr('git fetch: Connection closed by 198.18.0.1');
    return '';
  };
  await assert.rejects(
    () => installPluginWithRefresh({ name: 'x', marketplace: MK, repo: REPO, run, detect: noProxy }),
    (e) => e.message.includes('安装失败')
      && e.message.includes('已尝试刷新插件市场失败')
      && e.message.includes('Connection closed')
      && e.message.includes(`claude plugin marketplace update ${MK}`),
    't5: 刷新失败要透出刷新错误本身(真实根因)',
  );
  assert.equal(installN, 1, 't5: 刷新失败不再无谓重试 install');
}

// t6 非「not found」形态的 install 错误原样抛出,不触发刷新
{
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(' '));
    if (args[1] === 'install') throw cliErr('permission denied writing plugins dir');
    return '';
  };
  await assert.rejects(
    () => installPluginWithRefresh({ name: 'x', marketplace: MK, run, detect: noProxy }),
    (e) => e.message.includes('permission denied'),
  );
  assert.equal(calls.filter((c) => c.includes('marketplace update')).length, 0, 't6: 非缓存过期形态不刷新市场');
}

// t6b 缓存直装不应为了代理预检触网；首次 install 使用无代理环境，成功即结束。
{
  let detectCalls = 0;
  let probeCalls = 0;
  const inherited = {
    HTTP_PROXY: 'http://reachable-but-rejecting:8080',
    HTTPS_PROXY: 'http://reachable-but-rejecting:8080',
    KEEP: 'yes',
  };
  const { calls, run } = mockRun();
  await installPluginWithRefresh({
    name: 'cached', marketplace: MK, run,
    baseEnv: inherited,
    detect: async () => { detectCalls++; return null; },
    probe: async () => { probeCalls++; return true; },
  });
  assert.equal(calls.length, 1, 't6b: 缓存命中只执行一次 install');
  assert.equal(calls[0].opts.env.HTTP_PROXY, undefined, 't6b: 首次离线 install 不继承代理');
  assert.equal(calls[0].opts.env.HTTPS_PROXY, undefined, 't6b: 首次离线 install 不继承代理');
  assert.equal(calls[0].opts.env.KEEP, 'yes', 't6b: 非代理环境保持');
  assert.equal(detectCalls, 0, 't6b: 缓存命中不运行自动代理探测');
  assert.equal(probeCalls, 0, 't6b: 缓存命中不发代理探活连接');
  assert.deepEqual(inherited, {
    HTTP_PROXY: 'http://reachable-but-rejecting:8080',
    HTTPS_PROXY: 'http://reachable-but-rejecting:8080',
    KEEP: 'yes',
  }, 't6b: 不修改父环境');
}

// t7 代理 env 注入(mock detectLocalProxy)
{
  // t7a 探到且探活成功的代理 → 四键注入(baseEnv 显式传空)
  const proxy = 'http://127.0.0.1:7899';
  const liveProbe = async (value) => value === proxy || value === 'http://corp:8080';
  const env7a = await marketplaceProxyEnv(async () => proxy, {}, liveProbe);
  assert.equal(env7a.HTTP_PROXY, proxy);
  assert.equal(env7a.HTTPS_PROXY, proxy);
  assert.equal(env7a.http_proxy, proxy);
  assert.equal(env7a.https_proxy, proxy);

  // t7a' 接线:ensureMarketplace 把安全环境副本传给 run 的 opts.env。
  const { calls, run } = mockRun();
  await ensureMarketplace({ marketplace: MK, run, detect: async () => proxy, baseEnv: {}, probe: liveProbe });
  const updOpts = calls.find((c) => c.args.includes('update'))?.opts;
  assert.ok(updOpts && typeof updOpts.env === 'object', "t7a': marketplace update 调用带安全env");
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    assert.equal(updOpts.env[k], proxy, `t7a': 空键 ${k} 应注入代理`);
  }
  assert.equal(updOpts.timeout, PLUGIN_CLI_TIMEOUT_MS, "t7a': marketplace update 使用统一120秒预算");

  // t7b 探测不到/探测抛错 → 安全env为空,不炸主流程
  assert.deepEqual(await marketplaceProxyEnv(noProxy, {}, liveProbe), {});
  assert.deepEqual(await marketplaceProxyEnv(async () => { throw new Error('probe boom'); }, {}, liveProbe), {});

  // t7c 可达继承值原样保留，自动代理只补空键；父 env 不被修改。
  const parent = { HTTPS_PROXY: 'http://corp:8080', OTHER: 'keep' };
  const merged = await marketplaceProxyEnv(async () => proxy, parent, liveProbe);
  assert.equal(merged.HTTPS_PROXY, 'http://corp:8080', 't7c: 已有可达 HTTPS_PROXY 原样保留');
  assert.equal(merged.HTTP_PROXY, 'http://127.0.0.1:7899', 't7c: 缺的键仍注入');
  assert.deepEqual(parent, { HTTPS_PROXY: 'http://corp:8080', OTHER: 'keep' }, 't7c: 不修改父env');

  // t7d 四种继承值逐一探活，死值不进子进程环境，可达值保留。
  const probes = [];
  const inherited = {
    HTTP_PROXY: 'http://dead-a:1',
    HTTPS_PROXY: 'http://live-b:2',
    http_proxy: 'http://dead-c:3',
    https_proxy: 'http://live-d:4',
  };
  const sanitized = await marketplaceProxyEnv(
    async () => null,
    inherited,
    async (value) => { probes.push(value); return value.includes('live'); },
  );
  assert.deepEqual(probes, Object.values(inherited), 't7d: 四键逐一探活');
  assert.equal(sanitized.HTTP_PROXY, undefined);
  assert.equal(sanitized.http_proxy, undefined);
  assert.equal(sanitized.HTTPS_PROXY, inherited.HTTPS_PROXY);
  assert.equal(sanitized.https_proxy, inherited.https_proxy);
  assert.deepEqual(Object.keys(inherited), ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'], 't7d: 父env键未删');

  let detectedBaseEnv = null;
  await marketplaceProxyEnv(
    ({ baseEnv }) => { detectedBaseEnv = baseEnv; return null; },
    { HTTP_PROXY: 'http://dead-a:1', KEEP: 'yes' },
    async () => false,
  );
  assert.deepEqual(detectedBaseEnv, { KEEP: 'yes' }, 't7d: 自动探测基于已剔除死值的副本');

  // t7e URL 探活只传 host/port/短超时给 TCP probe。
  assert.equal(await probePluginProxy('http://proxy.test:8443', async (host, port, timeout) => {
    assert.deepEqual({ host, port, timeout }, { host: 'proxy.test', port: 8443, timeout: 600 });
    return true;
  }), true);
}

// t8 接线哨兵(源码级):吞错模式不得回归、安全env接线、Windows 红线(无 sh -lc)
{
  const src = readFileSync(new URL('../../server/routes/mcp.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ detectUv, detectLocalProxy, probeTcp \} from '\.\/version-check\.js'/,
    't8: 复用现有TCP探活');
  assert.match(src, /export async function marketplaceProxyEnv/, 't8: 代理 env 助手存在');
  assert.match(src, /env \|\| await marketplaceProxyEnv\(detect, baseEnv, probe\)/, 't8: ensureMarketplace 构造安全env');
  // ensureOfficialMarketplace 旧吞错形态(两行 try{...}catch{})不得回归
  const ensureBody = src.slice(src.indexOf('async function ensureOfficialMarketplace'));
  assert.ok(!ensureBody.slice(0, ensureBody.indexOf('}')).includes('catch {}'), 't8: ensureOfficialMarketplace 不得再 catch{} 吞错');
  assert.match(src, /await installPluginWithRefresh\(/, 't8: install 路由接重试逻辑');
  assert.match(src, /env: env \? \{ \.\.\.env \} : \{ \.\.\.process\.env, \.\.\.\(extraEnv \|\| \{\}\) \}/,
    't8: runClaude 可接受完整安全env副本');
  assert.ok(!src.includes('sh -lc'), 't8: Windows 红线 —— 不得用 sh -lc');

  assert.equal(pluginInstallErrorMessage({ message: '代理不可达' }), '代理不可达',
    't8: MCPPanel 展示结构化 error.message，不得变成 [object Object]');
  assert.equal(pluginInstallErrorMessage('旧版字符串错误'), '旧版字符串错误', 't8: 兼容旧字符串错误');
  assert.equal(pluginInstallErrorMessage({ stage: 'plugin-install' }), '安装失败', 't8: 缺message回退');
}

// t9 结构化阶段、超时元数据与刷新因果链。
{
  const timeoutError = Object.assign(new Error('command timed out'), {
    killed: true, code: 'ETIMEDOUT', signal: 'SIGTERM',
  });
  await assert.rejects(
    () => installPluginWithRefresh({
      name: 'x', marketplace: MK, run: async () => { throw timeoutError; },
      detect: noProxy, baseEnv: {}, probe: async () => false,
    }),
    (error) => {
      assert.deepEqual({
        stage: error.details?.stage,
        code: error.details?.code,
        retryable: error.details?.retryable,
        timeoutMs: error.details?.timeoutMs,
        killed: error.details?.killed,
        timedOut: error.details?.timedOut,
        cliExitCode: error.details?.cliExitCode,
        signal: error.details?.signal,
      }, {
        stage: 'plugin-install', code: 'CLI_TIMEOUT', retryable: true,
        timeoutMs: 120000, killed: true, timedOut: true,
        cliExitCode: 'ETIMEDOUT', signal: 'SIGTERM',
      });
      return true;
    },
  );

  const calls = [];
  const updateFails = async (args, opts) => {
    calls.push({ args, opts });
    if (args[1] === 'install') throw cliErr('plugin not found in marketplace');
    if (args[2] === 'update') throw Object.assign(cliErr('git fetch failed'), { code: 19, killed: false, signal: null });
    return '';
  };
  await assert.rejects(
    () => installPluginWithRefresh({
      name: 'x', marketplace: MK, repo: REPO, run: updateFails,
      detect: noProxy, baseEnv: {}, probe: async () => false,
    }),
    (error) => error.details?.stage === 'marketplace-update'
      && error.details?.code === 'CLI_EXIT_NONZERO'
      && error.details?.cliExitCode === 19
      && /首次|安装失败/.test(error.details?.message || ''),
    't9: not-found→update失败以marketplace-update为终态并保留首次安装因果',
  );
  assert.ok(calls.every(({ opts }) => opts.timeout === 120000), 't9: add/update/install统一120秒');
  assert.ok(calls.every(({ opts }) => opts.killTreeOnTimeout === true), 't9: 三阶段超时均终止整棵子进程树');
}

// t10 CLI 错误在 PluginCliError 边界统一脱敏/限长，网络非零只按窄白名单可重试。
{
  const secrets = ['url-user', 'url-pass', 'bearer-token', 'query-token', 'api-secret', 'json-auth', 'json-token', 'kv-pass'];
  const raw = [
    'R33_SAFE_CONTEXT marketplace-add',
    `url=https://${secrets[0]}:${secrets[1]}@example.invalid/repo?access_token=${secrets[3]}&api_key=${secrets[4]}`,
    `Authorization: Bearer ${secrets[2]}`,
    JSON.stringify({ authorization: `Bearer ${secrets[5]}`, token: secrets[6] }),
    `password=${secrets[7]}`,
    'bounded-context '.repeat(1000),
  ].join('\n');
  const sanitized = sanitizePluginErrorText(raw);
  assert.ok(sanitized.includes('R33_SAFE_CONTEXT'), 't10: 保留安全诊断上下文');
  assert.ok(sanitized.includes('[REDACTED]'), 't10: 敏感值替换为占位');
  assert.ok(secrets.every((secret) => !sanitized.includes(secret)), 't10: URL/header/query/JSON/kv秘密全部移除');
  assert.ok(sanitized.length <= 4096, 't10: 单字段最多4096字符');

  const run = async () => { throw cliErr(raw); };
  await assert.rejects(
    () => installPluginWithRefresh({ name: 'x', marketplace: MK, run, baseEnv: {} }),
    (error) => error.details?.stage === 'plugin-install'
      && error.details.message.includes('R33_SAFE_CONTEXT')
      && error.details.message.length <= 4096
      && secrets.every((secret) => !JSON.stringify(error.details).includes(secret)),
    't10: 真实PluginCliError details同样脱敏且有界',
  );

  for (const message of [
    'recv failure: connection reset by peer',
    'connect ECONNREFUSED 127.0.0.1:443',
    'getaddrinfo ENOTFOUND example.invalid',
    'TLS handshake failed',
    'temporary failure in name resolution',
    'network timeout while fetching',
  ]) assert.equal(isRetryablePluginNetworkError(cliErr(message)), true, `t10: 网络错误应可重试: ${message}`);
  for (const message of [
    'permission denied for repository',
    'invalid marketplace name',
    'plugin not found in marketplace',
  ]) assert.equal(isRetryablePluginNetworkError(cliErr(message)), false, `t10: 终态错误不可重试: ${message}`);
}

console.log('✓ check-r29-plugin-install: update 透出 + add 幂等 + not-found 重试/因果链 + 代理注入 + 哨兵');
// mcp.js 模块顶层有 setTimeout 预热(会 spawn claude CLI),显式退出避免测试进程挂 8s。
process.exit(0);
