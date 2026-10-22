#!/usr/bin/env node
// r151g 安全复审处置(重要 1 / 建议 4 / 建议 5)的守卫。
//   这三处都埋在 handleChatPost / finishSessionModeSwitch 的内部时序里,跑真 CLI 才能观察到,
//   代价高且不稳。这里只做两件轻量的事(不起进程、不监听端口):
//     a) isSessionIdShape:代数表只收 36 位 uuid 形状的 id(任意长字符串 / 路径片段都过不了);
//     b) finishSessionModeSwitch(r151q 第 13 项起导出真函数做行为断言):先无条件清"切档进行中"计数,
//        再在 isSessionIdShape 通过时才写代数表;
//     c) chat.js 源码锁(内部时序,没有可单测的纯函数):
//        · handleChatPost 的占位 409 在入口钩子 await runChatEntryHook 之前(卡片凭据不被白发);
//        · 冷启等待的第二段循环按 pumpEnded / exitCode 提前退出;
//        · 冷启强制兜底前有"活 shell 且未发起中止 → 不杀(置 null)"的保护。
// node tests/unit/check-r151g-mode-ordering-limits.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isSessionIdShape } from '../../server/services/session-reader.js';
import {
  finishSessionModeSwitch, beginSessionModeSwitch, permissionModeSwitchPending, sessionModeGeneration,
} from '../../server/routes/chat.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const chatSrc = readFileSync(join(ROOT, 'server', 'routes', 'chat.js'), 'utf8');

// ── a) 形状判据 ───────────────────────────────────────────────────────────────
// 真实会话 id 恒为 uuid;形状不合法的 id 不是真实会话,不配当长期表的键。
assert.equal(isSessionIdShape('s1'), false, '短 id 不是会话 id 形状(既有"非 UUID 也回 200"的单测仍要求接口放行)');
assert.equal(isSessionIdShape('a'.repeat(36)), true, '36 位 uuid 字符是合法会话 id 形状');
assert.equal(isSessionIdShape('x'.repeat(4096)), false, '超长字符串不是合法会话 id 形状(防内存放大的直接判据)');
assert.equal(isSessionIdShape('../etc/passwd'), false, '路径片段不是合法会话 id 形状');

// ── b) 源码锁 ────────────────────────────────────────────────────────────────
/** 取一个 `function <name>(` 声明到下一个行首 `}` 的函数体(先断言锚点存在)。 */
function functionBody(name) {
  const start = chatSrc.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `源码里找不到 function ${name}(`);
  const end = chatSrc.indexOf('\n}\n', start);
  assert.ok(end > start, `找不到 function ${name} 的结束位置`);
  return chatSrc.slice(start, end);
}

// b1) finishSessionModeSwitch:先无条件清计数,后(按形状)写表。行为断言,不再比对函数体里的位置。
{
  const goodSid = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const goodKey = goodSid.toLowerCase();
  const gen0 = sessionModeGeneration(goodSid);
  beginSessionModeSwitch(goodKey);
  assert.equal(permissionModeSwitchPending(goodSid), true, '前置:切档进行中');
  finishSessionModeSwitch(goodSid, goodKey, 'acceptEdits');
  assert.equal(permissionModeSwitchPending(goodSid), false, '合法 id:完成后清掉"切档进行中"');
  assert.equal(sessionModeGeneration(goodSid), gen0 + 1, '合法 id:代数 +1');
  assert.equal(sessionModeGeneration(goodSid.toUpperCase()), gen0 + 1, '代数表按小写记,大小写同一会话');

  // 计数是"个数"不是开关:两次开始、一次完成后仍在进行中
  beginSessionModeSwitch(goodKey); beginSessionModeSwitch(goodKey);
  finishSessionModeSwitch(goodSid, goodKey, null);
  assert.equal(permissionModeSwitchPending(goodSid), true, '还有一次切档没完成时仍算进行中');
  finishSessionModeSwitch(goodSid, goodKey, null);
  assert.equal(permissionModeSwitchPending(goodSid), false, '全部完成后清零');

  // 窄复审锚的行为版:形状不合法的 id 也必须清计数(清计数不能挪进形状分支),但不写代数表
  for (const bad of ['s1', 'x'.repeat(4096), '../etc/passwd']) {
    beginSessionModeSwitch(bad.toLowerCase());
    assert.equal(permissionModeSwitchPending(bad), true, `前置:${bad.slice(0, 16)} 切档进行中`);
    finishSessionModeSwitch(bad, bad.toLowerCase(), 'default');
    assert.equal(permissionModeSwitchPending(bad), false, `形状不合法的 id(${bad.slice(0, 16)})也要清计数,否则跨会话回合永远退回排队`);
    assert.equal(sessionModeGeneration(bad), 0, `形状不合法的 id(${bad.slice(0, 16)})不写代数表`);
  }

  // LRU 淘汰保留:再写 2048 个不同的合法 id 后,最早的条目已被淘汰(代数回到 0),最近的仍在
  const sidAt = (i) => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  for (let i = 0; i < 2048; i++) finishSessionModeSwitch(sidAt(i), sidAt(i), null);
  assert.equal(sessionModeGeneration(goodSid), 0, '代数表有上限:最久没动的条目被淘汰');
  assert.equal(sessionModeGeneration(sidAt(2047)), 1, '最近写入的条目仍在');
}

