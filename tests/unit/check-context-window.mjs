#!/usr/bin/env node
// 上下文徽章分母本地兜底表自检(nativeContextWindow 纯函数):
// 2026-07 官方口径 fable-5/mythos/sonnet-5/opus-4.6+/sonnet-4.6 原生 1M(无需 [1m]),
// haiku 与老代 200K。旧表全 claude 系一律 200K 是"389k/200k(194%) 爆红"根因(ddd588a)。
import assert from 'node:assert/strict';
import { nativeContextWindow } from '../../client/src/utils/contextWindow.js';

const M1 = 1_000_000, K200 = 200_000;

// ── 现网 8 形态 ──────────────────────────────────────────────
assert.equal(nativeContextWindow('claude-fable-5'), M1, 'fable-5 原生 1M');
assert.equal(nativeContextWindow('claude-sonnet-5'), M1, 'sonnet-5 原生 1M');
assert.equal(nativeContextWindow('claude-opus-4-6'), M1, 'opus-4.6 原生 1M');
assert.equal(nativeContextWindow('claude-opus-4-7'), M1, 'opus-4.7 原生 1M');
assert.equal(nativeContextWindow('claude-opus-4-8'), M1, 'opus-4.8 原生 1M');
assert.equal(nativeContextWindow('claude-sonnet-4-6'), M1, 'sonnet-4.6 原生 1M');
assert.equal(nativeContextWindow('claude-sonnet-4-5-20250929'), K200, 'sonnet-4.5 全 id 200K');
assert.equal(nativeContextWindow('claude-haiku-4-5'), K200, 'haiku-4.5 200K');

// ── 分代边界:x.5 vs x.6 一位之差 ────────────────────────────
assert.equal(nativeContextWindow('claude-sonnet-4-5'), K200, 'sonnet-4.5 是 200K');
assert.equal(nativeContextWindow('claude-opus-4-5'), K200, 'opus-4.5 是 200K');
assert.equal(nativeContextWindow('claude-opus-4-5-20251101'), K200, 'opus-4.5 全 id 200K');
assert.equal(nativeContextWindow('claude-opus-4-1'), K200, 'opus-4.1 200K');
assert.equal(nativeContextWindow('claude-mythos-5'), M1, 'mythos-5 同 fable 1M');

// ── 旧代 id ─────────────────────────────────────────────────
assert.equal(nativeContextWindow('claude-3-5-sonnet-20241022'), K200, 'claude-3.5-sonnet 200K(不被 sonnet-[5-9] 误中)');
assert.equal(nativeContextWindow('claude-3-haiku-20240307'), K200, 'claude-3-haiku 200K');
assert.equal(nativeContextWindow('claude-sonnet-4-20250514'), K200, 'sonnet-4.0 全 id 200K');

// ── 裸别名(CLI 解析到当前 tier 最新)─────────────────────────
assert.equal(nativeContextWindow('opus'), M1, '别名 opus = 最新 opus → 1M');
assert.equal(nativeContextWindow('sonnet'), M1, '别名 sonnet = 最新 sonnet → 1M');
assert.equal(nativeContextWindow('haiku'), K200, '别名 haiku 200K');

// ── [1m] 后缀恒 1M(老代靠它开 1M beta)─────────────────────
assert.equal(nativeContextWindow('claude-sonnet-4-5[1m]'), M1, '[1m] 后缀 1M');
assert.equal(nativeContextWindow('claude-opus-4-8[1m]'), M1, '[1m] 后缀 1M');

// ── 未来带日期新代:保守挡回 200K(断言现状)─────────────────
// (?![\d-]) 使 sonnet-5-20260101 / opus-5-20260101 不中 1M 支 → 200K。这是刻意的保守
// 现状:错小不错大(分母偏小只多警告);真跑过 1M 的会话由运行时推断自愈(6bfc207:
// 单次 ctxUsage 超名义窗口 → syncContext1m 补 1M 标记)。新代发布后在表里加行即可。
assert.equal(nativeContextWindow('claude-sonnet-5-20260101'), K200, '未来日期 id 保守 200K(现状)');
assert.equal(nativeContextWindow('claude-opus-5-20260101'), K200, '未来日期 id 保守 200K(对称)');
assert.equal(nativeContextWindow('claude-sonnet-52'), K200, '数字续接不误中(sonnet-52)');

// ── 第三方回归(表其余分支不因 claude 分支改动漂移)───────────
assert.equal(nativeContextWindow('deepseek-chat'), K200, 'deepseek 200K');
assert.equal(nativeContextWindow('mimo-v2.5-pro'), K200, 'mimo 200K');
assert.equal(nativeContextWindow('kimi-k2.6'), 262_144, 'kimi 256K');
assert.equal(nativeContextWindow('moonshot-v1-128k'), 128_000, '-Nk 标注优先');
assert.equal(nativeContextWindow('mimo-v2.5-pro[1m]'), M1, '第三方 [1m] 1M');
assert.equal(nativeContextWindow('gemini-2.5-pro'), M1, '未列第三方默认 1M');
assert.equal(nativeContextWindow(''), M1, '空模型走默认(徽章有 sane-ceiling 兜底)');

console.log('check-context-window: all assertions passed');
