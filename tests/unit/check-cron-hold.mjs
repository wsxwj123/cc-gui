#!/usr/bin/env node
// 批F F2 护栏:建过 cron(/loop)的会话,其 CLI 进程豁免 15 分钟闲置回收。
// 回归对象(#12):cron 调度器跑在 GUI 每回合起的那个 CLI 子进程内(1s tick),CronCreate
// 默认 session-only 不落盘 → idleReclaim 一 input.close(),内存 cron 连调度器一起静默消失。
// 实测全机 21+ 次定时任务、横跨 10 天、0 次触发记录。
// 直接 import chat.js 的真函数(非复刻):豁免被删掉时下面的断言必须失败。
//
// fixture 来自真实会话 jsonl(不自己编字段名):
//   ~/.claude/projects/-Users-wsxwj-Desktop-claude-sillytarvern-replica-worktrees-Sillytarvern-k3/
//   95a66306-7826-4afd-b3a6-1ae3dd1ba252.jsonl  第 3997/3998 行(CLI 2.1.220,`/loop 1m …`)
// 要点:成功的 tool_result 【没有】 is_error 字段;tool_use.id 形如 call_… / tool_… 都出现过。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyCronSignals, shouldHoldForCron } from '../../server/routes/chat.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const chatSrc = readFileSync(join(ROOT, 'server', 'routes', 'chat.js'), 'utf8');

const HOLD = 2 * 60 * 60 * 1000;
const MAX = 3;
const now = 1_800_000_000_000;
const newSlot = () => ({ cronToolIds: new Set(), cronHoldUntil: 0, cronPendingDelete: false });

// 真实样本(逐字摘自上述 jsonl,只删无关的 usage/uuid 等外层字段)
const CRON_CREATE_USE = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{
      type: 'tool_use', id: 'call_WFa05yRAleMJdYwNxTZvYlFl', name: 'CronCreate',
      input: { cron: '*/1 * * * *', prompt: '告诉我后台任务的进度', recurring: true, durable: false },
    }],
  },
};
const CRON_CREATE_OK = {
  type: 'user',
  message: {
    role: 'user',
    content: [{
      tool_use_id: 'call_WFa05yRAleMJdYwNxTZvYlFl', type: 'tool_result',
      content: 'Scheduled recurring job 3fa91055 (Every minute). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.',
    }],
  },
};
const CRON_DELETE_USE = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tool_5l85FxnfMxrXFD0GuzMQHbGO', name: 'CronDelete', input: { id: '1baa3259' } }],
  },
};

// ── ① CronCreate tool_use + 成功 tool_result → 挂上保活 ─────────────────────
{
  const slot = newSlot();
  applyCronSignals(slot, CRON_CREATE_USE, now, HOLD);
  assert.equal(slot.cronHoldUntil, 0, 'tool_use 只登记在飞 id,成败未知前不挂保活');
  assert.ok(slot.cronToolIds.has('call_WFa05yRAleMJdYwNxTZvYlFl'), 'CronCreate 的 tool_use_id 必须登记');
  applyCronSignals(slot, CRON_CREATE_OK, now, HOLD);
  assert.equal(slot.cronHoldUntil, now + HOLD, '成功的 tool_result → 挂 2 小时保活');
  assert.equal(slot.cronToolIds.size, 0, '配对后清掉在飞 id,不留残条');
  assert.equal(shouldHoldForCron(slot, [slot], now, MAX), true, '窗内 → 豁免闲置回收');
}

// ── ② tool_result 报错 → 不挂(模型调了但没建成,白挂 2 小时是纯泄漏)────────
{
  const slot = newSlot();
  applyCronSignals(slot, CRON_CREATE_USE, now, HOLD);
  applyCronSignals(slot, {
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'call_WFa05yRAleMJdYwNxTZvYlFl', type: 'tool_result', is_error: true, content: 'Error: bad cron expression' }] },
  }, now, HOLD);
  assert.equal(slot.cronHoldUntil, 0, 'is_error:true → 不挂保活');
  assert.equal(shouldHoldForCron(slot, [slot], now, MAX), false, '没挂 → 照常回收');
}

// ── ③ 三态:无 cronHold / 窗内 / 超窗 ──────────────────────────────────────
{
  assert.equal(shouldHoldForCron(newSlot(), [], now, MAX), false, '从没建过 cron → 不豁免');
  assert.equal(shouldHoldForCron({ cronHoldUntil: now + 1 }, [], now, MAX), true, '窗内(哪怕只剩 1ms)→ 豁免');
  assert.equal(shouldHoldForCron({ cronHoldUntil: now }, [], now, MAX), false, '恰好到点 → 不再豁免');
  assert.equal(shouldHoldForCron({ cronHoldUntil: now - 1 }, [], now, MAX), false, '超窗 → 回落常规回收');
  assert.equal(shouldHoldForCron(null, [], now, MAX), false, '空 slot 不抛');
}

