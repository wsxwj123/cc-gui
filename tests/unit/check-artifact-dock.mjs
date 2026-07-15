#!/usr/bin/env node
// #3 停靠面板 code 回写纯判定自检:仅 id 匹配 + code 变化才产出新对象,否则原引用不变(短路)。
import assert from 'node:assert/strict';
import { nextDockCode } from '../../client/src/utils/artifactDock.js';

const dock = { artifactId: 'a1', lang: 'html', code: '<p>1</p>' };

// id 匹配 + code 变了 → 新对象,code 更新,其余字段保留
{
  const r = nextDockCode(dock, 'a1', '<p>2</p>');
  assert.notEqual(r, dock, 'id 匹配+变化 → 新引用');
  assert.equal(r.code, '<p>2</p>', 'code 更新');
  assert.equal(r.lang, 'html', '其余字段保留');
}

// id 不匹配 → 原引用不变(不串到别的 artifact)
assert.equal(nextDockCode(dock, 'other', '<p>x</p>'), dock, 'id 不匹配 → 原引用');

// code 未变 → 原引用不变(短路,防空 setState)
assert.equal(nextDockCode(dock, 'a1', '<p>1</p>'), dock, 'code 未变 → 原引用');

// dock 为 null(无停靠)→ 返回 null,不崩
assert.equal(nextDockCode(null, 'a1', 'x'), null, 'null dock → null');

console.log('✓ check-artifact-dock: all passed');
