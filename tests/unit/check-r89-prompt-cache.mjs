#!/usr/bin/env node
// r89:第三方 provider 前缀缓存(依据 .devflow/PLAN-r89-prompt-cache.md + RESEARCH-r89-prompt-cache.md)。
//
//  A1 静态系统提示快照:切第三方写 settings.json 的 env.CLAUDE_CODE_CARVED_SLATE='1',
//     切官方移除;chat.js 按该键补 extraArgs['system-prompt-snapshot']='on'。
//  A2 第三方下 ENABLE_TOOL_SEARCH='false',切回官方还原用户原值。
//  A3 chatCompatKey 不再含项目 settings/settings.local 的 mtime(权限规则经 SDK
//     updatedPermissions 在同进程内热更新,重建是多余的冷启)。
//  A4 usage 解析(Anthropic 命名 + DeepSeek 命名兜底)与命中率公式。
//  A5 回环代理把第三方上游的 metadata.user_id 归一(去掉每会话变化的 session_id),
//     官方上游一字不动。
//
// Run: node tests/unit/check-r89-prompt-cache.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SNAPSHOT_ENV_KEY, TOOL_SEARCH_ENV_KEY,
  normalizePromptCacheMode, resolvePromptCacheOn, applyPromptCacheEnv,
} from '../../server/utils/prompt-cache-env.js';
import { normalizeUserId, normalizeUserIdInBody } from '../../server/utils/user-id-normalize.js';
import { readCacheUsage, cacheHitPct, addCacheUsage, EMPTY_CACHE_USAGE } from '../../client/src/utils/cacheStats.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const settingsSrc = readFileSync(join(root, 'server/routes/settings.js'), 'utf8');
const chatSrc = readFileSync(join(root, 'server/routes/chat.js'), 'utf8');
const proxySrc = readFileSync(join(root, 'server/services/anthropic-proxy.js'), 'utf8');
const panelSrc = readFileSync(join(root, 'client/src/components/SettingsPanel.jsx'), 'utf8');
const appSrc = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
const usagePanelSrc = readFileSync(join(root, 'client/src/components/UsagePanel.jsx'), 'utf8');

const failures = [];
const check = (name, fn) => { try { fn(); } catch (e) { failures.push(`${name}: ${e.message}`); } };

// ── A1/A2 纯函数:三态解析 ────────────────────────────────────────────────
check('A1-1 auto:第三方开、官方关', () => {
  assert.equal(resolvePromptCacheOn('auto', true), true);
  assert.equal(resolvePromptCacheOn('auto', false), false);
});
check('A1-2 显式 on/off 压过 provider 类别', () => {
  assert.equal(resolvePromptCacheOn('on', false), true);
  assert.equal(resolvePromptCacheOn('off', true), false);
});
check('A1-3 非法/缺省 mode 归一到 auto', () => {
  assert.equal(normalizePromptCacheMode(undefined), 'auto');
  assert.equal(normalizePromptCacheMode('nope'), 'auto');
  assert.equal(resolvePromptCacheOn(undefined, true), true);
});

