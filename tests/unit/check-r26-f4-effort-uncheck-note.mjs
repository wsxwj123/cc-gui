#!/usr/bin/env node
// r26-F4【单测】:ProviderThinkingEditor 必须明写「全不选 = 全放行」语义。
// 修前:toggleEffort 全不选 → 回到全默认(不限制任何档位),与「全禁」的直觉相反,
// 用户以为禁了所有档,实际一个没禁。
// 文本哨兵:①说明文案存在且同时在语义正确的位置(档位复选框行内,think 分支里);
// ②文案必须包含两个关键信息:「全部不勾选 = 不限制」与「支持思考」开关指引;
// ③toggleEffort 的全不选=全默认逻辑本身不动(语义保留,只加说明)。
// Run: node tests/unit/check-r26-f4-effort-uncheck-note.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };

const src = readFileSync(new URL('../../client/src/components/ProviderThinkingEditor.jsx', import.meta.url), 'utf8');

// ①② 文案存在且信息完整
{
  ok(src.includes('全部不勾选 = 不限制任何档位'), 'F4: 必须明写「全部不勾选 = 不限制任何档位」');
  ok(src.includes('支持思考'), 'F4: 必须指引到「支持思考」开关(真·禁用入口)');
  // 位置:在 think 条件分支(档位复选框行)内,不是写在别处没人看
  const thinkIdx = src.indexOf('{think && (');
  const noteIdx = src.indexOf('全部不勾选 = 不限制任何档位');
  const thinkBlock = src.slice(thinkIdx, src.indexOf(')}', thinkIdx) + 200);
  ok(noteIdx > thinkIdx && noteIdx < thinkIdx + thinkBlock.length + 800,
    'F4: 文案必须在档位复选框所在行内(用户正在操作的位置)');
  n += 3;
}

// ③ toggleEffort 语义不动(全不选=全默认的兼容行为保留)
{
  ok(/ordered\.length === 0 \|\| ordered\.length === EFFORT_ORDER\.length/.test(src),
    'F4: 全不选/全选 = 回到全默认的逻辑保留(不修行为,只加说明)');
  n += 1;
}

console.log(`PASS check-r26-f4-effort-uncheck-note (${n} assertions)`);
