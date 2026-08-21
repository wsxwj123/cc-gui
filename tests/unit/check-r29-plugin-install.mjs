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

const {
  ensureMarketplace, installPluginWithRefresh, marketplaceProxyEnv,
  isMarketplaceAddIdempotent, isMarketplaceStaleError,
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

// t7 代理 env 注入(mock detectLocalProxy)
{
  // t7a 探到代理 → 四键注入(baseEnv 显式传空,本机 shell 可能已带小写 proxy env)
  const proxy = 'http://127.0.0.1:7899';
  const env7a = await marketplaceProxyEnv(async () => proxy, {});
  assert.equal(env7a.HTTP_PROXY, proxy);
  assert.equal(env7a.HTTPS_PROXY, proxy);
  assert.equal(env7a.http_proxy, proxy);
  assert.equal(env7a.https_proxy, proxy);

  // t7a' 接线:ensureMarketplace 把代理 env 传给 run 的 opts.extraEnv;
  // 对本进程未占用的键必须注入(已被进程 env 占用的键按不覆盖语义跳过)。
  const { calls, run } = mockRun();
  await ensureMarketplace({ marketplace: MK, run, detect: async () => proxy });
  const updOpts = calls.find((c) => c.args.includes('update'))?.opts;
  assert.ok(updOpts && typeof updOpts.extraEnv === 'object', "t7a': marketplace update 调用带 extraEnv");
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    if (!process.env[k]) assert.equal(updOpts.extraEnv[k], proxy, `t7a': 未占用键 ${k} 应注入代理`);
  }

  // t7b 探测不到/探测抛错 → extraEnv 空对象,不炸主流程
  assert.deepEqual(await marketplaceProxyEnv(noProxy, {}), {});
  assert.deepEqual(await marketplaceProxyEnv(async () => { throw new Error('probe boom'); }, {}), {});

  // t7c 用户已有 env 不被覆盖
  const merged = await marketplaceProxyEnv(async () => 'http://127.0.0.1:7899', { HTTPS_PROXY: 'http://corp:8080' });
  assert.ok(!('HTTPS_PROXY' in merged), 't7c: 已有 HTTPS_PROXY 不覆盖');
  assert.equal(merged.HTTP_PROXY, 'http://127.0.0.1:7899', 't7c: 缺的键仍注入');
}

// t8 接线哨兵(源码级):吞错模式不得回归、代理注入接线、Windows 红线(无 sh -lc)
{
  const src = readFileSync(new URL('../../server/routes/mcp.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ detectUv, detectLocalProxy \} from '\.\/version-check\.js'/, 't8: 只读 import detectLocalProxy');
  assert.match(src, /export async function marketplaceProxyEnv/, 't8: 代理 env 助手存在');
  assert.match(src, /extraEnv: await marketplaceProxyEnv\(detect\)/, 't8: ensureMarketplace 给 marketplace 操作注代理');
  // ensureOfficialMarketplace 旧吞错形态(两行 try{...}catch{})不得回归
  const ensureBody = src.slice(src.indexOf('async function ensureOfficialMarketplace'));
  assert.ok(!ensureBody.slice(0, ensureBody.indexOf('}')).includes('catch {}'), 't8: ensureOfficialMarketplace 不得再 catch{} 吞错');
  assert.match(src, /await installPluginWithRefresh\(/, 't8: install 路由接重试逻辑');
  assert.match(src, /env: \{ \.\.\.process\.env, \.\.\.\(extraEnv \|\| \{\}\) \}/, 't8: runClaude 合并 extraEnv');
  assert.ok(!src.includes('sh -lc'), 't8: Windows 红线 —— 不得用 sh -lc');
}

console.log('✓ check-r29-plugin-install: update 透出 + add 幂等 + not-found 重试/因果链 + 代理注入 + 哨兵');
// mcp.js 模块顶层有 setTimeout 预热(会 spawn claude CLI),显式退出避免测试进程挂 8s。
process.exit(0);
