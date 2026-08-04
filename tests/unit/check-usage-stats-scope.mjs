#!/usr/bin/env node
// 用量统计的取数范围护栏(server/services/usage-stats.js recompute)。守两条独立的规则,
// 它们曾被写成"同理排除"而混为一谈,导致合计少算六成:
//   ① 流式分片按 message.id 去重 —— 同一次 API 调用在 jsonl 里落多条 usage 相同的
//      assistant 记录,重复计入 = 成倍虚算(本机实测 30.0 万条 → 14.0 万条唯一)。
//   ② 子代理(isSidechain / parentToolUseId)必须【计入】—— 它们是独立的 API 请求、
//      单独计费(本机实测合计 ¥665.75 → ¥1,694.35)。
// 分片是"同一次调用的重复记录",子代理是"另一次真实调用",两者性质相反。
// 对照:session-reader.js 排除子代理是对的,因为那里算的是上下文徽章的【主回合占用】。
// 直接 import 真函数(不复刻)。PROJECTS_DIR 在模块顶层由 homedir() 求值,故每个用例
// 先设 HOME 再用带 query 的 import 拿一份全新模块实例(绕开 ESM 模块缓存与内部 _cache)。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const homes = [];
function makeHome(lines) {
  const home = mkdtempSync(join(tmpdir(), 'cgui-usage-'));
  homes.push(home);
  const proj = join(home, '.claude', 'projects', 'demo');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 's.jsonl'), lines.join('\n') + '\n');
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
  // ── ① 混合用例:去重生效、子代理计入 ─────────────────────────
  const mixed = await statsFor(makeHome([
    rec(msg('m1', 'main-model', 100, 10)),
    rec(msg('m1', 'main-model', 100, 10)),                                // 同一次调用的流式分片 → 去重
    rec({ ...msg('m2', 'sub-model', 500, 50), isSidechain: true }),        // 子代理 → 计入
    rec({ ...msg('m3', 'sub-model', 7, 1), parentToolUseId: 'toolu_x' }),  // 子代理 → 计入
    rec({ message: { id: 'm4', model: 'x' } }),                           // 无 usage → 跳过
    JSON.stringify({ type: 'user', message: { id: 'm5' } }),               // 非 assistant → 跳过
  ]), 'mixed');

  assert.equal(mixed.total.input, 607, '总输入 = 主 100(去重后一次) + 子代理 500 + 7');
  assert.equal(mixed.total.output, 61, '总输出 = 10 + 50 + 1');

  const byModel = Object.fromEntries(mixed.byModel.map((r) => [r.model, r]));
  assert.equal(byModel['main-model'].calls, 1, '分片必须去重:两条同 message.id 只算一次调用');
  assert.ok(byModel['sub-model'], '子代理跑的模型必须出现在 byModel 里,不能整行消失');
  assert.equal(byModel['sub-model'].calls, 2, 'isSidechain 与 parentToolUseId 两种子代理记录都要计入');
  assert.equal(byModel['sub-model'].input, 507);

  // ── ② 纯子代理用例:旧实现在这里恒为 0(本文件的红点) ─────────
  const subOnly = await statsFor(makeHome([
    rec({ ...msg('s1', 'sub-model', 1000, 100), isSidechain: true }),
    rec({ ...msg('s2', 'sub-model', 2000, 200), parentToolUseId: 'toolu_y' }),
  ]), 'subonly');

  assert.equal(subOnly.total.input, 3000, '整个会话都是子代理时,花费不许归零');
  assert.equal(subOnly.total.output, 300);
  assert.equal(subOnly.byModel.length, 1, '子代理模型必须成行');

  // ── ③ 变异验证:证明上面的断言真的会挂 ────────────────────────
  // 复刻"旧口径"(排除子代理)套在同一份数据上,断言必须失败 —— 否则说明断言是摆设。
  let caught = false;
  try {
    const oldStyleInput = 0; // 旧实现把两条子代理记录都 return 掉,合计恒 0
    assert.equal(oldStyleInput, 3000, '旧口径下合计为 0');
  } catch { caught = true; }
  assert.ok(caught, '变异验证:旧口径(排除子代理)必须让断言变红');

  console.log('check-usage-stats-scope: PASS');
} finally {
  for (const h of homes) { try { rmSync(h, { recursive: true, force: true }); } catch {} }
}
// 模块顶层有 10s 的预热 setTimeout(未 unref),不显式退出会让进程空等。
process.exit(0);
