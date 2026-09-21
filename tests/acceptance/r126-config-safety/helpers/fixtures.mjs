// r126 · 夹具:隔离 HOME 的搭法 + 各处共用的路径/环境读取(照 r125 套件的写法)。
// 依据只有 .devflow/BRIEF-r126.md 与 .devflow/INTERFACE-r126.md;没看实现代码。
//   node helpers/fixtures.mjs   # run.sh 先跑这一步,建共享实例(界面用例)的 HOME;数据根由 R126_DATA_ROOT 给
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R126_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
export const sharedHome = () => path.join(dataRoot(), 'home');
/** 断外网预载的 file:// URL(路径里有空格,用 URL 形式塞进 NODE_OPTIONS 最稳)。 */
export const noOutboundUrl = () => pathToFileURL(suitePath('helpers', 'no-outbound.mjs')).href;

/** 共享隔离实例 / dev server / 共享 HOME(run.sh 注入,界面用例用)。 */
export const API_BASE = () => process.env.R126_API_BASE || '';
export const UI_BASE = () => process.env.R126_UI_BASE || '';
export const HOME_DIR = () => process.env.R126_HOME || '';

/** GUI 配置目录与四个涉事文件(INTERFACE §A)。 */
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

/**
 * 安全阀:所有会写文件的 helper 先过这一关 —— HOME 必须落在本套件 .artifacts 之下,
 * 绝不允许指向用户真实家目录(INTERFACE §D:绝不读写真实 ~/.claude-gui/**、~/.claude/**)。
 */
export function assertIsolated(home) {
  const real = path.resolve(String(home || ''));
  const allowed = path.resolve(suitePath('.artifacts'));
  const userHome = path.resolve(os.homedir());
  if (!real.startsWith(allowed + path.sep)) throw new Error(`拒绝操作:HOME「${real}」不在本套件 .artifacts(${allowed})之下`);
  if (real === userHome || real.startsWith(path.join(userHome, '.claude'))) throw new Error(`拒绝操作:HOME「${real}」指向了真实家目录`);
  return real;
}

/**
 * 搭一个干净的隔离 HOME:回环免密 + 压掉一次性浮层。
 * 公开版会自愈成 0.0.0.0+随机密码并去占 6677,所以 network.json 必须钉成 127.0.0.1。
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
  return home;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = buildHome(sharedHome());
  console.log(`[r126] 共享实例的隔离 HOME 就绪:${home}`);
}
