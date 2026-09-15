#!/usr/bin/env node
// 渐进挂载:窗口上沿因**消息增长**而右移时,那条补偿必须还在、且单位口径不能混。
//
// 为什么用源码哨兵:这段逻辑在 SessionDetail 的 render/useLayoutEffect 里,纯函数测不到;
// 而它踩过的两个坑都不是"忘了写"而是"写歪了"——
//   ① 用 scrollHeight 差值补:同一提交里下沿还会落地新行,差值是"卸掉−新增",补出来是错的
//      (实测卸 337px、同时新增 269px → 差值只剩 68px);
//   ② 锚点位置用 getBoundingClientRect 量:窗格可能带缩放,rect 是**视觉单位**、scrollTop 是
//      **布局单位**,混用会把补偿按缩放比写歪(实测残差 68px,改用 offsetTop 后逐像素对齐)。
// 所以这里既钉"这条路径在",也钉"这两个错法没有回来"。
//
// 端到端现场(浏览器)见同目录 sf-mount-anchor.repro.spec.mjs。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../client/src/App.jsx'), 'utf8');

// ── t1 补偿路径在:判据三条 + 锚点分支 + 与既有机制同一套 ──
const start = src.indexOf('const mountLenRef');
assert.ok(start > 0, '消息增长路径的补偿判据不见了(mountLenRef)');
const end = src.indexOf('}, [mountFromResolved, writeProgrammaticScroll]);', start);
assert.ok(end > start, '补偿 effect 的收尾没找到(结构变了?核对本文件判据)');
const block = src.slice(start, end);

for (const [needle, why] of [
  ['userScrolledAwayRef.current', '只在"用户在读历史"时补偿,跟随底部时不许抢吸底'],
  ['finalizedMessages.length > mountLenRef.current', '判据一:总行数真的长了'],
  ['mountFromResolved > mountFromRef.current', '判据二:窗口上沿真的往前挪了(才有行被卸)'],
  ['else {\n      captureMountBefore();', '量不到锚时回落既有差值口径,不许留空窗'],
]) {
  assert.ok(block.includes(needle), `补偿判据缺失:${why}(找不到 ${JSON.stringify(needle)})`);
}

// ── t2 锚点位置必须是布局单位(offsetTop),不许用 rect ──
assert.ok(block.includes('nodeTop: anchor.offsetTop'),
  '锚点位置必须记 offsetTop —— rect 是缩放后的视觉单位,scrollTop 是布局单位,混用会按缩放比写歪');
assert.ok(block.includes('prev.node.offsetTop - prev.nodeTop'),
  '补偿量必须用 offsetTop 的位移量');
{
  const anchorBranch = block.slice(block.indexOf('if (prev.node)'), block.indexOf('const delta = el.scrollHeight'));
  assert.ok(anchorBranch.length > 0, '锚点分支不见了');
  assert.ok(!anchorBranch.includes('getBoundingClientRect'),
    '锚点分支里不许出现 getBoundingClientRect(视觉单位混进布局单位 = 补偿按缩放比写歪)');
  assert.ok(anchorBranch.includes('writeProgrammaticScroll'), '锚点分支要把视口搬回去(写 scrollTop)');
  assert.ok(anchorBranch.includes('clampScrollTop'), '写回前必须过 clampScrollTop');
}

// ── t3 既有那条差值口径与它的显式调用点都还在(别为了新路径动老路径)──
assert.ok(block.includes('const delta = el.scrollHeight - prev.h;'),
  '既有"补齐/搜索开关/跳远"用的 scrollHeight 差值口径被改了');
assert.ok(block.includes("writeProgrammaticScroll(el, target, 'restore')"),
  '既有补偿的写回动作不在了');
{
  const sites = (src.match(/captureMountBeforeRef\.current\?\.\(\)/g) || []).length;
  assert.ok(sites >= 3, `既有 capture 调用点(搜索开/关、手机检索入口)少了:只剩 ${sites} 处`);
  assert.ok(src.includes('captureMountBefore();') && src.includes('setMountFrom(extendUp('),
    '补齐路径(滚到顶)的 capture + extendUp 必须原样保留');
}

console.log('check-mount-growth-anchor: all passed');
