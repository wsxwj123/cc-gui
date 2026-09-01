#!/usr/bin/env node
// 1M 开关三件事的自检(r6 修复批 A3):
//  ② 选择器侧模型解析必须与徽章/发送同口径(pin → 历史 → 全局 + context1m)——
//     旧的 `pin || global` 让无 pin 的老会话点 1M 开关时静默把会话 pin 成【全局默认】[1m];
//  ④ 手机页(MobileModelPage)与桌面共用同一条链,不再漏叠 context1m 标记;
//  ① 开关说明必须写清 4.6 一代原生 200K、4.7 起原生 1M、改动下一条消息才生效。
// 纯函数部分真 import;JSX 部分用源码守卫(与 check-model-row-badge.mjs 同法)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveSelectorModel } from '../../client/src/utils/routing.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sel = readFileSync(join(root, 'client/src/components/SessionSelectors.jsx'), 'utf8');
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');

// ── ② 解析链:pin → 历史(会话元数据)→ 全局 ────────────────────
const base = {
  modelBySession: {}, context1mBySession: {}, paneSessions: [], selectedSession: null,
  currentModel: 'claude-sonnet-4-6', providerEpoch: 0,
};
const S = (over) => ({ ...base, ...over });

assert.equal(resolveSelectorModel(S({ modelBySession: { s1: 'claude-opus-4-8' } }), 's1'),
  'claude-opus-4-8', 'pin 最优先');
assert.equal(resolveSelectorModel(S({ selectedSession: { sessionId: 's1', model: 'claude-opus-4-6' } }), 's1'),
  'claude-opus-4-6', '无 pin 时用会话历史模型,不是全局默认(点 1M 开关不许静默换模型)');
assert.equal(resolveSelectorModel(S({ paneSessions: [null, { sessionId: 's2', model: 'claude-opus-4-6' }] }), 's2'),
  'claude-opus-4-6', '分屏窗格的会话同样按 permKey 命中');
assert.equal(resolveSelectorModel(S({ selectedSession: { sessionId: 'other', model: 'claude-opus-4-6' } }), 's1'),
  'claude-sonnet-4-6', 'permKey 不匹配的会话元数据不许串进来');
assert.equal(resolveSelectorModel(S({}), null), 'claude-sonnet-4-6', '无 permKey(未选会话)回落全局');
assert.equal(resolveSelectorModel(S({
  modelBySession: { s1: 'claude-opus-4-8' },
  selectedSession: { sessionId: 's1', model: 'claude-opus-4-6' },
}), 's1'), 'claude-opus-4-8', 'pin 压过历史');

// providerEpoch 门控(U1/U4 同族):切过 provider 后不信任无时间戳的会话元数据。
// r80(B1):官方 Anthropic 下 epoch 门控已取消(它会把官方下合法的 claude 模型也永久
// 判死),这里的"旧 provider 模型不许再显示"改由白名单(availableModels)承担 —— 断言
// 的意图不变,只是换了执行它的那道防线。
assert.equal(resolveSelectorModel(S({
  providerEpoch: 1_700_000_000_000,
  availableModels: [{ id: 'claude-sonnet-4-6' }, { id: 'claude-opus-4-8' }],
  selectedSession: { sessionId: 's1', model: 'mimo-v2.5-pro' },
}), 's1'), 'claude-sonnet-4-6', '切过 provider 后旧 provider 的历史模型不许再显示/被 pin');
// 非官方 provider 下 epoch 门控本身仍在(白名单未加载时的兜底防线)
assert.equal(resolveSelectorModel(S({
  providerEpoch: 1_700_000_000_000,
  currentProvider: { providerHint: 'deepseek' },
  selectedSession: { sessionId: 's1', model: 'mimo-v2.5-pro' },
}), 's1'), 'claude-sonnet-4-6', '非官方 provider 下 epoch 门控原样保留');

// ── ④ context1m 标记叠加(桌面/手机同一处,手机原先漏了)────────
assert.equal(resolveSelectorModel(S({ context1mBySession: { s1: true } }), 's1'),
  'claude-sonnet-4-6[1m]', '重装丢 pin 后仍认得出该会话开着 1M(否则开关显示反向)');
assert.equal(resolveSelectorModel(S({
  modelBySession: { s1: 'claude-opus-4-6[1m]' }, context1mBySession: { s1: true },
}), 's1'), 'claude-opus-4-6[1m]', '已带 [1m] 不重复追加');
assert.equal(resolveSelectorModel(S({
  modelBySession: { s1: 'claude-opus-4-6' }, context1mBySession: { s1: true },
}), 's1'), 'claude-opus-4-6[1m]', 'pin 裸 id + 标记在 → 补回后缀(与徽章 App.jsx:3905 一致)');
assert.equal(resolveSelectorModel(null, 's1'), '', '状态缺失不炸');

// ── 两个渲染点都用同一条链,不许再写 `pin || global` ─────────────
for (const [name, src] of [['SessionSelectors.jsx', sel], ['App.jsx(MobileModelPage)', app]]) {
  assert.ok(src.includes('resolveSelectorModel(s, permKey)'),
    `${name}:模型下拉/1M 开关的 currentModel 必须走 resolveSelectorModel`);
  assert.ok(!/\(permKey && s\.modelBySession\[permKey\]\) \|\| s\.currentModel/.test(src),
    `${name}:不许残留 pin||global 的旧解析(无 pin 会话点 1M 开关会静默换模型)`);
  // 开关状态只认解析结果里的后缀:context1m 已在解析链里叠好,再 OR 一次 = 两套口径
  assert.ok(/const has1m = \/\\\[1m\\\]\/i\.test\(currentModel \|\| ''\);/.test(src),
    `${name}:has1m 必须只读 currentModel 的 [1m] 后缀`);
}

// ── ① 文案:说清 4.6 一代 200K / 4.7 起原生 1M / 下一条消息生效 ──
for (const [name, src] of [['SessionSelectors.jsx', sel], ['App.jsx(MobileModelPage)', app]]) {
  const i = src.indexOf('>1M 上下文</div>');   // 标签本体,别命中上方注释里的"1M 上下文"字样
  assert.ok(i > 0, `${name}:找不到 1M 开关`);
  const copy = src.slice(i, i + 900);
  assert.ok(copy.includes('sonnet-4.6') && copy.includes('200K'),
    `${name}:必须写明 4.6 一代原生窗口是 200K(用户会按旧认知以为它本来就是 1M)`);
  assert.ok(copy.includes('opus-4.7'),
    `${name}:必须写明 4.7 起原生 1M(开启无额外效果)`);
  assert.ok(copy.includes('下一条消息'),
    `${name}:必须写明改动在下一条消息生效(常驻进程本回合不换窗口)`);
  assert.ok(!/需 provider 支持/.test(copy), `${name}:旧的含糊说法必须删掉`);
}
// 原生 1M 模型上不禁用开关,只在 title 说明(headless 实测 sonnet-5 带不带 [1m] 都报 1e6,
// 且不报错 → 禁用属于凭空加限制)
for (const [name, src] of [['SessionSelectors.jsx', sel], ['App.jsx(MobileModelPage)', app]]) {
  assert.ok(src.includes("title={native1m ? '该模型原生 1M，开启无额外效果' : undefined}"),
    `${name}:原生 1M 模型必须给 title 说明`);
}

console.log('check-1m-toggle: all assertions passed');
