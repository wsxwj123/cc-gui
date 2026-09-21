// r124 · 夹具:隔离 HOME 的搭法 + 各处共用的路径/环境读取。
// 依据只有 .devflow/BRIEF-r124.md 与 .devflow/INTERFACE-r124.md;没看实现代码。
//   node helpers/fixtures.mjs   # run.sh 先跑这一步,建共享实例(界面用例)的 HOME;数据根由 R124_DATA_ROOT 给
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');
export const suitePath = (...p) => path.join(suiteDir, ...p);
export const dataRoot = () => process.env.R124_DATA_ROOT || suitePath('.artifacts', 'runtime-data');
export const sharedHome = () => path.join(dataRoot(), 'home');
/** 断外网预载的 file:// URL(路径里有空格,用 URL 形式塞进 NODE_OPTIONS 最稳)。 */
export const noOutboundUrl = () => pathToFileURL(suitePath('helpers', 'no-outbound.mjs')).href;

/** 假 GitHub 的两个基址(run.sh 注入)。 */
export const fakeApiBase = () => process.env.R124_FAKE_API_BASE || '';
export const fakeRawBase = () => process.env.R124_FAKE_RAW_BASE || '';
/** 共享隔离实例 / dev server(run.sh 注入,界面用例用)。 */
export const API_BASE = () => process.env.R124_API_BASE || '';
export const UI_BASE = () => process.env.R124_UI_BASE || '';

/** 隔离 HOME 下技能目录(INTERFACE C2:~/.claude/skills/<id>/)。 */
export const skillsDir = (home) => path.join(home, '.claude', 'skills');
export const skillDir = (home, id) => path.join(skillsDir(home), id);

/**
 * 搭一个干净的隔离 HOME:回环免密 + 压掉一次性浮层 + 空的技能目录。
 * 公开版会自愈成 0.0.0.0+随机密码并去占 6677,所以 network.json 必须钉成 127.0.0.1。
 */
export function buildHome(home) {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, '.claude-gui'), { recursive: true });
  fs.mkdirSync(skillsDir(home), { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), '2026-09-21T00:00:00.000Z');
  return home;
}

/** 递归列出目录下全部文件的相对路径(posix 分隔),排好序;目录不存在返回 null。 */
export function listFiles(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = [];
  const walk = (d, rel) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(d, ent.name), r); else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = buildHome(sharedHome());
  console.log(`[r124] 共享实例的隔离 HOME 就绪:${home}`);
}
