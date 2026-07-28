// B1 复现:高级选项原始 JSON 编辑器保存后内容被还原。
// 根因 = PUT /api/settings 对整份全文也做浅合并,用户删掉的顶层键被磁盘旧值复活。
// 修法 = JSON tab 带 _replace 标记走替换语义;补丁调用方(各设置 tab)语义零变化。
// node tests/unit/check-settings-put-merge.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeUpdatedSettings } from '../../server/routes/settings.js';

const disk = {
  model: 'claude-sonnet-4-6',
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo old' }] }] },
  statusLine: { type: 'command', command: 'foo' },
  env: { ANTHROPIC_MODEL: 'claude-sonnet-4-6' },
  permissions: { allow: ['Bash(ls:*)'] },
};

// 1) 复现场景:用户在 JSON 编辑器里删掉 hooks 和 statusLine 后整份保存。
//    替换模式下删掉的键必须真的消失(修复前浅合并会把它们复活 → 本断言失败)。
const fullDocWithoutHooks = { model: disk.model, env: disk.env, permissions: disk.permissions };
const replaced = computeUpdatedSettings(disk, fullDocWithoutHooks, true);
assert.equal('hooks' in replaced, false, '替换模式:用户删掉的 hooks 不得被磁盘旧值复活');
assert.equal('statusLine' in replaced, false, '替换模式:用户删掉的 statusLine 不得被磁盘旧值复活');
assert.deepEqual(replaced.permissions, disk.permissions, '保留的键原样写入');

// 2) 替换模式改值:编辑器里的新值必须原样落盘
const edited = { ...fullDocWithoutHooks, hooks: { PreToolUse: [] } };
assert.deepEqual(computeUpdatedSettings(disk, edited, true).hooks, { PreToolUse: [] }, '替换模式:改过的 hooks 以编辑器内容为准');

// 3) 补丁模式(默认)语义锁定:局部补丁只覆盖所发的键,其余键保住
const patched = computeUpdatedSettings(disk, { permissions: { allow: [] } }, false);
assert.deepEqual(patched.hooks, disk.hooks, '补丁模式:未发送的 hooks 必须保住(设置页各 tab 依赖)');
assert.deepEqual(patched.permissions, { allow: [] }, '补丁模式:发送的键被覆盖');

// 4) null 删键约定在两种模式下一致(autoCompactWindow 置空 = 回 CLI 默认)
assert.equal('statusLine' in computeUpdatedSettings(disk, { statusLine: null }, false), false, '补丁模式:null 键删除');
assert.equal('statusLine' in computeUpdatedSettings(disk, { model: 'x', statusLine: null }, true), false, '替换模式:null 键同样删除,不写字面 null');

// 5) 替换模式不读磁盘现值:磁盘独有键一律不渗入
const replaced2 = computeUpdatedSettings({ secretLeftover: 1 }, { model: 'x' }, true);
assert.equal('secretLeftover' in replaced2, false, '替换模式:结果只来自 body');

// ── 源码守卫:两端接线不许回退 ──
const settingsSrc = readFileSync(new URL('../../server/routes/settings.js', import.meta.url), 'utf-8');
assert.ok(/const replace = body\._replace === true/.test(settingsSrc), '服务端必须读取 _replace 标记');
assert.ok(/delete body\._replace/.test(settingsSrc), '_replace 标记键不得写入 settings.json');
assert.ok(/computeUpdatedSettings\(current, body, replace\)/.test(settingsSrc), 'PUT 必须经 computeUpdatedSettings 决定合并/替换');
const panelSrc = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf-8');
assert.ok(/_replace: true/.test(panelSrc), 'JSON tab 整份保存必须带 _replace 标记');

console.log('check-settings-put-merge OK');
