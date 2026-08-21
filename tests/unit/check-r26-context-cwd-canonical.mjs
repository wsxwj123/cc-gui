#!/usr/bin/env node
// 单测:r26-B4 /context cwd 归一化比对(canonicalCwd + contextHintsMatch)。
// 根因:symlink 别名(mac /tmp→/private/tmp)、尾斜杠、win 大小写差异让
// request.cwd 与 slot.cwd 严格 === 恒不等 → 永久 409。修法:双侧 canonicalCwd
// 归一化(收敛不放宽:realpath 单射,不同目录归一后仍不等)。
// 变异哨兵(实际验证过红):
//   S1 canonicalCwd 去掉 realpath 步骤 → t1 红(symlink 别名不再收敛)
//   S2 contextHintsMatch 回落到严格 === → t5 红
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalCwd } from '../../server/utils/safe-path.js';
import { contextHintsMatch } from '../../server/routes/chat.js';

const tmp = tmpdir(); // macOS: /var/folders/...(/var 是 symlink),不硬编路径
const realTmp = realpathSync(tmp);

// t1 mac 形态哨兵:symlink 别名两侧归一后相等
assert.equal(canonicalCwd(tmp), canonicalCwd(realTmp),
  `t1: symlink 别名应收敛到同一真实路径(${tmp} vs ${realTmp})`);
assert.equal(canonicalCwd(tmp), realTmp, 't1: 归一结果应为 realpath 形态');

// t2 尾部分隔符:/tmp 与 /tmp/(含 \)相等
assert.equal(canonicalCwd(tmp), canonicalCwd(tmp + '/'), 't2: 尾斜杠归一');
assert.equal(canonicalCwd(tmp), canonicalCwd(tmp + '\\'), 't2: 尾反斜杠归一');

// t3 防放宽哨兵:两个不同真实目录归一后仍不等
{
  const a = mkdtempSync(join(tmp, 'r26-b4-a-'));
  const b = mkdtempSync(join(tmp, 'r26-b4-b-'));
  assert.notEqual(canonicalCwd(a), canonicalCwd(b), 't3: 不同目录绝不归一到同一路径');
}

// t4 win32 分支(注入 platform):C:\Foo 与 c:\foo\ 相等;/ 分隔符统一为 \
{
  const x = canonicalCwd('C:\\Foo', 'win32');
  const y = canonicalCwd('c:\\foo\\', 'win32');
  const z = canonicalCwd('C:/FOO', 'win32');
  assert.equal(x, y, 't4: win 大小写 + 尾斜杠归一');
  assert.equal(x, z, 't4: win 正斜杠统一为反斜杠');
  assert.equal(x, 'c:\\foo', 't4: 归一形态钉死(lowercase + backslash)');
  assert.notEqual(canonicalCwd('C:\\Foo', 'win32'), canonicalCwd('C:\\Bar', 'win32'),
    't4: win 不同目录仍不等(防放宽)');
}

// t5 不存在路径回落不抛,且归一(大小写/尾斜杠)仍生效
{
  const ghost = join(tmp, 'r26-b4-nonexistent-' + Date.now());
  assert.doesNotThrow(() => canonicalCwd(ghost), 't5: ENOENT 不抛');
  assert.equal(canonicalCwd(ghost), canonicalCwd(ghost + '/'), 't5: 回落路径尾斜杠归一');
  assert.equal(canonicalCwd('Z:\\NoSuch\\Dir', 'win32'), 'z:\\nosuch\\dir',
    't5: win 不存在路径回落后大小写归一仍生效');
}

// t6 contextHintsMatch 集成:别名/真实路径两侧匹配;不同项目仍 409
{
  const canonical = canonicalCwd(tmp);
  const meta = {
    projectHash: canonical.replace(/[^A-Za-z0-9]/g, '-'), // trustedContextMeta 同口径派生
    canonicalCwd: canonical,
    cwd: tmp,
  };
  assert.equal(contextHintsMatch({ projectHash: meta.projectHash, cwd: realTmp }, meta), true,
    't6: 请求侧真实路径 vs slot 侧别名 → 匹配(409 消除)');
  assert.equal(contextHintsMatch({ projectHash: meta.projectHash, cwd: tmp + '/' }, meta), true,
    't6: 尾斜杠差异 → 匹配');
  const other = mkdtempSync(join(tmp, 'r26-b4-other-'));
  assert.equal(contextHintsMatch({ projectHash: meta.projectHash, cwd: other }, meta), false,
    't6: 不同目录 → 仍不匹配(信任不放宽)');
  assert.equal(contextHintsMatch({ projectHash: 'wrong-hash', cwd: realTmp }, meta), false,
    't6: projectHash 不等 → 仍不匹配');
  assert.equal(contextHintsMatch({ projectHash: '', cwd: '' }, meta), true,
    't6: 双侧缺省 → 不校验(既有语义保留)');
}

// t7 历史 meta(无 canonicalCwd 字段)回落到 meta.cwd 现算
{
  const meta = { projectHash: 'h', cwd: realTmp };
  assert.equal(contextHintsMatch({ projectHash: 'h', cwd: tmp }, meta), true,
    't7: 无 canonicalCwd 字段时 meta.cwd 现算归一');
}

console.log('PASS r26-b4-context-cwd-canonical');
