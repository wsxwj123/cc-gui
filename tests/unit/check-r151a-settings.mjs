#!/usr/bin/env node
// r151a T-Y6:设置页「权限」分区的第三方自动档设置块(INTERFACE Y.3.4 设置页)—— 文案与验收 texts.mjs 逐字一致(全角标点)、
// 搜索索引登记、可测标识齐全。界面行为由验收 S 组覆盖。
// node tests/unit/check-r151a-settings.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { UI } from '../acceptance/r151a-auto-audit/helpers/texts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'client/src/components/SettingsPanel.jsx'), 'utf8');

assert.ok(src.includes(`{ id: 'set-third-party-auto', tab: 'permissions', title: '${UI.SEARCH_TITLE}',`), '搜索索引登记(权限分区)');
assert.ok(src.includes('<div id="set-third-party-auto"'), '设置块容器 id');
for (const line of UI.NOTICE_LINES) assert.ok(src.includes(`<div>${line}</div>`), `告知:${line}`);
// r151j:alias-note 改为「审核模型存在 sonnet 档,并会作为分类器模型显式传给命令行;旧版命令行不认
// 该变量时按 sonnet 档解析」。验收 texts.mjs 本轮锁定不改,所以这条新文案在这里直接断言源码;
// 验收解锁后应把 texts.mjs 的 ALIAS_NOTE 同步成同一句(本文件的断言不用再动)。
const ALIAS_NOTE_R151J = '审核模型存在 sonnet 档，并会作为分类器模型显式传给命令行；旧版命令行不认该变量时按 sonnet 档解析。';
assert.ok(src.includes(`<div data-testid="auto-audit-alias-note" className="text-[10.5px] text-ink-faint font-body">${ALIAS_NOTE_R151J}</div>`), '文案:alias-note(r151j)');
for (const t of [UI.MODEL_HINT, UI.OFFICIAL_NOTE, UI.UNKNOWN_PROVIDER_NOTE, UI.RESET_BTN, UI.APPLY_FAILED_TEXT, UI.FOLLOW_DEFAULT, UI.UNUSABLE_MARK]) {
  assert.ok(src.includes(t), `文案:${t}`);
}
assert.ok(src.includes('`尚未选择审核模型，当前使用该 provider 的默认模型 ${status.auditModel}。`'), '未设提示');
assert.equal(UI.modelUnset('X'), '尚未选择审核模型，当前使用该 provider 的默认模型 X。');
for (const id of ['third-party-auto-section', 'third-party-auto-toggle', 'third-party-auto-notice', 'auto-audit-model-select', 'auto-audit-alias-note',
  'auto-audit-model-unset', 'auto-audit-model-hint', 'auto-unavailable-reset', 'third-party-auto-official']) {
  assert.ok(src.includes(`data-testid="${id}"`), `data-testid ${id}`);
}
assert.ok(/data-testid="third-party-auto-toggle" role="switch" aria-checked=\{enabled\}/.test(src), '开关是 role=switch + aria-checked');
console.log('check-r151a-settings: OK');
