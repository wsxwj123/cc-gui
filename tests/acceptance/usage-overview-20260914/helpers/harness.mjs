// 极简用例登记 + 断言。不引第三方框架(node:assert 就够):每条用例自己登记红/绿,
// 失败信息必须能自解释 —— 说清「哪条判据、期望什么、实际什么」。
//
// 为什么不用 node:test / vitest:本套件要断言跨进程的墙钟与 CPU 时间,用例之间有
// 顺序与实例生命周期关系(起实例 → 重启 → 再请求),用测试框架反而要绕它的并发模型。

export const results = [];

const ms = (n) => `${n.toFixed(1)}ms`;

/** 分组标题(只影响输出可读性)。 */
export function group(title) {
  console.log(`\n=== ${title} ===`);
}

/** 登记一条用例。fn 里抛错 = 红;返回值会作为附注打进输出(数字、备注)。 */
export async function test(id, name, fn) {
  const t0 = performance.now();
  try {
    const note = await fn();
    results.push({ id, name, ok: true, ms: performance.now() - t0 });
    console.log(`PASS ${id} ${name}${note ? ` | ${note}` : ''} (${ms(performance.now() - t0)})`);
    return true;
  } catch (err) {
    results.push({ id, name, ok: false, ms: performance.now() - t0, err });
    console.log(`FAIL ${id} ${name} | ${err.message} (${ms(performance.now() - t0)})`);
    if (process.env.USAGE_VERBOSE === '1' && err.stack) console.log(err.stack);
    return false;
  }
}

export function fail(msg) { throw new Error(msg); }

export function assertTrue(cond, msg) { if (!cond) fail(msg); }

export function assertEq(actual, expected, label) {
  const d = firstDiff(actual, expected, label || '$');
  if (d) fail(d);
}

/** 数值断言(带单位与容差说明,输出里能直接看懂差距)。 */
export function assertLt(actual, limit, label) {
  if (!(actual < limit)) fail(`${label}: 实际 ${actual} 不小于上限 ${limit}`);
}

/**
 * 深度相等,返回**第一处**差异的路径描述(相等返回 null)。数组按元素逐个比;
 * 对象键集合不同也报(多出/缺失的键名各列出来 —— 形状变了必须看得见)。
 */
export function firstDiff(a, b, path = '$') {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${path}: 类型不同 (${typeof a} vs ${typeof b})`;
  if (a === null || b === null || typeof a !== 'object') {
    return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  }
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return `${path}: 一边是数组一边不是`;
  if (aArr) {
    if (a.length !== b.length) return `${path}.length: ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i += 1) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  const missing = kb.filter((k) => !(k in a));
  if (missing.length) return `${path}: 缺少键 ${missing.join(',')}`;
  const extra = ka.filter((k) => !(k in b));
  if (extra.length) return `${path}: 多出键 ${extra.join(',')}`;
  for (const k of ka) {
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

/** 只比指定字段(用于「期望表」只覆盖某几个字段的场合)。返回差异描述或 null。 */
export function diffFields(actual, expected, fields, path = '$') {
  for (const f of fields) {
    const d = firstDiff(actual?.[f], expected?.[f], `${path}.${f}`);
    if (d) return d;
  }
  return null;
}

/** 汇总 + 退出码。绿=0,有红=1。 */
export function summary(title) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${title}: ${results.length - failed.length}/${results.length} 绿 ===`);
  if (failed.length) {
    console.log('红:', failed.map((f) => `${f.id}(${f.err.message.slice(0, 120)})`).join(' | '));
  }
  return failed.length ? 1 : 0;
}
