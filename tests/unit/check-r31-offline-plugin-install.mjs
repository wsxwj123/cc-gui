#!/usr/bin/env node
// r31 钉子:断网时本地缓存可装的插件不被安装前的市场刷新挡住(r29 回归守卫)。
// 根因:r29 把 /plugins/install 路由改成「先 ensureMarketplace(含 marketplace update)再
// 装」,且 update 失败直接抛错。断网/代理拉不动 GitHub 时 update 必挂 → 安装前即 500,
// 本地缓存里明明可装的插件也装不上。修:路由不再预刷新(仅自定义源保留幂等 add 注册),
// 刷新交由 installPluginWithRefresh 在 install 报 not-found/过期形态时按需做。
// 钉:①install 主路径直接 install(不先刷新)——本地缓存可装即装;②路由不预刷新
//      (不 pre 调 ensureMarketplace/ensureOfficialMarketplace);③refresh 仅在 not-found/
//      过期形态触发;④非 not-found 错误原样抛、不触发刷新。
// Run: node tests/unit/check-r31-offline-plugin-install.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installPluginWithRefresh } from '../../server/routes/mcp.js';

const src = readFileSync(new URL('../../server/routes/mcp.js', import.meta.url), 'utf8');
const MK = 'claude-plugins-official';
const REPO = 'anthropics/claude-plugins-official';

// ① install 主路径直接 install(不先刷新)——离线缓存可装场景
{
  const calls = [];
  const run = async (args, opts) => { calls.push(args.join(' ')); return ''; };
  await installPluginWithRefresh({ name: 'code-review', marketplace: MK, repo: REPO, run, detect: async () => null });
  assert.deepEqual(calls.map((c) => c.split(' ').slice(0, 5).join(' ')), ['plugin install code-review@claude-plugins-official'],
    '① 主路径直接 install(成功即返回,不刷新市场)- 本地缓存可装即装');
  assert.equal(calls.filter((c) => c.includes('marketplace update')).length, 0,
    '① install 成功不触发 marketplace update(不无谓刷新)');
}

// ② 路由源码钉:安装前不预刷新(不 pre 调 ensureMarketplace/ensureOfficialMarketplace)
{
  const route = src.slice(src.indexOf("router.post('/plugins/install'"), src.indexOf('// GET /api/plugins/:name/contents'));
  assert.ok(route.includes('await installPluginWithRefresh({'), '② 路由安装走 installPluginWithRefresh');
  const preInstall = route.slice(0, route.indexOf('await installPluginWithRefresh({'));
  assert.doesNotMatch(preInstall, /await ensureMarketplace\(|await ensureOfficialMarketplace\(/,
    '② 安装前不得预刷新(ensureMarketplace/ensureOfficialMarketplace)—— 断网会挡安装');
  assert.match(preInstall, /marketplace/, '② 仅保留自定义源 add 注册(幂等)相关代码');
  assert.ok(!preInstall.includes('marketplace update'), '② 安装前不得做 marketplace update(刷新)');
}

// ③ refresh 仅在 not-found/过期形态触发(installPluginWithRefresh 内部)
{
  const calls = [];
  let n = 0;
  const run = async (args) => {
    calls.push(args.join(' '));
    if (args[1] === 'install') { n++; if (n === 1) throw Object.assign(new Error('x'), { stderr: Buffer.from('Plugin "x" not found in marketplace. Your local copy may be out of date') }); }
    return '';
  };
  await installPluginWithRefresh({ name: 'x', marketplace: MK, repo: REPO, run, detect: async () => null });
  assert.ok(calls.some((c) => c.includes('marketplace update')), '③ not-found 形态 → 触发刷新重试');
}

// ④ 非 not-found 错误原样抛,不触发刷新
{
  const calls = [];
  const run = async (args) => { calls.push(args.join(' ')); if (args[1] === 'install') throw Object.assign(new Error('x'), { stderr: Buffer.from('permission denied') }); return ''; };
  await assert.rejects(() => installPluginWithRefresh({ name: 'x', marketplace: MK, repo: REPO, run, detect: async () => null }),
    (e) => (e.stderr?.toString() || e.message).includes('permission denied'));
  assert.equal(calls.filter((c) => c.includes('marketplace update')).length, 0, '④ 非 not-found 不触发刷新');
}

console.log('PASS check-r31-offline-plugin-install');
