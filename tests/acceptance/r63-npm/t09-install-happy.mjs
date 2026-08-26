#!/usr/bin/env node
// r63-npm【正常路径 + 幂等 + 用户没想到的】§2.2 S6/S4 + §2.5 marker。
// 场景:用户第一次 `cc-gui`(装+开)、第二次 `cc-gui`(只开不装)。以及家目录带空格/中文这种
//      国内 Windows/Mac 上很常见、开发机上永远踩不到的路径。
// 关于退出码:本机 fixture 是个假 .app,/usr/bin/open 必然失败 → 收尾落码 7。所以这里断言
//      码 ∈ {0,7} 并把重点压在"装对了没、有没有残留、marker 对不对";码 0 的完整路径见 TEST-PLAN 人工项。
// Run: node tests/acceptance/r63-npm/t09-install-happy.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { V, fakeInstall, runLauncher, macPayload, appVersion, strays, mkTmp, t, skip, done } from './lib.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  skip('t09 全部用例', '安装流程只能在 darwin/arm64 真机跑');
  done('t09 安装正常路径');
}
const PAY = macPayload('good-' + V);
const okCode = (r) => assert.ok(r.code === 0 || r.code === 7,
  `期望 0(装完打开)或 7(假 .app 打不开),实际 ${r.code}\n${r.all}`);

await t('全新安装:应用落到 ~/Applications/CC-GUI.app,版本正确,stdout 说清装到哪', () => {
  const inst = fakeInstall({ payload: PAY });
  const r = runLauncher(inst);
  okCode(r);
  assert.ok(fs.existsSync(inst.appRoot), '应用没落到 ~/Applications/CC-GUI.app\n' + r.all);
  assert.equal(appVersion(inst.appRoot), V, '装进去的版本和包版本对不上');
  assert.ok(r.stdout.includes(`正在安装 CC-GUI v${V}…`), 'stdout:\n' + r.stdout);
  assert.ok(r.stdout.includes(`已安装到 ${inst.appRoot}`), 'stdout 必须给出绝对路径:\n' + r.stdout);
});

await t('【反向】安装成功后不留 .cc-gui-npm-* / .cc-gui-old-* / .cc-gui-lock-*(20MB 备份不许常驻)', () => {
  const inst = fakeInstall({ payload: PAY });
  runLauncher(inst);
  assert.deepEqual(strays(inst), [], '残留中间目录:' + strays(inst).join(','));
});

await t('marker 写在 ~/.claude-gui/npm-install.json,含 appPath + installedAt', () => {
  const inst = fakeInstall({ payload: PAY });
  runLauncher(inst);
  assert.ok(fs.existsSync(inst.marker), '没写 marker,应用内就认不出自己是 npm 装的');
  const m = JSON.parse(fs.readFileSync(inst.marker, 'utf8'));
  assert.equal(m.appPath, inst.appRoot, 'appPath 必须是绝对路径,§4.4 靠它做前缀判定');
  assert.ok(Number.isFinite(Date.parse(m.installedAt)), 'installedAt 应是可解析的时间戳,实际:' + m.installedAt);
  assert.ok(!fs.existsSync(path.join(inst.home, '.claude')), 'marker 绝不能落进 ~/.claude');
});

await t('【幂等】同版本再跑一次 → 不安装、不换目录、不重写 marker', () => {
  const inst = fakeInstall({ payload: PAY });
  runLauncher(inst);
  fs.writeFileSync(path.join(inst.appRoot, 'SENTINEL'), '1'); // 被换掉的话这个文件会消失
  const mt = fs.statSync(inst.marker).mtimeMs;
  const r2 = runLauncher(inst);
  okCode(r2);
  assert.ok(r2.stdout.includes(`CC-GUI v${V} 已是最新，正在打开…`), 'stdout:\n' + r2.stdout);
  assert.ok(!r2.stdout.includes('正在安装'), '同版本还重装一遍 = 每次启动白等十几秒');
  assert.ok(fs.existsSync(path.join(inst.appRoot, 'SENTINEL')), '应用目录被无谓地重装了');
  assert.equal(fs.statSync(inst.marker).mtimeMs, mt, 'S4 路径不该重写 marker(每次启动都写盘)');
  assert.deepEqual(strays(inst), []);
});

await t('【边界】家目录下还没有 Applications 目录 → 自动创建,安装照常成功', () => {
  const inst = fakeInstall({ payload: PAY, makeApplications: false });
  const r = runLauncher(inst);
  okCode(r);
  assert.ok(fs.existsSync(inst.appRoot), '~/Applications 不存在就装不上了\n' + r.all);
});

await t('【用户没想到】家目录路径带空格 + 中文 → 安装成功且 marker 路径正确', () => {
  const home = path.join(mkTmp('cn'), '张 三 的 用户目录');
  fs.mkdirSync(home, { recursive: true });
  const inst = fakeInstall({ payload: PAY, home });
  const r = runLauncher(inst);
  okCode(r);
  assert.ok(fs.existsSync(inst.appRoot), '带空格/中文的家目录装不上(多半是拼命令行没引号)\n' + r.all);
  assert.equal(JSON.parse(fs.readFileSync(inst.marker, 'utf8')).appPath, inst.appRoot);
});

if (!fs.existsSync('/Applications/CC-GUI.app')) skip('/Applications 另有一份的提示行', '本机 /Applications 下没有 CC-GUI.app,该分支留人工');
else await t('/Applications 下另有一份时,stdout 追加端口争用提示', () => {
  const inst = fakeInstall({ payload: PAY });
  const r = runLauncher(inst);
  assert.ok(r.stdout.includes('提示：/Applications 下另有一份 CC-GUI。'), 'stdout:\n' + r.stdout);
});

done('t09 安装正常路径');
