#!/usr/bin/env node
// 单测:侧栏项目列表里「别的会话/子代理在某项目内部开出的临时工作目录」按 worktree 处理
// (R31 实报:ws-A-control-no-allowlist / ws-B-allowlist-Bash(python3 *) / .scratch/… 这类
//  行混进侧栏,而「显示 worktree」开关是关的)。
// 被测:server/services/session-reader.js 导出的纯函数 isInternalWorktreePath(path, listedPaths)。
//   判据①命中既有 worktree 形态(-worktrees/ 或 /.claude/worktrees/)——原行为不变;
//   判据②严格位于另一个【已列项目】路径之内,且相对路径含以 "." 开头的路径段。
// 变异哨兵(实际验证过红):
//   S1 删判据②的 dot-段检查(some(seg => seg.startsWith('.')) → false)→ t3 红(harness 掉 → 真缺陷复现)
//   S2 删大小写归一(去 .toLowerCase())→ t5 红(Windows/macOS 同目录不同大小写写法判不出来)
// Run: node tests/unit/check-project-list-internal-worktree.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isInternalWorktreePath } from '../../server/services/session-reader.js';

const D = '/Users/dev/Desktop';
// 用户真项目清单(模拟"全部已列项目路径",至少含每个待判路径的父项目)
const REAL = [
  D,
  `${D}/claude`,
  `${D}/claude/claude gui`,
  `${D}/claude/文献阅读`,
  `${D}/claude/省自2027`,
  `${D}/claude/代码agent选择`,
  `${D}/claude/zotero-claudian`,
  `${D}/转录组 代谢组`,
];

// t1 用户真项目一个都不许判成 worktree(含含空格/中文路径)
for (const p of REAL) {
  assert.equal(isInternalWorktreePath(p, REAL), false, `t1: 真项目不得判 worktree → ${p}`);
}

// t2 实报里的 ws-* 临时目录:父项目 zotero-claudian 在列 → 判 worktree(判据②)
{
  const hidden = [
    `${D}/claude/zotero-claudian/.scratch/m6-check/ws-A-control-no-allowlist`,
    `${D}/claude/zotero-claudian/.scratch/m6-check/ws-B-allowlist-Bash(python3 *)`,
    `${D}/claude/zotero-claudian/.scratch/m6-check/ws-C-allowlist-bad-syntax`,
    `${D}/claude/zotero-claudian/.scratch/m6-check/ws`,
  ];
  for (const p of hidden) {
    assert.equal(isInternalWorktreePath(p, REAL), true, `t2: 项目内部临时目录必须判 worktree → ${p}`);
  }
}

// t3 判据② 逐档:单层/多层嵌套、dot 段在中途、非列内路径、前缀边界
{
  const paths = [`${D}/claude`, `${D}/claude/文献阅读`];
  assert.equal(isInternalWorktreePath(`${D}/claude/文献阅读/.scratch`, REAL), true, 't3: 单层嵌套');
  assert.equal(isInternalWorktreePath(`${D}/claude/文献阅读/.tmp/a/b/c`, REAL), true, 't3: 多层嵌套');
  assert.equal(isInternalWorktreePath(`${D}/claude/文献阅读/x/.hidden/y`, REAL), true, 't3: dot 段在相对路径中途');
  assert.equal(isInternalWorktreePath(`${D}/claude/文献阅读/x/y`, REAL), false, 't3: 相对段全无 dot → 保留可见');
  assert.equal(isInternalWorktreePath(`${D}/claude/文献阅读`, paths), false, 't3: 父项目自身不判(等于自身→跳过)');
  // 父项目不在列 → 判不了(判据②要求"另一个已列项目";现实里父项目跑过会话才在列,故按规格从简)
  assert.equal(isInternalWorktreePath('/a/other/.scratch/x', ['/a/proj']), false, 't3: 不在任何已列项目内 → 不判');
  // 字符串前缀但不是路径段边界:/a/proj2 不在 /a/proj 之内
  assert.equal(isInternalWorktreePath('/a/proj2/.x/y', ['/a/proj']), false, 't3: 前缀边界必须按路径段比');
  assert.equal(isInternalWorktreePath('/a/proj', ['/a/proj']), false, 't3: 自身等于已列项 → 不判');
}

// t4 判据①(既有 worktree 形态)保持不变:有/无父项目在列都判 worktree
{
  assert.equal(isInternalWorktreePath(`${D}/claude/claude gui/.claude/worktrees/batch`, REAL), true,
    't4: /.claude/worktrees/ 判据不变');
  assert.equal(isInternalWorktreePath(`${D}/claude/claude gui/.claude/worktrees/batch`, []), true,
    't4: 判据①不依赖已列项目集合');
  assert.equal(isInternalWorktreePath('/a/repo-worktrees/f1', []), true, 't4: -worktrees/ 判据不变');
  // 只认 "段-" 形态:名字里正好含 -worktrees 但非该形态的不误伤(与既有正则同语义)
  assert.equal(isInternalWorktreePath('/a/myworktrees/f1', []), false, 't4: 无前置 "-" 不命中');
}

// t5 Windows 反斜杠 + 大小写 + 尾部分隔符
{
  assert.equal(isInternalWorktreePath('C:\\Users\\x\\proj\\.scratch\\m6\\ws-A', ['C:\\Users\\x\\proj']), true,
    't5: Windows 反斜杠路径判 worktree');
  assert.equal(isInternalWorktreePath(`C:\\Users\\x\\proj\\x\\y`, ['C:\\Users\\x\\proj']), false,
    't5: Windows 无 dot 段 → 保留');
  assert.equal(isInternalWorktreePath('C:\\Users\\x\\repo-worktrees\\f1', []), true, 't5: Windows 下判据①仍命中');
  assert.equal(isInternalWorktreePath('/a/Proj/.Scratch/X', ['/a/proj']), true, 't5: 大小写不敏感(同一目录)');
  assert.equal(isInternalWorktreePath('/A/PROJ/x/.hidden', ['/a/proj']), true, 't5: 父路径大小写不同也认');
  assert.equal(isInternalWorktreePath('/a/proj/.scratch/', ['/a/proj/']), true, 't5: 双侧尾斜杠不影响');
  assert.equal(isInternalWorktreePath('/a/proj/', ['/a/proj']), false, 't5: 带尾斜杠的父项目自身不判');
}

// t6 空值兜底(不抛)
{
  assert.equal(isInternalWorktreePath('', ['/a']), false, 't6: 空路径');
  assert.equal(isInternalWorktreePath(null, ['/a']), false, 't6: null 路径');
  assert.equal(isInternalWorktreePath('/a/x', undefined), false, 't6: 无已列集合');
}

// t7 接线:listProjects 必须经本函数打标(源级哨兵,防"函数加了没人用")
{
  const src = readFileSync(new URL('../../server/services/session-reader.js', import.meta.url), 'utf8');
  assert.match(src, /p\.isWorktree = isInternalWorktreePath\(p\.path, listedPaths\);?/,
    't7: listProjects 循环后统一用 isInternalWorktreePath 打标');
  assert.ok(!src.includes('slashPath'), 't7: 旧的单行 isWorktree 正则计算(slashPath)不得残留');
}

console.log('check-project-list-internal-worktree: PASS');
