import { Router } from 'express';
import { readdir, stat, lstat, readFile, realpath, writeFile, rm, unlink } from 'fs/promises';
import { createReadStream } from 'fs';
import { join, resolve, relative, extname, isAbsolute } from 'path';
import { homedir, platform } from 'os';
import { execFile } from 'child_process';
import { isPathInside, isKnownClaudeWorkspace } from '../utils/safe-path.js';

const router = Router();

const HOME = homedir();
// 安全:这些文件存鉴权/provider 凭据或"启动即执行"的配置,各有专用安全端点,绝不允许
// 经通用文件写/删端点覆盖或删除 —— 否则已认证客户端(或 AI)可改写鉴权配置/把 provider
// 指向自己的中转截获 token/植入恶意 MCP,把"可写 $HOME"升级为持久化控制(安全审计)。
const PROTECTED_WRITE_RELPATHS = new Set([
  join('.claude-gui', 'network.json'),        // 鉴权(passwordHash/tokenSecret)
  join('.claude-gui', 'custom-providers.json'), // 明文 provider apiKey
  join('.claude', 'settings.json'),           // provider env/token
  join('.claude', 'settings.local.json'),
  join('.claude', '.credentials.json'),       // 官方 OAuth token
  '.claude.json',                             // mcpServers(启动即连,可植恶意 MCP)
]);
const MAX_PREVIEW_BYTES = 256 * 1024; // 256KB cap for the read endpoint

// Extension → MIME for the raw byte endpoint (image/video/audio/pdf preview).
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
  ogg: 'video/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  pdf: 'application/pdf',
};

// Skip patterns — directories/files that explode the tree or just add noise.
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv', '.idea', '.vscode']);
const SKIP_EXACT = new Set(['.DS_Store']);

/**
 * Resolve+validate a user-provided path. Must be ABSOLUTE and resolve
 * (after realpath) under HOME — anything else is rejected. Returns the
 * realpath on success, throws on rejection.
 */
export async function safePath(p) {
  // isAbsolute is platform-aware (accepts /unix and C:\windows).
  if (typeof p !== 'string' || !isAbsolute(p)) {
    const err = new Error('absolute path required'); err.status = 400; throw err;
  }
  const real = await realpath(resolve(p)).catch(() => null);
  if (!real) { const err = new Error('not found'); err.status = 404; throw err; }
  // Must be HOME itself or a path UNDER it. isPathInside uses path.relative so it
  // handles the separator per-OS and isn't fooled by '/Users/alice2'.startsWith(
  // '/Users/alice').
  // 例外:claude 用过的工作区(~/.claude/projects 有 hash 目录)及其子路径放行 ——
  // Windows 项目常在 $HOME 之外(D:\ 等其他盘),纯 $HOME 门禁把合法项目整片 403
  // (用户实报)。realpath 前后两种形态都试,防 junction/OneDrive 改写路径致 hash 对不上。
  if (!isPathInside(real, HOME)) {
    const lexical = resolve(p);
    // 工作区例外(任一形态命中即候选放行)。
    if (!isKnownClaudeWorkspace(real, lexical)) {
      const err = new Error('路径不在家目录、也不在任何打开过的项目目录内'); err.status = 403; throw err;
    }
    // symlink 逃逸防护(与 resolveWorkspacePath line-96 一致,原 safePath 漏了):realpath 改写过
    // 路径(如工作区内 /proj/evil-link → /etc)时,只凭 lexical 命中工作区就放行会让 read/write/
    // delete 作用到越界目标(rm -rf /etc)。故 real 与 lexical 不同时,real 自身必须可信(命中工作区)。
    if (real !== lexical && !isKnownClaudeWorkspace(real)) {
      const err = new Error('路径经符号链接指向工作区外,已拒绝'); err.status = 403; throw err;
    }
  }
  return real;
}

/**
 * GET /api/files/search?cwd=<absolute-dir>&q=<query>
 * @ 引用选择器的文件搜索:返回 cwd 下匹配 q 的文件相对路径(最多 50 条)。
 * 有 git 时用 `git ls-files`(快且天然尊重 .gitignore);否则递归 readdir(限深/限量,
 * 应用 SKIP_DIRS)。全量清单按 cwd 缓存 15s,免得每敲一个字符扫一遍盘。
 */
