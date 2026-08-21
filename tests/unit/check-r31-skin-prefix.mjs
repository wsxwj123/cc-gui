#!/usr/bin/env node
// r31:D6【前缀误删】 —— findExistingSkinId 不能因 `startsWith(slug + '-')` 命中不同皮肤的
// 前缀同族。根因:导入「whale」时旧实现 `d === slug || d.startsWith(slug + '-')` 把已装的
// 「whale-song-abc123」(slug=whale-song 的独立皮肤)也当同 slug → 复用其 id → 整目录 rm 覆盖,
// 用户装进「whale-song」皮肤的清单被「whale」皮肤误删。皮肤 id 形态 = `<slug>-<6位小写字母数字>`
// (见 skin-validate.js skinIdFrom),后缀段才是随机后缀,slug 段可以含连字符。
// 修法:匹配收窄为「精确 slug」或「slug + '-' + 恰 6 位 [a-z0-9]」;`whale` 不再命中
// `whale-song-*`(后缀段多出连字符),`whale-song` 也不会误命中 `whale-song-2`(非随机后缀形态)。
//
// 断言(修前红):
//   A 只装「whale-song-abc123」时导入「whale」必须返回 null(不误删同族)—— 旧实现红;
//   B 只装「whale-zzz999」时导入「whale」返回该 id(同 slug 精确命中,阳性对照);
//   C 「whale-song」导入命中自身「whale-song-abc123」(同 slug 自身);
//   D 只装「whale-song-2」时导入「whale-song」必须返回 null(不命中合法同族之外);
//   E 同时装「whale-song-abc123」与「whale-zzz999」时导入「whale」返回后者(不同库互不串)。
// 全部在 /tmp 自建 scratch 目录,零触碰真实 ~/.claude-gui/skins。
// Run: node tests/unit/check-r31-skin-prefix.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { findExistingSkinId } = await import('../../server/routes/skins-packs.js');

const DIR = mkdtempSync(join(tmpdir(), 'r31-skin-'));
const mk = (dir, ...names) => { for (const n of names) mkdirSync(join(dir, n), { recursive: true }); };

let failure = null;
try {
  const d1 = join(DIR, 'a');
  mk(d1, 'whale-song-abc123');
  // A 修前红:导入「whale」不得命中不同皮肤的「whale-song-abc123」
  assert.equal(await findExistingSkinId('whale', d1), null,
    '修前红:导入「whale」不得误命中已装的「whale-song-abc123」(前缀同族会被整目录 rm 覆盖)');

  const d2 = join(DIR, 'b');
  mk(d2, 'whale-zzz999');
  // B 阳性对照:同 slug 自身必须命中
  assert.equal(await findExistingSkinId('whale', d2), 'whale-zzz999', 'B: 同 slug(whale)必须命中自身');

  const d3 = join(DIR, 'c');
  mk(d3, 'whale-song-abc123');
  // C「whale-song」导入命中自身
  assert.equal(await findExistingSkinId('whale-song', d3), 'whale-song-abc123', 'C: whale-song 命中自身');

  const d4 = join(DIR, 'd');
  mk(d4, 'whale-song-2');
  // D 不命中合法同族之外(非随机后缀形态)
  assert.equal(await findExistingSkinId('whale-song', d4), null,
    'D: 导入「whale-song」不得命中「whale-song-2」(非随机后缀形态,不是同皮肤)');

  const d5 = join(DIR, 'e');
  mk(d5, 'whale-song-abc123', 'whale-zzz999');
  // E 组合:导入「whale」返回真正的同 slug 目录,不碰「whale-song-*」(不同 slug 前缀同族)
  assert.equal(await findExistingSkinId('whale', d5), 'whale-zzz999',
    'E: 同时存在 whale-song-* 时导入「whale」仍命中 whale-zzz999(不串)');
} catch (e) {
  failure = e;
} finally {
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
}
if (failure) throw failure;
console.log('PASS check-r31-skin-prefix');
