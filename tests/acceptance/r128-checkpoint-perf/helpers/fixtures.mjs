// r128 · 夹具:隔离 HOME 的搭法 + 各处共用的路径/环境读取(照 r126 / r122 套件的写法)。
// 依据只有 .devflow/BRIEF-r128.md 与 .devflow/INTERFACE-r128.md;没看实现代码。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R128_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
/** 断外网预载的 file:// URL(路径里有空格,用 URL 形式塞进 NODE_OPTIONS 最稳)。 */
export const noOutboundUrl = () => pathToFileURL(suitePath('helpers', 'no-outbound.mjs')).href;

/**
 * 安全阀:所有会写文件的 helper 先过这一关 —— 路径必须落在本套件 .artifacts 之下,
 * 绝不允许指向用户真实家目录(INTERFACE §D:绝不读写真实 ~/.claude/**、~/.claude-gui/**)。
 */
export function assertIsolated(p) {
  const real = path.resolve(String(p || ''));
  const allowed = path.resolve(suitePath('.artifacts'));
  const userHome = path.resolve(os.homedir());
  if (!real.startsWith(allowed + path.sep)) throw new Error(`拒绝操作:路径「${real}」不在本套件 .artifacts(${allowed})之下`);
  if (real === userHome || real.startsWith(path.join(userHome, '.claude'))) throw new Error(`拒绝操作:路径「${real}」指向了真实家目录`);
  return real;
}

/**
 * 搭一个干净的隔离 HOME:回环免密 + 压掉一次性浮层 + 一个几十字节的小工作目录。
 * 公开版会自愈成 0.0.0.0+随机密码并去占 6677,所以 network.json 必须钉成 127.0.0.1。
 * 回滚点只认 $HOME 之下的 cwd(r120 探路实测),所以工作目录建在 HOME 里面。
 */
export function buildHome(home) {
  assertIsolated(home);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, '.claude-gui'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), '2026-09-21T00:00:00.000Z');
  const ws = path.join(home, 'work', 'ws');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'note.txt'), 'r128 fixture\n');
  return home;
}

/** 每条用例自己的数据根:<R128_DATA_ROOT>/<group>/<slug>/{home,*.log,*.pid} */
export function caseRoot(group, slug) {
  const root = path.join(dataRoot(), group, slug);
  assertIsolated(root);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const home = buildHome(path.join(root, 'home'));
  return { root, home, ws: path.join(home, 'work', 'ws') };
}

/** 工作目录里的小文件改一笔(几十字节),让下一张快照有内容差异。 */
export function touchNote(ws, text) {
  assertIsolated(ws);
  fs.writeFileSync(path.join(ws, 'note.txt'), `${text}\n`);
}
/** 写一个 n 字节的随机文件(A6 体积维专用,默认 1.5 KB,不可压缩 → 影子仓体积可预期)。 */
export function writeRandomBlob(ws, n = 1536) {
  assertIsolated(ws);
  fs.writeFileSync(path.join(ws, 'blob.bin'), crypto.randomBytes(n));
}

/** 影子仓路径(INTERFACE:隔离 HOME 下 ~/.claude/gui/checkpoints/<sessionId>/)。 */
export const checkpointDir = (home, sid) => path.join(home, '.claude', 'gui', 'checkpoints', sid);
export const metaPath = (home, sid) => path.join(checkpointDir(home, sid), 'meta.json');
export const packDir = (home, sid) => path.join(checkpointDir(home, sid), 'objects', 'pack');

/** 会话 id 必须是十六进制 UUID 形。 */
export const sid = (group, n) => `${group}${String(n).padStart(4, '0')}-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;

/** GUI 配置目录与四个受守卫的文件(INTERFACE §C)。 */
export const guiDir = (home) => path.join(home, '.claude-gui');
export const FILES = {
  custom: 'custom-providers.json',
  models: 'provider-models.json',
  active: 'active-provider.json',
  image: 'image-providers.json',
};
export const cfgPath = (home, key) => {
  if (!FILES[key]) throw new Error(`未知配置文件键 ${key}`);
  return path.join(guiDir(home), FILES[key]);
};

/** 把 meta.json 的修改时间改到 ageMs 之前(F 组既有写法:"活动"以它为准)。 */
export function ageMeta(home, s, ageMs) {
  assertIsolated(home);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(metaPath(home, s), t, t);
}
