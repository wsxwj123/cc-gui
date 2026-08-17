#!/usr/bin/env node
// 单测:r11-③ 皮肤 UI —— AI 提示词生成器三清单来源(import 真函数)+ 内置示例合法性
// (经服务端校验器整包过闸)+ SkinPanel 编排守卫(试穿应用分离/confirmDialog/门控/通道)。
// 变异哨兵(实际验证过红):buildSkinPrompt 锚点清单改空数组 → t1 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSkinPrompt } from '../../client/src/utils/skinPrompt.js';
import { BUILTIN_SKINS, SKIN_TOKENS_CLIENT, SKIN_TOKENS_REJECTED_CLIENT } from '../../client/src/utils/skins.js';
import { ICON_SEMANTICS } from '../../client/src/utils/iconOverrides.js';
import { SKIN_ANCHORS } from '../../client/src/utils/skinAnchors.js';
import { validateManifest, validateT2Script, ICON_SEMANTIC_NAMES } from '../../server/utils/skin-validate.js';

// t1 生成器:三清单全量入文 + schema/骨架/规范要素在位
{
  const p = buildSkinPrompt();
  for (const t of SKIN_TOKENS_CLIENT.filter((x) => !SKIN_TOKENS_REJECTED_CLIENT.includes(x))) {
    assert.ok(p.includes(t), `t1: token ${t} 进提示词`);
  }
  assert.ok(!p.includes('--glass-shadow'), 't1: v1 拒收 token 不进提示词');
  for (const s of Object.values(ICON_SEMANTICS)) assert.ok(p.includes(s), `t1: 图标语义 ${s} 进提示词`);
  for (const a of SKIN_ANCHORS) assert.ok(p.includes(a.id), `t1: 锚点 ${a.id} 进提示词(哨兵锚)`);
  assert.ok(p.includes('"format": "cgui-skin/1"'), 't1: skin.json schema 骨架');
  assert.ok(p.includes('{name}'), 't1: {name} 占位符说明(接⑫)');
  assert.ok(p.includes('window.__cguiSkinDispose'), 't1: T2 卸载器契约');
  assert.ok(p.includes('明暗规范'), 't1: 明暗规范段');
  assert.ok(p.includes('data-cgui'), 't1: 锚点选择器规范');
}

// t2 内置示例:T1 两套 manifest 过服务端校验器(files 空集,纯变量);T2 示例过静态校验
{
  assert.equal(BUILTIN_SKINS.length, 3, 't2: 内置三套(T1 亮/暗 + T2)');
  for (const b of BUILTIN_SKINS.filter((s) => s.manifest.tier !== 2)) {
    const r = validateManifest(b.manifest, new Set());
    assert.ok(r.ok, `t2: 内置 ${b.id} manifest 合法`);
    assert.equal(r.warnings.filter((w) => w.code === 'var_rejected').length, 0, `t2: 内置 ${b.id} 零被拒变量`);
  }
  const dev = BUILTIN_SKINS.find((s) => s.id === 'builtin-dev');
  assert.equal(dev.manifest.tier, 2, 't2: 开发者示例 tier 2');
  assert.ok(validateT2Script(dev.t2Texts['client.js']).ok, 't2: 示例 client.js 过黑名单');
  assert.ok(dev.t2Texts['client.js'].includes('__cguiSkinDispose'), 't2: 示例注册卸载器(活文档)');
  assert.ok(dev.t2Texts['skin.css'].includes('data-cgui='), 't2: 示例样式用语义锚点');
  // 示例 greeting 走 {name} 模板(与⑫衔接)
  assert.ok(BUILTIN_SKINS.some((s) => s.manifest.home?.greeting?.includes('{name}')), 't2: 示例含 {name} 问候模板');
  // 语义清单双端一致(注册表值 ⊆ 服务端白名单已在 icon 测钉;这里钉总量口径)
  assert.equal(Object.keys(ICON_SEMANTICS).length, ICON_SEMANTIC_NAMES.length, 't2: 图标语义名 30 全映射');
}

// t3 SkinPanel 编排守卫
{
  const src = readFileSync(new URL('../../client/src/components/SkinPanel.jsx', import.meta.url), 'utf8');
  assert.match(src, /activateSkin\(row, \{ tryOn \}\)/, 't3: 试穿/应用共用激活分离 tryOn');
  assert.match(src, /title="试穿\(不保存,刷新即回\)"/, 't3: 试穿语义明示');
  assert.match(src, /await confirmDialog\(`删除皮肤/, 't3: 删除走 confirmDialog(Tauri 红线)');
  assert.doesNotMatch(src, /window\.confirm|window\.alert/, 't3: 零原生弹窗');
  assert.match(src, /devSkinsEnabled\(\)\) return true;/, 't3: T2 总开关门控');
  assert.match(src, /danger: true, confirmText: '我明白,启用'/, 't3: 首次启用权限警示');
  assert.match(src, /\/api\/skins\/import-inline/, 't3: 三件套/dsw 保存通道');
  assert.match(src, /x-upload-name/, 't3: zip 通道(流式上传头)');
  assert.match(src, /不可直用/, 't3: dsh JS bundle 如实报不可直用');
  assert.match(src, /版权由使用者自行负责/, 't3: 素材合规陈述');
  // 永无市场/分享入口:面板零外网 URL(全部 fetch 都是本机 /api 相对路径)
  assert.doesNotMatch(src, /https?:\/\//, 't3: 永无市场/分享入口(零外网 URL)');
  assert.equal((src.match(/fetch\('\/api\/skins/g) || []).length >= 3, true, 't3: 全部请求走本机端点');
  assert.match(src, /flex flex-col animate-glass-rise/, 't3: 模态 flex 列(禁 sticky 红线)');
  assert.doesNotMatch(src, /className="[^"]*\bsticky\b/, 't3: 零 sticky 类(注释提及红线不算)');
  // 弹层接线
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /<SkinSection \/>/, 't3: 皮肤段落位主题弹层(入口落位再修订)');
  // import-inline 服务端接线:T2 保存必过静态校验、dsw 走映射器、名称必填
  const routes = readFileSync(new URL('../../server/routes/skins-packs.js', import.meta.url), 'utf8');
  const inline = routes.slice(routes.indexOf("'/skins/import-inline'"), routes.indexOf("'/skins/import'"));
  assert.match(inline, /validateT2Script\(text\)/, 't3: 三件套保存路径过 JS 静态校验(安全器③复用)');
  assert.match(inline, /convertDswVars\(parsed\)/, 't3: dsw 保存路径走映射器(值全套文法闸)');
  assert.match(inline, /skinName\) return res\.status\(422\)/, 't3: 名称必填');
}

console.log('check-skin-ui: all passed');
