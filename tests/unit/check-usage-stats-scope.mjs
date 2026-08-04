#!/usr/bin/env node
// 用量统计的取数范围护栏(server/services/usage-stats.js)。守三条容易互相混淆的规则:
//   ① **扫描深度**:会话本体在 `<项目>/<sessionId>.jsonl`,子代理 transcript 在
//      `<项目>/<sessionId>/subagents/agent-*.jsonl`(workflow 起的还要再深一层)。
//      只读顶层一层 = 一条子代理记录都读不到(本机实测顶层 1441 个文件含 sidechain 的
//      为 0,深层 2150 个全是)。**本文件第一版就栽在这:把 sidechain 记录写进顶层
//      jsonl,测试绿了而产品一分钱没修回来。用例必须按真实目录形态摆。**
//   ② **子代理计入**:它们是独立的 API 请求、单独计费,排除等于漏算。
//   ③ **按 message.id 跨文件去重**:流式分片会落多条 usage 相同的记录;续接/分叉会话
//      时 CLI 又把历史整段抄进新 jsonl,所以去重必须跨文件,per-file 去重会让总量翻倍。
// ② 与 ③ 性质相反(一个是"另一次真实调用",一个是"同一次调用的重复记录"),曾被写成
// "同理排除"而一起砍掉。对照:session-reader.js 排除子代理是对的,那里算的是上下文
// 徽章的【主回合占用】,不是【花了多少钱】。
// 直接 import 真函数(不复刻)。PROJECTS_DIR 在模块顶层由 homedir() 求值,故先设 HOME
// 再用带 query 的 import 拿全新模块实例(绕开 ESM 缓存与内部 _cache)。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const homes = [];
function makeHome(tree) {
  const home = mkdtempSync(join(tmpdir(), 'cgui-usage-'));
  homes.push(home);
  for (const [rel, lines] of Object.entries(tree)) {
    const abs = join(home, '.claude', 'projects', rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, lines.join('\n') + '\n');
  }
  return home;
}
const rec = (o) => JSON.stringify({ type: 'assistant', timestamp: '2026-08-04T00:00:00.000Z', ...o });
const msg = (id, model, input, output) => ({
  message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});
async function statsFor(home, tag) {
  process.env.HOME = home;
  const { getUsageStats } = await import(`../../server/services/usage-stats.js?case=${tag}`);
  return getUsageStats();
}

try {
  // ── ① 真实目录形态:会话在项目目录直属,子代理在两层深的 subagents/ 下 ──────
  const s = await statsFor(makeHome({
    'demo/s1.jsonl': [
      rec(msg('m1', 'main-model', 100, 10)),
      rec(msg('m1', 'main-model', 100, 10)),                                  // 流式分片 → 去重
      rec({ message: { id: 'm4', model: 'x' } }),                             // 无 usage → 跳过
      JSON.stringify({ type: 'user', message: { id: 'm5' } }),                 // 非 assistant → 跳过
    ],
    // 续接会话:CLI 把历史整段抄了过来,m1 在两个文件里各出现一次
    'demo/s2.jsonl': [
      rec(msg('m1', 'main-model', 100, 10)),                                  // 跨文件重复 → 仍只算一次
      rec(msg('m9', 'main-model', 3, 1)),                                     // s2 自己的新调用
    ],
    // 子代理 transcript 的真实落点(比会话本体深两层)
    'demo/s1/subagents/agent-x.jsonl': [
      rec({ ...msg('g1', 'sub-model', 500, 50), isSidechain: true }),
      rec({ ...msg('g2', 'sub-model', 7, 1), parentToolUseId: 'toolu_x' }),
    ],
  }), 'nested');

  assert.equal(s.total.input, 610, '总输入 = 主 100(跨文件只算一次) + 3 + 子代理 500 + 7');
  assert.equal(s.total.output, 62, '总输出 = 10 + 1 + 50 + 1');

  const byModel = Object.fromEntries(s.byModel.map((r) => [r.model, r]));
  assert.ok(byModel['sub-model'], '递归扫描必须读到两层深的 subagents/,否则子代理花费整个消失');
  assert.equal(byModel['sub-model'].calls, 2, 'isSidechain 与 parentToolUseId 两种子代理记录都要计入');
  assert.equal(byModel['sub-model'].input, 507);
  assert.equal(byModel['main-model'].calls, 2, '同一 message.id 跨两个文件出现,只能算一次调用');
  assert.equal(byModel['main-model'].input, 103);

  assert.equal(s.total.sessionCount, 2, '会话数只数项目目录直属的 jsonl,子代理 transcript 不是独立会话');

  const byProject = Object.fromEntries(s.byProject.map((r) => [r.hash, r]));
  assert.equal(byProject['demo'].input, 610, '深层文件归属到它所在的顶层项目,不另起一行');

  // ── ② 纯子代理会话:整个项目只有子代理记录时,花费不许归零 ─────────────
  const subOnly = await statsFor(makeHome({
    'demo/sx.jsonl': [],                                                       // 会话本体无 usage
    'demo/sx/subagents/agent-y.jsonl': [
      rec({ ...msg('h1', 'sub-model', 1000, 100), isSidechain: true }),
    ],
    // workflow 起的 agent 埋得更深一层,同样要算
    'demo/sx/subagents/workflows/wf_1/agent-z.jsonl': [
      rec({ ...msg('h2', 'sub-model', 2000, 200), isSidechain: true }),
    ],
  }), 'subonly');

  assert.equal(subOnly.total.input, 3000, '会话本体没花钱、钱全花在子代理上时,合计不许是 0');
  assert.equal(subOnly.total.output, 300);
  assert.equal(subOnly.byModel.length, 1, '子代理模型必须成行');
  assert.equal(subOnly.total.sessionCount, 1, '三个文件只对应一个会话');

  console.log('check-usage-stats-scope: PASS');
} finally {
  for (const h of homes) { try { rmSync(h, { recursive: true, force: true }); } catch {} }
}
// 模块顶层有 10s 的预热 setTimeout(未 unref),不显式退出会让进程空等。
process.exit(0);
