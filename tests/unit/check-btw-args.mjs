#!/usr/bin/env node
// #9 旁问对齐 CLI 原生 /btw(side_question)。回归对象:
//  ① 旁问自称有工具还真去调 —— `--tools ""` 只关【内置】工具集,MCP 原样继承(实测
//     截获的 payload 里躺着 13 个 mcp__*)。真零工具还需空 --mcp-config + --strict-mcp-config
//     + --disable-slash-commands。
//  ② 旁问答的是主会话的问题(串台) —— --resume 把主会话尾部悬空回合带进来,CLI 还自动
//     补 "Continue from where you left off."。唯一防线是 --append-system-prompt 里那段
//     side-question reminder,必须明确"不要继续上文的任务/续跑指令"。
// 直接 import chat.js 的真函数(非复刻):删任一 flag 或改坏 reminder,下面必失败。
import assert from 'node:assert/strict';
import { buildBtwArgs, BTW_SYSTEM_REMINDER } from '../../server/routes/chat.js';

const valueOf = (args, flag) => args[args.indexOf(flag) + 1];

// ── 1. 真零工具的四件套 + reminder 都在 ──────────────────────────
{
  const args = buildBtwArgs({ sessionId: 'sid-1', model: 'claude-sonnet-4-6' });
  for (const flag of ['--tools', '--mcp-config', '--strict-mcp-config',
    '--disable-slash-commands', '--append-system-prompt']) {
    assert.ok(args.includes(flag), `缺 ${flag}`);
  }
  assert.equal(valueOf(args, '--tools'), '', '--tools 的值必须是空串(禁全部内置工具)');
  const mcp = JSON.parse(valueOf(args, '--mcp-config'));
  assert.deepEqual(mcp, { mcpServers: {} }, '--mcp-config 必须是空 server 集');
  assert.equal(valueOf(args, '--append-system-prompt'), BTW_SYSTEM_REMINDER);
}

// ── 2. reminder 的四条硬语义(措辞可改,语义不许丢)────────────────
{
  const r = BTW_SYSTEM_REMINDER;
  assert.ok(/NO tools available/.test(r), 'reminder 缺"零工具"');
  assert.ok(/single response/.test(r), 'reminder 缺"单回合作答"');
  assert.ok(/separate, lightweight agent/.test(r), 'reminder 缺"独立轻量代理"');
  // 压 CLI 自动注入的 "Continue from where you left off."(串台的直接诱因)
  assert.ok(/continue from where you left off/i.test(r), 'reminder 缺"不要续跑上文"约束');
  assert.ok(/Let me check/.test(r), 'reminder 缺"禁 Let me… 开场"');
  // Windows 走 cmd.exe /c 会重解析引号/非 ASCII:reminder 必须 ASCII 且无双引号
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7F]/.test(r), 'reminder 含非 ASCII 字符(Windows 码页会打碎)');
  assert.ok(!r.includes('"'), 'reminder 含双引号(Windows cmd 会重解析)');
}

// ── 3. 既有 flag 一个不少:有 sessionId → --resume 在 --fork-session 之前 ────
{
  const args = buildBtwArgs({ sessionId: 'sid-1' });
  const iR = args.indexOf('--resume');
  const iF = args.indexOf('--fork-session');
  assert.ok(iR >= 0 && iF >= 0, '缺 --resume/--fork-session');
  assert.equal(valueOf(args, '--resume'), 'sid-1');
  assert.ok(iR < iF, '--resume 必须在 --fork-session 之前');
  for (const flag of ['-p', '--no-session-persistence', '--output-format',
    '--verbose', '--include-partial-messages']) {
    assert.ok(args.includes(flag), `缺既有 flag ${flag}`);
  }
  assert.equal(valueOf(args, '--output-format'), 'stream-json');
  assert.ok(!args.includes('--model'), '未给 model 时不许出现 --model');
}

// ── 4. 无 sessionId(草稿会话)→ 不 resume/不 fork,仍不落盘 ─────────
{
  const args = buildBtwArgs({});
  assert.ok(!args.includes('--resume'), '无 sessionId 不该 --resume');
  assert.ok(!args.includes('--fork-session'), '无 sessionId 不该 --fork-session');
  assert.ok(args.includes('--no-session-persistence'), '任何情况都不许落盘');
  assert.ok(args.includes('--mcp-config'), '草稿会话同样必须关 MCP');
}

// ── 5. model 透传 ────────────────────────────────────────────
{
  const args = buildBtwArgs({ sessionId: 's', model: 'deepseek-v4-pro' });
  assert.equal(valueOf(args, '--model'), 'deepseek-v4-pro');
}

console.log('check-btw-args: OK');
