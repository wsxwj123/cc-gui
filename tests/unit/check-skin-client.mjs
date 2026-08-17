#!/usr/bin/env node
// 单测:r11-③ 客户端皮肤引擎 —— 双端白名单一致 + expandSkin 展开矩阵 +
// T2 客户端复验 + DOM 编排源码守卫(setProperty 应用/三重卸载/FOUC/明暗联动)。
// 变异哨兵(实际验证过红):expandSkin 删模式块覆盖(只取 shared)→ t2 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SKIN_TOKENS_CLIENT, SKIN_TOKENS_REJECTED_CLIENT, T2_BLACKLIST_CLIENT,
  expandSkin, validateT2Client, resolveSkinMode, skinAssetUrl,
} from '../../client/src/utils/skins.js';
import { SKIN_TOKENS, SKIN_TOKENS_REJECTED_V1, T2_SCRIPT_BLACKLIST } from '../../server/utils/skin-validate.js';

// t1 双端口径逐字一致(白名单/拒收/黑名单)
{
  assert.deepEqual(SKIN_TOKENS_CLIENT, SKIN_TOKENS, 't1: token 白名单与服务端逐字一致');
  assert.deepEqual(SKIN_TOKENS_REJECTED_CLIENT, SKIN_TOKENS_REJECTED_V1, 't1: v1 拒收清单一致');
  assert.deepEqual(T2_BLACKLIST_CLIENT, T2_SCRIPT_BLACKLIST, 't1: T2 黑名单一致(纵深复验同口径)');
}

// t2 expandSkin:shared 先、模式块后覆盖;白名单外/拒收丢弃;背景默认值补齐
{
  const manifest = {
    shared: { vars: { '--color-accent': '#111111', '--radius-lg': '9px', '--glass-shadow': 'x', '--bogus': 'y' } },
    light: { vars: { '--color-accent': '#222222' }, background: { image: 'a.png', overlayOpacity: 0.6 } },
    dark: { vars: { '--color-accent': '#333333' }, background: { image: 'b.png', fit: 'tile', blur: 8 } },
    home: { icon: 'ic.svg', greeting: '你好 {name}' },
    icons: { send: 's.svg' },
  };
  const L = expandSkin(manifest, 'light');
  assert.equal(L.vars['--color-accent'], '#222222', 't2: 模式块覆盖 shared(哨兵锚)');
  assert.equal(L.vars['--radius-lg'], '9px', 't2: shared 透传');
  assert.ok(!('--glass-shadow' in L.vars), 't2: v1 拒收 token 不应用');
  assert.ok(!('--bogus' in L.vars), 't2: 白名单外不应用');
  assert.deepEqual(L.background, { image: 'a.png', overlayOpacity: 0.6, fit: 'cover', position: 'center', blur: 0 }, 't2: 背景默认值补齐');
  const D = expandSkin(manifest, 'dark');
  assert.equal(D.vars['--color-accent'], '#333333', 't2: 暗色块独立');
  assert.equal(D.background.fit, 'tile', 't2: fit 透传');
  assert.equal(D.background.blur, 8, 't2: blur 透传');
  assert.equal(D.home.greeting, '你好 {name}', 't2: home 透传(⑫ {name} 模板衔接)');
  assert.deepEqual(expandSkin({}, 'light'), { vars: {}, background: null, home: null, icons: null }, 't2: 空 manifest 安全');
  assert.equal(skinAssetUrl('a-1', 'b.png'), '/api/skins/a-1/asset/b.png', 't2: 资源 URL 形态');
}

// t3 resolveSkinMode(注入 root,不碰真 DOM)
{
  const fake = (attrs) => ({ getAttribute: (k) => attrs[k] ?? null });
  assert.equal(resolveSkinMode(fake({ 'data-theme': 'dark' })), 'dark', 't3: 显式 dark');
  assert.equal(resolveSkinMode(fake({ 'data-theme': 'light' })), 'light', 't3: 显式 light');
  assert.equal(resolveSkinMode(fake({ 'data-theme': 'auto', 'data-theme-system': 'dark' })), 'dark', 't3: auto 随系统');
  assert.equal(resolveSkinMode(fake({})), 'light', 't3: 缺省浅色');
}

