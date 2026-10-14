#!/usr/bin/env node
// r151a T-Y5:消息流里的提示(INTERFACE Y.3.4)—— 拒绝提示行的种类判定、连续拦截上交的判定,
// 以及界面文案与验收 texts.mjs 逐字一致(全角标点)。界面行为由验收 I 组覆盖。
// node tests/unit/check-r151a-notices.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { denialKind, isAuditStreakReason } from '../../server/utils/cli-strings.js';
import { UI } from '../acceptance/r151a-auto-audit/helpers/texts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── 1. 拒绝提示行的种类 ──
assert.equal(denialKind('classifier', 'writes outside the working directory', 'Permission … denied by the auto mode classifier'), 'blocked');
assert.equal(denialKind('classifier', 'Classifier unavailable', ''), 'unavailable');
assert.equal(denialKind('classifier', 'Auto mode could not evaluate this action (timeout)', ''), 'unavailable');
assert.equal(denialKind('classifier', '其它原因', 'x is temporarily unavailable (server error), so auto mode cannot determine'), 'unavailable');
assert.equal(denialKind('classifier', 'classifier unavailable', ''), 'blocked', '原文区分大小写:只认 CLI 的原句');
assert.equal(denialKind('classifier', 'Note: Classifier unavailable', ''), 'blocked', '"等于" Classifier unavailable 才算');
assert.equal(denialKind('classifier', '', ''), 'blocked');
for (const t of ['rule', 'mode', 'asyncAgent', 'subcommandResults', '', undefined]) {
  assert.equal(denialKind(t, 'Classifier unavailable', 'temporarily unavailable'), 'other', `来源 ${t} → other`);
}

// ── 2. 连续拦截上交 ──
assert.equal(isAuditStreakReason('3 consecutive actions were blocked. Please review the transcript before continuing.'), true);
assert.equal(isAuditStreakReason('Note: 5 consecutive actions were blocked. Latest: x'), true);
assert.equal(isAuditStreakReason('This command writes outside the working directory'), false);
assert.equal(isAuditStreakReason(null), false);
assert.equal(isAuditStreakReason({ reason: 'x' }), false);

// ── 3. 文案与验收 texts.mjs 逐字一致 ──
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
const perm = readFileSync(join(root, 'client/src/components/PermissionPrompt.jsx'), 'utf8');
// blocked:「已拒绝 <工具>(自动档审核):<原因>」—— 源码里分两段(原因为空时不带冒号)
assert.equal(UI.denialBlocked('T', 'R'), '已拒绝 T（自动档审核）：R');
assert.ok(app.includes('已拒绝 {tool}（自动档审核）</span>{reason && <span className="text-ink-faint">：{reason}</span>}'), 'blocked 文案');
assert.equal(UI.denialUnavailable('T', 'R'), '未执行 T：审核模型没有给出结论（R）。这不是对该操作安全性的判定。');
assert.ok(app.includes('未执行 {tool}：审核模型没有给出结论（{reason}）。这不是对该操作安全性的判定。'), 'unavailable 文案');
assert.equal(UI.checking('T'), '正在审核 T…');
assert.ok(app.includes('`正在审核 ${auditChecking[auditChecking.length - 1].toolName}…`'), '审核进行中文案');
assert.ok(app.includes(`'${UI.CHECKING_UNKNOWN}'`), '找不到工具名时的文案');
assert.ok(perm.includes(`>${UI.STREAK}</div>`), '连续拦截说明行文案');
// 三种种类都带同一个 data-testid
assert.equal((app.match(/data-testid="denial-notice"/g) || []).length, 2, 'blocked/unavailable 与 other 两个分支都带 data-testid');

console.log('check-r151a-notices: OK');
