#!/usr/bin/env node
// 单测:r11-③ 稳定锚点层 —— skinAnchors.js 清单与源码 data-cgui 挂点双向闭合快照。
// 变异哨兵(实际验证过红):删任一挂点(如 send-btn)→ t2 红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';
import { SKIN_ANCHORS, SKIN_ANCHOR_IDS } from '../../client/src/utils/skinAnchors.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

// t1 清单形态:≥40、唯一、命名规范、都有说明
{
  // r13-①:drill-back 随钻入两页退役删除(skinAnchors.js 备案注释),40→39。
  assert.ok(SKIN_ANCHOR_IDS.length >= 39, `t1: 首批 ≥39(实际 ${SKIN_ANCHOR_IDS.length})`);
  assert.ok(!SKIN_ANCHOR_IDS.includes('drill-back'), 't1: drill-back 已按备案退役');
  assert.equal(new Set(SKIN_ANCHOR_IDS).size, SKIN_ANCHOR_IDS.length, 't1: id 唯一');
  for (const a of SKIN_ANCHORS) {
    assert.match(a.id, /^[a-z][a-z0-9-]*$/, `t1: id 命名规范 ${a.id}`);
    assert.ok(a.desc && typeof a.desc === 'string', `t1: ${a.id} 有说明(供生成器/文档)`);
  }
}

// t2 双向闭合:清单内全部有挂点;源码 data-cgui 字面量不越清单
{
  let all = '';
  for (const f of globSync('client/src/**/*.jsx', { cwd: root })) {
    all += readFileSync(`${root}/${f}`, 'utf8');
  }
  // settings-btn 走动态表达式(单引号),由下方专项断言钉;其余一律静态字面量
  const missing = SKIN_ANCHOR_IDS.filter((id) => id !== 'settings-btn' && !all.includes(`data-cgui="${id}"`));
  assert.deepEqual(missing, [], `t2: 清单内锚点全部已挂,缺: ${missing.join(',')}`);
  // 源码中的 data-cgui="…" 字面量(排除 data-cgui-theme/data-cgui-skin 等其它属性)
  const used = [...all.matchAll(/data-cgui="([a-z0-9-]+)"/g)].map((m) => m[1]);
  const outside = [...new Set(used)].filter((id) => !SKIN_ANCHOR_IDS.includes(id));
  assert.deepEqual(outside, [], `t2: 挂点不越清单(新增锚点必须先进 skinAnchors.js),越界: ${outside.join(',')}`);
  // 动态挂点(settings-btn 经条件表达式)单独钉
  assert.match(all, /data-cgui=\{id === 'settings' \? 'settings-btn' : undefined\}/, 't2: settings-btn 动态挂点在位');
  for (const key of ['send-btn', 'stop-btn', 'composer', 'sidebar', 'session-row', 'project-row', 'topbar', 'badge-context', 'home']) {
    assert.ok(used.includes(key), `t2: 核心锚点 ${key} 已挂(哨兵锚)`);
  }
}

console.log('check-skin-anchors: all passed');
