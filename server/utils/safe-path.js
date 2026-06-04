import { homedir } from 'os';
import { isAbsolute, relative, resolve } from 'path';

export function isPathInside(child, parent) {
  const base = resolve(parent);
  const target = resolve(child);
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
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