const _fileSearchCache = new Map(); // cwd -> { at, list }
async function listProjectFiles(cwd) {
  const c = _fileSearchCache.get(cwd);
  if (c && Date.now() - c.at < 15_000) return c.list;
  let list = null;
  try {
    list = await new Promise((res, rej) => {
      execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (e, out) => {
        if (e) return rej(e);
        res(String(out).split('\n').map((s) => s.trim()).filter(Boolean));
      });
    });
  } catch { /* 非 git 项目走递归 */ }
  if (!list) {
    list = [];
    const walk = async (dir, rel, depth) => {
      if (depth > 6 || list.length >= 5000) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (list.length >= 5000) return;
        if (SKIP_EXACT.has(e.name) || (e.isDirectory() && (SKIP_DIRS.has(e.name) || e.name.startsWith('.')))) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), r, depth + 1);
        else list.push(r);
      }
    };
    await walk(cwd, '', 0);
  }
  _fileSearchCache.set(cwd, { at: Date.now(), list });
  return list;
}
router.get('/files/search', async (req, res) => {
  try {
    const cwd = await safePath(req.query.cwd);
    const q = String(req.query.q || '').toLowerCase();
    const all = await listProjectFiles(cwd);
    const hits = (q ? all.filter((p) => p.toLowerCase().includes(q)) : all).slice(0, 50);
    res.json({ files: hits });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * GET /api/files/list?path=<absolute-dir>
 * Returns immediate-children entries with stat info. Directories first,
 * then files alphabetically. Skip-list applied.
 */
router.get('/files/list', async (req, res) => {
  try {
    const real = await safePath(req.query.path);
    const st = await stat(real);
    if (!st.isDirectory()) return res.status(400).json({ error: 'not a directory' });

    const raw = await readdir(real, { withFileTypes: true });
    const entries = [];
    for (const e of raw) {
      if (SKIP_EXACT.has(e.name)) continue;
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const full = join(real, e.name);
      let s;
      try { s = await stat(full); } catch { continue; }
      entries.push({
        name: e.name,
        path: full,
        isDir: s.isDirectory(),
        size: s.size,
        mtimeMs: s.mtimeMs,
      });
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ path: real, entries });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * GET /api/files/read?path=<absolute-file>
 * Returns up to 256KB of the file as utf-8, plus stat metadata. Binary
 * detection (NUL byte in first 4KB) → returns { binary: true } without body.
 */
router.get('/files/read', async (req, res) => {
  try {
    const real = await safePath(req.query.path);
    // 凭据/鉴权配置不经通用读端点吐明文:write/delete 早有 PROTECTED_WRITE_RELPATHS 拦,read
    // 之前没有 → authed 客户端/文件树预览能读出 .credentials.json(OAuth token)、network.json
    // (passwordHash)、custom-providers.json(明文 apiKey)。这些各有专用端点,通用读一律 403。
    if (PROTECTED_WRITE_RELPATHS.has(relative(HOME, real))) {
      return res.status(403).json({ error: '该文件含敏感凭据,不提供预览' });
    }
    const st = await stat(real);
    if (st.isDirectory()) return res.status(400).json({ error: 'not a file' });

    // raw=1 → stream the actual bytes (images/video/audio/pdf preview), not JSON.
    if (req.query.raw === '1') {
      const e = extname(real).slice(1).toLowerCase();
      res.setHeader('Content-Type', MIME[e] || 'application/octet-stream');
      res.setHeader('Content-Length', st.size);
      res.setHeader('Cache-Control', 'no-cache');
      const stream = createReadStream(real);
      // Content-Length/200 are already flushed, so we can't switch to 500 mid-
      // stream. Destroy the socket instead — the client sees a truncated body +
      // aborted connection rather than a silently-incomplete 200.
      stream.on('error', () => { res.headersSent ? res.destroy() : res.status(500).end(); });
      return stream.pipe(res);
    }

    if (st.size === 0) {
      return res.json({ path: real, size: 0, content: '', truncated: false, binary: false });
    }

    // Read first MAX_PREVIEW_BYTES; sniff for binary by NUL byte.
    const buf = Buffer.alloc(Math.min(st.size, MAX_PREVIEW_BYTES));
    const fd = await (await import('node:fs/promises')).open(real, 'r');
    let bytesRead = 0;
    try {
      const r = await fd.read(buf, 0, buf.length, 0);
      bytesRead = r.bytesRead;
    } finally {
      await fd.close();
    }
    const head = buf.subarray(0, Math.min(bytesRead, 4096));
    const isBinary = head.includes(0);
    if (isBinary) {
      return res.json({ path: real, size: st.size, binary: true, truncated: bytesRead < st.size });
    }
    const content = buf.subarray(0, bytesRead).toString('utf-8');
    res.json({
      path: real,
      size: st.size,
      content,
      truncated: bytesRead < st.size,
      binary: false,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * POST /api/files/open  { path }
 * Open a file/dir with the OS default application (Finder/Explorer's
 * double-click behaviour). On macOS/Linux the path is a plain argv element to
 * `open`/`xdg-open` (no shell). On Windows `cmd /c start` IS parsed by cmd.exe,
 * so a HOME-internal filename containing cmd metachars (& | < > ^ ") could
 * inject — reject those before launching.
 */
router.post('/files/open', async (req, res) => {
  try {
    const real = await safePath(req.body?.path);
    const os = platform();
    let cmd, args;
    // `--` 分隔符:文件名以 `-` 开头(如 -foo.txt)时 open/xdg-open 会把它当选项解析,加 -- 强制当路径。
    if (os === 'darwin') { cmd = 'open'; args = ['--', real]; }
    else if (os === 'win32') {
      if (/[&|<>^"]/.test(real)) { const e = new Error('unsafe path for Windows open'); e.status = 400; throw e; }
      cmd = 'cmd'; args = ['/c', 'start', '', real];
    }
    else { cmd = 'xdg-open'; args = ['--', real]; }
    execFile(cmd, args, (err) => {
      // execFile already returned to the event loop; the response was sent
      // optimistically below. Log failures only.
      if (err) console.error('[files/open]', err.message);
    });
    res.json({ ok: true, path: real });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * PUT /api/files/write  { path, content }
 * Overwrite an EXISTING text file under $HOME. safePath() requires the path to
 * already resolve (realpath), so this never creates new files or follows a
 * symlink outside $HOME. Size-capped to match the read endpoint's intent.
 */
const MAX_WRITE_BYTES = 5 * 1024 * 1024; // 5MB
router.put('/files/write', async (req, res) => {
  try {
    const { path: p, content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content (string) required' });
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_WRITE_BYTES) {
      return res.status(413).json({ error: 'file too large to save (>5MB)' });
    }
    const real = await safePath(p);
    if (PROTECTED_WRITE_RELPATHS.has(relative(HOME, real))) {
      return res.status(403).json({ error: '该文件受保护,请通过对应的设置界面修改(不可经通用文件写覆盖)' });
    }
    const st = await stat(real);
    if (st.isDirectory()) return res.status(400).json({ error: 'not a file' });
    await writeFile(real, content, 'utf-8');
    const after = await stat(real);
    res.json({ ok: true, path: real, size: after.size });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * POST /api/files/delete  { path }
 * Delete a file or directory (recursive). safePath() enforces $HOME / known-
 * workspace containment and requires the path to exist. Protected config
 * files (auth/provider) are refused, same as the write endpoint. The 10s
 * undo window lives in the CLIENT (delayed submit) — by the time this
 * endpoint is hit the deletion is final.
 */
router.post('/files/delete', async (req, res) => {
  try {
    const real = await safePath(req.body?.path);
    // 最后一段是符号链接:只删链接本身(unlink),绝不 rm -rf 其指向的目标目录 —— 即便
    // 目标在工作区内,用户点"删除"意图是删这个链接,不是清空它指向的真实目录。safePath 已
    // 挡住"链接指向工作区外"(逃逸防护),这里再保证指向工作区内的链接也只删链接。
    const orig = resolve(req.body?.path || '');
    const lst = await lstat(orig).catch(() => null);
    if (lst?.isSymbolicLink()) {
      if (PROTECTED_WRITE_RELPATHS.has(relative(HOME, orig))) {
        return res.status(403).json({ error: '该文件受保护,不可删除' });
      }
      await unlink(orig);
      return res.json({ ok: true, path: orig });
    }
    if (PROTECTED_WRITE_RELPATHS.has(relative(HOME, real))) {
      return res.status(403).json({ error: '该文件受保护,不可删除' });
    }
    // 拒绝删除 HOME 本身/已知工作区根:误触根节点的兜底(树 UI 不给根出删除项,双保险)。
    // Windows 大小写不敏感文件系统 + CLI cwd 常以小写盘符记录(d:\proj)→ real(realpath
    // 已规范盘符/大小写)与 resolve(客户端原串)直接 === 可不匹配,第二道保险悄悄失效;
    // 故 win32 下不分大小写比较。
    const sameFsPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    // rootPath 缺失时 resolve('')=server cwd,拿它比较等于没比(P3):只在客户端确实传了 rootPath 时比。
    const rootReal = req.body?.rootPath ? resolve(req.body.rootPath) : null;
    if (sameFsPath(real, HOME) || (rootReal && sameFsPath(real, rootReal))) {
      return res.status(400).json({ error: '不允许删除根目录' });
    }
    // maxRetries:Windows 上文件被占用(刚"用默认 App 打开"又删)EBUSY/EPERM 概率高,直接报错。
    await rm(real, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
    res.json({ ok: true, path: real });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
