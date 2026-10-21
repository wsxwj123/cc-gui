#!/usr/bin/env node
// r151a T-Y3:审核模型(= 该 provider 的 sonnet 档)的状态组装与覆盖层改写规则(INTERFACE Y.3.1)。
//   纯函数:名字规范化、"不能当审核模型"、覆盖层条目只动 sonnet 一档、状态字段拼装;
//   computeAutoAuditStatus(隔离 HOME):providerId 识别、来源 tier/default、覆盖层 {} 压住 provider 自带档位、只读。
// HTTP 层(错误码、顺序、落盘失败、广播)由验收 B / C 组覆盖。
// node tests/unit/check-r151a-audit-status.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cgui-r151a-audit-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, '.claude'), { recursive: true });
mkdirSync(join(home, '.claude-gui'), { recursive: true });

const {
  normalizeAuditModelName, isUnusableAuditor, hasAnyTier, auditModelOverrideEntry, buildAutoAuditStatus,
} = await import('../../server/services/auto-audit.js');
const { computeAutoAuditStatus } = await import('../../server/routes/settings.js');

// ── 1. 名字规范化:去首尾空白与结尾 [1m](不区分大小写)──
for (const [input, want] of [
  ['  r151-reasoner \t', 'r151-reasoner'], ['r151-reasoner[1m]', 'r151-reasoner'], ['r151-reasoner[1M]', 'r151-reasoner'],
  ['  r151-reasoner[1m]  ', 'r151-reasoner'], ['   ', ''], ['', ''], ['a[1m]b', 'a[1m]b'], ['深度求索-对话', '深度求索-对话'],
]) assert.equal(normalizeAuditModelName(input), want, `normalize(${JSON.stringify(input)})`);

// ── 2. 不能当审核模型:转小写后等于或以 claude-sonnet-5-5 / claude-opus-5-5 开头 ──
for (const n of ['claude-sonnet-5-5', 'Claude-Opus-5-5-20261101', 'claude-sonnet-5-5[1m]', 'CLAUDE-OPUS-5-5']) assert.equal(isUnusableAuditor(n), true, n);
for (const n of ['claude-sonnet-5', 'claude-sonnet-4-6', 'r151-chat', 'x-claude-sonnet-5-5', '', null, 5]) assert.equal(isUnusableAuditor(n), false, String(n));

// ── 3. hasAnyTier ──
assert.equal(hasAnyTier(null), false);
assert.equal(hasAnyTier({}), false);
assert.equal(hasAnyTier({ sonnet: '' }), false);
assert.equal(hasAnyTier({ opus: 'x' }), true);

// ── 4. 覆盖层条目改写:只动 sonnet,其它档以"生效的档位"为底保留,其它键原样 ──
{
  // provider 自带 opus/haiku、覆盖层没有 → 复制成覆盖层的整组(否则覆盖层只有 sonnet 会把自带的冲掉)
  assert.deepEqual(auditModelOverrideEntry(undefined, { opus: 'O', haiku: 'H' }, true, 'S'), { tierModels: { haiku: 'H', opus: 'O', sonnet: 'S' } });
  // 覆盖层已有默认模型与 opus → 都保留
  const prev = { defaultModel: 'D', tierModels: { opus: 'O' }, extra: 1 };
  const out = auditModelOverrideEntry(prev, { opus: 'O' }, false, 'S');
  assert.deepEqual(out, { defaultModel: 'D', tierModels: { opus: 'O', sonnet: 'S' }, extra: 1 });
  assert.deepEqual(prev, { defaultModel: 'D', tierModels: { opus: 'O' }, extra: 1 }, '不改入参');
  // 生效档位里的旧 sonnet 被新值替换
  assert.deepEqual(auditModelOverrideEntry({ tierModels: { sonnet: 'A' } }, { sonnet: 'A' }, false, 'B'), { tierModels: { sonnet: 'B' } });
  // 清掉:还剩别的档 → 留下别的档
  assert.deepEqual(auditModelOverrideEntry({ tierModels: { sonnet: 'A', opus: 'O' } }, { sonnet: 'A', opus: 'O' }, false, ''), { tierModels: { opus: 'O' } });
  // 清掉:一档不剩、provider 自带没档位 → 删掉 tierModels 键(条目为空,调用方删整条)
  assert.deepEqual(auditModelOverrideEntry({ tierModels: { sonnet: 'A' } }, { sonnet: 'A' }, false, ''), {});
  // 清掉:一档不剩、provider 自带有 sonnet → 写 {}(全部跟随默认模型,压住自带的)
  assert.deepEqual(auditModelOverrideEntry(undefined, { sonnet: 'A' }, true, ''), { tierModels: {} });
  // 生效档位为 null(覆盖层 {} 在生效)→ 设值后只有 sonnet
  assert.deepEqual(auditModelOverrideEntry({ tierModels: {} }, null, true, 'S'), { tierModels: { sonnet: 'S' } });
}

