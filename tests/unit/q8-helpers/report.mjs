// Q8 系列单测共用的极简报告器:每条打 ✓/✗,末尾按「修前应红 / 修前应绿」分类汇总,有 ✗ 退出码 1。
// 不引入测试框架:node 直跑 + node:assert/strict(项目惯例)。
export function makeReport(suite) {
  const cases = [];
  const t0 = Date.now();
  async function check(id, title, expectation, fn) {
    // expectation: 'red' = 审查项本身(修前应红) / 'green' = 反向守卫或既有行为(修前应绿)
    const started = Date.now();
    try {
      await fn();
      cases.push({ id, title, expectation, ok: true, ms: Date.now() - started });
      console.log(`✓ ${id} ${title} (${Date.now() - started}ms)`);
    } catch (e) {
      const first = String(e && e.message || e).split('\n').slice(0, 3).join(' | ');
      cases.push({ id, title, expectation, ok: false, ms: Date.now() - started, error: first });
      console.log(`✗ ${id} ${title} (${Date.now() - started}ms)\n    ${first}`);
    }
  }
  function skip(id, title, expectation, reason) {
    cases.push({ id, title, expectation, ok: null, skipped: reason });
    console.log(`- ${id} ${title}  [跳过:${reason}]`);
  }
  function finish() {
    const red = cases.filter((c) => c.expectation === 'red');
    const green = cases.filter((c) => c.expectation === 'green');
    const mark = (c) => (c.ok === null ? '跳过' : c.ok ? '绿' : '红');
    console.log(`\n== ${suite} 汇总(${Date.now() - t0}ms)==`);
    console.log('修前应红(审查项):');
    for (const c of red) console.log(`  ${mark(c)}  ${c.id} ${c.title}${c.error ? ` —— ${c.error}` : ''}${c.skipped ? ` —— ${c.skipped}` : ''}`);
    console.log('修前应绿(反向守卫/既有行为):');
    for (const c of green) console.log(`  ${mark(c)}  ${c.id} ${c.title}${c.error ? ` —— ${c.error}` : ''}${c.skipped ? ` —— ${c.skipped}` : ''}`);
    const failed = cases.filter((c) => c.ok === false).length;
    console.log(`${suite}: ${cases.length} 条,红 ${failed},绿 ${cases.filter((c) => c.ok === true).length},跳过 ${cases.filter((c) => c.ok === null).length}`);
    return failed ? 1 : 0;
  }
  return { check, skip, finish, cases };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 fn() 为真或超时;返回最后一次的值。 */
export async function waitFor(fn, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(stepMs);
  }
  return last;
}
