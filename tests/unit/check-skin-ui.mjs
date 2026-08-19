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
  // r12-② t4:--app-h/--app-w 官方口径段落(zoom 不变量 px/client.js 同口径写 body+
  // 跟踪 resize 与 zoom/卸载清理),含两条「禁止」(静态 dvh 自算/自引用 calc)。
  assert.ok(p.includes('--app-h') && p.includes('--app-w'), 't4: 官方尺寸变量段落');
  assert.ok(p.includes('innerHeight/zoom'), 't4: zoom 不变量口径');
  assert.ok(p.includes('resize') && p.includes('卸载器中清理'), 't4: client.js 同口径+跟踪+清理');
  assert.ok(p.includes('禁止在 CSS 用静态 calc(100dvh'), 't4: 禁静态 dvh 自算(哨兵锚)');
  assert.ok(p.includes('禁止 --app-h: calc(var(--app-h)'), 't4: 禁自引用 calc');
}

// t2 内置示例:T1 两套 manifest 过服务端校验器(files 空集,纯变量);T2 示例过静态校验
{
  // r13-p2-10:内置示例皮肤退役(用户实测「和主题没区别」),皮肤一律靠三条导入通道。
  assert.equal(BUILTIN_SKINS.length, 0, 't2: 内置示例已退役(导入通道不受影响)');
  // (原此处是围绕三套内置示例的逐项断言;示例退役后由导入通道测试覆盖 —— 
  //  manifest 校验见 check-skin-validate,T2 装卸链见 check-skin-t2-chain 的内联夹具。)
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
  // p2-2 根因守卫:portal 对话框在主题弹层 wrapRef 之外——对话框存在期间弹层的
  // 外点/Esc 判定必须让位(否则点「AI 提示词」等任意对话框内容=关弹层连带卸载对话框)
  assert.match(src, /<div data-cgui-skin-dialog /, 't3-p2: 对话框根节点带让位标记(哨兵锚)');
  assert.match(app, /const skinDialogOpen = \(\) => !!document\.querySelector\('\[data-cgui-skin-dialog\]'\)/, 't3-p2: 弹层侧让位判定存在');
  assert.match(app, /onDown = \(e\) => \{ if \(skinDialogOpen\(\)\) return;/, 't3-p2: 外点判定让位');
  assert.match(app, /if \(skinDialogOpen\(\)\) return; e\.stopPropagation\(\); setOpen\(false\);/, 't3-p2: Esc 判定让位');
  assert.match(src, /window\.addEventListener\('keydown', onEsc, true\)/, 't3-p2: 对话框自管 Esc(capture+stopPropagation)');
  // 皮肤区按钮 type 清一色(防 form 隐式 submit,同面板既有口径)
  const btnCount = (src.match(/<button/g) || []).length;
  const typedCount = (src.match(/<button\s+type="button"|<button type="button"/g) || []).length;
  assert.equal(typedCount, btnCount, `t3-p2: 全部 ${btnCount} 个按钮 type="button"(实际 ${typedCount})`);
  // import-inline 服务端接线:T2 保存必过静态校验、dsw 走映射器、名称必填
  const routes = readFileSync(new URL('../../server/routes/skins-packs.js', import.meta.url), 'utf8');
  const inline = routes.slice(routes.indexOf("'/skins/import-inline'"), routes.indexOf("'/skins/import'"));
  assert.match(inline, /validateT2Script\(text\)/, 't3: 三件套保存路径过 JS 静态校验(安全器③复用)');
  assert.match(inline, /convertDswVars\(parsed\)/, 't3: dsw 保存路径走映射器(值全套文法闸)');
  assert.match(inline, /skinName\) return res\.status\(422\)/, 't3: 名称必填');
}

console.log('check-skin-ui: all passed');
