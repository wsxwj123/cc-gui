#!/usr/bin/env node
// computer-use 截图保留策略单测(批次3/R18):
//   * 每实例最多保留 5 个已完成图片文件:第 6 张起清最旧的
//   * 只清本实例前缀的文件 —— 别的实例仍在引用/在途的文件一个都不动
// 跑法:node tests/unit/check-cu-shots.mjs
import assert from 'node:assert/strict';

const { shotsToPrune } = await import('../../server/computer-use/mcp-server.js');

const mk = (names) => names.map((f, i) => ({ f, at: 1000 + i }));

// 7 张(单次截图只留一个已完成文件):清掉最旧的 2 个
assert.deepEqual(shotsToPrune(mk(['a1.jpg', 'a2.jpg', 'a3.jpg', 'a4.jpg', 'a5.jpg', 'a6.jpg', 'a7.jpg'])),
  ['a2.jpg', 'a1.jpg'], '超出 5 个的部分按 mtime 新→旧淘汰');
assert.deepEqual(shotsToPrune(mk(['a1.jpg', 'a2.jpg'])), [], '不足 5 个时不动');
assert.deepEqual(shotsToPrune(mk(['a1.jpg', 'a2.jpg', 'a3.jpg', 'a4.jpg', 'a5.jpg'])), [], '正好 5 个不动');

// 乱序 mtime:保留最新的 5 个
const shuffled = [{ f: 'old.jpg', at: 1 }, { f: 'new.jpg', at: 9 }, { f: 'mid.jpg', at: 5 },
  { f: 'older.jpg', at: 0 }, { f: 'newest.jpg', at: 10 }, { f: 'mid2.jpg', at: 6 }];
assert.deepEqual(shotsToPrune(shuffled), ['older.jpg'], '按 mtime 保留最新 5 个(最旧的一个被清)');

// 只接收本实例前缀的文件:别的实例的文件不会进这个列表(调用方按前缀过滤)
const mineOnly = mk(['cu-abc123-1.jpg', 'cu-abc123-2.jpg']);
assert.deepEqual(shotsToPrune(mineOnly), [], '其他实例文件不参与本实例淘汰');

console.log('check-cu-shots: 全部断言通过 ✓');
process.stdin.destroy();
