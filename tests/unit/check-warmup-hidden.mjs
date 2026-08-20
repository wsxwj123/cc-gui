#!/usr/bin/env node
// 单测:r21 启动预热不许热用户看不见的项目(server/services/warmup.js)。
//
// 纯 node + node:assert/strict,**不起 server、不碰 ~/.claude**;prefs 夹具一律写
// os.tmpdir() 下的临时目录,跑完删。
//
// ⚠️ 夹具陷阱(别改成集成测法):若有人改成「造真 projects 夹具 + 假 HOME + 跑
// listProjects()」,session-reader.js:31-43 的 isNonProjectPath 会丢弃 /tmp、
// /private/tmp 及不存在的路径 → 项目列表恒空 → 「空 ⊆ 空」恒真 → 假绿。
// t2「预热集非空」就是拦这个,别删。
//
// 变异哨兵(实际验证过红,见报告):
//   S1 pickWarmupTargets 忽略 hidden(退回 slice(0,16))→ t1 红「预热集包含被隐藏的项目」
//   S2 cap 改回 16 → t4 红
//   S3 用 p.path 而不是 p.hash 比 hidden 名单 → t3 红
//   S4 readHiddenProjects 坏 prefs 回落成「全过滤」(返回全部 hash / 抛错)→ t5 红
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { pickWarmupTargets, readHiddenProjects } from '../../server/services/warmup.js';

// listProjects() 的形状:hash + path + lastActivity,已按 lastActivity 降序。
const P = (hash, path, lastActivity) => ({ hash, path, lastActivity, sessionCount: 1 });
const projects = [
  P('h-work', '/Users/x/work', '2026-08-20T10:00:00Z'),
  P('h-home', '/Users/x', '2026-08-20T09:00:00Z'),          // 家目录,已隐藏
  P('h-tmp', '/private/tmp/scratch', '2026-08-20T08:00:00Z'), // 已隐藏
  P('h-gui', '/Users/x/claude-gui', '2026-08-20T07:00:00Z'),
  P('h-big', '/Users/x/big-346mb', '2026-08-20T06:00:00Z'),  // 已隐藏(冷读 886ms 的那个)
  ...Array.from({ length: 20 }, (_, i) => P(`h-fill${i}`, `/Users/x/fill${i}`, '2026-01-01T00:00:00Z')),
];
const hidden = new Set(['h-home', 'h-tmp', 'h-big', 'h-stale-1', 'h-stale-2']); // 含陈旧 hash

// t1 预热集 ⊆ 可见集(核心断言:一个被隐藏的项目都不许进)
{
  const picked = pickWarmupTargets(projects, hidden, 8);
  const bad = picked.filter((p) => hidden.has(p.hash)).map((p) => p.hash);
  assert.deepEqual(bad, [], `t1: 预热集包含被隐藏的项目 → ${bad.join(',')}`);
}

// t2 预热集非空(防「空 ⊆ 可见」恒真的假绿;R7)
{
  assert.ok(pickWarmupTargets(projects, hidden, 8).length > 0, 't2: 预热集不该是空的(假绿哨兵)');
  // 全隐藏时才允许为空 —— 那是真的没东西可热
  assert.equal(pickWarmupTargets(projects, new Set(projects.map((p) => p.hash)), 8).length, 0,
    't2: 全隐藏 → 预热集为空(不是把隐藏的又放回来)');
}

// t3 口径是 hash 不是 path(R5:名单存 hash,用 path 比会恒不命中 = 改了等于没改且静默)
{
  const list = [P('h-a', '/p/a', null), P('h-b', '/p/b', null)];
  // 名单里放的是 hash「h-a」,同时故意让另一项目的 path 长得像它 —— 用 path 比会漏掉 h-a
  const picked = pickWarmupTargets(list, new Set(['h-a']), 8).map((p) => p.hash);
  assert.deepEqual(picked, ['h-b'], 't3: 必须按 hash 匹配 hiddenProjects,不是 path');
  // 反向:名单里放 path 不该误伤任何项目
  assert.equal(pickWarmupTargets(list, new Set(['/p/a']), 8).length, 2, 't3: 名单里的 path 不该被当 hash 命中');
}

