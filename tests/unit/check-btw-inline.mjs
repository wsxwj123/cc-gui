#!/usr/bin/env node
// 批J J1:旁问串台的位置权重修复 —— 内联首尾标记。
// 回归对象:argv 层早已对齐(tools 恒 []、system reminder 在 system block 末尾,见
// check-btw-args.mjs),但串台照旧。真因是位置权重:system 层那段 reminder 只占整条
// prompt 的约 0.3%,后面还跟着几百 KB 的主任务上下文 —— 模型最后读到的是主任务,于是
// 接着做主任务。修法是把同一约束在【用户消息】里复制一份贴在首尾。
// **后缀是重点**(消息层最后一个位置权重最高):它必须是整条消息的字面最后内容,后面
// 不许再拼任何东西 —— 哪怕一个换行都不行,否则"最后读到的是约束"这个前提就没了。
// 直接 import chat.js 的真函数(非复刻):改坏 wrapBtwInline 或在后缀之后再拼东西,
// 下面必失败。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { wrapBtwInline, BTW_INLINE_PREFIX, BTW_INLINE_SUFFIX } from '../../server/routes/chat.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── 1. 前缀开头 / 后缀结尾 / 原文原样在中间 ────────────────────────
{
  const composed = '现在的追问:\n这个函数为什么要 await?';
  const out = wrapBtwInline(composed);
  assert.ok(out.startsWith(BTW_INLINE_PREFIX), '必须以旁问前缀标记开头');
  assert.ok(out.endsWith(BTW_INLINE_SUFFIX), '必须以旁问后缀标记结尾');
  assert.ok(out.includes(composed), '原 composed 文本必须原样保留(不许改写/截断)');
  // 后缀之后一个字符都不许有(含空白/换行)。endsWith 已蕴含,这里显式钉死意图。
  const tail = out.slice(out.lastIndexOf(BTW_INLINE_SUFFIX) + BTW_INLINE_SUFFIX.length);
  assert.equal(tail, '', '后缀之后不得再有任何字符');
  // 原文被夹在两个标记之间,而不是与标记重叠/穿插。
  const mid = out.slice(BTW_INLINE_PREFIX.length, out.length - BTW_INLINE_SUFFIX.length);
  assert.equal(mid.trim(), composed.trim(), '中间段必须就是原文本身');
}

// ── 2. 两条标记的硬语义(措辞可改,语义不许丢)─────────────────────
{
  assert.ok(/旁问/.test(BTW_INLINE_PREFIX), '前缀缺"旁问"标识');
  assert.ok(/只回答/.test(BTW_INLINE_PREFIX), '前缀缺"只回答这一个问题"');
  assert.ok(/忽略/.test(BTW_INLINE_PREFIX), '前缀缺"忽略上文未完成任务"');
  assert.ok(/只回答/.test(BTW_INLINE_SUFFIX), '后缀缺"只回答旁支问题"');
  assert.ok(/不要继续/.test(BTW_INLINE_SUFFIX), '后缀缺"不要继续执行上文任务"');
}

// ── 3. 空/多行/含标记同形文本都不破坏首尾不变量 ─────────────────────
for (const composed of ['', '一行', 'a\nb\n\nc', `${BTW_INLINE_SUFFIX} 这是正文里提到的标记`]) {
  const out = wrapBtwInline(composed);
  assert.ok(out.startsWith(BTW_INLINE_PREFIX), `前缀不变量破了: ${JSON.stringify(composed)}`);
  assert.ok(out.endsWith(BTW_INLINE_SUFFIX), `后缀不变量破了: ${JSON.stringify(composed)}`);
}

// ── 4. 源码守卫:写进 stdin 的必须是包过的文本 ───────────────────────
// 绕过 wrapBtwInline 直写 composed 时上面全部断言依旧通过 —— 只有这条能挡住。
{
  const chat = readFileSync(join(repo, 'server/routes/chat.js'), 'utf8');
  assert.ok(/proc\.stdin\.write\(wrapBtwInline\(composed\)\)/.test(chat),
    '旁问必须把 wrapBtwInline(composed) 写进 stdin —— 直写 composed 等于没修');
  // 内联标记走 stdin,不得混进 argv(Windows cmd.exe 会在换行处截断整条命令)。
  assert.ok(!/'--append-system-prompt', BTW_INLINE/.test(chat),
    '内联标记不得进 argv:它含换行与中文,Windows 上会打碎整条命令');
  // 双保险:system 层那段 reminder 仍在 argv 里,没被这次改动顶掉。
  assert.ok(/'--append-system-prompt', BTW_SYSTEM_REMINDER/.test(chat),
    'BTW_SYSTEM_REMINDER 必须保留(system 层 + 消息层双保险)');
}

console.log('check-btw-inline: OK');