// ── ④ 上限:最多 3 个 slot 同时豁免,超限时保活最早到期的先让位 ──────────────
{
  const mk = (until) => ({ cronHoldUntil: until });
  const s1 = mk(now + 1000);        // 最旧
  const s2 = mk(now + 2000);
  const s3 = mk(now + 3000);
  const s4 = mk(now + 4000);        // 最新
  const all = [s1, s2, s3, s4];
  assert.equal(shouldHoldForCron(s4, all, now, MAX), true, '最新的 3 个之一 → 豁免');
  assert.equal(shouldHoldForCron(s3, all, now, MAX), true, '最新的 3 个之一 → 豁免');
  assert.equal(shouldHoldForCron(s2, all, now, MAX), true, '第 3 新 → 仍在上限内');
  assert.equal(shouldHoldForCron(s1, all, now, MAX), false, '第 4 个(最早到期)→ 不豁免,防进程堆积');
  // 已过期的 slot 不占名额
  const stale = mk(now - 1);
  assert.equal(shouldHoldForCron(s1, [s1, s2, s3, stale], now, MAX), true, '过期 slot 不占用上限名额');
}

// ── ⑤ CronDelete → 立即清零 ───────────────────────────────────────────────
{
  const slot = newSlot();
  applyCronSignals(slot, CRON_CREATE_USE, now, HOLD);
  applyCronSignals(slot, CRON_CREATE_OK, now, HOLD);
  applyCronSignals(slot, CRON_DELETE_USE, now, HOLD);
  assert.equal(slot.cronPendingDelete, true, 'CronDelete 的 tool_use 先标记,等它的 tool_result');
  assert.equal(slot.cronHoldUntil, now + HOLD, 'tool_result 未到前保活仍在(宽松但不早停)');
  applyCronSignals(slot, {
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'tool_5l85FxnfMxrXFD0GuzMQHbGO', type: 'tool_result', content: 'Deleted job 1baa3259' }] },
  }, now, HOLD);
  assert.equal(slot.cronHoldUntil, 0, 'CronDelete 落地 → 立即清零豁免(宽松:不追查删的是哪个 job)');
  assert.equal(slot.cronPendingDelete, false, '标记复位,不影响后续回合');
  assert.equal(shouldHoldForCron(slot, [slot], now, MAX), false, '清零后照常回收');
}

// ── ⑥ 与既有信号互不干扰 ─────────────────────────────────────────────────
{
  const slot = newSlot();
  // 非 cron 工具、纯文本、system 事件都不该动 cron 簿记
  applyCronSignals(slot, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls', run_in_background: true } }] } }, now, HOLD);
  applyCronSignals(slot, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CronCreate' }] } }, now, HOLD);
  applyCronSignals(slot, { type: 'system', subtype: 'task_started', task_id: 't1' }, now, HOLD);
  applyCronSignals(slot, { type: 'user', message: { role: 'user', content: '普通文本消息' } }, now, HOLD);
  assert.equal(slot.cronToolIds.size, 0, '别的工具不进 cron 簿记');
  assert.equal(slot.cronHoldUntil, 0, '别的事件不挂保活');
  // 别人的 tool_result 不误配对
  const s2 = newSlot();
  applyCronSignals(s2, CRON_CREATE_USE, now, HOLD);
  applyCronSignals(s2, { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_other', type: 'tool_result', content: 'ok' }] } }, now, HOLD);
  assert.equal(s2.cronHoldUntil, 0, '不是自己的 tool_use_id → 不挂保活');
  assert.equal(s2.cronToolIds.size, 1, '在飞 id 仍在等自己的 tool_result');
}

// ── ⑦ 源码守卫:接线点必须在(纯函数再对,没接上等于没修)──────────────────
{
  assert.ok(/applyCronSignals\(slot, m, Date\.now\(\), CRON_HOLD_MS\)/.test(chatSrc),
    '消息泵必须每条消息调 applyCronSignals(CronCreate/CronDelete 检测接线)');
  assert.ok(/shouldHoldForCron\(slot, activeProcesses\.values\(\), now, CRON_HOLD_MAX_SLOTS\)/.test(chatSrc),
    'idleReclaim 必须调 shouldHoldForCron,且上限要看全体 activeProcesses');
  // 豁免只能是"新增分支",既有回收路径不许被改写
  const reclaim = chatSrc.match(/const idleReclaim = \(\) => \{([\s\S]*?)\n {6}\};/);
  assert.ok(reclaim, 'idleReclaim 仍是那个闭包');
  assert.ok(/slot\.closing = true;\s*\n\s*try \{ input\.close\(\); \} catch \{\}/.test(reclaim[1]),
    'idleReclaim 的既有回收路径(closing=true → input.close)逐字不动');
  assert.ok(/const CRON_HOLD_MS = 2 \* 60 \* 60 \* 1000;/.test(chatSrc), '保活上限 2 小时不得放宽');
  assert.ok(/const CRON_HOLD_MAX_SLOTS = 3;/.test(chatSrc), '同时豁免的 slot 上限 3 个不得放宽');
  assert.ok(/cronHold: slot\.cronHoldUntil > Date\.now\(\)/.test(chatSrc),
    'getActiveChatProcesses 必须暴露 cronHold,否则进程面板看不到"为什么这个进程不退"');
  const agentsSrc = readFileSync(join(ROOT, 'server', 'routes', 'agents.js'), 'utf8');
  assert.ok(/cronHold: !!p\.cronHold/.test(agentsSrc), '/api/agents/active 的 chat-process 条目必须带 cronHold');
  const panelSrc = readFileSync(join(ROOT, 'client', 'src', 'components', 'AgentMonitorPanel.jsx'), 'utf8');
  assert.ok(/agent\.cronHold &&/.test(panelSrc), '进程行必须显示保活标记');
}

console.log('✓ check-cron-hold: CronCreate 保活挂载/上限/CronDelete 清零 + idleReclaim 豁免接线');