// t4 上限与顺序(不得重排 listProjects 的 lastActivity 降序)
{
  const visible = projects.filter((p) => !hidden.has(p.hash));
  const picked = pickWarmupTargets(projects, hidden, 8);
  assert.equal(picked.length, 8, 't4: cap=8 生效(原来是 16)');
  assert.deepEqual(picked.map((p) => p.hash), visible.slice(0, 8).map((p) => p.hash),
    't4: 顺序 = 可见集原顺序的前 8 个(不得重排)');
  assert.equal(pickWarmupTargets(projects, new Set(), 8)[0].hash, 'h-work', 't4: 首个仍是最近活动的');
  // 无 hash 的脏条目不该混进去(listSessions(undefined) 白跑一趟)
  assert.equal(pickWarmupTargets([{ path: '/no/hash' }, P('h-ok', '/p/ok', null)], new Set(), 8).length, 1,
    't4: 无 hash 的条目被丢弃');
  // 入参防御:非数组不该抛(启动路径)
  assert.deepEqual(pickWarmupTargets(null, null), [], 't4: 入参为空不抛');
}

// t5 prefs 三种坏情况均回落「不过滤」(空 Set),而非「全过滤」(R2 红线)
{
  const dir = await mkdtemp(join(tmpdir(), 'cgui-warmup-test-'));
  try {
    const good = join(dir, 'good.json');
    await writeFile(good, JSON.stringify({ hiddenProjects: ['h-home', 'h-tmp'], pinned: {} }));
    assert.deepEqual([...(await readHiddenProjects(good))].sort(), ['h-home', 'h-tmp'], 't5: 正常读出名单');

    const broken = join(dir, 'broken.json');
    await writeFile(broken, '{ this is not json');
    assert.equal((await readHiddenProjects(broken)).size, 0, 't5: JSON 损坏 → 空 Set(不过滤)');

    const noField = join(dir, 'nofield.json');
    await writeFile(noField, JSON.stringify({ pinned: { projects: [] } }));
    assert.equal((await readHiddenProjects(noField)).size, 0, 't5: 无 hiddenProjects 字段 → 空 Set');

    const wrongType = join(dir, 'wrongtype.json');
    await writeFile(wrongType, JSON.stringify({ hiddenProjects: 'h-home' }));
    assert.equal((await readHiddenProjects(wrongType)).size, 0, 't5: 字段类型不对 → 空 Set');

    assert.equal((await readHiddenProjects(join(dir, 'does-not-exist.json'))).size, 0, 't5: 文件不存在 → 空 Set');

    // 回落必须是「不过滤」:拿空 Set 去选,预热集应与改动前同口径(全量前 cap 个)
    const fallback = pickWarmupTargets(projects, await readHiddenProjects(join(dir, 'nope.json')), 8);
    assert.equal(fallback.length, 8, 't5: 回落 = 不过滤(不是零预热)');
    assert.equal(fallback[0].hash, 'h-work', 't5: 回落仍按原顺序');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// t6 名单里的陈旧 hash(本机 prefs 49 条只有 35 条对得上现存项目)不影响结果
{
  const many = new Set([...hidden, ...Array.from({ length: 40 }, (_, i) => `h-gone-${i}`)]);
  assert.deepEqual(
    pickWarmupTargets(projects, many, 8).map((p) => p.hash),
    pickWarmupTargets(projects, hidden, 8).map((p) => p.hash),
    't6: 名单里对不上的陈旧 hash 不改变结果');
}

// t7 接线仪表化:启动预热确实走了纯函数,且 prefs 读留在既有 try 之内(R3);
//    并明令未动 /api/projects 语义(R6)。
{
  const idx = readFileSync(new URL('../../server/index.js', import.meta.url), 'utf8');
  assert.match(idx, /pickWarmupTargets\(projects, await readHiddenProjects\(\), 8\)/, 't7: 预热走纯函数 + cap 8');
  assert.ok(!/projects\.slice\(0, 16\)/.test(idx), 't7: 旧的 slice(0,16) 已移除');
  // R3:import 与 prefs 读都在 `try {` 之后、`} catch {}` 之前
  const block = idx.slice(idx.indexOf('后台预热会话列表缓存'));
  const tryAt = block.indexOf('try {');
  const catchAt = block.indexOf('} catch {}');
  assert.ok(tryAt >= 0 && catchAt > tryAt, 't7: 预热块仍是 try/catch 包住的 fire-and-forget');
  const inner = block.slice(tryAt, catchAt);
  assert.match(inner, /readHiddenProjects\(\)/, 't7: prefs 读必须在 try 之内(抛了不许掀掉服务端启动)');
}

// t8 客户端同族漏网点:单列表懒拉与 Home 默认项目都必须减 hidden。
//    r23:原来八条断言全是对源码做正则 —— 判官的反例是 /api/prefs/hidden-projects 的
//    响应字段若改名,App.jsx 里 `d?.hidden` 恒 undefined、Home 过滤彻底失效,而断言照样
//    全绿。现在解析与过滤都在 utils/home.js 的纯函数里,**真调它**。
{
  const { readHiddenHashes, visibleHomeProjects, pickHomeProject } = await import('../../client/src/utils/home.js');
  // ⚠️ 夹具必须有区分度:被隐藏的那个要是【不过滤就会被选中】的那个(家目录活动最新),
  // 否则解析读错字段 → 名单恒空 → 过滤失效,而断言照样绿(判官反例正是这条)。
  const list = [P('h-home', '/Users/x', '2026-08-20T10:00:00Z'), P('h-work', '/Users/x/work', '2026-08-20T09:00:00Z')];
  assert.equal(pickHomeProject({ projects: list }).hash, 'h-home', 't8: 夹具自检 —— 不过滤时选中的是被隐藏的那个');

  // ① 响应载荷 → 名单(字段名 `hidden` 是与服务端的契约;改名/改结构这条直接红)
  assert.deepEqual([...readHiddenHashes({ hidden: ['a', 'b', 42, ''] })].sort(), ['a', 'b'],
    't8: 按响应字段 hidden 解析,脏元素滤除');
  const picked = pickHomeProject({ projects: visibleHomeProjects(list, readHiddenHashes({ hidden: ['h-home'] })) });
  assert.equal(picked.hash, 'h-work', 't8: Home 默认项目(会写进新会话 cwd)不许落在被隐藏的目录上');

  // ② 坏载荷回落「不过滤」,不是「全过滤」(Home 不能变成没项目可选的死输入框)
  for (const bad of [null, {}, { hidden: 'h-home' }, { hiddenProjects: ['h-home'] }]) {
    assert.equal(readHiddenHashes(bad).size, 0, `t8: 坏载荷回落空 Set → ${JSON.stringify(bad)}`);
  }

  // ③ 全隐藏时回落全量(侧栏「显示全部项目」那个态)
  assert.deepEqual(visibleHomeProjects(list, new Set(['h-work', 'h-home'])).map((p) => p.hash),
    list.map((p) => p.hash), 't8: 全隐藏 → 回落全量,不把 Home 变成死输入框');

  // 接线(只剩这几条源码级:组件内没法纯函数导入)
  const sidebar = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  assert.match(sidebar, /const singleModeRows = useMemo/, 't8: 单列表懒拉有独立的已过滤行集');
  assert.match(sidebar, /for \(const p of singleModeRows\)/, 't8: 单列表懒拉不再遍历全量 st.projects');
  assert.ok(!/for \(const p of st\.projects\)/.test(sidebar), 't8: 全量遍历已移除');
  // 行集来自 singleModeVisibleProjects:query 恒空(与「搜会话标题依赖组已加载」成环)
  // 与 worktree 不受显示开关裁切,都由该函数签名保证,行为断言见 check-project-panel t8。
  assert.match(sidebar, /singleModeVisibleProjects\(\{ projects, hidden, panes, pinned: pinnedProjSet \}\)/,
    't8: 懒拉行集走共用纯函数(无 query 参数 = 结构上不可能成环)');
  // r23-①:上一轮只改了【拉取】,渲染仍平铺"所有已加载的组" → 隐藏对平铺模式无效。
  assert.match(sidebar, /const visibleHashes = useMemo\(\(\) => new Set\(singleModeRows\.map/,
    't8: 可见集由懒拉行集派生(单一来源)');
  assert.match(sidebar, /flattenSessionRows\(sessionsByProject, visibleHashes\)/,
    't8: 平铺渲染必须吃同一个可见集(只改拉取 = 只修了一半)');
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /pickHomeProject\(\{ chosenHash, projects: visibleProjects, selectedProject \}\)/,
    't8: Home 默认项目取已过滤列表');
  assert.match(app, /visibleHomeProjects\(projects, hiddenHashes\)/, 't8: 过滤走共用纯函数');
  assert.match(app, /setHiddenHashes\(readHiddenHashes\(d\)\)/, 't8: 载荷解析走共用纯函数');
  const recentAt = app.indexOf('const recent = useMemo');
  assert.match(app.slice(recentAt, recentAt + 200), /visibleProjects/, 't8: 最近项目下拉同样取已过滤列表');
}

console.log('check-warmup-hidden: all passed');
