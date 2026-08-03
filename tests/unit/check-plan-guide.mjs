#!/usr/bin/env node
// 批G G3/G5 护栏:让系统提示与 additionalDirectories 成为【与会话无关的静态前缀】,
// 使账号级前缀缓存能跨会话命中(DeepSeek pro 未命中价 = 命中的 120 倍)。
//  · G3 规划引导从"仅 plan 模式 append"改成无条件 append —— 分支写法会把前缀劈成两桶,
//    且旧写法只在 spawn 时定型,POST /chat/permission-mode 热切进 plan 的回合拿不到引导。
//  · G5 additionalDirectories 排序 —— Set 插入序让同一组目录在不同会话里顺序不同。
// 直接 import chat.js 的真函数(非复刻):门控被加回来时下面的断言必须失败。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { composeAppendSystemPrompt } from '../../server/routes/chat.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const chatSrc = readFileSync(join(ROOT, 'server', 'routes', 'chat.js'), 'utf8');

// ── G3 ① 无用户 append:引导本身就是全部内容,三条正文逐字保留 ──────────────
const guideOnly = composeAppendSystemPrompt(undefined);
assert.ok(guideOnly.startsWith('【规划模式补充指引'), '引导以标题开头');
assert.ok(guideOnly.includes('必须调用 AskUserQuestion 工具'), '第1条:提问走 AskUserQuestion');
assert.ok(guideOnly.includes('请用 TaskCreate 把计划拆成任务清单'), '第2条:批准后 TaskCreate 拆清单');
assert.ok(guideOnly.includes('【再次调用 ExitPlanMode】重新提交'), '第3条:要求修改则重新提交');
// 适用条件写进文案本身,替代原来的代码分支(非 plan 回合靠模型自行门控)
assert.ok(guideOnly.includes('仅在规划(plan)模式下适用'), '文案自带适用条件');

// ── G3 ② 恒等:不接受模式参数,任何调用都返回同一段引导(前缀才可能跨会话共享) ──
assert.equal(composeAppendSystemPrompt(), guideOnly, '无参数 = 同一段');
assert.equal(composeAppendSystemPrompt(''), guideOnly, '空串 = 同一段');
assert.equal(composeAppendSystemPrompt('   \n  '), guideOnly, '纯空白 = 同一段');
assert.equal(composeAppendSystemPrompt(null), guideOnly, 'null = 同一段');
assert.equal(composeAppendSystemPrompt(42), guideOnly, '非字符串 = 同一段');
assert.equal(composeAppendSystemPrompt.length, 1, '只收 appendSystemPrompt,没有 mode 参数');

// ── G3 ③ 有用户 append:用户的在前、引导在后(与改动前 plan 分支的拼接顺序一致) ──
const withUser = composeAppendSystemPrompt('  只说中文。  ');
assert.ok(withUser.startsWith('只说中文。\n\n'), '用户 append 在前且已 trim');
assert.ok(withUser.endsWith(guideOnly), '引导原样接在后面');

// ── G3 ④ 源码守卫:systemPrompt 组装不得再按 permissionMode 分支 ───────────
assert.ok(!/sdkPermMode === 'plan'[\s\S]{0,400}?appendText/.test(chatSrc),
  'appendText 不得再被 plan 模式门控(会把系统提示前缀劈成两桶)');
assert.ok(/const appendText = composeAppendSystemPrompt\(appendSystemPrompt\);/.test(chatSrc),
  'appendText 由无条件的 composeAppendSystemPrompt 产出');

// ── G5 源码守卫:[...dirSet] 每一处都必须紧跟 .sort() ─────────────────────
const dirSpreads = chatSrc.match(/\[\.\.\.dirSet\][^\n]*/g) || [];
assert.ok(dirSpreads.length >= 2, `[...dirSet] 应至少 2 处(compatKey + 实参),实得 ${dirSpreads.length}`);
for (const line of dirSpreads) {
  assert.ok(line.startsWith('[...dirSet].sort()'), `[...dirSet] 必须排序,漏了:${line}`);
}

console.log('check-plan-guide: OK');
