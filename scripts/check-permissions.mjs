// 权限批核心纯逻辑回归测试 —— "始终允许写规则"与"越界目录授权"的 updatedPermissions 构造。
// 跑法:npm run test:permissions
import assert from 'node:assert/strict';
import { buildAlwaysAllowUpdates, buildDirAuthUpdates } from '../server/utils/permission-rules.js';

// ── buildAlwaysAllowUpdates ──────────────────────────────────────
// SDK 给了 suggestions → 整组原样返回(官方 always-allow 语义,规则粒度由 CLI 决定)
{
  const sug = [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//tmp/**' }], behavior: 'allow', destination: 'session' },
  ];
  assert.deepEqual(buildAlwaysAllowUpdates('Bash', { command: 'git status' }, sug), sug, 'suggestions returned as-is');
}
// 无建议 + Bash → 精确命令规则,写 userSettings
assert.deepEqual(
  buildAlwaysAllowUpdates('Bash', { command: '  git log --oneline  ' }, undefined),
  [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git log --oneline' }], behavior: 'allow', destination: 'userSettings' }],
  'bash fallback = exact trimmed command rule',
);
// 无建议 + Bash 空命令 → 裸工具名(不生成空 specifier)
assert.deepEqual(
  buildAlwaysAllowUpdates('Bash', {}, [])[0].rules,
  [{ toolName: 'Bash' }],
  'empty command falls back to bare tool rule',
);
// 无建议 + WebFetch → domain 规则
assert.deepEqual(
  buildAlwaysAllowUpdates('WebFetch', { url: 'https://api.example.com/v1/x?y=1' }, null)[0].rules,
  [{ toolName: 'WebFetch', ruleContent: 'domain:api.example.com' }],
  'webfetch fallback = domain rule',
);
// WebFetch 坏 URL → 裸工具名,不抛
assert.deepEqual(
  buildAlwaysAllowUpdates('WebFetch', { url: 'not a url' }, null)[0].rules,
  [{ toolName: 'WebFetch' }],
  'bad url degrades to bare tool rule',
);
// 其余工具 → 裸工具名(与旧"永远允许 <tool>"白名单语义一致)
{
  const u = buildAlwaysAllowUpdates('Edit', { file_path: '/x/y.js' }, undefined);
  assert.deepEqual(u, [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'userSettings' }], 'generic tool = bare rule');
}

// ── buildDirAuthUpdates ──────────────────────────────────────────
// 文件路径(isDir=false)→ 取父目录;默认 session 级
assert.deepEqual(
  buildDirAuthUpdates('/Users/a/docs/notes.txt', { isDir: false }),
  [{ type: 'addDirectories', directories: ['/Users/a/docs'], destination: 'session' }],
  'file path → parent dir, session destination',
);
// 目录路径(isDir=true)→ 目录本身;permanent → userSettings
assert.deepEqual(
  buildDirAuthUpdates('/Users/a/docs', { isDir: true, permanent: true }),
  [{ type: 'addDirectories', directories: ['/Users/a/docs'], destination: 'userSettings' }],
  'dir path permanent → userSettings',
);
// isDir 未知(stat 失败,如路径不存在):带扩展名按文件、无扩展名按目录
assert.deepEqual(buildDirAuthUpdates('/a/b/new-file.md', {})[0].directories, ['/a/b'], 'unknown+ext → dirname');
assert.deepEqual(buildDirAuthUpdates('/a/b/subdir', {})[0].directories, ['/a/b/subdir'], 'unknown+no-ext → itself');
// 空路径 → 空更新(调用方不附带 updatedPermissions)
assert.deepEqual(buildDirAuthUpdates('', {}), [], 'empty path → no updates');
assert.deepEqual(buildDirAuthUpdates(null, {}), [], 'null path → no updates');

console.log('check-permissions: all assertions passed');
