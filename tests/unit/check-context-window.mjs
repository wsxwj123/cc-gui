#!/usr/bin/env node
// 上下文徽章分母本地兜底表自检(nativeContextWindow 纯函数):
// 口径依据 = CLI 2.1.226 二进制模型注册表 + headless 实测。原生 1M(native_1m)从 4.7 起:
// fable-5/mythos-5/opus-5/sonnet-5/opus-4.7/opus-4.8;4.6 一代(opus-4-6/sonnet-4-6)注册表
// 是 window:200000 + supports_1m_beta,1M 要 [1m] 后缀;haiku 与老代 200K。
// 两个方向的历史事故都由本文件钉住:全 claude 系一律 200K → fable-5 爆红 389k/200k(ddd588a);
// 4.6 一代记成 1M → 60% 的会话显示 12%、不预警不压缩直撞 CLI 硬阻断线(2026-08 修正)。
import assert from 'node:assert/strict';
import { nativeContextWindow, isBareClaudeAlias } from '../../client/src/utils/contextWindow.js';

const M1 = 1_000_000, K200 = 200_000;

// ── 现网 8 形态 ──────────────────────────────────────────────
assert.equal(nativeContextWindow('claude-fable-5'), M1, 'fable-5 原生 1M');
assert.equal(nativeContextWindow('claude-sonnet-5'), M1, 'sonnet-5 原生 1M');
assert.equal(nativeContextWindow('claude-opus-4-6'), K200, 'opus-4.6 原生 200K,1M 需 [1m] [CLI 2.1.226 二进制注册表 + headless 实测]');
assert.equal(nativeContextWindow('claude-opus-4-7'), M1, 'opus-4.7 原生 1M [同上]');
assert.equal(nativeContextWindow('claude-opus-4-8'), M1, 'opus-4.8 原生 1M [同上]');
assert.equal(nativeContextWindow('claude-sonnet-4-6'), K200, 'sonnet-4.6 原生 200K,1M 需 [1m] [同上]');
assert.equal(nativeContextWindow('claude-sonnet-4-5-20250929'), K200, 'sonnet-4.5 全 id 200K');
assert.equal(nativeContextWindow('claude-haiku-4-5'), K200, 'haiku-4.5 200K');

// ── 分代边界:x.6 vs x.7 一位之差(原生 1M 的分界线)───────────
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

// ── [1m] 后缀恒 1M(4.6 及更老代靠它开 1M beta)──────────────
assert.equal(nativeContextWindow('claude-sonnet-4-5[1m]'), M1, '[1m] 后缀 1M');
assert.equal(nativeContextWindow('claude-opus-4-8[1m]'), M1, '[1m] 后缀 1M');
assert.equal(nativeContextWindow('claude-opus-4-6[1m]'), M1, 'opus-4.6 的 1M 只能靠 [1m](裸 id 是 200K)');
assert.equal(nativeContextWindow('claude-sonnet-4-6[1m]'), M1, 'sonnet-4.6 同理');

// ── 未来带日期新代:保守挡回 200K(断言现状)─────────────────
// (?![\d-]) 使 sonnet-5-20260101 / opus-5-20260101 不中 1M 支 → 200K。这是刻意的保守
// 现状:错小不错大(分母偏小只多警告);真跑过 1M 的会话由运行时推断自愈(6bfc207:
// 单次 ctxUsage 超名义窗口 → syncContext1m 补 1M 标记)。新代发布后在表里加行即可。
assert.equal(nativeContextWindow('claude-sonnet-5-20260101'), K200, '未来日期 id 保守 200K(现状)');
assert.equal(nativeContextWindow('claude-opus-5-20260101'), K200, '未来日期 id 保守 200K(对称)');
assert.equal(nativeContextWindow('claude-sonnet-52'), K200, '数字续接不误中(sonnet-52)');

