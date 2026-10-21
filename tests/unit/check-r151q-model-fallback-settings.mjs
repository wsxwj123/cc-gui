// r151q 第 3、4 项:代理的 claude 名映射目标与保护名单跟随用户级 settings.json。只测 model-fallback.js 的真函数;
// settings 文件一律写在本测试自己的临时目录、经 file 参数传入,不读真实 ~/.claude/settings.json。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  resolveFallbackModel, resolveUpstreamModel, readModelSettings, modelSettingsFrom, normalizeModelName,
  resetModelFallbackLogState,
} = await import('../../server/utils/model-fallback.js');

const root = mkdtempSync(join(tmpdir(), 'cgui-r151q-mf-'));
const logs = [];
const logger = { warn: (m) => logs.push(String(m)) };
const later = () => Date.now() + 10_000; // 越过"刚改过不信缓存"的窗口,才看得到缓存命中
try {
  // ── 1. 规范化与推导 ──
  assert.equal(normalizeModelName('  m2[1M] '), 'm2', '去空白与结尾 [1m](不分大小写)');
  assert.equal(normalizeModelName(5), '', '非字符串 → 空');
  const full = modelSettingsFrom({
    model: 'claude-opus-4-6[1m]',
    env: { ANTHROPIC_MODEL: ' m1 ', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5', CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-4-5',
      ANTHROPIC_AUTH_TOKEN: 'tok', OTHER: 'claude-x', EMPTY_MODEL: '  ' },
  });
  assert.equal(full.target, 'm1', '目标先取 env.ANTHROPIC_MODEL');
  assert.deepEqual([...full.protectedNames].sort(), ['claude-haiku-4-5', 'claude-opus-4-6', 'claude-sonnet-4-5', 'm1'],
    '保护名单 = 以 _MODEL 结尾的键的值 + 顶层 model(规范化,空值不收,其它键不收)');
  assert.equal(modelSettingsFrom({ model: 'm-top' }).target, 'm-top', '没有 env.ANTHROPIC_MODEL → 顶层 model');
  assert.equal(modelSettingsFrom({ model: 'opus' }).target, '', 'CLI 别名不当映射目标');
  assert.equal(modelSettingsFrom({ env: { ANTHROPIC_MODEL: 'sonnet[1m]' }, model: 'm-top' }).target, 'm-top', 'env 是别名 → 退到顶层 model');
  for (const bad of [null, [], 'x', { env: [] }, { env: 'x' }]) {
    assert.equal(modelSettingsFrom(bad).target, '', `形状不对 → 没有目标:${JSON.stringify(bad)}`);
  }

  // ── 2. 纯函数:保护名单只在列表里有 claude 名时生效;目标优先级 settings > setter > models[0] ──
  const sells = ['m1', 'claude-opus-4-7'];
  const P = new Set(['claude-haiku-4-5']);
  assert.equal(resolveFallbackModel('claude-haiku-4-5', { models: sells, defaultModel: 'm1', protectedNames: P }), 'claude-haiku-4-5', '卖 claude:配置过的名字原样');
  assert.equal(resolveFallbackModel('claude-haiku-4-5', { models: ['m1', 'm2'], defaultModel: 'm1', protectedNames: P }), 'm1', '不卖 claude:残留照旧映射');
  assert.equal(resolveFallbackModel('claude-haiku-4-5', { models: sells, protectedNames: ['claude-haiku-4-5'] }), 'claude-haiku-4-5', '数组形式的名单也认');
  assert.equal(resolveFallbackModel('claude-sonnet-4-6', { models: sells, defaultModel: 'm1', protectedNames: P, settingsTarget: 'm2' }), 'm2', 'settings 目标优先于 setter');
  assert.equal(resolveFallbackModel('claude-sonnet-4-6', { models: ['m1'], defaultModel: 'm1', settingsTarget: '' }), 'm1', 'settings 没目标 → setter');
  assert.equal(resolveFallbackModel('claude-sonnet-4-6', { models: ['m1'], settingsTarget: 7 }), 'm1', '目标不是字符串 → models[0]');

  // ── 2b. 映射目标过同一道门:不卖 claude 时,settings 残留的 claude 名候选跳过、取下一项;都不行 → setter 给的值 ──
  const noClaude = ['m1', 'm2'];
  const residue = modelSettingsFrom({ env: { ANTHROPIC_MODEL: 'claude-opus-4-7' }, model: 'm2' });
  assert.deepEqual(residue.targets, ['claude-opus-4-7', 'm2'], '候选按优先级:env.ANTHROPIC_MODEL,其次顶层 model');
  assert.equal(residue.target, 'claude-opus-4-7', 'target = 第一个候选');
  assert.deepEqual(modelSettingsFrom({ env: { ANTHROPIC_MODEL: 'm1[1m]' }, model: 'm1' }).targets, ['m1'], '重复候选只留一个');
  const viaSettings = (requested, models, cfg, defaultModel) => resolveFallbackModel(requested, {
    models, defaultModel, settingsTarget: cfg.targets, protectedNames: cfg.protectedNames,
  });
  assert.equal(viaSettings('claude-opus-4-7', noClaude, residue, 'm1'), 'm2', '残留 claude 名不当目标(不映射成自己)→ 顶层 model');
  assert.equal(viaSettings('claude-sonnet-4-6', noClaude, residue, 'm1'), 'm2', '别的 claude 名也不映射到残留名');
  const allClaude = modelSettingsFrom({ env: { ANTHROPIC_MODEL: 'claude-opus-4-7[1m]' }, model: 'claude-sonnet-4-6' });
  assert.equal(viaSettings('claude-opus-4-7', noClaude, allClaude, 'm1'), 'm1', '候选都是残留 claude 名 → setter 的 defaultModel(与改动前相同)');
  assert.equal(viaSettings('claude-haiku-4-5', noClaude, allClaude, undefined), 'm1', '没有 defaultModel → models[0]');
  assert.equal(resolveFallbackModel('claude-opus-4-7', { models: noClaude, defaultModel: 'm1', settingsTarget: 'claude-opus-4-7' }), 'm1', '单个字符串目标同样过门');
  assert.equal(resolveFallbackModel('claude-haiku-4-5', { models: [], settingsTarget: 'claude-opus-4-7' }), 'claude-haiku-4-5', '列表空、没有 setter 值 → 原样,不改成过不了门的名字');
  assert.equal(resolveFallbackModel('claude-sonnet-4-6', { models: noClaude, defaultModel: 'm1', settingsTarget: ['m9'] }), 'm9', '非 claude 名的目标不在列表也照用(与改动前相同)');
  assert.equal(viaSettings('claude-sonnet-4-6', sells, modelSettingsFrom({ env: { ANTHROPIC_MODEL: 'claude-opus-4-7' } }), 'm1'), 'claude-opus-4-7', '列表里有的 claude 名能当目标');
  assert.equal(viaSettings('claude-sonnet-4-6', sells, modelSettingsFrom({ env: { ANTHROPIC_MODEL: 'claude-opus-4-8' } }), 'm1'), 'claude-opus-4-8',
    '卖 claude:配置过的主模型本身会被原样放行,也就能当目标');

  // ── 3. 读 settings:文件不存在、缓存、刚改过不信缓存、失败沿用且不缓存失败、日志不带内容、BOM、从没成功过 ──
  const f = join(root, 'settings.json');
  assert.equal(readModelSettings({ file: f, logger }), null, '文件不存在 → null(退回 setter)');
  const T = Math.floor(Date.now() / 1000) - 100; // 整秒 mtime:还原时不丢亚毫秒精度
  writeFileSync(f, JSON.stringify({ env: { ANTHROPIC_MODEL: 'm1' } }));
  utimesSync(f, T, T);
  assert.equal(readModelSettings({ file: f, logger }).target, 'm1');
  writeFileSync(f, JSON.stringify({ env: { ANTHROPIC_MODEL: 'm9' } })); // 等长改写,再把 mtime 拨回同一个整秒
  utimesSync(f, T, T);
  assert.equal(statSync(f).mtimeMs, T * 1000, '前置:mtime 拨回原值');
  assert.equal(readModelSettings({ file: f, logger, now: later() }).target, 'm1', 'mtime+size 都没变 → 用缓存');
  assert.equal(readModelSettings({ file: f, logger, now: T * 1000 + 500 }).target, 'm9', '刚改过(2 秒内)不信缓存,重读');
  const TOKEN = 'R151QUNIT-SECRET-77';
  writeFileSync(f, `{"env": {"ANTHROPIC_MODEL": "m3", "ANTHROPIC_AUTH_TOKEN": "${TOKEN}`);
  assert.equal(readModelSettings({ file: f, logger }).target, 'm9', '半截 JSON → 沿用上一次成功的结果');
  assert.equal(readModelSettings({ file: f, logger, now: later() }).target, 'm9', '再读仍沿用,不报错');
  assert.equal(logs.length, 1, `同一坏文件只记一次日志:${JSON.stringify(logs)}`);
  assert.equal(logs[0], '[model-fallback] settings 读取失败(SyntaxError)', '日志只写错误类型');
  assert.ok(!logs.join('\n').includes(TOKEN) && !logs.join('\n').includes('m3'), '日志里没有 settings 的内容');
  writeFileSync(f, `﻿${JSON.stringify({ env: { ANTHROPIC_MODEL: 'm4[1m]' } })}`);
  assert.equal(readModelSettings({ file: f, logger }).target, 'm4', '恢复后按新内容生效(带 BOM 也能读)');
  writeFileSync(f, 'null');
  assert.equal(readModelSettings({ file: f, logger }).target, 'm4', '不是对象 → 按失败处理,沿用');
  resetModelFallbackLogState();
  assert.equal(readModelSettings({ file: f, logger }), null, '从来没成功过 → null');

  // ── 4. resolveUpstreamModel:只有"claude 名且不在列表"才读 settings ──
  const dir = join(root, 'g');
  mkdirSync(dir);
  const g = join(dir, 'settings.json');
  writeFileSync(g, JSON.stringify({ env: { ANTHROPIC_MODEL: 'm2' } }));
  const up = { models: ['m1', 'm2', 'claude-opus-4-7'], defaultModel: 'm1' };
  assert.equal(resolveUpstreamModel('claude-sonnet-4-6', up, { file: g, logger }), 'm2', '映射目标跟随 settings');
  const before = logs.length;
  // file 指向目录:一旦被读就会记一条 EISDIR 失败日志 —— 下面这些都不该读
  for (const name of ['m1', 'claude-opus-4-7', 'gpt-4o', '', undefined]) {
    assert.equal(resolveUpstreamModel(name, up, { file: dir, logger }), name, `原样:${String(name)}`);
  }
  assert.equal(logs.length, before, '不需要映射时不读 settings');
  assert.equal(resolveUpstreamModel('claude-sonnet-4-6', up, { file: join(root, 'none.json'), logger }), 'm1', '没有 settings → setter 目标');
  assert.equal(resolveUpstreamModel('claude-sonnet-4-6', null, { file: join(root, 'none.json'), logger }), 'claude-sonnet-4-6', '没有上游快照 → 原样');
  // 复查发现的场景:不卖 claude 的 provider,settings 主模型残留成 claude 名 → 落到 setter 的默认模型,而不是映射成自己
  const r = join(root, 'residue.json');
  writeFileSync(r, JSON.stringify({ env: { ANTHROPIC_MODEL: 'claude-opus-4-7[1m]' } }));
  const upNoClaude = { models: ['m1', 'm2'], defaultModel: 'm1' };
  assert.equal(resolveUpstreamModel('claude-opus-4-7', upNoClaude, { file: r, logger }), 'm1', '残留主模型 = 请求名 → setter 的默认模型');
  assert.equal(resolveUpstreamModel('claude-sonnet-4-6', upNoClaude, { file: r, logger }), 'm1', '其它 claude 名 → setter 的默认模型');
  console.log('PASS check-r151q-model-fallback-settings');
} finally {
  rmSync(root, { recursive: true, force: true }); // 只清本测试自己 mkdtemp 出来的目录
}
