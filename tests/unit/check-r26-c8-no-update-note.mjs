#!/usr/bin/env node
// r26-C8【单测】:删 updateNote 死字段。
// 背景:version-check.js 曾对 npm 安装恒发 updateNote「npm 渠道已被官方降级为原生安装器
// 引导壳…」,但 r13-p2-20 之后 npm 已是用户可选的真 npm 更新渠道,文案与现实矛盾;
// 且前端 grep 无任何 updateNote 渲染 —— 纯死字段。修复=删除,零影响。
// 验收点(PLAN C8):/claude-version-check 响应组装不再含 updateNote 键(哨兵防复活)。
// Run: node tests/unit/check-r26-c8-no-update-note.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ①响应组装哨兵:claude-version-check 路由段内不得再出现 updateNote
{
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  const start = src.indexOf("router.get('/claude-version-check'");
  const end = src.indexOf("router.post('/claude-update'");
  assert.ok(start > 0 && end > start, 'C8: 路由段定位失败(锚漂移需换锚)');
  const routeBody = src.slice(start, end);
  assert.ok(!/updateNote/.test(routeBody),
    'C8: /claude-version-check 响应组装仍含 updateNote 死字段(文案与现实矛盾且前端无消费)');
}

// ②前端无消费哨兵:整个 client/src 树不得有 updateNote 引用(若将来真接了渲染,
// 本钉迫使同步审视服务端口径)。纯 node 遍历,不依赖 grep(Windows 无此命令)。
{
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../client/src', import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(jsx?|tsx?)$/.test(name)) continue;
      if (/updateNote/.test(readFileSync(p, 'utf8'))) offenders.push(p);
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], 'C8: 前端不应消费 updateNote(死字段防复活)');
}

console.log('PASS check-r26-c8-no-update-note');
