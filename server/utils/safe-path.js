import { homedir, tmpdir } from 'os';
import nodePath, { isAbsolute, relative, resolve, join, dirname, basename } from 'path';
import { readdirSync, realpathSync, realpath as fsRealpath } from 'fs';

/**
 * r26-B4:cwd 归一化比对(/context 409 归属判定用)。收敛不放宽:
 *   1. 去首尾空白、去尾部分隔符(/ \\ 都剥,保留根 '/')——'/tmp' 与 '/tmp/' 同一目录;
 *   2. realpathSync.native 解 symlink(mac /tmp→/private/tmp、/var→/private/var);
 *      ENOENT/权限不足等失败回落原串(不抛),此时大小写/尾斜杠归一仍生效;
 *   3. win32:分隔符统一 '\\' + toLowerCase(Windows 路径大小写不敏感,红线要求归一)。
 * 不放宽论证:realpath 对已存在目录是单射——两个不同项目不可能归一到同一路径;
 * 唯一"变宽"情形是 symlink 别名指向同一真实目录,而那本来就是同一个项目。
 * realpath 是 µs 级 syscall,请求侧每次算即可,不需要缓存。
 * @param {string} p 待归一化路径
 * @param {string} [platform] 仅供测试注入;默认 process.platform。
 */
export function canonicalCwd(p, platform = process.platform) {
  let s = String(p ?? '').trim();
  if (!s) return '';
  const stripped = s.replace(/[/\\]+$/, '');
  s = stripped || (s.startsWith('\\') ? '\\' : '/'); // 全部分隔符 = 根,保留根
  try { s = realpathSync.native(s); } catch { /* 不存在/无权限 → 回落归一化后的原串 */ }
  if (platform === 'win32') s = s.replace(/\//g, '\\').toLowerCase();
  return s;
}

export function isPathInside(child, parent) {
  return isPathInsideWith(nodePath, child, parent);
}

// 同 isPathInside,路径模块可注入(单测在 macOS 上用 path.win32 模拟 Windows;
// win32 的 path.relative 比较本来就不区分大小写,另一个盘上的路径得到绝对路径 → 判为不在)。
export function isPathInsideWith(pathModule, child, parent) {
  const base = pathModule.resolve(parent);
  const target = pathModule.resolve(child);
  const rel = pathModule.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !pathModule.isAbsolute(rel));
}

// r193:上传附件目录(与 upload.js / screenshot.js 同一个)。
export const UPLOAD_DIR = join(tmpdir(), 'cgui-attachments');

// 真实路径:用 fs.realpath.native(Windows 上会展开 8.3 短名;fs.realpath 的 JS 实现不展开)。
// 上传目录与被判定的路径必须用同一个函数取,两边形态才一致。
export function realpathNative(p) {
  return new Promise((resolvePromise, reject) => {
    fsRealpath.native(p, (err, real) => (err ? reject(err) : resolvePromise(real)));
  });
}

/**
 * r193:真实路径 realTarget 是否在上传目录内。上传目录的两种写法都认,按顺序比:
 *   1. 先和上传目录的原写法比,中了就算在内。调用方取目标真实路径的函数不一定和这里相同:
 *      files.js 的 safePath 用 fs/promises 的 realpath(JS 实现,Windows 上不展开 8.3 短名),
 *      临时目录是短名时目标仍是短名,只能和原写法对上(R08 修过的「刷新后图片不可用」)。
 *   2. 不中再和上传目录的真实路径(realpathFn 取)比:macOS 的 /var 是 /private/var 的符号链接,
 *      Windows 上 realpath.native 会把短名展开成长名。上传目录取不到真实路径(还不存在等)时只认第 1 步。
 * 比较走 path.relative 而不是字符串前缀(win32 不区分大小写)。
 */
export async function isInsideUploadDir(realTarget, {
  uploadDir = UPLOAD_DIR,
  pathModule = nodePath,
  realpathFn = realpathNative,
} = {}) {
  if (typeof realTarget !== 'string' || !realTarget) return false;
  if (isPathInsideWith(pathModule, realTarget, uploadDir)) return true;
  const uploadReal = await Promise.resolve().then(() => realpathFn(uploadDir)).catch(() => null);
  return !!uploadReal && isPathInsideWith(pathModule, realTarget, uploadReal);
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