// ── 5. 状态拼装 ──
{
  const base = { enabled: true, providerId: 'p', models: ['a', 'claude-sonnet-5-5', 'a', ''], settingsSonnet: 'a', sonnetTierSet: true };
  assert.deepEqual(buildAutoAuditStatus({ ...base, official: false }),
    { official: false, enabled: true, providerId: 'p', auditModel: 'a', auditModelSource: 'tier', auditModelUnusable: false, models: ['a', 'claude-sonnet-5-5'], unusable: ['claude-sonnet-5-5'] });
  assert.equal(buildAutoAuditStatus({ ...base, official: false, sonnetTierSet: false }).auditModelSource, 'default');
  const off = buildAutoAuditStatus({ ...base, official: true });
  assert.equal(off.auditModel, null); assert.equal(off.auditModelSource, null); assert.deepEqual(off.models, []);
  const unk = buildAutoAuditStatus({ ...base, official: false, providerId: null });
  assert.equal(unk.providerId, null); assert.deepEqual(unk.models, []); assert.equal(unk.auditModelSource, 'default');
  const none = buildAutoAuditStatus({ ...base, official: false, settingsSonnet: undefined });
  assert.equal(none.auditModel, null); assert.equal(none.auditModelSource, null);
  // r151q:auditModelUnusable 只按解析出的审核模型名判,认不出 provider(providerId null、models 为空)也照样判
  for (const [sonnet, want] of [['claude-sonnet-5-5', true], ['Claude-Opus-5-5[1m]', true], ['r151q-audit', false], ['claude-sonnet-5', false]]) {
    assert.equal(buildAutoAuditStatus({ ...base, official: false, settingsSonnet: sonnet }).auditModelUnusable, want, `auditModelUnusable:${sonnet}`);
    assert.equal(buildAutoAuditStatus({ ...base, official: false, providerId: null, settingsSonnet: sonnet }).auditModelUnusable, want, `auditModelUnusable(认不出 provider):${sonnet}`);
  }
  assert.equal(buildAutoAuditStatus({ ...base, official: true, settingsSonnet: 'claude-sonnet-5-5' }).auditModelUnusable, false, '官方端点不判');
  assert.equal(none.auditModelUnusable, false, '没有审核模型 → false');
}

// ── 6. computeAutoAuditStatus(隔离 HOME)──
const SETTINGS = join(home, '.claude', 'settings.json');
const GUI = join(home, '.claude-gui');
const write = (p, o) => writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o));
const PROXY = 'http://127.0.0.1:6999';
write(join(GUI, 'custom-providers.json'), [
  { id: 'tp1', name: 'TP1', type: 'anthropic', baseURL: 'http://127.0.0.1:6998/lane/x', apiKey: 'k', models: ['a', 'b'], defaultModel: 'a', tierModels: { sonnet: 'b' } },
  { id: 'tp2', name: 'TP2', type: 'openai', baseURL: 'http://127.0.0.1:6998/lane/y', apiKey: 'k', models: ['c', 'claude-opus-5-5'], defaultModel: 'c', tierModels: null },
  { id: 'off1', name: 'OFF', type: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: 'k', models: ['claude-sonnet-4-6'], defaultModel: 'claude-sonnet-4-6' },
]);
const setActive = (id) => (id === null ? rmSync(join(GUI, 'active-provider.json'), { force: true }) : write(join(GUI, 'active-provider.json'), { id }));
const setOverrides = (o) => write(join(GUI, 'provider-overrides.json'), o);
const thirdParty = (sonnet = 'b') => write(SETTINGS, { env: { ANTHROPIC_BASE_URL: PROXY, ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet } });

