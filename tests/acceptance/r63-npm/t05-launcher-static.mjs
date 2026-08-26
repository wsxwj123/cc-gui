#!/usr/bin/env node
// r63-npm【契约检查(静态)】§1.1 薄壳 ES5 纯度 + §5 安全边界 + Windows 半边(mac 上跑不到,只能查源码)。
// 场景:老 Node 用户、离线用户、以及"启动器会不会偷偷联网/动我的 ~/.claude"。
// Run: node tests/acceptance/r63-npm/t05-launcher-static.mjs
import assert from 'node:assert/strict';
import { P, read, t, done } from './lib.mjs';

const bin = read(P.bin, 'npm/bin/cc-gui.js 启动器薄壳');
const lib = read(P.lib, 'npm/lib/main.js 启动器主体');
const both = { 'bin/cc-gui.js': bin, 'lib/main.js': lib };

await t('薄壳 ES5 纯度:出现任一 ES6+ 语法,老 Node 会先 SyntaxError,根本打不出"请升级 Node"', () => {
  const banned = [[/\?\./, '?.'], [/\?\?/, '??'], [/=>/, '=>'], [/`/, '模板串'],
    [/\bconst\b/, 'const'], [/\blet\b/, 'let'], [/\basync\b/, 'async']];
  const hit = banned.filter(([re]) => re.test(bin)).map(([, n]) => n);
  assert.deepEqual(hit, [], 'bin/cc-gui.js 含 ES6+ 语法:' + hit.join(' '));
});

await t('薄壳只做两件事:先判 Node 版本,再 require ../lib/main.js', () => {
  assert.ok(/require\(\s*['"]\.\.\/lib\/main\.js['"]\s*\)/.test(bin), '薄壳必须 require ../lib/main.js');
  const iMsg = bin.indexOf('CC-GUI 需要 Node.js 20 或更高版本');
  const iReq = bin.search(/require\(\s*['"]\.\.\/lib\/main\.js['"]\s*\)/);
  assert.ok(iMsg >= 0, '薄壳里必须有 Node 版本文案(放到 lib 里就来不及了)');
  assert.ok(iMsg < iReq, '版本判断必须在 require 之前,否则 lib 的新语法先炸');
});

await t('【反向】启动器没有任何网络能力(两个文件都扫)', () => {
  const re = /fetch\(|https?\.(get|request)|require\(['"](http|https|net|dns|tls)['"]\)|curl|wget|Invoke-WebRequest|bitsadmin/;
  for (const [n, s] of Object.entries(both)) {
    const hits = s.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l));
    assert.deepEqual(hits.map(([i, l]) => i + ':' + l.trim()), [],
      `${n} 出现联网痕迹 = 破了"安装字节只能来自包内"的红线`);
  }
});

await t('【反向】启动器不触碰 ~/.claude(.claude-gui 因带连字符不算)', () => {
  for (const [n, s] of Object.entries(both)) {
    const hits = s.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.claude([^-]|$)/.test(l));
    assert.deepEqual(hits.map(([i, l]) => i + ':' + l.trim()), [], `${n} 碰了 ~/.claude`);
  }
});

await t('mac 安装只用 tar 解包 + rename 换入,禁 cp -R / ditto(会破坏签名或留残留导致 FDA 失效)', () => {
  assert.ok(lib.includes('/usr/bin/tar'), '解包必须用 /usr/bin/tar 绝对路径');
  assert.ok(lib.includes('/usr/bin/open'), '启动必须用 /usr/bin/open 绝对路径');
  assert.ok(lib.includes('/usr/bin/pgrep'), '运行检测必须用 /usr/bin/pgrep');
  assert.ok(!/\bcp\s+-R\b/.test(lib), 'cp -R 会破坏 .app 签名');
  assert.ok(!/\bditto\b/.test(lib), 'ditto 叠加进已存在 bundle 会留旧文件、seal 失效 → FDA 失效');
});

await t('【待双平台·契约检查】Windows 分支参数按约定拼装', () => {
  assert.ok(/['"]\/S['"]/.test(lib), 'NSIS 必须静默安装(/S),否则用户会看到安装向导');
  assert.ok(lib.includes('300000'), '安装超时必须 5 分钟,防不可见对话框把进程挂死');
  assert.ok(/windowsHide/.test(lib), '必须 windowsHide,不然会闪黑框');
  assert.ok(/detached/.test(lib) && /unref\(\)/.test(lib), '不 detach+unref 的话用户终端会被 GUI 占住');
  assert.ok(!/\/D=/.test(lib), '不得传 /D=:覆盖升级要让 NSIS 沿用上次目录');
  assert.ok(!/cmd\s+\/c|\bstart\s+""/.test(lib), '多一层 shell 只会引来引号转义坑');
  assert.ok(!/%ProgramFiles%/i.test(lib), 'currentUser 安装不可能落到 ProgramFiles,留着是想象需求');
  for (const c of ['LOCALAPPDATA']) assert.ok(lib.includes(c), '候选目录表必须基于 %LOCALAPPDATA%');
});

done('t05 启动器静态契约');
