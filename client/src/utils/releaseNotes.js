// 应用内「更新说明」弹窗的运行时读取层。
//
// 数据完全离线:CHANGELOG.md → 构建期 scripts/gen-release-notes.mjs 切片 →
// client/src/generated/release-notes/*.json 打进 bundle → 这里本地读。整条路径不碰网络,
// 所以墙内访问 GitHub 的问题在更新说明上根本不存在(GitHub Release 只喂 Tauri updater)。
import RELEASE_INDEX from '../generated/release-notes/index.json';

// 「已读到哪一版」的落点。存服务端 ~/.claude-gui/prefs.json,不用 localStorage:
// localStorage 绑 WebView 数据目录,端口漂移/换目录会整份丢失 → 同一版本反复弹。
export const RELEASE_NOTES_SEEN_URL = '/api/prefs/release-notes-seen';

export const releaseNotesIndex = Array.isArray(RELEASE_INDEX) ? RELEASE_INDEX : [];

const VERSION_RE = /^\d+\.\d+\.\d+/;

// 该不该弹。唯一规则:当前版本与「已读版本」不同就弹,同一版本只弹一次。
// 真值表(见 tests/unit/check-release-notes.mjs):
//   首次安装(lastSeen null/undefined) → 弹;同版本 → 不弹;升级 → 弹;
//   降级/回滚 → 弹(弹的永远是当前实际在跑那一版的说明);lastSeen 非法值 → 当没看过,弹;
//   currentVersion 非法(vite 兜底的 'unknown' 等) → 不弹(没有可信的版本身份)。
export function shouldShow(currentVersion, lastSeen) {
  if (typeof currentVersion !== 'string' || !VERSION_RE.test(currentVersion)) return false;
  if (typeof lastSeen !== 'string' || !VERSION_RE.test(lastSeen)) return true;
  return lastSeen !== currentVersion;
}

export function hasReleaseNotes(version) {
  return releaseNotesIndex.some((v) => v && v.version === version);
}

// 按需加载单版正文。Vite 会给 generated/release-notes/*.json 各切一个 chunk,
// 冷启只下载 index(已在主 chunk)+ 当前版本这一个。
export function loadVersionNotes(version) {
  if (!hasReleaseNotes(version)) return Promise.reject(new Error(`no release notes for ${version}`));
  return import(`../generated/release-notes/${version}.json`).then((m) => m.default || m);
}

export async function fetchLastSeen() {
  const r = await fetch(RELEASE_NOTES_SEEN_URL);
  const d = await r.json();
  return typeof d.lastSeen === 'string' ? d.lastSeen : null;
}

export async function markSeen(version) {
  await fetch(RELEASE_NOTES_SEEN_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  });
}
