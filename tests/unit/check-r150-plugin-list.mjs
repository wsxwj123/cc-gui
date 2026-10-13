#!/usr/bin/env node
// 单测:r150 E 组 —— `claude plugin list` 的输出解析(模块 server/utils/plugin-list.js,纯函数)。
//
// 背景:Claude CLI 会把 claude.ai 账号上启用的插件同步到本机,`claude plugin list` 把它们列在单独一段
// 「Synced from claude.ai:」下面。它们不在 ~/.claude/plugins/installed_plugins.json 里,而插件面板的列表
// 只读那个文件,所以面板里看不到它们(它们带来的 MCP 却出现在 MCP 列表里),用户没有入口整个停用。
//   E1 解析出这一段的插件:名字(<name>@synced)、版本、路径、启用状态(✔ loaded 与 ✔ enabled 都算启用)
//   另:这一段的插件不许覆盖"已安装插件"里同名插件的启用状态(原来按不带 @ 的名字记状态,后出现的盖掉先出现的)
// 界面与接口层见 tests/acceptance/r150-plugins。
// Run: node tests/unit/check-r150-plugin-list.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').slice(0, 14).join('\n      ')}`); }
};

// 任务书给的样例(同步已开)+ 前面一段已安装插件
const SAMPLE = `Installed plugins:

  ❯ pua@pua-skills
    Version: 2.0.0
    Scope: user
    Status: ✔ enabled

  ❯ design@acme-market
    Version: 0.9.0
    Scope: user
    Status: ✔ enabled

  ❯ broken@acme-market
    Version: 0.1.0
    Scope: user
    Status: ✘ failed to load

Synced from claude.ai:
  ❯ design@synced
    Version: 1.2.0
    Path: /Users/someone/.claude/plugins/synced/0a1b2c/design
    Status: ✘ disabled
  ❯ bio-research@synced
    Version: 1.2.0
    Path: /Users/someone/.claude/plugins/synced/0a1b2c/bio-research
    Status: ✔ loaded
  ❯ data@synced
    Version: 3.0.1
    Path: /Users/someone/.claude/plugins/synced/0a1b2c/data
    Status: ✔ enabled
`;
// 未开同步的环境里的标题
const SAMPLE_SYNC_OFF = `  ❯ pua@pua-skills
    Version: 2.0.0
    Scope: user
    Status: ✘ disabled

Synced from claude.ai — sync is off in this shell; these load only in a synced session:
  ❯ design@synced
    Version: 1.2.0
    Path: /Users/someone/.claude/plugins/synced/0a1b2c/design
    Status: ✔ enabled
`;

console.log('r150 E 组:claude plugin list 的解析');

let M = null;
await check('模块存在(server/utils/plugin-list.js)并导出 parsePluginList', async () => {
  M = await import(root + 'server/utils/plugin-list.js');
  assert.equal(typeof M.parsePluginList, 'function');
});
const need = () => assert.ok(M && typeof M.parsePluginList === 'function', '模块不存在');

await check('E1「Synced from claude.ai」一段的插件都解析出来:名字带 @synced、版本、路径;loaded 与 enabled 都算启用', async () => {
  need();
  const { synced } = M.parsePluginList(SAMPLE);
  assert.deepEqual(synced.map((p) => p.name), ['design@synced', 'bio-research@synced', 'data@synced']);
  assert.deepEqual(synced.map((p) => p.enabled), [false, true, true]);
  assert.deepEqual(synced.map((p) => p.version), ['1.2.0', '1.2.0', '3.0.1']);
  assert.equal(synced[1].path, '/Users/someone/.claude/plugins/synced/0a1b2c/bio-research');
});
await check('E1 未开同步时的标题(Synced from claude.ai — sync is off in this shell; …)同样认', async () => {
  need();
  const { synced, installed } = M.parsePluginList(SAMPLE_SYNC_OFF);
  assert.deepEqual(synced.map((p) => [p.name, p.enabled, p.version]), [['design@synced', true, '1.2.0']]);
  assert.deepEqual(installed, { pua: false });
});
await check('E1 已安装插件的启用状态只取"已安装"那一段:同名的同步插件不许盖掉它(原来:design 被同步段的 disabled 盖成停用)', async () => {
  need();
  const { installed } = M.parsePluginList(SAMPLE);
  assert.deepEqual(installed, { pua: true, design: true, broken: false });
});
await check('E1 没有同步段、空输出、非字符串:不抛,synced 为空', async () => {
  need();
  assert.deepEqual(M.parsePluginList('  ❯ pua@pua-skills\n    Version: 2.0.0\n    Status: ✔ enabled\n'), { installed: { pua: true }, synced: [] });
  assert.deepEqual(M.parsePluginList(''), { installed: {}, synced: [] });
  assert.deepEqual(M.parsePluginList(undefined), { installed: {}, synced: [] });
  assert.deepEqual(M.parsePluginList('No plugins installed.'), { installed: {}, synced: [] });
});
await check('E1 CRLF 行尾(Windows 上的 CLI 输出)结果相同', async () => {
  need();
  assert.deepEqual(M.parsePluginList(SAMPLE.replace(/\n/g, '\r\n')), M.parsePluginList(SAMPLE));
});
await check('E1 接线:插件列表接口(server/routes/mcp.js)用这个解析,并把同步段的插件放进返回的 plugins', async () => {
  const src = readFileSync(root + 'server/routes/mcp.js', 'utf8');
  assert.match(src, /import \{[^}]*parsePluginList[^}]*\} from '\.\.\/utils\/plugin-list\.js'/, 'mcp.js 没有引入 parsePluginList');
  assert.match(src, /source: 'synced'/, '返回的同步插件应带来源标记 source: \'synced\'');
});

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
