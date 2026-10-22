// r151s 临时 HOME 与 claude 垫片(不依赖 @playwright/test,run.sh 可直接用 node 跑本文件建共享实例的 HOME)。
// 不碰用户真实的 ~/.claude、~/.claude.json、~/.claude-gui:所有路径都落在 R151B_DATA_ROOT(run.sh 指到本次运行的 .artifacts 目录)下。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKTREE, fakebinDir, guiDir, claudeDir, prefsPath, homeDir, ctlDir } from '../../r151b-xsession-p1/helpers/fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const pkgVersion = () => JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;

/**
 * 建一个 GUI 能直接起的临时 HOME。prefs:
 *   undefined → 偏好文件只有 releaseNotesSeen(和别的套件的默认一致,免得界面弹更新说明);
 *   null      → 不建偏好文件(S01"新环境");
 *   对象      → releaseNotesSeen + 这个对象的键;
 *   字符串 / Buffer → 原样当偏好文件的字节写入(S05 的 BOM、S06 的坏 JSON)。
 */
export function buildHomeS(home, ctl, prefs) {
  for (const d of [guiDir(home), claudeDir(home), path.join(claudeDir(home), 'projects'), ctl, path.join(ctl, 'scripts')]) fs.mkdirSync(d, { recursive: true });
  if (prefs === null) { /* 不建偏好文件 */ }
  else if (typeof prefs === 'string' || Buffer.isBuffer(prefs)) fs.writeFileSync(prefsPath(home), prefs);
  else fs.writeFileSync(prefsPath(home), JSON.stringify({ releaseNotesSeen: pkgVersion(), ...(prefs || {}) }, null, 2));
  fs.writeFileSync(path.join(guiDir(home), 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(guiDir(home), 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.writeFileSync(path.join(claudeDir(home), 'settings.json'), JSON.stringify({ env: {} }, null, 2));
}

/** claude 垫片:本套件全部走假 claude(不接真 CLI、不接任何模型接口,不会有模型请求)。 */
export function writeShimS() {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const sh = `#!/bin/sh\n# r151s claude 垫片:一律交给本套件的假 claude 外壳(没有真 CLI 车道)。\nunset NODE_OPTIONS\nexec ${q(process.execPath)} ${q(path.join(here, 'fx-claude.mjs'))} "$@"\n`;
  fs.mkdirSync(fakebinDir(), { recursive: true });
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, sh);
  fs.chmodSync(shim, 0o755);
  return shim;
}

// run.sh 调用:建共享实例(界面用例用)的 HOME + 垫片
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildHomeS(homeDir(), ctlDir(), undefined);
  console.log(`[r151s] 夹具就绪:HOME=${homeDir()};垫片=${writeShimS()}`);
}
