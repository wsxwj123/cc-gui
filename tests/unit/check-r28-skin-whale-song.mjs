#!/usr/bin/env node
// r28【单测】:内置皮肤 whale-song(鲸歌)四件套验收 ——
//   ① skin.json/skin.css/a11y.css/client.js 四件套存在且非空;
//   ② manifest 过 validateManifest(files 含四件套),tier=2 且三件套字段被收录,
//     无 var_rejected warning(token 全在白名单+文法内);
//   ③ client.js 过 validateT2Script 黑名单;
//   ④ client.js 注册 window.__cguiSkinDispose(卸载契约);
//   ⑤ skin.css 挂 cgui 语义锚点且全部在 SKIN_ANCHOR_IDS 清单内(不越清单),
//     作用域标记 data-cgui-whale-song 存在(惰性卸载前提)。
// Run: node tests/unit/check-r28-skin-whale-song.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, 'client', 'src', 'builtin-skins', 'whale-song');

const { validateManifest, validateT2Script } = await import(join(root, 'server', 'utils', 'skin-validate.js'));
const { SKIN_ANCHOR_IDS } = await import(join(root, 'client', 'src', 'utils', 'skinAnchors.js'));

// ① 四件套存在且非空
const texts = {};
for (const f of ['skin.json', 'skin.css', 'a11y.css', 'client.js']) {
  const t = readFileSync(join(dir, f), 'utf8');
  assert.ok(t.trim().length > 0, `${f} 为空`);
  texts[f] = t;
}

// ② manifest 校验
const manifest = JSON.parse(texts['skin.json']);
const mv = validateManifest(manifest, new Set(Object.keys(texts)));
assert.ok(mv.ok, `manifest 被拒: ${JSON.stringify(mv)}`);
assert.equal(mv.manifest.tier, 2, 'tier 必须是 2');
for (const k of ['skin_css', 'a11y_css', 'client_js']) {
  assert.ok(mv.manifest[k], `manifest 未收录 ${k}`);
}
const varRejected = mv.warnings.filter((w) => w.code === 'var_rejected');
assert.deepEqual(varRejected, [], `有 token 被拒: ${JSON.stringify(varRejected)}`);

// ③ T2 黑名单
const t2 = validateT2Script(texts['client.js']);
assert.ok(t2.ok, `client.js 命中黑名单: ${JSON.stringify(t2.hits)}`);

// ④ 卸载契约
assert.ok(texts['client.js'].includes('window.__cguiSkinDispose'), 'client.js 未注册 __cguiSkinDispose');

// ⑤ 锚点不越清单 + 作用域标记
const anchorIds = [...texts['skin.css'].matchAll(/\[data-cgui="([^"]+)"\]/g)].map((m) => m[1]);
assert.ok(anchorIds.length > 0, 'skin.css 未使用任何 data-cgui 锚点');
for (const id of anchorIds) {
  assert.ok(SKIN_ANCHOR_IDS.includes(id), `锚点 ${id} 不在 SKIN_ANCHORS 清单内`);
}
assert.ok(texts['skin.css'].includes('data-cgui-whale-song'), 'skin.css 缺作用域标记');
assert.ok(texts['client.js'].includes('data-cgui-whale-song'), 'client.js 未挂作用域标记');

console.log('✅ check-r28-skin-whale-song 全过(四件套/manifest/T2 黑名单/dispose/锚点清单)');
