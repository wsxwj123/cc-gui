// 修正批#6 + 审计批挂账收紧:mergeProviderLists 自检 —— 官方置顶 / 名称序 /
// 同名【且同 baseURL】才吞并(自定义优先,官方永不被吞) / dupOf 标注(含 isCurrent) /
// hidden 合并前过滤 / rowIsCurrent 兼配 dupOf。node tests/unit/check-provider-merge.mjs
import assert from 'node:assert/strict';
import { mergeProviderLists, rowIsCurrent } from '../../client/src/utils/providerList.js';

const providers = [
  { id: 'cc1', name: 'DeepSeek', category: 'cn_official' }, // cc-switch 组不暴露 baseURL
  { id: 'off', name: 'Claude Official', category: 'official' },
  { id: 'cc2', name: 'OpenRouter', category: 'aggregator' },
];
const openaiProviders = [{ id: 'ox1', name: 'codex local', models: [] }];
const customProviders = [
  // 与 cc1 同名(忽略大小写)但 cc1 无 baseURL → 收紧后【不吞并】(异后端可能不可切,根治)
  { id: 'cu1', name: 'deepseek', type: 'anthropic', baseURL: 'https://api.deepseek.com', models: [] },
  { id: 'cu2', name: 'qwen', type: 'anthropic', models: [] },
];

const rows = mergeProviderLists({ providers, openaiProviders, customProviders });

// 1) 官方恒第一
assert.equal(rows[0].id, 'off');
assert.equal(rows[0].source, 'official');
// 2) 收紧:同名但 baseURL 未知(cc-switch 不暴露)→ 不吞并,cc1 仍在列表可切
assert.ok(rows.some((r) => r.id === 'cc1'), '同名但后端未知的导入项不许被吞(否则无法切换)');
assert.ok(!rows.find((r) => r.id === 'cu1')?.dupOf, '未吞并时不应有 dupOf/「含导入」徽章');
// 3) 总数 = 6 输入,零合并
assert.equal(rows.length, 6);
// 4) 官方之外按名称升序
const names = rows.slice(1).map((r) => String(r.name));
const sorted = [...names].sort((a, b) => a.localeCompare(b, 'zh'));
assert.deepEqual(names, sorted);
// 5) 自定义与官方同名 → 官方仍单独成行
const rows2 = mergeProviderLists({
  providers: [{ id: 'off', name: 'Claude Official', category: 'official' }],
  customProviders: [{ id: 'cux', name: 'claude official', type: 'anthropic', baseURL: 'https://x' }],
});
assert.ok(rows2.some((r) => r.id === 'off'), '官方项不许被同名自定义吞掉');
// 6) 同名【且同 baseURL】(尾斜杠/大小写归一)→ 吞并,自定义留下,dupOf 记 isCurrent
const rows3 = mergeProviderLists({
  openaiProviders: [{ id: 'oa1', name: 'Relay', baseURL: 'https://Relay.example.com/', isCurrent: true }],
  customProviders: [{ id: 'cu3', name: 'relay', type: 'anthropic', baseURL: 'https://relay.example.com' }],
});
assert.equal(rows3.length, 1);
assert.equal(rows3[0].id, 'cu3');
assert.deepEqual(rows3[0].dupOf, [{ id: 'oa1', source: 'openai', isCurrent: true }]);
// 6b) 同名异 baseURL → 不吞并
const rows4 = mergeProviderLists({
  customProviders: [
    { id: 'a', name: 'Same', baseURL: 'https://a.example.com' },
    { id: 'b', name: 'same', baseURL: 'https://b.example.com' },
  ],
});
assert.equal(rows4.length, 2, '同名异后端必须各自成行');
// 7) hidden 合并前过滤:被隐藏的同后端导入项既不显示、也不进 dupOf(无「含导入」)
const rows5 = mergeProviderLists({
  openaiProviders: [{ id: 'oa1', name: 'Relay', baseURL: 'https://relay.example.com' }],
  customProviders: [{ id: 'cu3', name: 'relay', type: 'anthropic', baseURL: 'https://relay.example.com' }],
  hidden: new Set(['oa1']),
});
assert.equal(rows5.length, 1);
assert.ok(!rows5[0].dupOf, '隐藏的导入项不许再挂「含导入」');
// 8) rowIsCurrent 兼配 dupOf:激活 id 是被吞并的导入项时保留行仍算当前
assert.equal(rowIsCurrent(rows3[0], 'oa1'), true);
assert.equal(rowIsCurrent(rows3[0], 'zzz'), false);
// activeId 缺省时回退 isCurrent(含 dupOf 的 isCurrent)
assert.equal(rowIsCurrent(rows3[0], null), true);

console.log('check-provider-merge: all assertions passed');