// ── A1/A2 纯函数:env 写入 / 移除 / 还原用户原值 ───────────────────────────
check('A2-1 切第三方:写两个键,并把用户原值记进备忘', () => {
  const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789', [TOOL_SEARCH_ENV_KEY]: 'true' };
  const memo = applyPromptCacheEnv(env, true, null);
  assert.equal(env[SNAPSHOT_ENV_KEY], '1');
  assert.equal(env[TOOL_SEARCH_ENV_KEY], 'false');
  assert.deepEqual(memo, { toolSearch: 'true' });
});
check('A2-2 切回官方:移除快照键 + 还原用户原值 + 清空备忘', () => {
  const env = { [SNAPSHOT_ENV_KEY]: '1', [TOOL_SEARCH_ENV_KEY]: 'false' };
  const memo = applyPromptCacheEnv(env, false, { toolSearch: 'true' });
  assert.equal(SNAPSHOT_ENV_KEY in env, false);
  assert.equal(env[TOOL_SEARCH_ENV_KEY], 'true');
  assert.equal(memo, null);
});
check('A2-3 用户原本没设过 ENABLE_TOOL_SEARCH:切回官方要把键删掉,不留 false', () => {
  const env = { ANTHROPIC_BASE_URL: 'x' };
  const memo = applyPromptCacheEnv(env, true, null);
  assert.deepEqual(memo, { toolSearch: null });
  assert.equal(env[TOOL_SEARCH_ENV_KEY], 'false');
  applyPromptCacheEnv(env, false, memo);
  assert.equal(TOOL_SEARCH_ENV_KEY in env, false);
});
check('A2-4 连续两次切第三方不能把自己写的 false 当成用户原值', () => {
  const env = { [TOOL_SEARCH_ENV_KEY]: 'true' };
  const m1 = applyPromptCacheEnv(env, true, null);
  const m2 = applyPromptCacheEnv(env, true, m1);
  assert.deepEqual(m2, { toolSearch: 'true' });
});
check('A2-5 用户在第三方下手动改回 true:切回官方不拿备忘覆盖', () => {
  const env = { [SNAPSHOT_ENV_KEY]: '1', [TOOL_SEARCH_ENV_KEY]: 'true' };
  applyPromptCacheEnv(env, false, { toolSearch: null });
  assert.equal(env[TOOL_SEARCH_ENV_KEY], 'true');
});
check('A2-6 关闭时无备忘:只删快照键,不动 ENABLE_TOOL_SEARCH', () => {
  const env = { [SNAPSHOT_ENV_KEY]: '1', [TOOL_SEARCH_ENV_KEY]: 'false' };
  applyPromptCacheEnv(env, false, null);
  assert.equal(SNAPSHOT_ENV_KEY in env, false);
  assert.equal(env[TOOL_SEARCH_ENV_KEY], 'false');
});

