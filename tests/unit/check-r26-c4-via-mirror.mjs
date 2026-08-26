#!/usr/bin/env node
// r26-C4【单测】:viaMirror 透传 + 前端指引。
// 背景:fetchJsdelivrLatest 返回带 viaMirror:true,但 /version-check 响应组装不含该字段
// → 墙内用户拿到 assets 是 GitHub 直链,下载必败且无任何提示。
// 验收点(PLAN C4):snap 带 viaMirror → 响应含;不带 → 不含(字段有无哨兵);
// 前端见 viaMirror 显示「检测到镜像源…请手动到发布页下载」+ htmlUrl 链接。
// Run: node tests/unit/check-r26-c4-via-mirror.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ①服务端响应组装钉:条件透传(带才有、不带没有 —— 条件展开形态钉死)
{
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  const start = src.indexOf("router.get('/version-check'");
  const end = src.indexOf('// ─── Claude Code CLI 版本检测');
  assert.ok(start > 0 && end > start, 'C4: /version-check 路由段定位失败(锚漂移需换锚)');
  const routeBody = src.slice(start, end);
  assert.match(routeBody, /\.\.\.\(snap\.viaMirror \? \{ viaMirror: true \} : \{\}\)/,
    'C4: 响应必须条件透传 viaMirror(snap 带才有、不带没有 —— 字段有无哨兵)');
  // 镜像源仍在产出 viaMirror(上游字段防丢)
  // (r63) 换锚:fetchJsdelivrLatest 的返回追加了 mirrorSource:'jsdelivr'(排障用新增字段),
  // viaMirror:true 语义不变,锚放宽以容纳其后的新字段。
  assert.match(src, /assets: \[\], viaMirror: true[,}]/, 'C4: fetchJsdelivrLatest 仍产出 viaMirror:true');
}

// ②字段有无语义行为佐证:与响应组装同形的条件展开,带/不带两态
{
  const assemble = (snap) => ({ latestVersion: 'x', ...(snap.viaMirror ? { viaMirror: true } : {}) });
  assert.equal(assemble({ viaMirror: true }).viaMirror, true, 'C4: snap 带 viaMirror → 响应含');
  assert.ok(!('viaMirror' in assemble({})), 'C4: snap 不带 → 响应不含(键缺席而非 false)');
}

// ③前端指引钉:viaMirror 提示块 + 手动发布页链接(走 htmlUrl)
{
  const ui = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
  assert.match(ui, /state\.viaMirror && \(/, 'C4: 前端必须按 viaMirror 渲染提示');
  assert.match(ui, /检测到镜像源/, 'C4: 提示文案「检测到镜像源」');
  assert.match(ui, /手动到发布页下载/, 'C4: 指引「手动到发布页下载」');
  // 提示块内的链接必须打开 htmlUrl(发布页),不是别的地址
  const blkStart = ui.indexOf('state.viaMirror && (');
  const blk = ui.slice(blkStart, ui.indexOf('新版本可用', blkStart));
  assert.match(blk, /openExternalUrl\(state\.htmlUrl\)/, 'C4: 指引链接必须走 state.htmlUrl(发布页)');
}

console.log('PASS check-r26-c4-via-mirror');
