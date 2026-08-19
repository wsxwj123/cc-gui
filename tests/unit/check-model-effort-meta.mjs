// 单测:r10-9 思考强度按模型自适应——server 数据层 normalize/denormalize/sanitize 矩阵
// + client 回落矩阵(resolveEffortOnModelChange)。均 import 真函数。
// 变异哨兵(实际验证过红):
//   S1 删 client 回落逻辑(不支持档回落最高可用档)→ t6 红
//   S2 normalizeProviderModels 全选仍写 efforts → t2 红
import assert from 'node:assert/strict';
import {
  effortCapsFor, effortAllowed, resolveEffortOnModelChange, EFFORT_ORDER,
} from '../../client/src/utils/effortCaps.js';

const { normalizeProviderModels, denormalizeProviderModels, sanitizeModelMeta, EFFORT_LEVEL_IDS } =
  await import('../../server/routes/settings.js');

// t1 normalize:string 条目原样;对象条目拆 id;非法条目(无 id)丢弃
{
  const { ids, meta } = normalizeProviderModels([
    'plain-model',
    { id: 'no-think', reasoning: false },
    { id: 'some-think', efforts: ['low', 'high'] },
    { id: '  ' },
    { bad: true },
    42,
  ]);
  assert.deepEqual(ids, ['plain-model', 'no-think', 'some-think'], 't1: ids 提取');
  assert.deepEqual(meta, {
    'no-think': { reasoning: false },
    'some-think': { efforts: ['low', 'high'] },
  }, 't1: meta 提取');
}

// t2 normalize:全档 efforts = 等于不声明;空数组不声明;非法档位剔除;reasoning:true 不写
{
  const { meta } = normalizeProviderModels([
    { id: 'all', efforts: [...EFFORT_LEVEL_IDS] },
    { id: 'empty', efforts: [] },
    { id: 'junk', efforts: ['low', 'ultra', 'low'] },
    { id: 'rtrue', reasoning: true },
  ]);
  assert.deepEqual(meta, { junk: { efforts: ['low'] } }, 't2: 全选/空/true 均不留条目,非法档剔除+去重');
}

// t3 denormalize 往返:normalize(denormalize(x)) 不变(存储形态稳定)
{
  const ids = ['a', 'b', 'c'];
  const meta = { b: { reasoning: false }, c: { efforts: ['medium'] } };
  const wire = denormalizeProviderModels(ids, meta);
  assert.deepEqual(wire, ['a', { id: 'b', reasoning: false }, { id: 'c', efforts: ['medium'] }], 't3: 混合条目');
  const back = normalizeProviderModels(wire);
  assert.deepEqual(back.ids, ids, 't3: 往返 ids');
  assert.deepEqual(back.meta, meta, 't3: 往返 meta');
  assert.deepEqual(denormalizeProviderModels(ids, null), ids, 't3: 无 meta 原样');
}

// t4 sanitizeModelMeta:只留 models 内的 id;全默认返回 null
{
  const mm = sanitizeModelMeta({ a: { reasoning: false }, ghost: { reasoning: false } }, ['a', 'b']);
  assert.deepEqual(mm, { a: { reasoning: false } }, 't4: 越界 id 剔除');
  assert.equal(sanitizeModelMeta({ a: { reasoning: true } }, ['a']), null, 't4: 全默认 → null');
  assert.equal(sanitizeModelMeta('junk', ['a']), null, 't4: 非对象 → null');
}

// t5 client caps 查询:[1m] 后缀剥离;无声明 = 全档可用
{
  const meta = { 'model-x': { efforts: ['low', 'high'] }, 'model-y': { reasoning: false } };
  assert.deepEqual(effortCapsFor(meta, 'model-x[1m]'), { reasoning: true, efforts: ['low', 'high'] }, 't5: 剥[1m]查询');
  assert.equal(effortCapsFor(meta, 'model-y').reasoning, false);
  assert.deepEqual(effortCapsFor(meta, 'unknown'), { reasoning: true, efforts: null }, 't5: 无声明全档');
  assert.deepEqual(effortCapsFor(null, 'any'), { reasoning: true, efforts: null }, 't5: 无 meta 全档');
  // effortAllowed:''(默认档)在支持思考时恒允许;锁思考时非空档全不允许
  assert.equal(effortAllowed({ reasoning: true, efforts: ['low'] }, ''), true);
  assert.equal(effortAllowed({ reasoning: true, efforts: ['low'] }, 'high'), false);
  assert.equal(effortAllowed({ reasoning: false, efforts: null }, 'low'), false);
  assert.equal(effortAllowed({ reasoning: true, efforts: null }, 'max'), true, 't5: 无声明任意档');
}

// t6 回落矩阵:reasoning:false 锁 off;记忆优先;当前支持保留;不支持回落最高可用档
{
  const capsLtd = { reasoning: true, efforts: ['low', 'medium'] };
  // 锁思考
  assert.deepEqual(resolveEffortOnModelChange({ reasoning: false, efforts: null }, 'high', null),
    { effort: '', changed: true, reason: 'locked' }, 't6: 锁思考清档');
  // 记忆合法 → 优先
  assert.deepEqual(resolveEffortOnModelChange(capsLtd, 'high', 'low'),
    { effort: 'low', changed: true, reason: 'remembered' }, 't6: 记忆优先');
  // 记忆非法 → 忽略;当前支持 → 保留
  assert.deepEqual(resolveEffortOnModelChange(capsLtd, 'medium', 'xhigh'),
    { effort: 'medium', changed: false, reason: 'kept' }, 't6: 非法记忆忽略,当前档保留');
  // 当前不支持 → 回落 efforts 最高档(EFFORT_ORDER 序)
  assert.deepEqual(resolveEffortOnModelChange(capsLtd, 'xhigh', null),
    { effort: 'medium', changed: true, reason: 'fallback' }, 't6: 回落最高可用档');
  // 默认档('')恒保留(不强插档位)
  assert.deepEqual(resolveEffortOnModelChange(capsLtd, '', null),
    { effort: '', changed: false, reason: 'kept' }, 't6: 默认档保留');
  assert.deepEqual(EFFORT_ORDER, ['low', 'medium', 'high', 'xhigh', 'max'], 't6: 档位次序(r15-2 五档,无 minimal)');
}

console.log('check-model-effort-meta: all passed');
process.exit(0); // settings.js 顶层副作用,显式退出
