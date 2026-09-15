#!/usr/bin/env node
// R42(2026-09-13,用户实报):轮末/消息用量行的**价格来源标注**太长 —— 窄面板下它把这条行撑出换行。
// 契约(INTERFACE §G):来源词从行内收起,改做金额 title 的**首行**(悬停可见);行内只留
// 输入 / 输出 / 金额,外加三类「钱算不出 / 算不全」的提示(费用未知原因 / 已知小计说明 /
// 用量字段异常 code)—— 那三类是声明,收起来等于把部分金额装成完整金额,必须仍留在行内。
// 渲染点两处(P1 TurnBubble 轮末回合气泡 / P2 MessageBubble 逐条消息卡),JSX 不能真 import
// → 源码锁 + 变异哨兵(把任一处改回行内 span / 删 ml-auto / 删三类提示之一,本文件必红)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { costSourceLabel, costUnknownNote, COST_REASON_TEXT } from '../../client/src/utils/pricing.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = {
  TurnBubble: readFileSync(join(root, 'client/src/components/TurnBubble.jsx'), 'utf8'),
  MessageBubble: readFileSync(join(root, 'client/src/components/MessageBubble.jsx'), 'utf8'),
};

// ── 0. 来源词的唯一来源(pricing.js,本项一个字不改):六个词 + 两个后缀 ──────────
{
  const golden = [
    [{ tier: 'official', appliedConditions: [{ period: 'peak' }] }, '官方价·分时段'],
    [{ tier: 'official', appliedConditions: [{ context: 'long context' }] }, '官方价·长上下文'],
    [{ tier: 'official' }, '按官网价估算'],
    [{ tier: 'manual' }, '手填单价'],
    [{ tier: 'community' }, '社区表（估算）'],
    [{ tier: 'offline' }, '离线旧价（估算）'],
  ];
  for (const [cost, word] of golden) assert.equal(costSourceLabel(cost), word, `来源词表漂了: ${word}`);
  assert.equal(costSourceLabel({ tier: 'official', matchedExactly: false }), '按官网价估算·疑似', '后缀·疑似');
  assert.equal(costSourceLabel({ tier: 'official', retired: true }), '按官网价估算·已下架', '后缀·已下架');
  assert.equal(COST_REASON_TEXT.NO_PRICE, '未定价 · 费用未知', '费用未知六词之一漂了');
  assert.equal(costUnknownNote({ unknownDimensions: ['period'] }), '部分调用时段未知 · 费用为已知小计', '已知小计三句之一漂了');
}

// ── 1. 行内不再有来源词:来源只能作为 title 模板的一部分出现 ────────────────────
for (const [name, src] of Object.entries(files)) {
  assert.ok(!/\{authoritative \? '官方计费口径' : costSourceLabel\(cost\)\}/.test(src),
    `${name}: 旧的「行内来源 span」必须已删除`);
  assert.ok(!/;\s*\/\/\s*R42[\s\S]{0,200}?=>\s*\{costSourceLabel\(cost\)\s*\}/.test(src), `${name}: 来源词不得作为 JSX 子节点渲染`);
  const calls = src.split('costSourceLabel(cost)').length - 1;
  const inTitle = src.split('${costSourceLabel(cost)}\\n${costTitle(cost)}').length - 1;
  assert.equal(inTitle, 1, `${name}: 金额 title 首行必须是「来源词\\n + 原有说明」这一形态`);
  assert.equal(calls, inTitle, `${name}: costSourceLabel 只能出现在 title 模板里(${calls} 处调用 / ${inTitle} 处 title)`);
  if (name === 'TurnBubble') assert.ok(src.includes('官方计费口径\\n'), 'TurnBubble: authoritative 分支的 title 首行必须是固定串「官方计费口径」');
}

// ── 2. 金额锚点 + 靠右:锚点恰好 1 个;ml-auto 由金额自己或其直接父元素接住 ────────
for (const [name, src] of Object.entries(files)) {
  assert.equal(src.split('data-cgui="usage-amount"').length - 1, 1, `${name}: 用量行金额元素恰好 1 个 data-cgui="usage-amount"`);
}
{
  const turnClass = /data-cgui="usage-amount"\s+className="([^"]*)"/.exec(files.TurnBubble)?.[1] ?? '';
  assert.ok(turnClass.includes('ml-auto'),
    `轮末:来源 span 被删后 ml-auto 必须迁到金额自身(否则金额贴左),实际 class="${turnClass}"`);
  assert.ok(/<span className="ml-auto flex items-center gap-1\.5">[\s\S]{0,400}?data-cgui="usage-amount"/.test(files.MessageBubble),
    '消息卡:金额的直接父元素仍须是带 ml-auto 的那一组');
}

// ── 3. 边界三类必须仍在行内(BRIEF 红线:钱拿不到 / 钱算不全的声明不许收进悬停) ──
for (const [name, src] of Object.entries(files)) {
  assert.ok(/\{COST_REASON_TEXT\[unavailable\.reason\] \|\| COST_REASON_TEXT\.NO_PRICE\}/.test(src),
    `${name}: 费用未知原因必须仍以可见文本渲染`);
  assert.ok(/costUnknownNote\(cost\)\}/.test(src), `${name}: 已知小计说明必须仍以可见文本渲染`);
}
assert.ok(/\{usage\.ccgui_usage\.codes\.join\(' \/ '\)\}/.test(files.TurnBubble), 'TurnBubble: 用量字段异常 code 必须仍以可见文本渲染');
assert.ok(/\{usageCodes\.join\(' \/ '\)\}/.test(files.MessageBubble), 'MessageBubble: 用量字段异常 code 必须仍以可见文本渲染');

// ── 4. 行容器要素不许被顺手清掉(契约 §G.1:flex-wrap 必须保留,极窄下自然折行) ────
for (const [name, src] of Object.entries(files)) {
  assert.ok(src.includes('flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-ink-faint'),
    `${name}: 用量行容器的 flex/flex-wrap/gap/字号类串必须保留`);
}

console.log('check-r42-usage-source-tooltip: all passed');
