// P0 回归:safePath 的 symlink 逃逸防护(工作区内的符号链接指向工作区外 → 必须拒,
// 否则 read/write/delete 作用到越界目标 = rm -rf /etc 类)。用本仓库(已注册工作区、在 HOME 内)
// 建临时符号链接指向 /private/tmp 外部目标,验证 safePath 抛 403;合法路径应通过。
import { safePath } from '../server/routes/files.js';
import { mkdtempSync, symlinkSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('✗', m); } };
const repo = process.cwd(); // = claude-gui 仓库,已注册工作区且在 HOME 内

// 外部受害目标(HOME 外)+ 仓库内指向它的符号链接
const victim = mkdtempSync(join(tmpdir(), 'cgui-symtest-victim-'));
writeFileSync(join(victim, 'keep.txt'), 'sentinel');
const link = join(repo, `.cgui-symtest-link-${process.pid}`);
try {
  symlinkSync(victim, link);
  // 逃逸:仓库内符号链接 → HOME 外目标 → 必须抛(不返回 real)
  let threw = false;
  try { await safePath(link); } catch (e) { threw = true; ok(e.status === 403, `逃逸应 403,实际 status=${e.status}`); }
  ok(threw, 'safePath 对逃逸符号链接必须抛(否则 delete 会 rm 越界目标)');

  // 合法:仓库内真实文件 → 通过,返回 real
  const legit = await safePath(join(repo, 'package.json')).catch((e) => { console.error('合法路径不该抛:', e.message); return null; });
  ok(!!legit && legit.endsWith('package.json'), '仓库内真实文件应放行');

  // 非绝对路径 → 400
  let bad = false; try { await safePath('relative/x'); } catch (e) { bad = e.status === 400; }
  ok(bad, '非绝对路径应 400');
} finally {
  try { rmSync(link); } catch {}
  try { rmSync(victim, { recursive: true, force: true }); } catch {}
}

console.log(`check-files-safepath: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