// b2) handleChatPost:占位 409 前移到入口钩子之前(建议 4)。
{
  const handlerAt = chatSrc.indexOf('async function handleChatPost(');
  assert.ok(handlerAt >= 0, '找不到 handleChatPost');
  const entryHookAt = chatSrc.indexOf('await runChatEntryHook({');
  const earlyBusyAt = chatSrc.indexOf('if (sessionId && sessionSlotReserved(sessionId)) {');
  assert.ok(entryHookAt >= 0, '找不到入口钩子调用 await runChatEntryHook({');
  assert.ok(earlyBusyAt >= 0, '找不到占位 409 的调用锚点');
  assert.ok(earlyBusyAt > handlerAt, '占位 409 调用应位于 handleChatPost 内');
  assert.ok(earlyBusyAt < entryHookAt, '占位 409 必须在入口钩子 await 之前(否则卡片凭据已先被消耗)');
}

// b3) 冷启等待:第二段循环对"没有活后台命令"的槽按 pumpEnded / exitCode 立即退出,不再无条件等满 4 秒;
//     带活后台命令的已中止槽不能只看这两个信号(finishSlot 在泵收尾时就补 exitCode,进程可能还活着;E10 锁这条)。
{
  const liveAt = chatSrc.indexOf('if (slotHasLiveShell(abortedLiveShell)) {');
  const settleAt = chatSrc.indexOf('const settled = () => abortedLiveShell.pumpEnded || abortedLiveShell.exitCode !== null;');
  const waitAt = chatSrc.indexOf('while (!settled() && Date.now() < deadline)');
  assert.ok(liveAt >= 0, '第二段等待循环必须区分"带活后台命令的已中止槽"');
  assert.ok(settleAt >= 0, '没有活后台命令的槽:泵收尾 / exitCode 一落就立即退出');
  assert.ok(waitAt >= 0, '找不到第二段等待循环');
  assert.ok(liveAt < settleAt && settleAt < waitAt, '判据与等待循环的相对位置不对');
}

// b4) 冷启强制兜底前:活 shell 且未发起中止 → 置 null 不杀(建议 5)。
{
  const forceAt = chatSrc.indexOf('\n    if (lingering) {\n');
  const guardAt = chatSrc.indexOf('if (lingering && slotHasLiveShell(lingering) && !lingering.abort?.signal?.aborted) lingering = null;');
  assert.ok(forceAt >= 0, '找不到冷启强制兜底 if (lingering) {');
  assert.ok(guardAt >= 0, '强制兜底前应有"活 shell 且未发起中止不杀"的保护');
  assert.ok(guardAt < forceAt, '"活 shell 且未中止 → 不杀"保护必须在强制兜底之前');
}

console.log('check-r151g-mode-ordering-limits: OK');
process.exit(0);
