#!/usr/bin/env node
// r63-npm【半自动:需要 CC-GUI 正在运行】§4 GET /api/version-check 的字段契约。
// 场景:应用内"检查更新"。npm 装的用户看到的"最新版本",必须是他跑那条命令真能装到的版本;
//      dmg/exe 装的用户则一切照旧,一个字段都不许变味。
// 前提:本机跑着 CC-GUI(默认 http://127.0.0.1:6677,可用 CGUI_BASE 覆盖)。没跑就整体 skip。
// 说明:viaNpm=true 那一半需要真的用 npm 装一遍(会写 ~/.claude-gui/npm-install.json),
//      自动化跑会污染用户状态,已列进 TEST-PLAN 的人工项。
// Run: node tests/acceptance/r63-npm/t14-version-check-api.mjs
import assert from 'node:assert/strict';
import { t, skip, done } from './lib.mjs';

const BASE = process.env.CGUI_BASE || 'http://127.0.0.1:6677';
const NPM_ONLY = ['npmUpgradeCommand', 'githubLatestVersion', 'npmLagsBehind', 'npmChannelUnknown'];

async function get(p) {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(30000) });
  return { status: r.status, body: await r.json() };
}
let live = null;
const t0 = Date.now();
try { live = await get('/api/version-check'); } catch (e) { live = null; }
const elapsed = Date.now() - t0;

if (!live) {
  skip('t14 全部用例', `${BASE} 没响应 —— 先启动 CC-GUI 再跑本文件`);
  done('t14 应用内更新检查');
}

await t('/api/version-check 返回 200 且带 currentVersion', () => {
  assert.equal(live.status, 200);
  assert.ok(/^\d+\.\d+\.\d+$/.test(live.body.currentVersion), 'currentVersion 形态异常:' + live.body.currentVersion);
});

await t('viaNpm 字段总是出现,且是布尔', () => {
  assert.ok('viaNpm' in live.body, '前端靠这个字段决定渲不渲染 npm 升级块,不能"有时才有"');
  assert.equal(typeof live.body.viaNpm, 'boolean');
});

await t('读不到 marker 不许让接口报错或变慢(marker 只影响提示文案)', () => {
  assert.equal(live.status, 200);
  assert.ok(elapsed < 30000, `耗时 ${elapsed}ms,marker 读取不该引入等待`);
});

await t('【反向】非 npm 装法时,npm 通道专属字段一个都不该出现', () => {
  if (live.body.viaNpm === true) return skipInline('本机是 npm 装法,该条不适用');
  const leaked = NPM_ONLY.filter((k) => k in live.body);
  assert.deepEqual(leaked, [], 'dmg/exe 用户拿到了 npm 字段,UI 会给出一条他根本用不上的命令');
});

await t('【反向】响应里不该有 npmPackage 字段(零消费者,A2 已删)', () => {
  assert.ok(!('npmPackage' in live.body), 'npmPackage 没有任何读者,留着就是负债');
});

await t('viaMirror 为真时必须说清答案来自哪个源', () => {
  if (live.body.viaMirror !== true) return skipInline('本次答案不是来自镜像源');
  const s = live.body.mirrorSource;
  assert.ok(s === 'npmmirror' || s === 'jsdelivr' || /^npm:/.test(s), 'mirrorSource 非法:' + s);
});

await t('npm 装法下:命令字段与"命令此刻有没有用"严格对应', () => {
  if (live.body.viaNpm !== true) return skipInline('本机不是 npm 装法(该分支见 TEST-PLAN 人工项)');
  const b = live.body;
  const shouldHave = !b.npmLagsBehind && !b.npmChannelUnknown;
  assert.equal('npmUpgradeCommand' in b, shouldHave, '"该不该给命令"必须后端一处判完,前端只看字段在不在');
  if (shouldHave) assert.equal(b.npmUpgradeCommand, 'npx @wsxwj123/cc-gui@latest');
});

await t('【零影响】claude CLI 的更新检查不得沾上 npm 通道字段', async () => {
  const cc = await get('/api/claude-version-check');
  const leaked = NPM_ONLY.concat(['viaNpm']).filter((k) => k in cc.body);
  assert.deepEqual(leaked, [], 'CC-GUI 自身的更新字段串进了 claude CLI 的接口,两套渠道语义被混淆');
});

function skipInline(why) { console.log('       (跳过实质断言:' + why + ')'); }
done('t14 应用内更新检查');
