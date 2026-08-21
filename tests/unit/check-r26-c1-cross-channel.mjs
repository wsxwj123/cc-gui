#!/usr/bin/env node
// r26-C1【单测】:跨渠道 npm 警告/确认。
// 背景:resolveUpdateMethod 对 channel='npm' 无条件回 'npm-registry';npm-registry 自检
// `claude --version` 走 PATH,native 安装用户命中旧 native 版 → 0 退出码假成功。
// 验收点(PLAN C1):
//   ①crossChannel 判据纯函数(isCrossChannel)四象限断言;
//   ②npm-registry 命令串含 npm prefix -g(mac/linux 哨兵 —— 自检钉到刚装的安装);
//   ③native 渠道 + npm 安装【不】标 crossChannel(防误报哨兵);
//   ④resolveUpdateMethod 跨渠道裸解析回 null,显式确认回执(allowCrossChannel)才放行;
//   ⑤服务端双 POST 裸调用拒绝钉(409 / error 帧)+ 前端确认弹窗钉。
// Run: node tests/unit/check-r26-c1-cross-channel.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTmpHome, cleanupDirs } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('c1-unit'); // version-check 顶层固化 PREFS_FILE,先隔离 HOME

const realPlatform = process.platform;
const setPlatform = (v) => Object.defineProperty(process, 'platform', { value: v, configurable: true });

try {
  const { isCrossChannel, resolveUpdateMethod, updateCmdFor } = await import('../../server/routes/version-check.js');

  // ①四象限:仅「显式 npm 渠道 × 非 npm 安装」算跨渠道
  assert.equal(isCrossChannel('npm', 'native'), true, 'C1: npm 渠道 × native 安装 = 跨渠道');
  assert.equal(isCrossChannel('npm', 'brew'), true, 'C1: npm 渠道 × brew 安装 = 跨渠道');
  assert.equal(isCrossChannel('npm', 'npm'), false, 'C1: npm 渠道 × npm 安装 = 一致,不标');
  // ③防误报哨兵:native 渠道 × npm 安装走官方自更新,不算跨渠道
  assert.equal(isCrossChannel('native', 'npm'), false, 'C1: native 渠道 × npm 安装不得误标(官方支持路径)');
  assert.equal(isCrossChannel(null, 'native'), false, 'C1: 未选渠道不标(跟随安装方式)');

  // ④裸解析回 null;显式确认回执放行
  assert.equal(resolveUpdateMethod('npm', 'native'), null, 'C1: 跨渠道裸解析必须回 null(不静默给 npm-registry)');
  assert.equal(resolveUpdateMethod('npm', 'brew'), null, 'C1: brew 安装 × npm 渠道同回 null');
  assert.equal(resolveUpdateMethod('npm', 'native', { allowCrossChannel: true }), 'npm-registry',
    'C1: 显式确认回执(前端弹窗)才放行 npm-registry');
  // 一致组合与跟随语义不变(回归)
  assert.equal(resolveUpdateMethod('npm', 'npm'), 'npm-registry', 'C1: npm × npm 走 npm');
  assert.equal(resolveUpdateMethod('native', 'npm'), 'native', 'C1: native × npm 走原生自更新');
  assert.equal(resolveUpdateMethod(null, 'npm'), 'npm-registry', 'C1: 未选跟随 npm 安装');
  assert.equal(resolveUpdateMethod(null, 'native'), 'native', 'C1: 未选跟随 native 安装');

  // ②mac/linux 自检钉到 npm 前缀里的新二进制(防 PATH 命中旧安装假成功)
  setPlatform('darwin');
  {
    const cmd = updateCmdFor('npm-registry', '/x/claude');
    assert.match(cmd, /npm install -g @anthropic-ai\/claude-code@latest/, 'C1: 仍走 npm 安装');
    assert.match(cmd, /"\$\(npm prefix -g\)\/bin\/claude" --version/, 'C1: 自检必须钉到 npm 前缀的新安装(假成功哨兵)');
  }
  setPlatform('win32');
  {
    const cmd = updateCmdFor('npm-registry', 'C:\\x\\claude.cmd');
    assert.match(cmd, /^call npm install -g/, 'C1: win 保持 call 前缀(.bat 调 .cmd 控制权)');
    assert.match(cmd, /call claude --version/, 'C1: win 自检保持 call claude --version(跨渠道风险由前端弹窗兜)');
  }
  setPlatform(realPlatform);

  // ⑤服务端钉:两个执行入口裸调用都拒绝,确认回执才放行
  const src = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  const termRoute = src.slice(src.indexOf("router.post('/claude-update'"), src.indexOf("router.post('/claude-update/stream'"));
  assert.match(termRoute, /res\.status\(409\)\.json\(\{[\s\S]*?crossChannel: true/, 'C1: 终端更新入口裸跨渠道必须 409');
  assert.match(termRoute, /allowCrossChannel: req\.body\?\.allowCrossChannel === true/, 'C1: 终端入口认确认回执');
  const streamRoute = src.slice(src.indexOf("router.post('/claude-update/stream'"), src.indexOf("router.post('/claude-update/attach'"));
  assert.match(streamRoute, /allowCrossChannel: req\.body\?\.allowCrossChannel === true/, 'C1: 流入口认确认回执');
  assert.match(streamRoute, /if \(!resolved\) \{[\s\S]*?throw new Error\('更新渠道\(npm\)与当前安装方式不一致/, 'C1: 流入口裸跨渠道必须 error 收尾(不起进程)');
  // 响应组装钉:crossChannel 标记下发
  const checkRoute = src.slice(src.indexOf("router.get('/claude-version-check'"), src.indexOf("router.post('/claude-update'"));
  assert.match(checkRoute, /crossChannel: isCrossChannel\(channel, method\)/, 'C1: /claude-version-check 响应必须带 crossChannel 标记');

  // 前端钉:确认弹窗 + 回执下发
  const ui = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
  assert.match(ui, /state\.crossChannel/, 'C1: 前端更新按钮必须按 crossChannel 分流');
  assert.match(ui, /与当前安装是两份;PATH 里先生效的仍是当前安装/, 'C1: 确认弹窗必须明示两份安装与 PATH 生效序');
  assert.match(ui, /doUpdateStream\(\{ allowCrossChannel: true \}\)/, 'C1: 确认后必须带回执下发');
  assert.match(ui, /body: JSON\.stringify\(\{ allowCrossChannel: true \}\)/, 'C1: 回执进请求体');
} finally {
  setPlatform(realPlatform);
  cleanupDirs(TMP_HOME);
}

console.log('PASS check-r26-c1-cross-channel');
