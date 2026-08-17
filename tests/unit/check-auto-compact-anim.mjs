#!/usr/bin/env node
// 单测:r11-⑥ 自动压缩动画 —— 事件→动画态 reducer(autoCompactTransition,import 真函数)
// + App.jsx 接线仪表化。取证依据(只读):装机 CLI 二进制字符串层
// (sdk_status→{type:'system',subtype:'status',status:'compacting'|'requesting'|null,
// compact_result?,compact_error?};boundary 处 CLI 渲染器自清压缩态)+ 本机真实 jsonl
// (compact_boundary.compactMetadata.trigger ∈ {'auto','manual'})。
// 变异哨兵(实际验证过红):
//   S1 删检测分支(status==='compacting' 恒 false)→ t1 红
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoCompactTransition } from '../../client/src/utils/compactStatus.js';

// t1 开始:status 事件 status='compacting' → 进行中(auto 与 manual 同一发射点,30s 心跳重发同样命中)
{
  assert.equal(autoCompactTransition({ type: 'system', subtype: 'status', status: 'compacting' }), true, 't1: compacting → 动画开');
  assert.equal(autoCompactTransition({ type: 'system', subtype: 'status', status: 'compacting', uuid: 'x' }), true, 't1: 心跳重发同样为真');
}

// t2 结束:status 变 null / requesting(可带 compact_result),或 compact_boundary
{
  assert.equal(autoCompactTransition({ type: 'system', subtype: 'status', status: null }), false, 't2: status null → 结束');
  assert.equal(autoCompactTransition({ type: 'system', subtype: 'status', status: 'requesting' }), false, 't2: requesting → 结束');
  assert.equal(autoCompactTransition({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'x' }), false, 't2: 失败收尾也结束');
  assert.equal(autoCompactTransition({ type: 'system', subtype: 'compact_boundary' }), false, 't2: boundary → 结束(对齐 CLI 渲染器)');
}

// t3 无关事件不改状态(undefined):调用方不据此清别的等待行
{
  assert.equal(autoCompactTransition({ type: 'system', subtype: 'api_retry' }), undefined, 't3: api_retry 无关');
  assert.equal(autoCompactTransition({ type: 'assistant' }), undefined, 't3: 非 system 无关');
  assert.equal(autoCompactTransition(null), undefined, 't3: 空事件无关');
  assert.equal(autoCompactTransition({ type: 'system', subtype: 'permission_denied' }), undefined, 't3: 其他 system 子类无关');
}

// t4 仪表化:App.jsx 检测点接线(复用手动压缩的同一动画组件,文案标自动压缩,无定时假动画)
{
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /autoCompactTransition\(event\)/, 't4: 检测分支走 reducer');
  assert.match(app, /正在自动压缩上下文…', compacting: true/, 't4: 自动压缩文案+动画标记');
  assert.match(app, /liveStatus\.compacting && <CompactProgressBar \/>/, 't4: 复用手动压缩同一动画组件');
  assert.match(app, /prev\?\.compacting \? null : prev/, 't4: boundary 只清压缩行,不动其他等待行');
  // 无定时假动画:压缩动画的显隐不许挂 setTimeout/setInterval
  const seg = app.split('r11-⑥').slice(1).join('\n');
  assert.ok(seg.length > 0, 't4: 标注段存在');
  assert.doesNotMatch(/const _ac = autoCompactTransition[\s\S]{0,600}/.exec(app)?.[0] || '', /setTimeout|setInterval/, 't4: 起止只随真实事件,无定时器');
}

console.log('check-auto-compact-anim: all passed');
