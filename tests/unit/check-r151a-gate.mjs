#!/usr/bin/env node
// r151a T-Y4:前端三层门控的纯判据(INTERFACE Y.3.4)。
//   "是不是第三方"读审核状态的 official,没取到时按 providerHint;不可用标记的键(官方沿用旧写法,第三方 tp:<id>|<模型>);
//   第三方下运行时回退只认 CLI 的四句原文;选择器里审核模型行的文案。界面行为由验收 G / H 组覆盖。
// node tests/unit/check-r151a-gate.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isThirdPartyProvider, officialAutoKey, thirdPartyAutoKey, autoUnavailableKeyFor, THIRD_PARTY_AUTO_DESC, auditModelLineText,
} from '../../client/src/utils/autoAudit.js';
import { AUTO_UNAVAILABLE_PHRASES, matchesAutoUnavailable } from '../../server/utils/cli-strings.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── 1. 第三方判据 ──
assert.equal(isThirdPartyProvider({ official: false }, 'anthropic'), true, '状态优先:official:false 即第三方(地址含 anthropic.com 字样的中转)');
assert.equal(isThirdPartyProvider({ official: true }, 'deepseek'), false, '状态优先:official:true 即官方');
assert.equal(isThirdPartyProvider(null, 'anthropic'), false, '没状态时按 providerHint');
assert.equal(isThirdPartyProvider(null, 'deepseek'), true);
assert.equal(isThirdPartyProvider(null, 'unknown'), true);
assert.equal(isThirdPartyProvider(undefined, undefined), false, '都没有 = 官方(与改动前默认值一致)');
assert.equal(isThirdPartyProvider({ official: 'no' }, 'anthropic'), false, 'official 不是布尔 → 当没取到');

// ── 2. 不可用标记的键 ──
assert.equal(officialAutoKey('anthropic', 'claude-sonnet-4-6[1m]'), 'anthropic|claude-sonnet-4-6', '官方键与改动前写法相同');
assert.equal(officialAutoKey(undefined, ''), 'anthropic|');
assert.equal(thirdPartyAutoKey('p1', 'r151-chat[1M]'), 'tp:p1|r151-chat');
assert.equal(thirdPartyAutoKey(null, 'r151-chat'), 'tp:unknown|r151-chat', '认不出 provider → unknown');
assert.equal(autoUnavailableKeyFor({ official: false, providerId: 'p2' }, 'anthropic', 'm'), 'tp:p2|m');
assert.equal(autoUnavailableKeyFor({ official: true, providerId: 'builtin-official' }, 'anthropic', 'claude-opus-4-6'), 'anthropic|claude-opus-4-6');
assert.equal(autoUnavailableKeyFor(null, 'deepseek', 'deepseek-chat'), 'tp:unknown|deepseek-chat', '状态没取到的第三方 → unknown');

// ── 3. 选择器文案(全角标点,与验收 texts.mjs 逐字一致)──
assert.equal(THIRD_PARTY_AUTO_DESC, '由审核模型逐动作判定，通过即执行，判定有风险则拒绝。每次审核额外消耗约 3 万输入 token；审核模型判错可能放行危险操作。');
assert.equal(auditModelLineText(null), '审核模型：未知');
assert.equal(auditModelLineText({ auditModel: null, auditModelSource: null }), '审核模型：未知');
assert.equal(auditModelLineText({ auditModel: 'r151-reasoner', auditModelSource: 'tier' }), '审核模型：r151-reasoner');
assert.equal(auditModelLineText({ auditModel: 'r151-chat', auditModelSource: 'default' }), '审核模型：r151-chat（未单独设置）');

// ── 4. 四句 CLI 原文 ──
assert.equal(AUTO_UNAVAILABLE_PHRASES.length, 4);
for (const p of AUTO_UNAVAILABLE_PHRASES) {
  assert.equal(matchesAutoUnavailable(`API Error: 400 {"type":"error","error":{"message":"${p}"}}`), true, p);
  assert.equal(matchesAutoUnavailable(p[0].toUpperCase() + p.slice(1)), true, `${p}(句首大写)`);
}
for (const t of ['upstream overloaded, auto retry later', 'auto mode', 'permission denied', 'model unavailable', '', null, undefined]) {
  assert.equal(matchesAutoUnavailable(t), false, String(t));
}

// ── 5. 官方分支的两条宽正则逐字保留(运行时回退的官方判据不动)──
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
assert.ok(app.includes("(/auto/i.test(msg) && /support|avail|invalid|eligib|permission|denied|mode/i.test(msg))"), '回合报错回退:官方宽正则应原样保留');
assert.ok(app.includes("/auto|permission/i.test(String(err.message || ''))"), '启动失败回退:官方宽正则应原样保留');
assert.equal((app.match(/matchesAutoUnavailable\(/g) || []).length, 2, '两处运行时回退的第三方分支都只认四句原文');

console.log('check-r151a-gate: OK');
