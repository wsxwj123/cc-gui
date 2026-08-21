#!/usr/bin/env node
// 单测:r28 内置皮肤 miku（初音未来 · 电子歌姬）四件套契约 ——
//   ①四件套存在性（skin.json / skin.css / a11y.css / client.js）;
//   ②manifest 全量校验（真文件集入参）:ok + tier:2 + T2 三件被记录引用
//     + 变量零拒载（var_rejected 空）+ 未知字段仅样板同款三件文件名键;
//   ③T2 黑名单:validateT2Script 全过;
//   ④client.js 卸载契约:window.__cguiSkinDispose 注册 + 幂等装载链（先卸旧）
//     + 卸载器引用计数形态哨兵（refs.count += 1 / -= 1 成对、REF_KEY 挂窗）;
//   ⑤skin.css/a11y.css 锚点合法性:[data-cgui="…"] 全部在 SKIN_ANCHOR_IDS 白名单,
//     作用域标记 body[data-cgui-miku] 在场,不挂 Tailwind 工具类选择器;
//   ⑥标志性元素在场哨兵（防「只映射配色」退化）:蓝紫洋红渐变三色值、
//     01 徽标、波形、音符层、--app-h 消费、home.greeting {name} 占位。
// Run: node tests/unit/check-r28-skin-miku.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '../../client/src/builtin-skins/miku');

// ── ① 四件套存在性 ──
const files = readdirSync(DIR);
for (const f of ['skin.json', 'skin.css', 'a11y.css', 'client.js']) {
  assert.ok(files.includes(f), `四件套缺 ${f}`);
}
const manifest = JSON.parse(readFileSync(join(DIR, 'skin.json'), 'utf8'));
const css = readFileSync(join(DIR, 'skin.css'), 'utf8');
const a11y = readFileSync(join(DIR, 'a11y.css'), 'utf8');
const js = readFileSync(join(DIR, 'client.js'), 'utf8');

const { validateManifest, validateT2Script } = await import('../../server/utils/skin-validate.js');
const { SKIN_ANCHOR_IDS } = await import('../../client/src/utils/skinAnchors.js');

// ── ② manifest 校验（真文件集:tier 2 三件必须被记录引用）──
const mv = validateManifest(manifest, new Set(files));
assert.ok(mv.ok, `manifest 拒载: ${JSON.stringify(mv)}`);
assert.equal(mv.manifest.tier, 2, 'tier 必须是 2');
assert.equal(mv.manifest.skin_css, 'skin.css', 'skin.css 未被记录');
assert.equal(mv.manifest.client_js, 'client.js', 'client.js 未被记录');
assert.equal(mv.manifest.a11y_css, 'a11y.css', 'a11y.css 未被记录');
const varRejects = mv.warnings.filter((w) => w.code === 'var_rejected');
assert.deepEqual(varRejects, [], `变量被拒载: ${JSON.stringify(varRejects)}`);
const unknownKeys = mv.warnings.filter((w) => w.code === 'unknown_field').map((w) => w.key).sort();
assert.deepEqual(unknownKeys, ['a11y_css', 'client_js', 'skin_css'],
  `未知字段告警仅允许样板同款三件文件名键,实得: ${JSON.stringify(unknownKeys)}`);
assert.ok(mv.manifest.home?.greeting?.includes('{name}'), 'home.greeting 缺 {name} 占位');

// ── ③ T2 黑名单 ──
const t2 = validateT2Script(js);
assert.ok(t2.ok, `T2 黑名单命中: ${JSON.stringify(t2.hits)}`);

// ── ④ client.js 卸载契约 ──
assert.match(js, /window\.__cguiSkinDispose\s*=/, '缺 __cguiSkinDispose 注册');
assert.match(js, /typeof prev === 'function'/, '缺幂等装载链（重复注入先卸旧卸载器）');
// 引用计数形态哨兵:计数器挂窗 + += 1/-= 1 成对出现
assert.match(js, /window\[REF_KEY\] = refs/, '引用计数对象未挂 window（哨兵不可巡检）');
assert.match(js, /refs\.count \+= 1/, '缺计数 +1（track 登记）');
assert.match(js, /refs\.count -= 1/, '缺计数 -1（dispose 逐项核销）');
// 应用占位尺寸口径:--app-h 由 client.js 实算（禁 CSS 自算,CSS 侧仅 var() 消费兜底）
assert.match(js, /--app-h/, 'client.js 未写 --app-h');
assert.match(js, /innerHeight \/ z/, '--app-h 未按 innerHeight/zoom 口径实算');

// ── ⑤ CSS 锚点合法性（先剥注释:头注里的 dsh 原名对照不算选择器）──
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
for (const [label, text] of [['skin.css', css], ['a11y.css', a11y]]) {
  assert.ok(text.includes('body[data-cgui-miku]'), `${label} 缺 body[data-cgui-miku] 作用域标记`);
  const bare = stripComments(text);
  for (const m of bare.matchAll(/\[data-cgui="([^"]+)"\]/g)) {
    assert.ok(SKIN_ANCHOR_IDS.includes(m[1]), `${label} 锚点越白名单: data-cgui="${m[1]}"`);
  }
  assert.ok(!/\[class[*$^]?=/.test(bare), `${label} 挂了点名类选择器（禁挂 Tailwind/CSS-modules 类名）`);
}

// ── ⑥ 标志性元素在场哨兵（与 dsh miku 逐项对账）──
for (const hex of ['#2e9bff', '#9b5dff', '#ff4da6']) {
  assert.ok(css.includes(hex), `skin.css 缺签名渐变色 ${hex}（蓝/紫/洋红缺一即退化）`);
}
assert.ok(js.includes('>01</text>'), 'client.js 缺 01 徽标');
assert.ok(js.includes('cgui-miku-statusbar-wave'), 'client.js 缺状态栏波形');
assert.ok(js.includes('cgui-miku-note'), 'client.js 缺漂浮音符层');
assert.match(css, /var\(--app-h/, 'skin.css 未消费 --app-h（悬浮窗口径断裂）');
assert.match(css, /backdrop-filter/, 'skin.css 缺毛玻璃（backdrop-filter）');

console.log('✓ check-r28-skin-miku: 四件套 / manifest / T2 黑名单 / 卸载契约+引用计数 / 锚点 / 标志性元素 全过');
