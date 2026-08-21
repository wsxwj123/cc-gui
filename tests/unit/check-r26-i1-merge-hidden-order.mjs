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

// t6 接线:r26 收尾交办把并回下沉到 store 层(唯一真相源)—— putSidebarView 收到含
//    projectOrder 的写入先过 mergeHiddenOrder 再乐观 set + PUT;组件层直传 preview
//    不自行并回(防双重并回)。验收 i1 直接驱动 store.putSidebarView,必须这层绿。
{
  const store = readFileSync(new URL('../../client/src/stores/sessionStore.js', import.meta.url), 'utf8');
  assert.match(store, /mergeHiddenOrder\(patch\.projectOrder, get\(\)\.sidebarView\?\.projectOrder\)/, 't6: store 层并回接线');
  assert.match(store, /import \{[^}]*mergeHiddenOrder[^}]*\} from '\.\.\/utils\/projectPanel\.js'/, 't6: store import 纯函数');
  const sb = readFileSync(new URL('../../client/src/components/UnifiedSidebar.jsx', import.meta.url), 'utf8');
  assert.match(sb, /putSidebarView\(\{ projectOrder: drag\.preview \}\)/, 't6: 组件层直传 preview');
  assert.ok(!/mergeHiddenOrder\(/.test(sb), 't6: 组件层零并回调用(唯一真相源=store;注释提及不算)');
  const importLine = sb.match(/import \{[^}]*\} from '\.\.\/utils\/projectPanel\.js';/)?.[0] || '';
  assert.ok(!/mergeHiddenOrder/.test(importLine), 't6: 组件层不再 import 并回函数');
}

// t7 store 行为哨兵(与验收 i1 同场景):旧 order [A,H,B,C](H 隐藏),preview [C,A,B]
//    → 乐观 set 与 PUT body 都保住 H 的原相对位次;不含 projectOrder 的写入不并回。
{
  const lsMap = new Map();
  globalThis.localStorage = {
    getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
    setItem: (k, v) => lsMap.set(k, String(v)),
    removeItem: (k) => lsMap.delete(k),
  };
  globalThis.window = globalThis;
  if (!globalThis.addEventListener) globalThis.addEventListener = () => {};
  if (!globalThis.matchMedia) globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const putBodies = [];
  let serverOrder = ['A', 'H', 'B', 'C']; // 模拟服务端现存序(真路由整体替换语义)
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    putBodies.push(body);
    if (Array.isArray(body.projectOrder)) serverOrder = body.projectOrder; // 服务端整体覆盖
    return { ok: true, json: async () => ({ groupMode: 'project', sortMode: body.sortMode || 'manual', projectOrder: serverOrder }) };
  };
  try {
    const { useStore } = await import('../../client/src/stores/sessionStore.js');
    useStore.setState({ sidebarView: { groupMode: 'project', sortMode: 'manual', projectOrder: ['A', 'H', 'B', 'C'] } });
    await useStore.getState().putSidebarView({ projectOrder: ['C', 'A', 'B'] });
    const final = useStore.getState().sidebarView.projectOrder;
    assert.deepEqual(final, ['C', 'A', 'H', 'B'], 't7: 并回后 H 保原锚位(验收同场景)');
    assert.deepEqual(putBodies.at(-1).projectOrder, ['C', 'A', 'H', 'B'], 't7: PUT body 同样是并回后的序(服务端落库一致)');
    // 其它字段写入不受影响(不触发并回、projectOrder 不被改写)
    await useStore.getState().putSidebarView({ sortMode: 'recent' });
    assert.ok(!('projectOrder' in putBodies.at(-1)), 't7: 无 projectOrder 的 patch 原样发出');
    assert.deepEqual(useStore.getState().sidebarView.projectOrder, ['C', 'A', 'H', 'B'], 't7: 其它字段写入不动 order');
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('check-r26-i1-merge-hidden-order: all passed');
