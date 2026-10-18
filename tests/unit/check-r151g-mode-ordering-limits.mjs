#!/usr/bin/env node
// r151g 安全复审处置(重要 1 / 建议 4 / 建议 5)的守卫。
//   这三处都埋在 handleChatPost / finishSessionModeSwitch 的内部时序里,跑真 CLI 才能观察到,
//   代价高且不稳。这里只做两件轻量的事(不起进程、不监听端口):
//     a) isSessionIdShape:代数表只收 36 位 uuid 形状的 id(任意长字符串 / 路径片段都过不了);
//     b) chat.js 源码锁:
//        · finishSessionModeSwitch 先清"切档进行中"计数,再在 isSessionIdShape 通过时才写代数表;
//        · handleChatPost 的占位 409 在入口钩子 await runChatEntryHook 之前(卡片凭据不被白发);
//        · 冷启等待的第二段循环按 pumpEnded / exitCode 提前退出;
//        · 冷启强制兜底前有"活 shell 且未发起中止 → 不杀(置 null)"的保护。
// node tests/unit/check-r151g-mode-ordering-limits.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isSessionIdShape } from '../../server/services/session-reader.js';

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

// b1) finishSessionModeSwitch:先清计数,后(按形状)写表。
{
  const body = functionBody('finishSessionModeSwitch');
  const shapeAt = body.indexOf('isSessionIdShape(');
  const clearAt = body.indexOf('permissionModeSwitching.delete(switchKey)');
  const writeAt = body.indexOf('sessionModeGenerations.get(key)');
  assert.ok(shapeAt >= 0, 'finishSessionModeSwitch 必须先过 isSessionIdShape 才写代数表');
  assert.ok(clearAt >= 0, '找不到清"切档进行中"计数的锚点');
  assert.ok(writeAt >= 0, '找不到写代数表的锚点');
  assert.ok(clearAt < writeAt, '必须始终先清计数(形状不合法也不能漏),再按形状决定写不写代数表');
  assert.ok(shapeAt < writeAt, '写表必须在 isSessionIdShape 判真之后');
  // 窄复审(补锚):清计数必须无条件发生在 isSessionIdShape 分支之外 —— 只锁 clearAt < writeAt / shapeAt < writeAt
  // 不够:把清计数整体挪进 `if (isSessionIdShape(...))` 分支里时,三条既有锚仍全绿,但形状不合法的 id 永远清不掉
  // 自己的"切档进行中"标记 → 该会话的跨会话回合永远退回排队。故直接锚定 clearAt < shapeAt。
  assert.ok(clearAt < shapeAt, '清计数必须在 isSessionIdShape 判定之前(不能挪进形状分支,否则不合法 id 的"切档进行中"永久非零)');
  assert.ok(/SESSION_MODE_GEN_MAX/.test(body), 'LRU 淘汰逻辑应保留');
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
