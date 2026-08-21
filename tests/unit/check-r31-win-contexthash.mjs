#!/usr/bin/env node
// r31:B4【Windows /context 恒 409】 —— contextHintsMatch 的 projectHash 双侧必须同口径归一。
// 根因:trustedContextMeta 的 `meta.projectHash = canonicalCwd(slot.cwd).replace(...)`,而
// canonicalCwd 在 win32 会 toLowerCase;客户端 request.projectHash 却来自磁盘真实目录名
// (Windows 大小写保留)→ 两值大小写不同 → `request.projectHash === meta.projectHash` 恒 false
// → /context 恒 409。目录名本就是路径编码,大小写不敏感比较是安全的。
// 修法:contextHintsMatch 比对前双侧都 toLowerCase(cwd 那条已是双侧 canonicalCwd,不动)。
//
// 断言(修前红):
//   A 大小写差异的 projectHash 双侧必须判等(旧实现恒 409 → 红);
//   B 完全相等 → 判等(回归);
//   C 真正不同(非大小写)projectHash → 判不等(不因归一而放宽);
//   D cwd 双侧 canonicalCwd 归一仍判等(不回归 r26-B4)。
// Run: node tests/unit/check-r31-win-contexthash.mjs
import assert from 'node:assert/strict';
import { contextHintsMatch } from '../../server/routes/chat.js';
import { canonicalCwd } from '../../server/utils/safe-path.js';

let n = 0;
const ok = (v, m) => { assert.equal(v, true, m); n += 1; };
const notOk = (v, m) => { assert.equal(v, false, m); n += 1; };

// 根因佐证:win32 canonicalCwd 会把项目目录名小写化(服务端 meta.projectHash 由此派生)。
const metaStem = canonicalCwd('C:\\Users\\Admin\\Desktop\\MyProj', 'win32').replace(/[^A-Za-z0-9]/g, '-');
assert.ok(metaStem === metaStem.toLowerCase() && metaStem.includes('myproj'),
  '根因:win32 canonicalCwd 产出小写化项目 hash 段');

// A 修前红:客户端 request.projectHash 大小写保留,服务端 meta.projectHash 小写化 → 必须判等。
{
  const request = { projectHash: 'C-Users-Admin-Desktop-MyProj' }; // 客户端:磁盘真实目录名(大小写保留)
  const meta = { projectHash: 'c-users-admin-desktop-myproj' };     // 服务端:canonicalCwd(win32)派生(小写)
  ok(contextHintsMatch(request, meta), '修前红:大小写差异的 projectHash 双侧必须判等(旧实现恒 409)');
}

// B 完全相等 → 判等(回归)。
ok(contextHintsMatch({ projectHash: 'proj-a' }, { projectHash: 'proj-a' }), 'B: 完全相等判等');

// C 真正不同 → 判不等(归一不放宽)。
notOk(contextHintsMatch({ projectHash: 'proj-a' }, { projectHash: 'proj-b' }), 'C: 真正不同判不等');

// D cwd 双侧 canonicalCwd 归一仍判等(不回归 r26-B4)。
{
  const cwd = '/tmp/r31-cwd-proj';
  ok(
    contextHintsMatch({ cwd }, { cwd, canonicalCwd: canonicalCwd(cwd) }),
    'D: cwd 双侧 canonicalCwd 归一仍判等',
  );
}

console.log(`PASS check-r31-win-contexthash (${n} assertions)`);
