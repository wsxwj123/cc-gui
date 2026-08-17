#!/usr/bin/env node
// 单测:r11-③ Icon 间接层 —— 全仓 lucide 唯一出口守卫 + 导入/导出闭合 +
// 语义名注册表与服务端白名单一致 + 皮肤替换渲染机制仪表化。
// 变异哨兵(实际验证过红):删 wrap 内 override 分支(恒走 Orig)→ t4 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';
import { ICON_SEMANTIC_NAMES } from '../../server/utils/skin-validate.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const iconSrc = readFileSync(new URL('../../client/src/components/Icon.jsx', import.meta.url), 'utf8');

// t1 唯一出口:除 Icon.jsx 外零处直连 lucide-react(新增直连即红)
{
  const files = globSync('client/src/**/*.jsx', { cwd: root });
  const offenders = files.filter((f) => f !== 'client/src/components/Icon.jsx'
    && readFileSync(`${root}/${f}`, 'utf8').includes("from 'lucide-react'"));
  assert.deepEqual(offenders, [], `t1: lucide 直连清零,违例: ${offenders.join(',')}`);
  assert.ok(iconSrc.includes("from 'lucide-react'"), 't1: Icon.jsx 是唯一直连点');
  // 命名导入(非 namespace):tree-shaking 前提
  assert.doesNotMatch(iconSrc, /import \* as .* from 'lucide-react'/, 't1: 禁 namespace import(防全量打包)');
}

// t2 导入/导出闭合:所有文件从 Icon.jsx 拿的名字都被导出;每个导出都经 wrap
{
  const exported = new Set([...iconSrc.matchAll(/export const ([A-Za-z0-9]+) = wrap\(/g)].map((m) => m[1]));
  assert.ok(exported.size >= 100, `t2: 导出面 ≥100(实际 ${exported.size})`);
  const used = new Set();
  for (const f of globSync('client/src/**/*.jsx', { cwd: root })) {
    if (f === 'client/src/components/Icon.jsx') continue;
    const src = readFileSync(`${root}/${f}`, 'utf8');
    const re = /import\s*\{([^}]*)\}\s*from\s*'[^']*\/Icon\.jsx'/g;
    let m;
    while ((m = re.exec(src))) {
      for (let part of m[1].split(',')) {
        part = part.trim();
        if (part) used.add(part.split(/\s+as\s+/)[0].trim());
      }
    }
  }
  assert.ok(used.size >= 100, `t2: 消费面 ≥100(实际 ${used.size})`);
  const missing = [...used].filter((n) => !exported.has(n));
  assert.deepEqual(missing, [], `t2: 全部消费名有导出,缺: ${missing.join(',')}`);
}

// t3 语义名注册表 ⊆ 服务端白名单,一一对应无重复
{
  const pairs = [...iconSrc.matchAll(/^export const ([A-Za-z0-9]+) = wrap\("([a-z-]+)",/gm)]
    .map((m) => [m[1], m[2]]);
  assert.ok(pairs.length >= 25, `t3: 语义映射 ≥25(实际 ${pairs.length})`);
  const sems = pairs.map(([, s]) => s);
  assert.equal(new Set(sems).size, sems.length, 't3: 语义名不重复(1:1)');
  const outside = sems.filter((s) => !ICON_SEMANTIC_NAMES.includes(s));
  assert.deepEqual(outside, [], `t3: 语义名全在服务端白名单内,越界: ${outside.join(',')}`);
  for (const anchor of ['send', 'stop', 'settings', 'close', 'pin', 'folder']) {
    assert.ok(sems.includes(anchor), `t3: 高频语义 ${anchor} 已映射`);
  }
}

// t4 替换机制仪表化:override 分支 + CSS mask(currentColor,零 innerHTML)+ 订阅热更
{
  assert.match(iconSrc, /if \(!url\) return <Orig \{\.\.\.props\} \/>;/, 't4: 无替换恒等价直通(哨兵锚)');
  assert.match(iconSrc, /useSyncExternalStore\(subscribe, getSnapshot, getSnapshot\)/, 't4: 皮肤切换热更订阅');
  assert.match(iconSrc, /backgroundColor: 'currentColor'/, 't4: 颜色跟随主题');
  assert.match(iconSrc, /maskImage: `url\("\$\{url\}"\)`/, 't4: CSS mask 渲染皮肤 SVG');
  assert.doesNotMatch(iconSrc, /dangerouslySetInnerHTML/, 't4: 零 innerHTML 注入面');
  assert.match(iconSrc, /export function setIconOverrides\(map\)/, 't4: 覆盖入口');
  assert.match(iconSrc, /width: size, height: size/, 't4: 尺寸跟随原 size(等价包装)');
}

console.log('check-icon-indirection: all passed');
