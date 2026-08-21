#!/usr/bin/env node
// 单测:r28 内置皮肤 gallery —— t1 registry 形状(三套齐全/builtin- 前缀/tier:2/三件套齐)、
// t2 BUILTIN_SKINS 接线(registry 自注册)、t3 reconcile 对内置 id 不误清(行为级:
// mock fetch 服务端列表为空,内置皮肤仍激活;未知 id 仍清)、t4 SkinPanel 区块源码哨兵。
// 依赖:vite-raw-hooks(node 加载 ?raw)+ 最小 DOM/localStorage/fetch 假身(行为级跑通
// reconcile → activateSkin → applySkinDom → loadT2 全链,不碰真浏览器)。
// 前置:client/src/builtin-skins/{miku,xp,whale-song}/ 四件套已落地(移植代理产出);
// 未落地时 t1 即红 —— 这正是「三套齐全」哨兵的职责。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

register('./helpers/vite-raw-hooks.mjs', import.meta.url);

// ── 最小浏览器假身(须在动态 import registry/skins 之前装好) ──
const lsData = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsData.has(k) ? lsData.get(k) : null),
  setItem: (k, v) => lsData.set(k, String(v)),
  removeItem: (k) => lsData.delete(k),
};
const rootAttrs = new Map();
globalThis.document = {
  documentElement: {
    style: { setProperty() {}, removeProperty() {} },
    getAttribute: (k) => (rootAttrs.has(k) ? rootAttrs.get(k) : null),
    setAttribute: (k, v) => rootAttrs.set(k, String(v)),
    removeAttribute: (k) => rootAttrs.delete(k),
    getAttributeNames: () => [...rootAttrs.keys()],
  },
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '', src: '' }),
  head: { appendChild() {} },
  querySelectorAll: () => [],
};
// 行为级口径:服务端列表为空(内置皮肤永不在其中,reconcile 不得误判失效)。
globalThis.fetch = async () => ({ ok: true, json: async () => ({ skins: [] }) });

const { BUILTIN_GALLERY } = await import('../../client/src/builtin-skins/registry.js');
const {
  BUILTIN_SKINS, getSkinState, reconcileSkinOnBoot, deactivateSkin,
} = await import('../../client/src/utils/skins.js');

// t1 registry 形状:三套齐全、id 带 builtin- 前缀、manifest tier:2、三件套文本齐
{
  assert.equal(BUILTIN_GALLERY.length, 3, 't1: gallery 三套齐全(哨兵锚)');
  assert.deepEqual(
    BUILTIN_GALLERY.map((s) => s.id),
    ['builtin-miku', 'builtin-xp', 'builtin-whale-song'],
    't1: id 清单与 builtin- 前缀',
  );
  for (const row of BUILTIN_GALLERY) {
    assert.equal(row.source, 'builtin', `t1: ${row.id} source=builtin`);
    assert.ok(row.name && typeof row.name === 'string', `t1: ${row.id} 有名称`);
    assert.equal(row.manifest?.format, 'cgui-skin/1', `t1: ${row.id} manifest format`);
    assert.equal(row.manifest?.tier, 2, `t1: ${row.id} manifest tier:2(哨兵锚)`);
    assert.deepEqual(
      Object.keys(row.t2Texts || {}).sort(),
      ['a11y.css', 'client.js', 'skin.css'],
      `t1: ${row.id} 三件套键齐`,
    );
    for (const [f, t] of Object.entries(row.t2Texts)) {
      assert.ok(typeof t === 'string' && t.length > 0, `t1: ${row.id} ${f} 非空文本`);
    }
  }
}

// t2 BUILTIN_SKINS 接线:registry 自注册,数组内容 = gallery(引用同一批 row 对象)
{
  assert.equal(BUILTIN_SKINS.length, 3, 't2: BUILTIN_SKINS 已由 registry 填充(哨兵锚)');
  for (const row of BUILTIN_GALLERY) {
    assert.ok(BUILTIN_SKINS.includes(row), `t2: BUILTIN_SKINS 含 ${row.id}(同引用)`);
  }
}

// t3 reconcile 行为级:服务端列表为空时——
{
  localStorage.setItem('cgui-dev-skins', '1'); // T2 总开关开(T1 激活不依赖它,T2 装载依赖)
  // ① 内置 id 仍激活(不被误判成失效皮肤清掉),T2 三件套走本地 t2Texts 装载
  deactivateSkin();
  localStorage.setItem('cgui-skin-id', 'builtin-miku');
  await reconcileSkinOnBoot();
  assert.equal(getSkinState().id, 'builtin-miku', 't3①: 服务端列表为空,内置皮肤仍激活(哨兵锚)');
  assert.equal(localStorage.getItem('cgui-skin-id'), 'builtin-miku', 't3①: 激活态未清');
  assert.ok(getSkinState().t2, 't3①: T2 经 t2Texts 本地装载(不过资源端点)');
  // ② 未注册的 builtin- id(gallery 查无)→ 照常清
  deactivateSkin();
  localStorage.setItem('cgui-skin-id', 'builtin-ghost');
  await reconcileSkinOnBoot();
  assert.equal(getSkinState().id, null, 't3②: 未注册 builtin- id 停用');
  assert.equal(localStorage.getItem('cgui-skin-id'), null, 't3②: 失效 id 落盘清除');
  // ③ 普通用户皮肤 id 失效 → 静默清(r26-D8 既有口径不回退)
  deactivateSkin();
  localStorage.setItem('cgui-skin-id', 'user-gone-123');
  await reconcileSkinOnBoot();
  assert.equal(getSkinState().id, null, 't3③: 服务端查无的用户皮肤静默清');
  assert.equal(localStorage.getItem('cgui-skin-id'), null, 't3③: 落盘清除');
}

// t4 SkinPanel 区块源码哨兵
{
  const src = readFileSync(fileURLToPath(new URL('../../client/src/components/SkinPanel.jsx', import.meta.url)), 'utf8');
  assert.ok(src.includes('data-cgui-builtin-gallery'), 't4: 内置 gallery 区块标记(哨兵锚)');
  assert.ok(src.includes('BuiltinSkinCard'), 't4: 内置卡片组件');
  assert.ok(src.includes("from '../builtin-skins/registry.js'"), 't4: 面板接 registry');
  assert.ok(src.includes('内置皮肤'), 't4: 区块标题');
  assert.ok(src.includes('开启下方开发者皮肤开关后可应用'), 't4: 开发者总开关门控提示');
  assert.ok(src.includes('tagline || m.description'), 't4: tagline/description 展示');
  assert.ok(!src.includes('[...installed, ...BUILTIN_SKINS]'), 't4: 内置不再混入用户皮肤网格');
}

console.log('check-r28-builtin-gallery: all green');
