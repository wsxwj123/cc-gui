#!/usr/bin/env node
// r26-E1/E4 前端映射(GitInitBanner 在 App.jsx,JSX 进不了 node → 源码哨兵 +
// 契约形状钉死;服务端半由 PKG-4 实现,契约见 PLAN C-E1/C-E4):
//   E1:git status 新增 {isRepo:null, gitError:true, error, detail}(与 permissionDenied
//       互斥)→ 前端显示「git 状态探测失败：detail」+ 重新检测,不挂初始化引导;
//   E4:探测 fetch 对 403 + code:'no-disk-access' 单独放行读 body(现状非 ok 一律
//       catch 不显示横幅),映射到 tcc 横幅分支。
// Run: node tests/unit/check-r26-git-status-banner.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const bannerStart = app.indexOf('export function GitInitBanner');
assert.ok(bannerStart > 0, 'E1/E4: GitInitBanner 不见了(重构后同步本锚)');
const banner = app.slice(bannerStart, app.indexOf('const init = async () =>', bannerStart));
assert.ok(banner.length > 500, 'E1/E4: GitInitBanner 探测段切片失败');

// ── E4:403 放行读 body,且只认 no-disk-access 契约(别的 403 不冒称权限问题)──
assert.match(banner, /r\.status === 403/, 'E4: 探测 fetch 必须对 403 单独放行');
assert.match(banner, /d\?\.code === 'no-disk-access'/, 'E4: 只认 no-disk-access 契约形状');
assert.match(banner, /permissionDenied: true, hint: d\.hint/, 'E4: 403 映射到 tcc 横幅分支(hint 透传)');
assert.match(banner, /canOpenSettings: !!d\.canOpenSettings/, 'E4: canOpenSettings 透传(按钮门控)');
// 放行段必须先于/替代「非 ok 一律 reject」的旧行为 —— reject 仍在(其他非 2xx 不显示横幅)
assert.match(banner, /Promise\.reject\(new Error\('HTTP ' \+ r\.status\)\)/, 'E4: 其他非 2xx 仍 reject(fail-safe 不显示横幅)');

// ── E1:gitError 映射分支 ──
assert.match(banner, /s\?\.gitError \? 'giterror'/, 'E1: gitError 必须映射到独立 status,不挂 init 引导');
assert.match(banner, /setGitErr\(s\?\.gitError \? \{ error: s\.error/, 'E1: error/detail 入 state');
// 渲染分支:探测失败文案 + 重新检测 + 无初始化按钮
const errBranchStart = app.indexOf("if (status === 'giterror')", bannerStart);
assert.ok(errBranchStart > bannerStart, 'E1: giterror 渲染分支缺失');
const errBranch = app.slice(errBranchStart, app.indexOf("if (status === 'nogit')", errBranchStart));
assert.match(errBranch, /git 状态探测失败/, 'E1: 渲染「git 状态探测失败：detail」');
assert.match(errBranch, /gitErr\?\.detail/, 'E1: detail 逐字渲染');
assert.match(errBranch, /setKick\(\(k\) => k \+ 1\)/, 'E1: 重新检测按钮');
const errBranchCode = errBranch.replace(/\/\/[^\n]*/g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
assert.doesNotMatch(errBranchCode, /init|初始化/, 'E1: 探测失败分支不得挂初始化引导(误诊哨兵;注释已剥离)');

// 互斥:gitError 与 permissionDenied 同响应不叠加(服务端契约互斥,前端映射顺序钉住:
// gitError 分支在 permissionDenied 之前判,两者同时出现也落 giterror —— 与「不指去开权限」同向)
assert.ok(banner.indexOf("s?.gitError ? 'giterror'") < banner.indexOf("s?.permissionDenied ? 'tcc'"),
  'E1: gitError 判定先于 permissionDenied(互斥契约的确定性分支)');

console.log('PASS check-r26-git-status-banner');
