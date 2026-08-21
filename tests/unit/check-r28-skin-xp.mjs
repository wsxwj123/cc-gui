#!/usr/bin/env node
// 单测:r28 内置皮肤 xp(Windows XP Luna 移植)四件套守门 ——
// t1 四件套存在且非空;t2 manifest 过 validateManifest(tier:2/format/三件套收录);
// t3 client.js 过 T2 黑名单(validateT2Script);t4 client.js 注册 __cguiSkinDispose;
// t5 skin.css/a11y.css 引用的 data-cgui 锚点不越 skinAnchors.js 清单。
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateManifest, validateT2Script } from '../../server/utils/skin-validate.js';
import { SKIN_ANCHOR_IDS } from '../../client/src/utils/skinAnchors.js';

const dir = fileURLToPath(new URL('../../client/src/builtin-skins/xp/', import.meta.url));
const FILES = ['skin.json', 'skin.css', 'a11y.css', 'client.js'];

// t1 四件套存在且非空
{
  for (const f of FILES) {
    assert.ok(existsSync(dir + f), `t1: 缺 ${f}(哨兵锚)`);
    assert.ok(statSync(dir + f).size > 0, `t1: ${f} 为空`);
  }
}

// t2 manifest 校验:format/tier:2/base 合法、三件套被收录、无结构性拒绝
{
  const man = JSON.parse(readFileSync(dir + 'skin.json', 'utf8'));
  const mv = validateManifest(man, new Set(FILES));
  assert.ok(mv.ok, `t2: manifest 被拒 ${JSON.stringify(mv)}(哨兵锚)`);
  assert.equal(mv.manifest.format, 'cgui-skin/1', 't2: format');
  assert.equal(mv.manifest.tier, 2, 't2: tier:2');
  assert.equal(mv.manifest.base, 'default', 't2: base=default');
  assert.equal(mv.manifest.skin_css, 'skin.css', 't2: skin.css 收录');
  assert.equal(mv.manifest.client_js, 'client.js', 't2: client.js 收录');
  assert.equal(mv.manifest.a11y_css, 'a11y.css', 't2: a11y.css 收录');
  assert.ok(mv.manifest.light?.vars?.['--color-accent'] === '#316ac5', 't2: 亮态 accent=Luna 蓝 #316ac5');
  assert.ok(mv.manifest.home?.greeting, 't2: home.greeting 在');
}

// t3 T2 黑名单
{
  const js = readFileSync(dir + 'client.js', 'utf8');
  const t2 = validateT2Script(js);
  assert.ok(t2.ok, `t3: client.js 命中黑名单 ${JSON.stringify(t2.hits)}(哨兵锚)`);
}

// t4 client.js 注册 __cguiSkinDispose(卸载契约)
{
  const js = readFileSync(dir + 'client.js', 'utf8');
  assert.match(js, /window\.__cguiSkinDispose\s*=/, 't4: __cguiSkinDispose 注册(哨兵锚)');
  assert.match(js, /removeAttribute\('data-cgui-xp'\)/, 't4: 卸载器摘除作用域标记');
}

// t5 样式引用的锚点不越清单
{
  const css = readFileSync(dir + 'skin.css', 'utf8') + '\n' + readFileSync(dir + 'a11y.css', 'utf8');
  const used = [...new Set([...css.matchAll(/\[data-cgui="([a-z0-9-]+)"\]/g)].map((m) => m[1]))];
  assert.ok(used.length >= 5, `t5: 至少引用 5 个锚点(实际 ${used.length})`);
  const outside = used.filter((id) => !SKIN_ANCHOR_IDS.includes(id));
  assert.deepEqual(outside, [], `t5: 锚点越清单: ${outside.join(',')}`);
}

console.log('check-r28-skin-xp: all passed');
