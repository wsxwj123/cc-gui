// 回归:官方 provider(settings.json 无 ANTHROPIC_BASE_URL)被宿主继承的 env 判成 DeepSeek。
// 用真的 getAvailableModels/getDefaultModel 跑,先证明污染确实成立(变异探针),再证明
// stripInheritedProviderEnv() 之后回到 Anthropic + 四档 CLI 别名恢复。
// node tests/unit/check-provider-env-strip.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 隔离 HOME:model-resolver 在模块加载期用 homedir() 定住 ~/.claude/settings.json 路径,
// 所以必须在 import 之前改,且只能用动态 import。
const home = mkdtempSync(join(tmpdir(), 'cgui-provider-env-'));
mkdirSync(join(home, '.claude'), { recursive: true });
// 官方 provider 的真实形态:env 里没有任何路由键。
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: {} }));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows

// 宿主(Claude Desktop / 第三方 provider 下起的 dev server)透传进来的污染
process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
process.env.ANTHROPIC_MODEL = 'deepseek-v4-flash';
process.env.ANTHROPIC_AUTH_TOKEN = 'sk-host-leak';

const { getAvailableModels, getDefaultModel } = await import('../../server/services/model-resolver.js');

// 1) 变异探针:不清理时 bug 必现。这条一旦不成立,说明测试没测到真实读点。
const dirty = await getAvailableModels();
assert.equal(dirty.provider, 'DeepSeek', '前置条件失效:宿主 env 应当污染 provider 判定');
assert.equal(dirty.models.some((m) => m.id === 'sonnet'), false, '污染时 CLI 别名行本就该消失');
assert.equal(await getDefaultModel(), 'deepseek-v4-flash', '污染时 getDefaultModel 第 4 步读到宿主模型');

// 2) boot 清理
const { stripInheritedProviderEnv, PROVIDER_ROUTING_ENV_KEYS } = await import('../../server/utils/provider-env.js');
process.env.CGUI_UNRELATED = 'keep-me';
process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
stripInheritedProviderEnv();

for (const k of PROVIDER_ROUTING_ENV_KEYS) {
  assert.equal(process.env[k], undefined, `${k} 必须被删净`);
}
// 键清单不许被裁掉这几个:它们是 model-resolver / GET /api/provider 真正读的键。
for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_MODEL', 'CLAUDE_MODEL']) {
  assert.ok(PROVIDER_ROUTING_ENV_KEYS.includes(k), `键清单缺 ${k} → 读点仍会被污染`);
}
// 非 provider 键一律不碰
assert.equal(process.env.CGUI_UNRELATED, 'keep-me');
assert.equal(process.env.HTTPS_PROXY, 'http://127.0.0.1:7897');

// 3) 清理后回到官方口径
const clean = await getAvailableModels();
assert.equal(clean.provider, 'Anthropic', '官方 settings.json → provider 必须是 Anthropic');
for (const alias of ['sonnet', 'opus', 'haiku', 'fable']) {
  assert.ok(clean.models.some((m) => m.id === alias), `CLI 别名行 ${alias} 必须恢复`);
}
assert.equal(await getDefaultModel(), 'claude-sonnet-4-6', '官方默认模型不再是宿主的 deepseek');

console.log('check-provider-env-strip: all assertions passed');
