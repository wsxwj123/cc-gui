#!/usr/bin/env node
// r36【单测】:更新渠道 = 总开关(比较该渠道 + 使用该渠道的 claude)。
// 用户报的症状:原生装的 claude 已是原生渠道最新,只因 npm 渠道先发了一版,GUI 仍红点提醒更新
// (反之亦然)。根因:/claude-version-check 的 latest 按【显式渠道】取源(resolveSrcKey),
// 而 currentVersion 是【在用二进制】的版本 —— 跨渠道比对必然造假阳性。
// 三条语义:
//   ①「要不要提醒」永远按在用二进制自己的渠道比(compareSrcKey(method),渠道参数进不来);
//   ②选渠道 = 同时把 GUI 用的 claude 钉到该渠道的安装(pickChannelInstall + setClaudeOverride);
//   ③响应带 path,前端显示「检测对象」。
// Run: node tests/unit/check-r36-channel-install.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTmpHome, cleanupDirs } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('r36-unit'); // version-check 顶层固化 PREFS_FILE,先隔离 HOME

try {
  const vc = await import('../../server/routes/version-check.js');
  const { compareSrcKey, pickChannelInstall, resolveSrcKey, resolveUpdateMethod, isCrossChannel } = vc;
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');

  // ── ① 比较源只由在用二进制的安装方式决定 ────────────────────────────────
  {
    assert.equal(typeof compareSrcKey, 'function', 'r36-①: 必须导出 compareSrcKey(method) 纯函数(比较源选择器)');
    // 渠道参数【物理上】进不来 —— 一元签名是最硬的锚:后人想"顺手"把渠道再塞回来必须改签名。
    assert.equal(compareSrcKey.length, 1, 'r36-①: compareSrcKey 只接受 method,渠道不得参与比较源选择');

    // 用户原场景:显式选了 npm 渠道,但在用的是原生安装 → 比较源必须是 native(现状 resolveSrcKey 给 npm)
    assert.equal(compareSrcKey('native'), 'native', 'r36-①: 在用原生安装 → 比较原生渠道 latest(哪怕显式选了 npm 渠道)');
    assert.equal(resolveSrcKey('npm', 'native'), 'npm', 'r36-①: 旧口径(保留导出)确实会跨渠道取 npm —— 端点必须已不再用它');
    assert.notEqual(compareSrcKey('native'), resolveSrcKey('npm', 'native'),
      'r36-①: 新旧口径在跨渠道组合上必须分道(否则假阳性没修掉)');

    // 反向组合:显式选 native 渠道 × npm 安装 → 比较源 npm
    assert.equal(compareSrcKey('npm'), 'npm', 'r36-①: 在用 npm 安装 → 比较 npm 渠道 latest(哪怕显式选了原生渠道)');

    // 默认(未选渠道)逐项与现状一致 —— 回归保护,不许顺手改口径
    for (const m of ['native', 'npm', 'brew', 'unknown']) {
      assert.equal(compareSrcKey(m), resolveSrcKey(null, m), `r36-①: 未选渠道时 ${m} 的比较源与现状一致(回归)`);
    }
    assert.equal(compareSrcKey('brew'), 'native', 'r36-①: brew → 原生源');
    assert.equal(compareSrcKey('unknown'), 'native', 'r36-①: unknown → 原生源');
  }

  // ── ② 选渠道 = 挑该渠道的安装(纯函数,classify 可注入) ──────────────────
  {
    assert.equal(typeof pickChannelInstall, 'function', 'r36-②: 必须导出 pickChannelInstall(channel, installs, classify)');
    // classify 按 real 路径特征分类(与 classifyClaudePath 同口径,测试内注入免受平台影响)
    const classify = (real) => (/npm|node_modules/.test(real) ? 'npm' : 'native');
    const installs = [
      { path: '/n/bin/claude', real: '/home/u/.local/share/claude/versions/2.1.0/claude' },
      { path: '/npm/bin/claude', real: '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
    ];
    assert.equal(pickChannelInstall('npm', installs, classify)?.path, '/npm/bin/claude', 'r36-②: npm 渠道挑出 npm 安装');
    assert.equal(pickChannelInstall('native', installs, classify)?.path, '/n/bin/claude', 'r36-②: 原生渠道挑出原生安装');
    assert.equal(pickChannelInstall('npm', [installs[0]], classify), null, 'r36-②: 目标渠道无安装 → null(不许乱钉别的)');
    assert.equal(pickChannelInstall(null, installs, classify), null, 'r36-②: 跟随(null)不挑安装 → null');

    // broken 壳包必须跳过:钉死它之后所有 spawn 都会废(PUT /claude-active 亦同判)
    const withBroken = [
      { path: '/npm/broken/claude', real: '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', broken: true, reason: '壳包未完成安装' },
      { path: '/npm/good/claude', real: '/opt/npm/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
    ];
    assert.equal(pickChannelInstall('npm', withBroken, classify)?.path, '/npm/good/claude', 'r36-②: broken 壳包被跳过(变异:去掉 broken 过滤即红)');
    assert.equal(pickChannelInstall('npm', [withBroken[0]], classify), null, 'r36-②: 只有 broken 安装 → null(不许钉死壳包)');

    // 多命中取列表第一个(listClaudeInstallsAsync 的顺序即优先级:PATH → login shell → npm 前缀 …)
    const multi = [
      { path: '/a/claude', real: '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
      { path: '/b/claude', real: '/opt/npm/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
    ];
    assert.equal(pickChannelInstall('npm', multi, classify)?.path, '/a/claude', 'r36-②: 多命中取列表第一个');
  }

  // ── 回归:更新方式解析 / 跨渠道判据不动(渠道只管更新走哪条管线) ──────────
  {
    assert.equal(resolveUpdateMethod('npm', 'native'), null, 'r36 回归: 跨渠道裸解析仍回 null(r26-C1)');
    assert.equal(resolveUpdateMethod('npm', 'native', { allowCrossChannel: true }), 'npm-registry', 'r36 回归: 回执放行');
    assert.equal(resolveUpdateMethod(null, 'npm'), 'npm-registry', 'r36 回归: 未选 + npm 安装 → npm');
    assert.equal(isCrossChannel('npm', 'native'), true, 'r36 回归: 跨渠道判据不动');
    assert.equal(isCrossChannel('native', 'npm'), false, 'r36 回归: native 渠道 × npm 安装不算跨渠道');
  }

  // ── 接线哨兵:写了函数没接线 = 白改 ────────────────────────────────────
  {
    const routeBody = src.slice(src.indexOf("router.get('/claude-version-check'"), src.indexOf("router.post('/claude-update'"));
    assert.ok(routeBody.length > 200, 'r36: /claude-version-check 路由定位锚失效');
    assert.match(routeBody, /const srcKey = compareSrcKey\(method\)/, 'r36-①: 端点比较源必须走 compareSrcKey(method)');
    assert.ok(!/resolveSrcKey\(/.test(routeBody), 'r36-①: 端点不得再按显式渠道选比较源(变异:改回 resolveSrcKey(channel, method) 即红)');
    assert.match(routeBody, /^\s*path: claudePath,/m, 'r36-③: 响应必须透传 path(前端「检测对象」的数据源)');

    const putBody = src.slice(src.indexOf("router.put('/claude-update-channel'"), src.indexOf("router.post('/claude-install'"));
    assert.ok(putBody.length > 200, 'r36: PUT /claude-update-channel 定位锚失效');
    assert.match(putBody, /pickChannelInstall\(/, 'r36-②: PUT 渠道必须用 pickChannelInstall 挑该渠道的安装');
    assert.match(putBody, /setClaudeOverride\(/, 'r36-②: PUT 渠道必须真的钉选(复用 resolver 现有导出)');
    assert.match(putBody, /channelInstallMissing: true/, 'r36-②: 该渠道无安装时回执 channelInstallMissing(前端据此提示)');
    // ch=null(跟随)不许连带清掉用户手动钉的 claude —— 钉选只发生在 ch 为真时
    assert.match(putBody, /if \(ch\) \{/, 'r36-②: 钉选必须门控在显式渠道(ch=null 不动 override)');

    // 前端:检测对象 + 无安装提示 + 跨渠道文案补充
    assert.match(ui, /检测对象/, 'r36-③: 更新区必须显示「检测对象」(安装方式 + 路径)');
    assert.match(ui, /state\.path/, 'r36-③: 检测对象读响应的 path');
    assert.match(ui, /channelInstallMissing/, 'r36-③: 渠道切换必须处理 channelInstallMissing');
    assert.match(ui, /可能与上方显示的版本号不同/, 'r36-③: 跨渠道确认弹窗需说明装的是所选渠道的最新版');
  }
} finally {
  cleanupDirs(TMP_HOME);
}

console.log('PASS check-r36-channel-install');
