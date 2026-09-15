// 数据正确性对拍(M2 的第 1 条交付物里最关键的一条):**同一份数据,新实现与"全量扫描"必须
// 给出同一份结果**。性能数字再好看,列表显示错行数/错标题就是白改。
//
// 做法(照独立验收代理的口径):从 `git show 177fc632^:server/services/session-reader.js` 取
// 改动前那份实现(177fc632 = 会话画像 T1 的提交,它的父提交就是"逐文件全文读"的最后状态),
// 写到临时目录里(仓库里不留痕),与当前实现各自跑一遍 listProjects / listSessions,响应体
// **逐字节**比较。
//
// 为什么临时目录里要铺一层软链:旧实现里 `import '../utils/x.js'` 这类相对路径必须能解析。
// 软链指向真实文件,node 按 realpath 解析 —— 旧实现拿到的是旧 session-reader + 现行工具模块
// (jsonl-parser 自 177fc632 起只增函数、没动老函数,见 git diff --stat 的纯增行)。
//
// 本脚本自己起不了服务,由 slowload.spec.mjs 以 HOME=夹具 home 起子进程跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { projectsRoot } from './fixtures.mjs';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worktree = path.resolve(process.env.WORKTREE || path.join(suiteDir, '..', '..', '..'));
const BASE_COMMIT = '177fc632^';

function extractOldImplementation() {
  const src = execFileSync('git', ['show', `${BASE_COMMIT}:server/services/session-reader.js`], { cwd: worktree, encoding: 'utf8' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgui-old-reader-'));
  fs.mkdirSync(path.join(tmp, 'services'));
  fs.symlinkSync(path.join(worktree, 'server', 'utils'), path.join(tmp, 'utils'), 'dir');
  for (const name of fs.readdirSync(path.join(worktree, 'server', 'services'))) {
    if (name === 'session-reader.js') continue;
    fs.symlinkSync(path.join(worktree, 'server', 'services', name), path.join(tmp, 'services', name));
  }
  fs.writeFileSync(path.join(tmp, 'services', 'session-reader.js'), src);
  return { dir: tmp, entry: path.join(tmp, 'services', 'session-reader.js'), bytes: src.length };
}

/** 逐字节比较:一样返回 null,不一样返回第一处差异附近的上下文。 */
function firstDiff(a, b) {
  if (a === b) return null;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  const from = Math.max(0, i - 60);
  return { at: i, old: a.slice(from, i + 90), new: b.slice(from, i + 90), oldLen: a.length, newLen: b.length };
}

export async function runCrosscheck() {
  const old = extractOldImplementation();
  const result = {
    baseCommit: BASE_COMMIT,
    extractedBytes: old.bytes,
    comparisons: [],
    diffs: [],
  };
  try {
    const newReader = await import(pathToFileURL(path.join(worktree, 'server', 'services', 'session-reader.js')).href);
    const oldReader = await import(pathToFileURL(old.entry).href);

    const hashes = fs.readdirSync(projectsRoot()).filter((n) => fs.statSync(path.join(projectsRoot(), n)).isDirectory());
    // 旧实现先跑(它是只读的),免得新实现落下的索引影响它。
    const oldProjects = JSON.stringify(await oldReader.listProjects());
    const oldSessions = {};
    for (const h of hashes) oldSessions[h] = JSON.stringify(await oldReader.listSessions(h));

    const newProjects = JSON.stringify(await newReader.listProjects());
    const newSessions = {};
    for (const h of hashes) newSessions[h] = JSON.stringify(await newReader.listSessions(h));

    // 跑完新实现再回头跑一次旧实现:证明新的那些索引文件没有改动源数据。
    const oldProjectsAgain = JSON.stringify(await oldReader.listProjects());

    result.comparisons.push({ what: 'GET /api/projects', projects: hashes.length });
    const dProjects = firstDiff(oldProjects, newProjects);
    if (dProjects) result.diffs.push({ what: '/api/projects', ...dProjects });
    for (const h of hashes) {
      result.comparisons.push({ what: `listSessions(${h})`, bytes: oldSessions[h].length });
      const d = firstDiff(oldSessions[h], newSessions[h]);
      if (d) result.diffs.push({ what: h, ...d });
    }
    const dAgain = firstDiff(oldProjects, oldProjectsAgain);
    if (dAgain) result.diffs.push({ what: '旧实现二次运行(索引未污染源数据)', ...dAgain });

    result.projectsCount = JSON.parse(newProjects).length;
    result.ok = result.diffs.length === 0;
  } finally {
    fs.rmSync(old.dir, { recursive: true, force: true }); // 本脚本自己建的临时目录
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = await runCrosscheck();
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  process.exit(r.ok ? 0 : 1);
}
