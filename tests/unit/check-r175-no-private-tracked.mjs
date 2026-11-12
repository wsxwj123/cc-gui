#!/usr/bin/env node
// 单测:r175 —— 公开仓里不得跟踪本机私有文件、过程档案及它们的备份。
// 发版脚本用 `git add -A` 提交,工作区里任何没被忽略的文件都会被带进公开仓;只按几个精确文件名
// 核对,会漏掉「同一份私有文件的备份」这类变体。这里按「文件名形态」看守 git 已跟踪的全部文件:
//   t1 没有私有文件 / 过程档案 / 备份被跟踪
//   t2 .gitignore 里有对应的忽略规则(防 git add -A 再带进来)
// 不是 git 检出(例如 npm 包里)时跳过。
// Run: node tests/unit/check-r175-no-private-tracked.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

let tracked = null;
try {
  tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
} catch {
  console.log('check-r175-no-private-tracked: 不是 git 检出,跳过');
  process.exit(0);
}
assert.ok(tracked.length > 100, `自证:拿到了已跟踪文件清单(${tracked.length} 个)`);

// 文件名形态 → 为什么不该进公开仓
const FORBIDDEN = [
  [/\.bak($|-)/i, '备份文件(私有文件的备份常带时间戳后缀)'],
  [/(^|\/)LEARNINGS[^/]*$/i, '经验文件及其副本'],
  [/(^|\/)PROJECT[^/]*\.md$/i, '状态账本及其副本'],
  [/\.local\.(md|js|jsx|sh)$/i, '本机私有模块 / 文档 / 脚本'],
  [/^\.devflow\//, '开发过程档案'],
  [/^\.learnings\//, '本机错误库'],
  [/^\.claude\//, '会话工作树与本机设置'],
  [/(^|\/)AGENTS\.md$/, '本机的 AI 上手指引'],
  [/(^|\/)\.env($|\.)/, '环境变量文件'],
];

// t1 没有私有文件 / 过程档案 / 备份被跟踪
{
  const hits = [];
  for (const file of tracked) {
    const rule = FORBIDDEN.find(([re]) => re.test(file));
    if (rule) hits.push(`${file}(${rule[1]})`);
  }
  assert.deepEqual(hits, [], `t1: 公开仓里跟踪了不该公开的文件: ${hits.join(';')}`);
}

// t2 忽略规则在位(这几条缺了,git add -A 就会把对应文件带进来)
{
  const lines = readFileSync(join(root, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  for (const rule of ['LEARNINGS.md', 'PROJECT.md', '*.local.md', '*.local.js', '*.local.jsx', '*.local.sh', '.devflow/', '.learnings/', '.claude/', 'AGENTS.md', '*.bak', '*.bak-*']) {
    assert.ok(lines.includes(rule), `t2: .gitignore 里有 ${rule}`);
  }
}

console.log('check-r175-no-private-tracked: all passed');
