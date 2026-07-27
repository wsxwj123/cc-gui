// V1 回归:点「Claude 官方」报 provider 不存在。
// 组合 = cc-switch.db 里有真官方行 + 已一次性导入(GET 不读 db,列表给的是合成 builtin-official id)。
// node tests/unit/check-provider-switch-official.mjs
import assert from 'node:assert/strict';
import { findClaudeProviderRow } from '../../server/routes/settings.js';

const OFFICIAL_ROW = { id: 'cc-off-uuid', name: 'Claude Official', category: 'official', settings_config: '{"env":{}}' };
const THIRD_ROW = { id: 'cc-ds', name: 'DeepSeek', category: 'cn_official', settings_config: '{}' };

// 1) 用户真实环境:db 有官方行(withBuiltinOfficial 因此不补合成行)+ 前端拿到的是合成 id
const rowsWithRealOfficial = [THIRD_ROW, OFFICIAL_ROW];
const hit = findClaudeProviderRow(rowsWithRealOfficial, 'builtin-official');
assert.ok(hit, 'db 有真官方行时,builtin-official 必须回落命中,不能落空穿到 custom 查找(404)');
assert.equal(hit.category, 'official', '必须走 official 分支(strip env 回 OAuth)');
assert.equal(hit.name, 'Claude Official');
assert.equal(hit.id, 'builtin-official', '必须保留请求 id 写 activeProviderId,否则列表 isCurrent 对不上');

// 2) db 无官方行:withBuiltinOfficial 已补合成行 → 直接命中,行为不变
const synthesized = { id: 'builtin-official', name: 'Claude 官方', category: 'official', settings_config: '{}' };
const hit2 = findClaudeProviderRow([THIRD_ROW, synthesized], 'builtin-official');
assert.equal(hit2, synthesized, '合成行必须原样命中(同一引用,零行为变化)');

// 3) 普通 id 精确命中,回落逻辑不介入
assert.equal(findClaudeProviderRow(rowsWithRealOfficial, 'cc-ds'), THIRD_ROW);
assert.equal(findClaudeProviderRow(rowsWithRealOfficial, 'cc-off-uuid'), OFFICIAL_ROW, '真官方 id 直查仍返回原行(不改 id)');

// 4) 不存在的 id 仍返回 undefined(必须继续穿到 openai/custom 查找,不能被回落吞掉)
assert.equal(findClaudeProviderRow(rowsWithRealOfficial, 'some-custom-id'), undefined);
// 5) db 读不到(空行)时 builtin-official 也不许凭空命中
assert.equal(findClaudeProviderRow([], 'builtin-official'), undefined);

console.log('check-provider-switch-official: all assertions passed');
