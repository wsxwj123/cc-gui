#!/usr/bin/env node
// r130 安全审计(重要 1):recompute 的 byModel / byProject / byDay 桶用外部字符串当键。普通对象上
// bucket['__proto__'] 取到 Object.prototype(真值 → 跳过 emptyTotals 初始化),随后的 += 把 input / output /
// cacheRead / cacheWrite / calls = NaN 与 byPeriod 写到 Object.prototype 上 —— 进程里每个对象都多 6 个可枚举
// 继承属性,直到重启;bucket['constructor'] 同理写到 Object 函数上。model 来自第三方中转的响应、项目目录名
// 与会话文件都在用户目录下可改。修法:三个桶 Object.create(null)。本用例开头记录污染前状态、结尾清理,
// 保证即使红也不影响别的用例。写法同 check-usage-stats-scope(临时 HOME + 带 query 的动态 import)。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'calls', 'byPeriod'];
const TARGETS = [['Object.prototype', Object.prototype], ['Object', Object], ['Function.prototype', Function.prototype]];
const polluted = () => TARGETS.flatMap(([n, t]) => KEYS.filter((k) => Object.prototype.hasOwnProperty.call(t, k)).map((k) => `${n}.${k}`));
assert.deepEqual(polluted(), [], '污染前:全局对象上不该已有这些键(否则是环境脏,先查别的)');

const homes = [];
function makeHome(tree) {
  const home = mkdtempSync(join(tmpdir(), 'cgui-proto-key-'));
  homes.push(home);
  for (const [rel, lines] of Object.entries(tree)) {
    const abs = join(home, '.claude', 'projects', rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, lines.join('\n') + '\n');
  }
  return home;
}
// 同一天(+08:00 08:0i)的 assistant 记录;model 是本用例的变量
const rec = (model, u, i) => JSON.stringify({ type: 'assistant', timestamp: `2026-08-04T00:0${i}:00.000Z`,
  message: { id: `m${i}`, model, stop_reason: 'end_turn', usage: { input_tokens: u[0], output_tokens: u[1], cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3] } } });

try {
  const home = makeHome({
    'demo/s1.jsonl': [rec('__proto__', [100, 20, 300, 40], 1), rec('constructor', [7, 3, 0, 0], 2), rec('prototype', [5, 0, 0, 0], 3), rec('claude-a', [1000, 0, 0, 0], 4)],
    '__proto__/s2.jsonl': [rec('claude-a', [11, 0, 0, 0], 5)],   // 项目目录名同样是外部字符串(byProject 桶)
  });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { getUsageStats } = await import('../../server/services/usage-stats.js?case=proto-key');
  const s = await getUsageStats();
  assert.deepEqual(polluted(), [], `聚合后全局对象被写上了:${polluted().join(', ')}(bucket['__proto__'] / ['constructor'] 命中了原型链)`);
  // 不用 Object.fromEntries / 对象字面量建索引:键 '__proto__' 正是本用例的雷,用 find。
  const row = (m) => s.byModel.find((r) => r.model === m);
  assert.deepEqual([row('claude-a')?.input, row('claude-a')?.calls], [1011, 2], '正常模型的数字正确(两个项目各一条)');
  assert.deepEqual([row('__proto__')?.input, row('__proto__')?.calls, typeof row('__proto__')?.byPeriod], [100, 1, 'object'], "model '__proto__' 按普通模型成行(不是消失在原型上)");
  assert.deepEqual([row('constructor')?.input, row('constructor')?.calls], [7, 1], "model 'constructor' 按普通模型成行");
  assert.deepEqual([row('prototype')?.input, row('prototype')?.calls], [5, 1], "model 'prototype' 成行");
  assert.equal(s.byModel.length, 4, '四个模型各一行');
  assert.equal(s.total.input, 1123, '总输入 = 100 + 7 + 5 + 1000 + 11,不是 NaN');
  const proj = s.byProject.find((p) => p.hash === '__proto__');
  assert.deepEqual([proj?.input, proj?.calls], [11, 1], "项目目录名 '__proto__' 也按普通项目成行");
  assert.deepEqual([s.byDay.length, s.byDay[0]?.calls, s.byDay[0]?.sessions], [1, 5, 2], '同一天一行:5 次调用、2 个会话');
  assert.equal(s.overview.favoriteModel, 'claude-a');
  assert.ok(JSON.stringify(s).indexOf('NaN') === -1 && !JSON.stringify(s).includes('null,null'), '结果里没有 NaN 泄漏');
  console.log('check-r130-usage-proto-key: PASS');
} finally {
  // 清理:无论红绿都把可能写上去的键删掉,不让污染漏到别的用例 / 进程内后续代码
  for (const [, t] of TARGETS) for (const k of KEYS) { try { delete t[k]; } catch { /* 不可配置就算了 */ } }
  for (const h of homes) { try { rmSync(h, { recursive: true, force: true }); } catch {} }
}
// 模块顶层有 10s 的预热 setTimeout(未 unref),不显式退出会让进程空等。
process.exit(0);
