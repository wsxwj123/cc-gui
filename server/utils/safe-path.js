import { homedir } from 'os';
import { isAbsolute, relative, resolve, join, dirname, basename } from 'path';
import { readdirSync, realpathSync } from 'fs';

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

/**
 * resolveUnderHome + "已知 claude 工作区"例外:$HOME 外但属于用户显式用过 claude 的
 * 项目目录(或其子路径)时放行——Windows 项目常在 D:\ 等其他盘、mac 会话可能改过
 * /tmp 下文件,纯 $HOME 门禁会让审查回滚/恢复整片报 "path outside $HOME"(用户实报)。
 * requireCanonical 语义保留:含 ./.. 段无论在哪都拒。realpath 前后两种形态都试
 * (mac /tmp → /private/tmp symlink、Windows junction 会让 hash 对不上)。
 */
export function resolveWorkspacePath(input, opts = {}) {
  try {
    return resolveUnderHome(input, opts);
  } catch (e) {
    if (typeof input !== 'string' || !isAbsolute(input)) throw e;
    if (opts.requireCanonical) {
      const segs = input.split(/[\\/]+/);
      if (segs.some((s) => s === '.' || s === '..')) throw e;
    }
    const resolved = resolve(input);
    // realpath best-effort:目标可能不存在(恢复"已被删除的文件"),往上找最近
    // 存在的祖先做 realpath 再把剩余段拼回(mac /tmp→/private/tmp 靠这步解开)。
    let real = resolved;
    {
      let cur = resolved; const tail = [];
      for (;;) {
        try { real = tail.length ? join(realpathSync(cur), ...tail) : realpathSync(cur); break; }
        catch {}
        const parent = dirname(cur);
        if (parent === cur) break;
        tail.unshift(basename(cur));
        cur = parent;
      }
    }
    if (isKnownClaudeWorkspace(real, resolved)) {
      // symlink 逃逸防护:realpath 改写过路径(如 /tmp/evil-link → /etc)时,实际
      // 落点必须自身可信(在 $HOME 内或自己命中工作区),否则共享目录(/tmp)里
      // 预埋的 symlink 能把"工作区例外"引到任意外部路径。mac 正常场景不受影响:
      // /tmp/x → /private/tmp/x,real 自身命中 -private-tmp。
      if (real !== resolved && !isPathInside(real, homedir()) && !isKnownClaudeWorkspace(real)) {
        throw e;
      }
      return real;
    }
    throw e;
  }
}
