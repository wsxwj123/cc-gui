#!/usr/bin/env node
// 问题1 artifact 预览显示档持久化自检:mode 按 artifactId 记忆,重挂(= 新 useState 惰性初始化)
// 后仍读回用户选的档,不被打回 'preview'。跑法:node tests/unit/check-preview-mode.mjs
import assert from 'node:assert/strict';
import { makeModePersist } from '../../client/src/utils/previewMode.js';

// 默认档 = 'preview'(从未选过)
{
  const p = makeModePersist();
  assert.equal(p.get('a'), 'preview');
}

// 选 code 后再 get(模拟重挂 useState 惰性初始化)→ 仍是 code,谁也没把它打回 preview
{
  const p = makeModePersist();
  p.set('a', 'code');
  assert.equal(p.get('a'), 'code', '重挂后恢复用户选的 code 档');
  // 其它 artifact 不受影响(按 id 隔离)
  assert.equal(p.get('b'), 'preview');
}

// 切回 preview 也被记住(用户显式选 preview,不是默认)
{
  const p = makeModePersist();
  p.set('a', 'code');
  p.set('a', 'preview');
  assert.equal(p.get('a'), 'preview');
}

// 传入外部 memory → 可被复用/共享(模块级单例即此形态)
{
  const mem = new Map();
  const p1 = makeModePersist(mem);
  p1.set('x', 'code');
  const p2 = makeModePersist(mem);
  assert.equal(p2.get('x'), 'code', '共享 memory 时跨实例可见');
}

console.log('✓ check-preview-mode: all passed');