// 没有 settings.json、没有当前 provider 记录 → 官方、认不出
rmSync(SETTINGS, { force: true }); setActive(null); setOverrides({});
assert.deepEqual(await computeAutoAuditStatus(), { official: true, enabled: false, providerId: null, auditModel: null, auditModelSource: null, auditModelUnusable: false, models: [], unusable: [] });

// 第三方 + provider 自带 sonnet 档 → tier
thirdParty(); setActive('tp1');
assert.deepEqual(await computeAutoAuditStatus(), { official: false, enabled: false, providerId: 'tp1', auditModel: 'b', auditModelSource: 'tier', auditModelUnusable: false, models: ['a', 'b'], unusable: [] });
// 覆盖层 {} → 压住自带档位 → default
setOverrides({ tp1: { tierModels: {} } });
assert.equal((await computeAutoAuditStatus()).auditModelSource, 'default');
// 覆盖层只有 opus → 整体替换自带的 → sonnet 不再显式设 → default
setOverrides({ tp1: { tierModels: { opus: 'a' } } });
assert.equal((await computeAutoAuditStatus()).auditModelSource, 'default');
// 覆盖层的值全部不在 models 里 → 校验后一个不剩 → 沿用自带 → tier
setOverrides({ tp1: { tierModels: { sonnet: 'zzz' } } });
assert.equal((await computeAutoAuditStatus()).auditModelSource, 'tier');
// 覆盖层损坏 → 按没有覆盖层,仍回完整字段
write(join(GUI, 'provider-overrides.json'), '{ 损坏');
assert.equal((await computeAutoAuditStatus()).auditModelSource, 'tier');
setOverrides({});

// openai 协议 provider:unusable 按规则列出;总开关开 → enabled
write(join(GUI, 'prefs.json'), { thirdPartyAuto: true });
thirdParty('c'); setActive('tp2');
assert.deepEqual(await computeAutoAuditStatus(), { official: false, enabled: true, providerId: 'tp2', auditModel: 'c', auditModelSource: 'default', auditModelUnusable: false, models: ['c', 'claude-opus-5-5'], unusable: ['claude-opus-5-5'] });
write(join(GUI, 'prefs.json'), {});

// 官方:内置官方 id + 官方 settings → providerId 是它;官方地址的自定义 provider 同样算官方
write(SETTINGS, { env: {} }); setActive('builtin-official');
assert.deepEqual(await computeAutoAuditStatus(), { official: true, enabled: false, providerId: 'builtin-official', auditModel: null, auditModelSource: null, auditModelUnusable: false, models: [], unusable: [] });
write(SETTINGS, { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }); setActive('off1');
assert.equal((await computeAutoAuditStatus()).providerId, 'off1');

// 记录与 settings.json 对不上(记的是官方、settings 是第三方;记的是第三方、settings 是官方)→ 认不出
thirdParty(); setActive('builtin-official');
assert.equal((await computeAutoAuditStatus()).providerId, null);
write(SETTINGS, { env: {} }); setActive('tp1');
assert.equal((await computeAutoAuditStatus()).providerId, null);
// 记录指向已删的 provider → 认不出;settings 里的 sonnet 仍如实报(来源 default)
thirdParty('b'); setActive('gone');
assert.deepEqual(await computeAutoAuditStatus(), { official: false, enabled: false, providerId: null, auditModel: 'b', auditModelSource: 'default', auditModelUnusable: false, models: [], unusable: [] });
// settings.json 损坏 → 认不出,official 按读不出 = 官方(与服务端门控同判据)
write(SETTINGS, '{ "env": { 损坏'); setActive('tp1');
const broken = await computeAutoAuditStatus();
assert.equal(broken.providerId, null); assert.deepEqual(broken.models, []); assert.equal(broken.official, true);

// 只读:前后文件逐字不变
thirdParty(); setActive('tp1'); setOverrides({ tp1: { defaultModel: 'a' } });
const files = ['custom-providers.json', 'active-provider.json', 'provider-overrides.json'].map((f) => join(GUI, f)).concat(SETTINGS);
const before = files.map((f) => readFileSync(f, 'utf8'));
await computeAutoAuditStatus();
assert.deepEqual(files.map((f) => readFileSync(f, 'utf8')), before, '状态查询不改任何文件');

rmSync(home, { recursive: true, force: true });
console.log('check-r151a-audit-status: OK');
