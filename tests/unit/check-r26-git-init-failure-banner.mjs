#!/usr/bin/env node
// r26-E5:git init 失败弹窗丢 canOpenSettings —— 服务端 classifyGitInitError 已回
// canOpenSettings,前端却只 confirmDialog 纯文本,没有「打开系统设置」按钮。
// 修法:init 失败且 data.canOpenSettings → 置 tcc 横幅态(复用既有横幅渲染与按钮);
// 无 canOpenSettings(Windows/Linux 无面板可跳)仍走 confirmDialog。
// GitInitBanner 是 JSX 组件(node 直跑不了),判定逻辑又薄(一个布尔分支),抽纯函数的
// 收益不抵引入新模块的成本 —— 按仓库既有惯例(check-home-state t5 / check-git-init-error)
// 用源码哨兵钉住两分支的存在与互斥。
// Run: node tests/unit/check-r26-git-init-failure-banner.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');

// 切出 GitInitBanner 的 init 函数段
const bannerStart = app.indexOf('export function GitInitBanner');
assert.ok(bannerStart > 0, 'E5: GitInitBanner 不见了(重构后同步本锚)');
const initStart = app.indexOf('const init = async () =>', bannerStart);
const initEnd = app.indexOf('const dismiss = () =>', initStart);
const initBlock = app.slice(initStart, initEnd > initStart ? initEnd : undefined);
assert.ok(initBlock.length > 200, 'E5: init 函数切片失败');

// 分支一:canOpenSettings → 横幅态(tcc),带 hint,不弹窗
assert.match(initBlock, /else if \(data\.canOpenSettings\) \{/,
  'E5: init 失败必须先判 canOpenSettings 分支');
const tccBranch = initBlock.slice(initBlock.indexOf('else if (data.canOpenSettings)'));
assert.match(tccBranch, /setAccess\(\{ hint: data\.hint \|\| '', canOpenSettings: true \}\);\s*\n\s*setStatus\('tcc'\)/,
  'E5: canOpenSettings 分支必须置 tcc 横幅态(复用「打开系统设置」按钮)');
// 分支二:无 canOpenSettings → 仍 confirmDialog 文本流
assert.match(initBlock, /confirmDialog\(data\.error/, 'E5: 无面板可跳时保留 confirmDialog 兜底');
// 互斥哨兵:canOpenSettings 分支里不得弹窗(按钮与弹窗二选一)
const tccOnly = tccBranch.slice(0, tccBranch.indexOf('} else {'));
assert.doesNotMatch(tccOnly, /confirmDialog/, 'E5: 横幅分支不得再弹 confirmDialog(双提示)');

// 横幅渲染端:tcc 分支确实存在「打开系统设置」按钮且按 canOpenSettings 门控(回归钉)
const bannerBlock = app.slice(bannerStart, app.indexOf('// busy 一条共用', bannerStart));
assert.match(bannerBlock, /access\?\.canOpenSettings && \(/, 'E5: tcc 横幅按钮按 canOpenSettings 门控');
assert.match(bannerBlock, /open-fda-settings/, 'E5: 按钮走 /api/system/open-fda-settings');

console.log('PASS check-r26-git-init-failure-banner');
