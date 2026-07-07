import { homedir } from 'os';
import { isAbsolute, relative, resolve, join, dirname } from 'path';
import { readdirSync } from 'fs';

export function isPathInside(child, parent) {
  const base = resolve(parent);
  const target = resolve(child);
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// "已知 claude 工作区"判定:给定路径(或其任一祖先)按 CLI 同款 dash 编码
// (replace(/[^A-Za-z0-9]/g,'-'))能在 ~/.claude/projects/ 下找到目录 = 用户显式在
// 该目录用过 claude 的工作区。用途:Windows 项目常在 $HOME 之外(D:\ 等其他盘、
// C:\projects),纯 $HOME 门禁会把合法项目整片 403(用户实报文件浏览器 outside $HOME);
// 工作区是用户自选的项目目录,放行它们不等于放开整盘。hash 比较大小写不敏感 ——
// CLI 按"当时的原始 cwd 字符串"编码,Windows 盘符/路径大小写随来源漂移。
// 可传多个候选(realpath 前后的形态都试,防 OneDrive/junction 解析改写路径致 hash 对不上)。
export function isKnownClaudeWorkspace(...paths) {
  let hashesLower;
  try {
    hashesLower = new Set(readdirSync(join(homedir(), '.claude', 'projects')).map((n) => n.toLowerCase()));
  } catch { return false; }
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    let cur = resolve(p);
    for (;;) {
      const parent = dirname(cur);
      // 文件系统根(/ 或盘符根)不作为工作区匹配:历史上以 `/` 为 cwd 跑过一次 claude
      // 就会留下 hash 条目 `-`,若认它等于放行整盘(实测抓到:/etc 都过) —— 门禁失效。
      if (parent === cur) break;
      if (hashesLower.has(cur.replace(/[^A-Za-z0-9]/g, '-').toLowerCase())) return true;
      cur = parent;
    }
  }
  return false;
}

export function resolveUnderHome(input, { label = 'path', requireCanonical = false } = {}) {
  if (typeof input !== 'string' || !isAbsolute(input)) {
    throw new Error(`invalid ${label}`);
  }
  const resolved = resolve(input);
  // requireCanonical 防止用户传 `..` / `.` 段绕过 $HOME 校验。
  // 原实现 `resolved !== input` 在 Windows 上把分隔符差异 (`/` vs `\`) 也判成
  // 非 canonical → worktree 创建报 "invalid path"。但 normalize(both) 又会消除
  // `..` 段使两边相等漏放攻击。正确做法:显式检查 input 是否含 `..` / `.` 段。
  if (requireCanonical) {
    const segs = input.split(/[\\/]+/);
    if (segs.some((s) => s === '.' || s === '..')) {
      throw new Error(`invalid ${label}`);
    }
  }
  if (!isPathInside(resolved, homedir())) {
    throw new Error(`${label} outside $HOME`);
  }
  return resolved;
}