// ── 第三方回归(表其余分支不因 claude 分支改动漂移)───────────
// 依据说明:
//   [实测] = 用户真实历史 jsonl 里该模型的最大 prompt(input+cache_read+cache_creation),
//            是窗口的硬下界 —— 达到过的长度不可能超过真实窗口。
//   [官方] = 厂商官方文档/模型卡的上下文长度。
// 本段 6 条断言在 2026-08 按上述证据改过口径(旧值全部被实测打穿),不是为了变绿而改。
const K1M = 1_048_576;
assert.equal(nativeContextWindow('deepseek-chat'), 131_072, 'deepseek 旧系 128K [官方 api-docs.deepseek.com]');
assert.equal(nativeContextWindow('deepseek-v4-flash'), K1M, 'deepseek V4 1M [官方 1M / 实测最大 680,100 已打穿旧值 200K]');
assert.equal(nativeContextWindow('deepseek-v4-pro'), K1M, 'deepseek V4 pro 同代 1M [实测最大 152,027]');
assert.equal(nativeContextWindow('mimo-v2.5-pro'), M1, 'MiMo v2.5 1M [官方 mimo.mi.com 规格页;实测最大 183,223 已打穿旧值 200K 的近半]');
assert.equal(nativeContextWindow('mimo-v2-flash'), K200, 'MiMo 旧代已下线无官方规格 → 保守 200K [实测最大 83,847,未打穿]');
assert.equal(nativeContextWindow('mimo-v10'), M1, '两位版本号不静默回落旧档(v10 ≥ v2.5)');
assert.equal(nativeContextWindow('mimo-20260115'), K200, '裸日期后缀不是版本号:两位分支必须挡住 mimo-YYYYMMDD 的前两位');
assert.equal(nativeContextWindow('kimi-k2.6'), 262_144, 'kimi K2.x 256K [官方 platform.kimi.ai]');
assert.equal(nativeContextWindow('k3'), K1M, '裸 k3 = Kimi Code 套餐别名,官方 1,048,576 [实测最大 319,687 已证伪旧值 262,144]');
assert.equal(nativeContextWindow('kimi-k3'), K1M, 'kimi-k3 全名同为 1M [官方]');
assert.equal(nativeContextWindow('k3[1m]'), M1, 'k3[1m] 走 [1m] 分支 1M');
assert.equal(nativeContextWindow('k3-0905'), K1M, 'k3 带日期变体同为 1M');
assert.equal(nativeContextWindow('k3.5'), K1M, 'k3 带小版本变体同为 1M');
assert.equal(nativeContextWindow('k3-256k'), 256_000, 'k3-256k 是官方明列的固定 256K 档,由 -Nk 分支接住');
assert.equal(nativeContextWindow('k3-0905[1m]'), M1, 'k3 变体带 [1m] 仍走 [1m] 分支 1M');
assert.equal(nativeContextWindow('minimax-k3'), M1, '含 k3 字样的其他模型不被误捕(默认 1M)');
assert.equal(nativeContextWindow('k30-preview'), M1, '数字续接不误中(k30 不是 k3 变体)');
assert.equal(nativeContextWindow('  k3 '), K1M, '首尾空白被 trim 不影响 k3 前缀匹配');
assert.equal(nativeContextWindow('moonshot-v1-128k'), 128_000, '-Nk 标注优先');
assert.equal(nativeContextWindow('mimo-v2.5-pro[1m]'), M1, '第三方 [1m] 1M');
assert.equal(nativeContextWindow('gpt-5'), 400_000, 'GPT-5 400K [官方 developers.openai.com]');
assert.equal(nativeContextWindow('gpt-5-mini'), 400_000, 'GPT-5 mini 400K [官方]');
assert.equal(nativeContextWindow('gpt-5-nano'), 400_000, 'GPT-5 nano 400K [官方]');
assert.equal(nativeContextWindow('gpt-5.5'), 1_050_000, 'GPT-5.5 1.05M [官方;实测最大 102,471 不与之冲突]');
assert.equal(nativeContextWindow('gpt-5.6-sol'), 1_050_000, 'GPT-5.6 全档 1.05M [官方;实测最大 335,148 已打穿旧值 400K 的八成]');
assert.equal(nativeContextWindow('openai/gpt-5.6-sol'), 1_050_000, '带 openai/ 前缀的同一模型给同一答案');
assert.equal(nativeContextWindow('gpt-5.10'), 1_050_000, '两位小版本不静默回落 400K 档');
assert.equal(nativeContextWindow('gpt-5.1'), 400_000, '5.4 之前的小版本仍走 400K(两位数放宽不能误伤单位数)');
assert.equal(nativeContextWindow('gpt-5.05'), 400_000, '前导零的两位小版本语义上小于 5.4,不进 1.05M 档');
assert.equal(nativeContextWindow('gemini-2.5-pro'), M1, '未列第三方默认 1M');
assert.equal(nativeContextWindow(''), M1, '空模型走默认(徽章有 sane-ceiling 兜底)');

// ── 低危#3:裸别名判定(第三方分母欠告警的触发条件)──────────────
assert.equal(isBareClaudeAlias('sonnet'), true, '裸 sonnet');
assert.equal(isBareClaudeAlias('opus'), true, '裸 opus');
assert.equal(isBareClaudeAlias('haiku'), true, '裸 haiku');
assert.equal(isBareClaudeAlias('claude-opus'), true, 'claude- 前缀裸别名');
assert.equal(isBareClaudeAlias('Sonnet'), true, '大小写不敏感');
assert.equal(isBareClaudeAlias('claude-opus-4-8'), false, '带版本号不算裸别名(分母确定)');
assert.equal(isBareClaudeAlias('claude-sonnet-5'), false, '带版本号不算裸别名');
assert.equal(isBareClaudeAlias('sonnet[1m]'), false, '带 [1m] 标注分母确定');
assert.equal(isBareClaudeAlias('deepseek-chat'), false, '非 claude 系不算');
assert.equal(isBareClaudeAlias(''), false, '空模型不算');

console.log('check-context-window: all assertions passed');
