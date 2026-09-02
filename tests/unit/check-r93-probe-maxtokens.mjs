// r93:provider「测试连接」探针的 max_tokens 不能是 1/2 —— 部分中转站(apimart 等)校验必须 >2,
// 否则 invalid_request 被误报为"连接失败"(用户实报)。锁:常量 ≥3 且两条探针分支都用它。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'server/routes/settings.js'), 'utf8');
const m = src.match(/const PROBE_MAX_TOKENS = (\d+);/);
assert.ok(m, '探针 max_tokens 必须是具名常量 PROBE_MAX_TOKENS');
assert.ok(Number(m[1]) >= 3 && Number(m[1]) <= 64, `PROBE_MAX_TOKENS 应在 3..64(实际 ${m[1]})`);
const uses = src.match(/max_tokens: PROBE_MAX_TOKENS, messages: \[\{ role: 'user', content: 'ping' \}\]/g) || [];
assert.equal(uses.length, 2, 'openai 与 anthropic 两条探针分支都必须用该常量');
assert.ok(!/max_tokens: [12]\b/.test(src.split('PROBE_MAX_TOKENS')[0] + src.split('PROBE_MAX_TOKENS').slice(1).join('')), '探针路径不许再出现字面 max_tokens: 1/2');
console.log('check-r93-probe-maxtokens: all passed');
