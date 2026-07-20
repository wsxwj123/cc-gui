// 修正批#6:mergeProviderLists 自检 —— 官方置顶 / 名称序 / 同名去重(自定义优先,
// 官方永不被吞) / dupOf 标注。node tests/unit/check-provider-merge.mjs
import assert from 'node:assert/strict';
import { mergeProviderLists } from '../../client/src/utils/providerList.js';

const providers = [
  { id: 'cc1', name: 'DeepSeek', category: 'cn_official' },
  { id: 'off', name: 'Claude Official', category: 'official' },
  { id: 'cc2', name: 'OpenRouter', category: 'aggregator' },
];
const openaiProviders = [{ id: 'ox1', name: 'codex local', models: [] }];
const customProviders = [
  { id: 'cu1', name: 'deepseek', type: 'anthropic', models: [] }, // 与 cc1 同名(忽略大小写)→ 合并,自定义留下
  { id: 'cu2', name: 'qwen', type: 'anthropic', models: [] },
];

const rows = mergeProviderLists({ providers, openaiProviders, customProviders });

// 1) 官方恒第一
assert.equal(rows[0].id, 'off');
assert.equal(rows[0].source, 'official');
// 2) 同名去重:cc1 被并进 cu1,列表里无 cc1
assert.ok(!rows.some((r) => r.id === 'cc1'), 'cc-switch 同名项应被合并');
const kept = rows.find((r) => r.id === 'cu1');
assert.equal(kept.source, 'custom');
assert.deepEqual(kept.dupOf, [{ id: 'cc1', source: 'ccswitch' }]);
// 3) 总数 = 6 输入 - 1 合并
assert.equal(rows.length, 5);
// 4) 官方之外按名称升序
const names = rows.slice(1).map((r) => String(r.name));
const sorted = [...names].sort((a, b) => a.localeCompare(b, 'zh'));
assert.deepEqual(names, sorted);
// 5) 自定义与官方同名 → 官方仍单独成行
const rows2 = mergeProviderLists({
  providers: [{ id: 'off', name: 'Claude Official', category: 'official' }],
  customProviders: [{ id: 'cux', name: 'claude official', type: 'anthropic' }],
});
assert.ok(rows2.some((r) => r.id === 'off'), '官方项不许被同名自定义吞掉');

console.log('check-provider-merge: all assertions passed');
