#!/usr/bin/env node
// r76:助手气泡头的名字跟随 provider 显示名。
// 纯逻辑部分真 import resolveAssistantName;JSX 那半用源码守卫钉死两个渲染点
// 都走同一个 AssistantName(与 check-model-row-badge.mjs 同法)。
//
// 四级优先级(注释见 utils/providerList.js):
//   ① 官方端点 + claude-* → 'Claude'
//   ② model id 唯一命中某个已配置 provider 的模型清单 → 该 provider 的 name
//   ③ 当前激活 provider 的显示名
//   ④ 'Claude'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveAssistantName, OFFICIAL_ASSISTANT_NAME, mergeProviderLists } from '../../client/src/utils/providerList.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 已配置 provider 行:一个官方(models 为空,服务端就是这么下发的)+ 三个第三方。
const PROVIDERS = mergeProviderLists({
  providers: [
    { id: 'official', name: 'Anthropic 官方', category: 'official', models: [] },
    { id: 'ds', name: '我的 DeepSeek 中转', models: ['deepseek-chat', 'deepseek-reasoner'] },
  ],
  customProviders: [
    // claude-opus-5 只有 Kimi 一家声明 → 是 ①/② 顺序的判据(见下方哨兵1)。
    { id: 'kimi', name: 'Kimi 自建', models: ['kimi-k2-turbo', 'claude-opus-5', 'claude-sonnet-4-6'], baseURL: 'https://a.example' },
    { id: 'glm', name: '智谱 GLM', models: ['glm-4.6', 'claude-sonnet-4-6'], baseURL: 'https://b.example' },
  ],
});
assert.equal(PROVIDERS.length, 4, '四行都在(名字不同不会被 mergeProviderLists 吞并)');

// ── ① 官方恒 Claude ────────────────────────────────────────────
assert.equal(resolveAssistantName({ model: 'claude-opus-5', providers: PROVIDERS, activeName: 'Anthropic', activeOfficial: true }),
  'Claude', '官方端点上的 claude-* → Claude');
assert.equal(resolveAssistantName({ model: 'claude-opus-5[1m]', providers: PROVIDERS, activeName: 'Anthropic', activeOfficial: true }),
  'Claude', '[1m] 后缀不影响判定');
assert.equal(resolveAssistantName({ model: 'CLAUDE-Sonnet-4-6', providers: PROVIDERS, activeName: 'Anthropic', activeOfficial: true }),
  'Claude', '大小写不影响;且必须压过 Kimi/GLM 清单里同名的 claude-sonnet-4-6(否则官方消息被标成第三方)');
// 哨兵1 的行为判据:某个中转 provider 的清单里【独家】写了官方模型 id 时,官方端点
// 上的这条消息仍必须是 Claude。①/② 顺序调换会在这里返回 'Kimi 自建'。
assert.equal(resolveAssistantName({ model: 'claude-opus-5', providers: PROVIDERS, activeName: 'Anthropic', activeOfficial: true }),
  'Claude', '中转清单独家声明 claude-opus-5 也不许把官方消息标成它的名字');
// 反过来:同一个 id 在第三方端点下渲染 → 就是那家中转(r76 的正题:中转常伪装成 claude-*)。
assert.equal(resolveAssistantName({ model: 'claude-opus-5', providers: PROVIDERS, activeName: 'Kimi 自建', activeOfficial: false }),
  'Kimi 自建', '第三方中转伪装成 claude-* 时显示中转的名字');
assert.equal(resolveAssistantName({ model: '', providers: PROVIDERS, activeName: 'Anthropic', activeOfficial: true }),
  'Claude', '官方端点无 model id 也是 Claude');

// ── ② 唯一命中某个 provider 的模型清单 → 该 provider 的 name ────
assert.equal(resolveAssistantName({ model: 'deepseek-chat', providers: PROVIDERS, activeName: '我的 DeepSeek 中转', activeOfficial: false }),
  '我的 DeepSeek 中转', '第三方模型 → 用户给它起的名字(不是 providerHint / 内部 id)');
assert.equal(resolveAssistantName({ model: 'glm-4.6', providers: PROVIDERS, activeName: '我的 DeepSeek 中转', activeOfficial: false }),
  '智谱 GLM', '历史消息按自己的 model id 归属,不跟着当前激活的那个走');
assert.equal(resolveAssistantName({ model: 'kimi-k2-turbo', providers: PROVIDERS, activeName: 'Anthropic', activeOfficial: true }),
  'Kimi 自建', '切回官方后,旧第三方消息仍显示它原来的 provider 名');

