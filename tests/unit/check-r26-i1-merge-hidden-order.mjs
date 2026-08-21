#!/usr/bin/env node
// r26-I1 单测:mergeHiddenOrder 纯函数矩阵 + 侧栏接线钉。
// 哨兵(实际验证过红):删掉并回循环(直接 return result)→ t1/t2 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeHiddenOrder } from '../../client/src/utils/projectPanel.js';

// t1 主哨兵:old=[A,H1,B,H2,C](H 隐藏),preview=[C,A](用户把 C 拖到最前)
// → H1/H2 按原相对位次并回:H1 锚 A(H 前最近的 survivor),H2 锚 B → [C,A,H1,B,H2]
{
  assert.deepEqual(
    mergeHiddenOrder(['C', 'A'], ['A', 'H1', 'B', 'H2', 'C']),
    ['C', 'A', 'H1', 'B', 'H2'],
    't1: 隐藏项保持原锚位(算法确定性哨兵,数组逐字)',
  );
}

// t2 missing 全在头部:old=[H1,H2,A],preview=[A] → [H1,H2,A](无锚插头部且保相对序)
{
  assert.deepEqual(mergeHiddenOrder(['A'], ['H1', 'H2', 'A']), ['H1', 'H2', 'A'], 't2: 头部 missing 保相对序');
}

// t3 preview 含原 hidden(取消隐藏后被拖动)→ 不属于 missing,不重复插入;
//    其余 missing(B)锚 = oldOrder 中前方最近已在 result 的元素(H1)→ 插 H1 后
{
  assert.deepEqual(mergeHiddenOrder(['H1', 'A'], ['A', 'H1', 'B']), ['H1', 'B', 'A'], 't3: 已回 preview 的不重复插,B 锚 H1');
}

// t4 空 oldOrder → preview 原样;非法入参不炸
{
  assert.deepEqual(mergeHiddenOrder(['C', 'A'], []), ['C', 'A'], 't4: 空 oldOrder 原样');
  assert.deepEqual(mergeHiddenOrder(['A'], undefined), ['A'], 't4: undefined oldOrder 原样');
  assert.deepEqual(mergeHiddenOrder(undefined, ['A']), ['A'], 't4: 空 preview 并入全部旧序');
}

// t5 同段连续 missing 锚链:old=[A,H1,H2,B],preview=[B,A] → H1 锚 A,H2 锚 H1(刚插入)
{
  assert.deepEqual(mergeHiddenOrder(['B', 'A'], ['A', 'H1', 'H2', 'B']), ['B', 'A', 'H1', 'H2'], 't5: 连续 missing 锚链保序');
}

// t6 侧栏接线:松手 PUT 前过 mergeHiddenOrder,且 PUT 前重取最新 sidebar-view
{
  const sb = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  assert.match(sb, /putSidebarView\(\{ projectOrder: mergeHiddenOrder\(preview, oldOrder\) \}\)/, 't6: 松手 PUT 过并回');
  assert.match(sb, /fetch\('\/api\/prefs\/sidebar-view'\)/, 't6: PUT 前重取最新 order(收窄并发窗)');
  assert.match(sb, /mergeHiddenOrder/, 't6: 纯函数已接线');
}

console.log('check-r26-i1-merge-hidden-order: all passed');