// t4 T2 客户端复验(与服务端同刀)
{
  assert.ok(validateT2Client('document.title = "x"').ok, 't4: 无害通过');
  assert.equal(validateT2Client('fetch("/x")').ok, false, 't4: fetch 拒');
  assert.equal(validateT2Client('EVAL(“x”)'.replace('EVAL(', 'eval(')).ok, false, 't4: 大小写归一拒');
}

// t5 DOM 编排源码守卫:注入面为零(setProperty 应用)+ 三重卸载 + FOUC + 明暗联动
{
  const src = readFileSync(new URL('../../client/src/utils/skins.js', import.meta.url), 'utf8');
  assert.match(src, /root\.style\.setProperty\(k, v\)/, 't5: 应用只走 setProperty');
  assert.match(src, /root\.style\.removeProperty\(k\)/, 't5: 停用逐个 removeProperty');
  // T1 区段(T2 代码层之前)零 <style>/eval 注入面——createElement 只允许出现在 loadT2 内
  const t1Section = src.slice(0, src.indexOf('── T2 代码层'));
  assert.ok(t1Section.includes('applySkinDom'), 't5: 区段切分有效');
  assert.doesNotMatch(t1Section, /createElement|innerHTML|insertAdjacentHTML/, 't5: T1 路径零 style/HTML 注入');
  // T2 三重卸载:disposer → 标记节点移除 → documentElement 属性快照恢复
  assert.match(src, /window\.__cguiSkinDispose\?\.\(\)/, 't5: ①皮肤自注册 disposer');
  assert.match(src, /querySelectorAll\('\[data-cgui-skin-style\]'\)/, 't5: ②标记节点逐项移除');
  assert.match(src, /attrSnapshot/, 't5: ③属性快照恢复');
  assert.match(src, /devSkinsEnabled\(\)/, 't5: T2 受「开发者皮肤(本机)」总开关门控');
  assert.match(src, /new Blob\(\[js\], \{ type: 'text\/javascript' \}\)/, 't5: Blob-URL 经典脚本注入');
  assert.match(src, /validateT2Client\(js\)/, 't5: 载入前客户端复验(纵深)');
  // FOUC:同步重放 + 对账
  assert.match(src, /export function bootReplaySkin\(\)/, 't5: 启动同步重放');
  assert.match(src, /export async function reconcileSkinOnBoot\(\)/, 't5: 列表返回后校对');
  assert.match(src, /deactivateSkin\(\); return;/, 't5: id 失效静默清回默认');
  // 明暗联动:MutationObserver 只观察 data-theme/data-theme-system
  assert.match(src, /attributeFilter: \['data-theme', 'data-theme-system'\]/, 't5: 明暗联动观察面最小化');
  // 明暗双图预载
  assert.match(src, /new Image\(\)\.src = skinAssetUrl\(id, other\)/, 't5: 另一模式背景预载');
  // 接线:main.jsx 同步重放;App.jsx 对账+观察器+背景层+Home 订阅
  const main = readFileSync(new URL('../../client/src/main.jsx', import.meta.url), 'utf8');
  assert.match(main, /bootReplaySkin\(\);/, 't5: main.jsx 挂载前重放');
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /<SkinBackgroundLayer \/>/, 't5: App 根部皮肤背景层');
  assert.match(app, /-z-20 pointer-events-none/, 't5: 背景层垫底不截事件');
  assert.match(app, /reconcileSkinOnBoot\(\);/, 't5: App 挂载对账');
  assert.match(app, /watchThemeForSkin\(\);/, 't5: 明暗观察器启动');
}

console.log('check-skin-client: all passed');