// ── ②的"宁可回落也不标错名":命中 ≥2 家 = 没确证 ────────────────
assert.equal(resolveAssistantName({ model: 'claude-sonnet-4-6', providers: PROVIDERS, activeName: '我的 DeepSeek 中转', activeOfficial: false }),
  '我的 DeepSeek 中转', 'Kimi 与 GLM 都声明了同一个 id → 不许二选一,落到 ③ 当前激活 provider');

// ── ③ 解析不了 → 当前激活 provider 的显示名 ─────────────────────
assert.equal(resolveAssistantName({ model: 'some-unlisted-model', providers: PROVIDERS, activeName: 'OpenRouter', activeOfficial: false }),
  'OpenRouter', '清单里查不到 → 用当前激活 provider 的名字(这条消息正在它下面渲染)');
assert.equal(resolveAssistantName({ model: 'claude-opus-5', providers: [], activeName: 'Anthropic', activeOfficial: true }),
  'Claude', 'provider 列表还没拉到时官方照样是 Claude');

// ── ④ 兜底 + 官方别名归一 ───────────────────────────────────────
assert.equal(resolveAssistantName({}), 'Claude', '什么都没有 → Claude');
assert.equal(resolveAssistantName({ model: 'x', providers: [], activeName: '', activeOfficial: false }),
  'Claude', '第三方但连名字都没有 → 回落 Claude,不留空白');
assert.equal(resolveAssistantName({ model: 'x', providers: [], activeName: 'Anthropic', activeOfficial: false }),
  'Claude', '激活名就是 Anthropic 时不制造第二种叫法');
assert.equal(resolveAssistantName({ model: 'deepseek-chat', providers: [{ name: '  ', models: ['deepseek-chat'] }], activeName: 'Foo', activeOfficial: false }),
  'Foo', 'provider 行名字是空白 → 不署空名,继续回落');
assert.equal(OFFICIAL_ASSISTANT_NAME, 'Claude', '官方名常量单处定义');

// ── 变异哨兵:改坏实现必须红 ────────────────────────────────────
// 哨兵1:若 ① 与 ② 顺序调换(先查清单再判官方),上面 'CLAUDE-Sonnet-4-6' 那条会
//        因 Kimi/GLM 双命中而落到 ③,官方消息被标成第三方名 —— 由该断言看守。
// 哨兵2:若 hits.length === 1 放宽成 hits.length >= 1,'claude-sonnet-4-6' 那条会
//        返回 'Kimi 自建'(排序后第一家)而不是当前激活名 —— 由该断言看守。
{
  const src = readFileSync(join(root, 'client/src/utils/providerList.js'), 'utf8');
  assert.match(src, /hits\.length === 1/, '唯一命中才采信(放宽成 >=1 就会在多家声明同一 id 时瞎猜)');
  const iOfficial = src.indexOf("activeOfficial && id.startsWith('claude')");
  const iHits = src.indexOf('const hits =');
  assert.ok(iOfficial > 0 && iHits > iOfficial, '官方判定必须写在清单查找之前');
}

// ── 源码守卫:两个渲染点都不许再写死 Claude ─────────────────────
for (const rel of ['client/src/components/TurnBubble.jsx', 'client/src/components/MessageBubble.jsx']) {
  const src = readFileSync(join(root, rel), 'utf8');
  assert.match(src, /<AssistantName model=\{/, `${rel} 必须用 AssistantName 渲染助手名`);
  assert.doesNotMatch(src, /font-body">Claude<\/span>/, `${rel} 不许再写死「Claude」`);
}
{
  const badge = readFileSync(join(root, 'client/src/components/ModelBadge.jsx'), 'utf8');
  assert.match(badge, /export function AssistantName/, 'AssistantName 单处定义,两个渲染点共用');
  assert.match(badge, /s\.providerRows/, '直取 store 的 providerRows(不许 `|| []` 造新引用 → React #185)');
  assert.doesNotMatch(badge, /providerRows \|\| \[\]/, 'zustand 选择器里不许造新数组引用');
  const store = readFileSync(join(root, 'client/src/stores/sessionStore.js'), 'utf8');
  assert.match(store, /providerRows: \[\]/, 'providerRows 有初值,首帧不会是 undefined');
  assert.match(store, /set\(\{ providerRows: mergeProviderLists/, 'providerRows 由 /api/providers 水合');
}

console.log("✓ check-assistant-name: 21 assertions passed");
