#!/usr/bin/env node
// r49b②③(B2)守卫:CLI init 自报的【生效档位】与 GUI 请求档不一致时当场现形。
//
// 背景(audit-sdk,CLI 2.1.240 已核):init(SDKSystemMessage)带 CLI 自报的 permissionMode;
// 而 guardPermissionModeChange 会拒掉一部分请求档(auto 受模型门控等)。此前 GUI 只管发,
// 从不看 CLI 回报什么 —— 请求 auto 实得 default 时界面照旧显示「自动」,零提示。
//
// 判定必须是纯函数(六档 × init 三值矩阵可单测),因为 GUI 六档→SDK 三值本身就有合法的
// 多对一:default/acceptEdits/dontAsk/bypassPermissions 都映射 'default'(放行/弹窗由
// canUseTool 按 guiMode 自己裁决),init 报 'default' 属【正常】,报警会天天误报。
// 只有「请求 auto 得到非 auto」「请求 plan 得到非 plan」两类是真的没生效。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { permissionModeMismatch } from '../../server/routes/chat.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const chatSrc = readFileSync(join(ROOT, 'server', 'routes', 'chat.js'), 'utf8');
const appSrc = readFileSync(join(ROOT, 'client', 'src', 'App.jsx'), 'utf8');

// ── 六档 × init 三值全矩阵(true = 应当报 mismatch)────────────────────────────
const MATRIX = {
  //                 init:default  init:plan  init:auto
  default:           [false,       false,     false],
  acceptEdits:       [false,       false,     false],
  dontAsk:           [false,       false,     false],
  bypassPermissions: [false,       false,     false],
  plan:              [true,        false,     true],
  auto:              [true,        true,      false],
};
const INITS = ['default', 'plan', 'auto'];
for (const [gui, expected] of Object.entries(MATRIX)) {
  INITS.forEach((eff, i) => {
    const got = permissionModeMismatch(gui, eff);
    if (expected[i]) {
      assert.deepEqual(got, { requested: gui, effective: eff },
        `GUI「${gui}」+ init「${eff}」应判为未生效,并原样带出两侧档位`);
    } else {
      assert.equal(got, null, `GUI「${gui}」+ init「${eff}」是合法映射,不得报警(误报=天天弹)`);
    }
  });
}

// ── 边界:init 没带档位 / 带了未知值 ──────────────────────────────────────────
for (const bad of [undefined, null, '', 0, {}, []]) {
  assert.equal(permissionModeMismatch('auto', bad), null,
    'init 没给出生效档位时不得凭空判定(旧版 CLI 不带该字段,报警=纯噪音)');
}
assert.deepEqual(permissionModeMismatch('auto', 'acceptEdits'), { requested: 'auto', effective: 'acceptEdits' },
  '未知/意外的生效值同样算 auto 没生效(对账是唯一真相源,不维护白名单)');
assert.equal(permissionModeMismatch('', 'default'), null, '没有请求档时不判定');

// ── 服务端:init 解析处必须存生效档并发一条系统行 ─────────────────────────────
const count = (re) => (chatSrc.match(re) || []).length;
assert.equal(count(/slot\.effectiveMode = m\.permissionMode/g), 1, 'init 的生效档位要落到 slot,恰好一处');
assert.equal(count(/subtype: 'mode_mismatch'/g), 1, '不一致时经既有系统行通道发一条 mode_mismatch,恰好一处');
assert.ok(/permissionModeMismatch\(slot\.guiMode, m\.permissionMode\)/.test(chatSrc),
  '比对的是 slot 的 GUI 请求档与 init 回报值(别拿 sdkMode 比,那是映射后的值,永远相等)');

// ── 客户端:提示行 + 一键改用 ────────────────────────────────────────────────
assert.equal((appSrc.match(/subtype === 'mode_mismatch'/g) || []).length, 1,
  '客户端要接这条系统行,恰好一处');
assert.ok(/权限档位未生效/.test(appSrc), '提示文案客观陈述:权限档位未生效 + 请求/实际');
assert.ok(/改用 ?\{/.test(appSrc), '要给一键「改用 <实际档>」按钮(点击走既有 setPermissionMode 流)');
assert.ok(/setPermissionMode\(notice\.effective, permKey\)/.test(appSrc),
  '「改用」按钮必须把档位切成 CLI 实际生效的那一档');
assert.equal((appSrc.match(/<ModeMismatchNotice notice=\{msg\} permKey=\{sessionQueueKey\} \/>/g) || []).length, 1,
  '提示行要真的接进实时消息流的渲染分支(组件写了却没挂 = 用户永远看不到),恰好一处');
assert.ok(/当前模型可能不支持自动档/.test(appSrc), '③请求 auto 时追加模型门控提示');
assert.ok(/requested === 'auto'/.test(appSrc), '③该追加句只在请求 auto 时出现');
// 提示行只活在本地(CLI 不把它写进 jsonl):回合落盘对账时必须与 btw/denial 一样被保留,
// 否则它在回合结束那刻凭空消失。
assert.equal((appSrc.match(/m\.type === 'btw' \|\| m\.type === 'denial' \|\| m\.type === 'mode-mismatch'/g) || []).length, 3,
  '三处本地态过滤(两处 reconcile + 一处回合末清理)都要保留 mode-mismatch 行');

console.log('✓ check-mode-mismatch: 六档×init 矩阵 / 边界 / 服务端对账 / 客户端提示与一键改用 全部通过');
