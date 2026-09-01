#!/usr/bin/env node
// r71:市场浏览层的接线审计。两件事:
//   ① 浏览控件真的接在市场组件上(搜索 / 来源分面 / 安装状态 / 排序 / 长列表都有锚)
//   ② 安装链路零改动 —— 这是本轮的安全红线:只做浏览层,不碰装机
//      · 服务端 skills.js 的安装关键行逐条对齐(内容锁)
//      · 改动文件名单锁(git diff 白名单),越界即红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');
const panel = read('client/src/components/SkillsPanel.jsx');
const market = read('client/src/utils/skillMarket.js');

// ── ① 浏览控件接线锚 ──────────────────────────────────────────────────
for (const tid of ['market-search', 'market-source-facet', 'market-source-chip', 'market-source-count',
  'market-installed-filter', 'market-sort', 'market-list', 'market-row', 'market-empty', 'market-result-count']) {
  assert.ok(panel.includes(`data-testid="${tid}"`), `市场组件缺锚点 ${tid}`);
}
// 控件必须真的驱动列表:渲染的是筛选排序后的 marketView,不是原始 official
assert.ok(/marketView\.map\(/.test(panel), '列表必须渲染 marketView(筛选+排序后的),渲染 official 等于控件是摆设');
assert.ok(/sortMarket\(filterMarket\(official/.test(panel), '先筛后排,输入是 official');
assert.ok(/value=\{mq\}[\s\S]{0,120}onChange=\{\(e\) => setMq\(/.test(panel), '搜索框是受控输入,即输即滤');
// 跨源 id 会撞:列表 key / 展开态 / 忙碌标记必须用 marketKey,不能退回裸 id
assert.ok(/key=\{k\}/.test(panel) && /const k = marketKey\(s\)/.test(panel), '列表 key 必须用 marketKey(source:id)');
assert.ok(!/key=\{s\.id\}[\s\S]{0,400}data-testid="market-row"/.test(panel), '市场行不得用裸 id 当 key');
assert.ok(/busy\.has\(k\)/.test(panel) && !/busy\.has\(s\.id\)/.test(panel), '忙碌标记用 marketKey,否则跨源同名条目一起转圈');
// 长列表性能:用浏览器原生 content-visibility,不引依赖、不改 DOM 结构
assert.ok(/contentVisibility: 'auto'/.test(panel) && /containIntrinsicSize/.test(panel), '长列表须挂 content-visibility 占位');
assert.ok(/style=\{ROW_CV\}/.test(panel), 'ROW_CV 必须挂到行上(模块级常量,避免每次渲染新对象)');
// 浏览层是纯客户端:不新增端点、不发写请求
assert.ok(!/fetch\(/.test(market), 'skillMarket.js 必须是纯函数模块,不许发请求');
assert.ok(!/method: 'POST'|method: 'DELETE'/.test(market), 'skillMarket.js 不许有写操作');

// ── ② 安装链路内容锁:这些行一个字都不该因为本轮改动而变 ──────────────────
const server = read('server/routes/skills.js');
for (const line of [
  "router.post('/skills/import', async (req, res) => {",
  'async function doImport(repo, branchArg, ids, overwrite, force = false, host = \'github\') {',
  'if (exists && !overwrite) { conflicts.push(id); continue; }',
  'const existed = await stat(dest).then(() => true).catch(() => false);',
  'if (existed) { dstashed = `${dest}.old-${Date.now()}`; await rename(dest, dstashed); }',
  'sourcesPatch[id] = { repo, branch, root: meta.root, host, sha: dirShas[meta.root] || null };',
]) assert.ok(server.includes(line), `安装逻辑被动过:缺 ${line.slice(0, 60)}`);

// 前端导入请求体形状不变(只多了一个显式 source 覆盖 —— 合并视图下每条按自己的源装,
// 否则 source='__all__' 传到后端会静默回落 SOURCES[0],把同名 skill 从错误仓库装进来)
assert.ok(panel.includes("await fetch('/api/skills/import', {"), '导入仍走同一端点');
assert.ok(/activeRepo \? \{ repo: activeRepo, branch: activeBranch, host: activeHost, ids, overwrite \} : \{ source: srcOverride \|\| source, ids, overwrite \}/.test(panel),
  '导入请求体形状必须保持(自定义仓库分支原样,内置源分支只加 srcOverride 兜底)');
assert.ok(/runImport\(\[s\.id\], false, k, false, s\.source\)/.test(panel), '合并视图逐条导入必须带上该条自己的来源');
assert.ok(/runImport\(conflicts, true, 'all', false, conflictSrc\)/.test(panel), '重名覆盖必须沿用触发时的来源');
assert.ok(/disabled=\{loadingOff \|\| busy\.size > 0 \|\| notInstalled\.length === 0 \|\| ms\.selMode \|\| isAllSources\}/.test(panel),
  '合并视图必须禁用一键导入全部(一次调用只能带一个 source,硬装会装错仓库)');
// 浏览层不许新增任何"点一下就执行"的通道:市场条目是纯文本清单
assert.ok(!/dangerouslySetInnerHTML|eval\(|new Function/.test(panel), '市场组件不得引入任何执行通道');

// ── ③ 改动文件名单锁 ──────────────────────────────────────────────────
// 本轮只允许动这三个文件。git 不可用(打包产物里跑)则跳过,不是失败。
let changed = null;
try {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf-8' }).split('\n').map((s) => s.trim()).filter(Boolean);
  const base = git('merge-base', 'HEAD', 'master')[0];
  // 已跟踪的改动 + 未跟踪的新文件(新增的纯函数模块与本测试都属后者,只看 diff 会漏)。
  // worktree 里的 node_modules 是手工软链、未被 .gitignore 命中,排掉。
  changed = [...new Set([...git('diff', '--name-only', base), ...git('ls-files', '--others', '--exclude-standard')])]
    .filter((f) => !f.startsWith('node_modules'));
} catch { /* 非 git 环境:跳过这一节 */ }
if (changed) {
  const ALLOW = new Set([
    'client/src/components/SkillsPanel.jsx',
    'client/src/utils/skillMarket.js',
    'tests/unit/check-r71-market-facets.mjs',
    'tests/unit/check-r71-market-wiring.mjs',
  ]);
  const stray = changed.filter((f) => !ALLOW.has(f));
  assert.deepEqual(stray, [], `本轮越界改动了不该动的文件(安装/服务端/genui 都在禁区):${stray.join(', ')}`);
  assert.ok(!changed.includes('server/routes/skills.js'), '服务端安装路由必须零改动');
}

console.log(`r71 市场接线审计通过${changed ? `(改动文件 ${changed.length} 个,均在白名单内)` : '(跳过 git 名单锁)'}`);