// ── A1/A2 接线:每条 provider 切换路径都调到 ──────────────────────────────
check('A1-4 五条 provider 切换路径全部调用 applyProviderPromptCache', () => {
  const n = (settingsSrc.match(/await applyProviderPromptCache\(/g) || []).length;
  assert.ok(n >= 5, `只找到 ${n} 处调用(openai/anthropic/官方/原生 claude/自定义官方直连 各一)`);
  assert.ok(/applyProviderPromptCache\(env, true\)/.test(settingsSrc), '第三方路径缺 true');
  assert.ok(/applyProviderPromptCache\(env, false\)/.test(settingsSrc), '官方路径缺 false');
});
check('A1-5 GET/PUT /prompt-cache 端点存在且校验 mode', () => {
  assert.ok(/router\.get\('\/prompt-cache'/.test(settingsSrc));
  assert.ok(/router\.put\('\/prompt-cache'/.test(settingsSrc));
  assert.ok(/PROMPT_CACHE_MODES\.includes\(mode\)/.test(settingsSrc), 'PUT 未校验 mode 白名单');
});
check('A1-6 chat.js:按 CARVED_SLATE 补 extraArgs system-prompt-snapshot,且不覆盖 acw 的 settings', () => {
  assert.ok(/CLAUDE_CODE_CARVED_SLATE === '1'/.test(chatSrc), '缺 resolveSnapshotOn 判据');
  assert.ok(/resolveSnapshotOn\(\)\) options\.extraArgs = \{ \.\.\.\(options\.extraArgs \|\| \{\}\), 'system-prompt-snapshot': 'on' \}/.test(chatSrc),
    'extraArgs 未按展开合并写入');
  // acw 那块也必须是展开合并(否则两者互相顶掉)
  assert.ok(/options\.extraArgs = \{ \.\.\.\(options\.extraArgs \|\| \{\}\), settings: acwTmpFile \}/.test(chatSrc));
});
check('A1-7 设置面板有开关 + 搜索索引条目', () => {
  assert.ok(/PromptCacheSnapshotToggle/.test(panelSrc));
  assert.ok(/id: 'set-prompt-snapshot'/.test(panelSrc));
  assert.ok(/静态系统提示快照/.test(panelSrc));
  // 面板须写清 ToolSearch 的代价
  assert.ok(/ENABLE_TOOL_SEARCH=false/.test(panelSrc) && /前置加载/.test(panelSrc), '未写清关 ToolSearch 的代价');
  assert.ok(/settings\.json/.test(panelSrc) && /bot/.test(panelSrc), '未告知 settings.json 与终端/bot 共用');
});

// ── A3 前提实测不成立 → 保留 mtime(见 .devflow/test-red-r89.txt 的 A3 段)────
// 实测(perm-drive.mjs,常驻进程三回合):
//  ① 规则确实在同进程内热生效 —— canUseTool 只被调用 1 次,第 2/3 回合不再弹卡;
//  ② 但「始终允许」写的是 ~/.claude/settings.json(userSettings),不是项目
//     settings.local.json —— permission-rules.js 把 CLI 给的 localSettings 建议
//     改写成了 userSettings。故去掉 projSettingsMtime 并不能让下一轮复用进程,
//     真正触发冷启的是 chatCompatKey 的 settingsMtime。前提不成立 → 保留,不硬去。
// 本用例把这两条钉死,防止后续有人凭 PLAN 的旧假设把 mtime 摘掉。
check('A3-1 项目 settings mtime 仍计入 chatCompatKey(前提不成立,保留)', () => {
  const key = chatSrc.slice(chatSrc.indexOf('export function chatCompatKey'), chatSrc.indexOf('export function closePersistentForSession'));
  assert.ok(/projSettingsMtime/.test(key), 'projSettingsMtime 被移除了,但 A3 前提实测不成立');
  assert.ok(/settingsMtime/.test(key), 'settingsMtime 被移除了');
});
check('A3-2 「始终允许」的落点是 userSettings(实测事实,决定 A3 结论)', () => {
  const rules = readFileSync(join(root, 'server/utils/permission-rules.js'), 'utf8');
  assert.ok(/destination: 'userSettings'/.test(rules), 'buildAlwaysAllowUpdates 不再写 userSettings,A3 结论需重测');
});

// ── A4 usage 解析与命中率 ────────────────────────────────────────────────
check('A4-1 Anthropic 命名', () => {
  const u = readCacheUsage({ input_tokens: 72, cache_creation_input_tokens: 0, cache_read_input_tokens: 512, output_tokens: 9 });
  assert.deepEqual({ read: u.read, creation: u.creation, input: u.input }, { read: 512, creation: 0, input: 72 });
  assert.equal(Math.round(u.hitPct * 10) / 10, 87.7);
});
check('A4-2 DeepSeek 命名兜底', () => {
  const u = readCacheUsage({ prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 });
  assert.deepEqual({ read: u.read, creation: u.creation, input: u.input }, { read: 900, creation: 0, input: 100 });
  assert.equal(u.hitPct, 90);
});
check('A4-3 Anthropic 命名优先于 DeepSeek 命名(两者同时存在)', () => {
  const u = readCacheUsage({ input_tokens: 10, cache_read_input_tokens: 90, prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 1 });
  assert.equal(u.read, 90);
  assert.equal(u.input, 10);
});
check('A4-4 边界:全 0 / 缺失 / 非对象 → 0%,不产生 NaN', () => {
  for (const v of [null, undefined, 0, 'x', {}, { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]) {
    const u = readCacheUsage(v);
    assert.equal(u.hitPct, 0, `hitPct 应为 0,实际 ${u.hitPct}(输入 ${JSON.stringify(v)})`);
    assert.equal(Number.isFinite(u.hitPct), true);
    assert.equal(u.miss, 0);
  }
});
check('A4-5 边界:只有 read(纯命中)= 100%', () => {
  assert.equal(readCacheUsage({ cache_read_input_tokens: 1000 }).hitPct, 100);
});
check('A4-6 边界:只有 creation(首轮写入)= 0% 命中,miss = creation', () => {
  const u = readCacheUsage({ cache_creation_input_tokens: 4000 });
  assert.equal(u.hitPct, 0);
  assert.equal(u.miss, 4000);
});
check('A4-7 命中率公式 = read/(read+creation+input);miss = creation+input', () => {
  assert.equal(cacheHitPct(0, 0, 0), 0);
  assert.equal(cacheHitPct(75, 20, 5), 75);
  const u = readCacheUsage({ input_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 75 });
  assert.equal(u.miss, 25);
});
check('A4-8 累加器:多轮求和口径一致', () => {
  let acc = { ...EMPTY_CACHE_USAGE };
  acc = addCacheUsage(acc, { input_tokens: 100, cache_read_input_tokens: 0 });
  acc = addCacheUsage(acc, { input_tokens: 10, cache_read_input_tokens: 890 });
  assert.deepEqual({ read: acc.read, creation: acc.creation, input: acc.input }, { read: 890, creation: 0, input: 110 });
  assert.equal(acc.hitPct, 89);
  assert.equal(acc.miss, 110);
});
check('A4-9 徽章弹层显示本轮命中率;用量面板显示累计命中率与未命中 token', () => {
  assert.ok(/turnCacheHitPct|本轮缓存命中率/.test(appSrc), 'App.jsx 未接入本轮命中率');
  assert.ok(/cacheStats/.test(appSrc), 'App.jsx 未使用共享的 usage 解析纯函数');
  assert.ok(/缓存命中率/.test(usagePanelSrc) && /未命中/.test(usagePanelSrc), '用量面板缺累计命中率/未命中 token');
});

// ── A5 metadata.user_id 归一 ──────────────────────────────────────────────
check('A5-1 合法 JSON:清空 session_id,保留 device_id/account_uuid', () => {
  const raw = JSON.stringify({ device_id: 'dev-1', account_uuid: '', session_id: 'abc-123' });
  const out = normalizeUserId(raw);
  const o = JSON.parse(out);
  assert.equal(o.session_id, '');
  assert.equal(o.device_id, 'dev-1');
  assert.equal(o.account_uuid, '');
});
check('A5-2 两个不同 session_id 归一后完全相同(= 同一个 KVCache 桶)', () => {
  const a = normalizeUserId(JSON.stringify({ device_id: 'd', account_uuid: '', session_id: 's1' }));
  const b = normalizeUserId(JSON.stringify({ device_id: 'd', account_uuid: '', session_id: 's2' }));
  assert.equal(a, b);
});
check('A5-3 非 JSON / 空 / 非对象 / 无 session_id → null(原样透传)', () => {
  for (const v of ['not-json', '', null, undefined, '123', '"str"', '[1,2]', JSON.stringify({ device_id: 'd' })]) {
    assert.equal(normalizeUserId(v), null, `输入 ${JSON.stringify(v)} 应返回 null`);
  }
});
check('A5-4 归一保留其它未知字段(不丢信息)', () => {
  const o = JSON.parse(normalizeUserId(JSON.stringify({ device_id: 'd', session_id: 's', extra: 7 })));
  assert.equal(o.extra, 7);
});
check('A5-5 body 改写:第三方上游改,官方上游一字不动', () => {
  const body = Buffer.from(JSON.stringify({
    model: 'deepseek-chat',
    metadata: { user_id: JSON.stringify({ device_id: 'd', account_uuid: '', session_id: 'S' }) },
    messages: [],
  }));
  const third = normalizeUserIdInBody(body, 'https://api.deepseek.com/anthropic');
  assert.notEqual(third, body);
  assert.equal(JSON.parse(JSON.parse(third.toString('utf8')).metadata.user_id).session_id, '');
  const official = normalizeUserIdInBody(body, 'https://api.anthropic.com');
  assert.equal(official, body, '官方上游必须原样返回同一个 Buffer');
});
check('A5-6 body 无 metadata / 非法 JSON → 原样返回同一个 Buffer', () => {
  const b1 = Buffer.from(JSON.stringify({ model: 'm', messages: [] }));
  assert.equal(normalizeUserIdInBody(b1, 'https://x.example'), b1);
  const b2 = Buffer.from('not json');
  assert.equal(normalizeUserIdInBody(b2, 'https://x.example'), b2);
  const b3 = Buffer.from(JSON.stringify({ metadata: { user_id: 'plain-string' } }));
  assert.equal(normalizeUserIdInBody(b3, 'https://x.example'), b3);
});
check('A5-7 代理只在 /v1/messages POST 上改写,且调用点在转发之前', () => {
  assert.ok(/normalizeUserIdInBody\(body, up\.baseURL\)/.test(proxySrc), '代理未调用 body 改写');
  const call = proxySrc.indexOf('normalizeUserIdInBody(body, up.baseURL)');
  const fwd = proxySrc.indexOf('upstreamResp = await fetch(url');
  assert.ok(call > 0 && call < fwd, '改写必须发生在 fetch 转发之前');
});

if (failures.length) {
  console.error('FAIL:\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('check-r89-prompt-cache: OK');
