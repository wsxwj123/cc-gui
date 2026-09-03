#!/usr/bin/env node
// r103 开发侧自测:徽章分母来源优先级(resolveBadgeWindow 纯函数)+ 三处接线源码锁。
// node tests/unit/check-r103-dev-badge-window.mjs
//
// 事故语义:CLI 对它不认识的第三方模型名 result.modelUsage[*].contextWindow 恒 200,000,
// 而 GUI 已用 CLAUDE_CODE_MAX_CONTEXT_TOKENS 把 CLI 的真实窗口/压缩线抬到手填值 →
// 旧的"cli 单行道覆盖"让徽章分母与 CLI 实际压缩行为相反。新优先级:
//   [1m] > 压缩联动下发值(linked) > provider 手填/实抓/规则表(provider) > CLI 自报(cli)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveBadgeWindow } from '../../client/src/utils/contextWindow.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── ① 用户实报场景:第三方手填 1M + CLI 自报 200k → 分母仍 1M ──────────────
assert.deepEqual(
  resolveBadgeWindow({ cliWindow: 200_000, providerWindow: 1_000_000, model: 'k3' }),
  { window: 1_000_000, source: 'provider' }, '手填 1M 不被 CLI 自报的 200k 顶掉');
assert.deepEqual(
  resolveBadgeWindow({ cliWindow: 200_000, linkedWindow: 1_048_576, model: 'kimi-k3' }),
  { window: 1_048_576, source: 'linked' }, '压缩联动下发值优先于 CLI 自报');
// linked 与 provider 同在 → linked 赢(它才是真下发给 CLI 的那个值)
assert.deepEqual(
  resolveBadgeWindow({ cliWindow: 200_000, linkedWindow: 300_000, providerWindow: 1_000_000, model: 'x' }),
  { window: 300_000, source: 'linked' }, 'linked > provider');

// ── ② 官方 claude:GUI 侧无来源 → 采 CLI 自报 200k(无回归) ────────────────
assert.deepEqual(
  resolveBadgeWindow({ cliWindow: 200_000, linkedWindow: null, providerWindow: null, model: 'claude-sonnet-4-6' }),
  { window: 200_000, source: 'cli' }, '官方模型仍按 CLI 自报');

// ── ③ 无任何来源 → null(调用方落实测缓存/本地兜底表) ─────────────────────
assert.deepEqual(resolveBadgeWindow({ model: 'unknown-model' }),
  { window: null, source: null }, '全空 → null');
assert.deepEqual(resolveBadgeWindow(), { window: null, source: null }, '无参数不炸');
// 非对象入参一律按全缺处理(回调里抛错会吞掉整条 result 处理)
for (const bad of [null, undefined, 0, 200000, 'k3', true, []]) {
  assert.deepEqual(resolveBadgeWindow(bad), { window: null, source: null },
    `非对象入参 ${JSON.stringify(bad)} → { window: null, source: null }`);
}

// ── ③b explicit:分母 = min(显式值, CLI 自报窗口) ───────────────────────────
// 显式设置时压缩联动整个让位(server resolveCompactWindowSettings 返 null),CLI 仍按
// 它自己认的窗口算 → 官方模型上选 500K 实际只有 200K,分母不能显示 500K。
assert.deepEqual(
  resolveBadgeWindow({ cliWindow: 200_000, linkedWindow: 500_000, linkedSource: 'explicit', model: 'claude-sonnet-4-6' }),
  { window: 200_000, source: 'explicit' }, '官方选 500K + CLI 自报 200K → 钳到 200K');
assert.deepEqual(
  resolveBadgeWindow({ cliWindow: 200_000, linkedWindow: 150_000, linkedSource: 'explicit', model: 'x' }),
  { window: 150_000, source: 'explicit' }, '显式值更小 → 取显式值(min 取小,不是恒取 CLI)');
assert.deepEqual(
  resolveBadgeWindow({ linkedWindow: 500_000, linkedSource: 'explicit', model: 'x' }),
  { window: 500_000, source: 'explicit' }, 'CLI 自报缺席 → 原样显式值(无可钳者)');
// 'linked'(GUI 按 provider 窗口联动)不走 min:那个 200K 正是被 GUI 下发的
// MAX_CONTEXT_TOKENS 替掉的 CLI 默认值,拿它钳就把修好的又钳回去了。
assert.deepEqual(
  resolveBadgeWindow({ cliWindow: 200_000, linkedWindow: 1_000_000, linkedSource: 'linked', model: 'k3' }),
  { window: 1_000_000, source: 'linked' }, "source='linked' 不被 CLI 自报钳(本轮 bug 本体)");
assert.deepEqual(
  resolveBadgeWindow({ cliWindow: 200_000, linkedWindow: 1_000_000, model: 'k3' }),
  { window: 1_000_000, source: 'linked' }, 'linkedSource 缺省 → 按 linked 处理,不钳');
