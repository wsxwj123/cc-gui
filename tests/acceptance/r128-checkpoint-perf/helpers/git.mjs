// r128 · 对**隔离 HOME 里的**影子仓直接跑 git 只读命令(INTERFACE §D 明确允许:fsck / cat-file -e / rev-list)。
// 每个函数先过 assertIsolated,绝不碰 .artifacts 之外的仓。只读:不 add / commit / gc / repack。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assertIsolated, checkpointDir, packDir } from './fixtures.mjs';

function git(dir, args) {
  assertIsolated(dir);
  const r = spawnSync('git', ['--git-dir', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANG: 'C' } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** objects/pack/ 里 .pack 文件名集合(目录不存在 = 空集)。 */
export function packNames(home, s) {
  const dir = packDir(home, s);
  assertIsolated(dir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.pack')).sort();
}

/** 对象是否仍存在(git cat-file -e <sha>^{commit}):true = 还在;false = 已回收。 */
export function objectExists(home, s, sha) {
  const r = git(checkpointDir(home, s), ['cat-file', '-e', `${sha}^{commit}`]);
  return r.status === 0;
}

/** git fsck --strict --no-dangling 的完整输出与"是否干净"(无 error/missing/broken 字样且退出码 0)。 */
export function fsck(home, s) {
  const r = git(checkpointDir(home, s), ['fsck', '--strict', '--no-dangling']);
  const out = `${r.stdout}\n${r.stderr}`.trim();
  const dirty = /\b(error|missing|broken)\b/i.test(out) || r.status !== 0;
  return { clean: !dirty, status: r.status, out };
}

/** 影子仓的 log(新→旧)—— 磁盘真相,不依赖列表接口。 */
export function logShas(home, s) {
  const r = git(checkpointDir(home, s), ['log', '--format=%H']);
  return r.status === 0 ? r.stdout.split('\n').map((x) => x.trim()).filter(Boolean) : [];
}

/** 松散对象数量(objects/xx/ 下的文件数)。 */
export function looseCount(home, s) {
  const root = path.join(checkpointDir(home, s), 'objects');
  assertIsolated(root);
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  for (const d of fs.readdirSync(root)) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    n += fs.readdirSync(path.join(root, d)).length;
  }
  return n;
}