assert.deepEqual(
  resolveBadgeWindow({ cliWindow: 200_000, providerWindow: 1_000_000, linkedSource: 'explicit', model: 'k3' }),
  { window: 1_000_000, source: 'provider' }, 'explicit 只作用于 linkedWindow,不误钳 provider');
assert.deepEqual(
  resolveBadgeWindow({ cliWindow: 200_000, linkedWindow: 500_000, linkedSource: 'explicit', model: 'k3[1m]' }),
  { window: 1_000_000, source: '1m' }, '[1m] 仍压过 explicit 钳位');

// ── ④ [1m] 后缀最优先(与 CLI 口径一致的 1,000,000 整) ────────────────────
assert.deepEqual(resolveBadgeWindow({ cliWindow: 200_000, providerWindow: 262_144, model: 'k3[1m]' }),
  { window: 1_000_000, source: '1m' }, '[1m] 压过一切');

// ── ⑤ 非法值一律不参战(0 / 负 / NaN / 字符串) ────────────────────────────
for (const bad of [0, -1, NaN, Infinity, '1000000', null, undefined]) {
  assert.deepEqual(
    resolveBadgeWindow({ cliWindow: 200_000, providerWindow: bad, model: 'k3' }),
    { window: 200_000, source: 'cli' }, `providerWindow=${String(bad)} 非法 → 落 cli`);
}

// ── ⑥ 源码锁:R8-6 不再无条件覆盖 + 服务端下发 + 前端接线 ──────────────────
{
  const app = readFileSync(join(root, 'client', 'src', 'App.jsx'), 'utf8');
  const blkStart = app.indexOf("event.type === 'result' && event.modelUsage");
  assert.ok(blkStart > -1, 'R8-6 分支存在');
  const blk = app.slice(blkStart, blkStart + 2600);
  assert.ok(/resolveBadgeWindow\(/.test(blk), 'R8-6 必须经 resolveBadgeWindow 定优先级');
    // 红线:分子口径不动
  assert.ok(!/setLiveContextUsage/.test(blk), 'R8-6 块绝不写徽章分子');
  assert.ok(!/inputTokens|cacheReadInputTokens/.test(blk), 'R8-6 块只读 contextWindow');
  // 服务端下发的联动窗口有接线
  assert.ok(/subtype === 'context_window'/.test(app), '客户端消费服务端下发的 context_window 事件');
  assert.ok(/source: 'linked'/.test(app), '下发值写缓存标 source:linked');
  assert.ok(/event\.linkedContextWindowOrigin \|\| event\.linkedContextWindowSource/.test(app),
    '读服务端来源字段用 linkedContextWindow* 前缀(不读裸 source/origin)');
  // 分母来源脚注
  assert.ok(/winSourceLabel/.test(app), '徽章弹层分母来源标签函数存在');
  assert.ok(/linkedSource: prevMeta\?\.origin/.test(app),
    'R8-6 与 fetch 回写都要把 origin 作为 linkedSource 传进纯函数(explicit 钳位靠它)');
  assert.ok(/resolvedWindowCache\.set\(wk, picked\.window\)/.test(blk),
    'R8-6 写入仲裁结果 picked.window(explicit 钳位后的新值必须落缓存)');
  assert.ok(!/resolvedWindowCache\.set\(wk, cliWin\.window\)/.test(blk),
    'R8-6 绝不把 CLI 自报值原样写进分母缓存');
}
{
  const chat = readFileSync(join(root, 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/export function resolveLinkedWindowInfo/.test(chat), '服务端导出 resolveLinkedWindowInfo');
  // 「用户显式设置」判据必须共用同一个谓词,不许两处各写一份
  assert.ok(/function explicitCompactWindow\(st\)/.test(chat), '抽出共用谓词 explicitCompactWindow');
  assert.equal((chat.match(/explicitCompactWindow\(st\)/g) || []).length, 3,
    'explicitCompactWindow 定义 1 处 + 两个消费者各调 1 次');
  assert.ok(!/typeof st\?\.autoCompactWindow === 'number'\) return null/.test(chat),
    'resolveCompactWindowSettings 不再自写一份显式判据');
  assert.ok(/subtype: 'context_window'/.test(chat), 'init 后随流下发 context_window');
  assert.ok(/linkedContextWindowSource: linkedWin\.source/.test(chat),
    '来源字段名带 linkedContextWindow 前缀,避免与 init 其它字段撞名');
  assert.ok(!/\bsource: linkedWin\.source/.test(chat), '不得再下发裸 source 字段');
  // /api/model-window 带 source
  assert.ok(/resolveDisplayWindowInfo/.test(chat), '/api/model-window 复用带 source 的解析');
}

console.log('✓ check-r103-dev-badge-window: 优先级四档 + 非法值 + 源码锁 全过');
