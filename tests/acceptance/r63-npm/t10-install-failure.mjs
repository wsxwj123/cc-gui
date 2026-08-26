#!/usr/bin/env node
// r63-npm【错误路径 + 反向断言】§2.2 S7:安装失败必须"退回原状",用户手里不能两手空空。
// 场景:tarball 传坏了、包结构变了、复核对不上版本。这类失败最怕的不是失败本身,
//      而是把用户已经能用的旧版本弄没了 —— 用户第二天要干活,应用打不开。
// Run: node tests/acceptance/r63-npm/t10-install-failure.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { V, fakeInstall, runLauncher, macPayload, preinstallApp, appVersion, strays, t, skip, done } from './lib.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  skip('t10 全部用例', '安装流程只能在 darwin/arm64 真机跑');
  done('t10 安装失败与回退');
}

/** 核心不变量:失败之后,用户要么手里还有能用的旧版,要么被明确告知旧版在哪、怎么改回来。 */
function stillUsable(inst, r, oldVer) {
  const alive = fs.existsSync(inst.appRoot) && fs.existsSync(path.join(inst.appRoot, 'MINE.txt'))
    && appVersion(inst.appRoot) === oldVer;
  if (alive) return;
  assert.ok(r.stderr.includes('新版本换入失败，且旧版本没能自动改回原位。')
    && /\.cc-gui-old-\d+/.test(r.stderr),
    '旧版没回到原位,又没告诉用户备份在哪 —— 用户的应用就这么没了:\n' + r.all);
}

for (const [kind, why] of [['badgz', 'tarball 传坏了(不是合法 gzip)'], ['noapp', '包里没有 *.app'],
  ['twoapp', '包里有两个 *.app,无法判断装哪个'], ['noexec', '.app 里 Contents/MacOS 下没有可执行文件']]) {
  await t(`安装失败:${why} → 码 6 + 明说"已保留原有版本"`, () => {
    const inst = fakeInstall({ payload: macPayload(kind) });
    preinstallApp(inst, '0.2.100');
    const r = runLauncher(inst);
    assert.equal(r.code, 6, '实际:\n' + r.all);
    assert.ok(r.stderr.includes(`CC-GUI v${V} 安装失败：`), 'stderr:\n' + r.stderr);
    assert.ok(r.stderr.includes('已保留原有版本，可继续使用。'), 'stderr:\n' + r.stderr);
    assert.ok(r.stderr.includes('https://github.com/wsxwj123/claude-gui/releases'), '要给手动下载的退路');
    stillUsable(inst, r, '0.2.100');
  });
}

await t(`【反向】安装失败后旧版本一字未动(版本文件仍是 0.2.100,自留文件还在)`, () => {
  const inst = fakeInstall({ payload: macPayload('badgz') });
  preinstallApp(inst, '0.2.100');
  const before = fs.readdirSync(inst.appRoot).sort().join('|');
  const r = runLauncher(inst);
  assert.equal(r.code, 6);
  assert.equal(fs.readdirSync(inst.appRoot).sort().join('|'), before, '旧应用目录内容被动过了');
  assert.equal(appVersion(inst.appRoot), '0.2.100');
});

await t('【反向】安装失败后不留中间目录、不写 marker(失败不许留半成品)', () => {
  const inst = fakeInstall({ payload: macPayload('noapp') });
  preinstallApp(inst, '0.2.100');
  runLauncher(inst);
  assert.deepEqual(strays(inst), [], '残留:' + strays(inst).join(','));
  assert.ok(!fs.existsSync(inst.marker), '装失败了却写了 marker,应用内会误判成 npm 安装');
});

await t('装完复核版本对不上(包说 V,解出来是 0.1.1)→ 码 6,不许报成功', () => {
  const inst = fakeInstall({ payload: macPayload('good-0.1.1') });
  preinstallApp(inst, '0.1.0');
  const r = runLauncher(inst);
  assert.equal(r.code, 6, '复核不过还报 0 = "装成功了但其实没装上",最难排查的一类假成功:\n' + r.all);
  stillUsable(inst, r, '0.1.0');
});

await t('全新机器上安装失败(没有旧版可退)→ 仍是码 6,且不留下半个应用', () => {
  const inst = fakeInstall({ payload: macPayload('badgz') });
  const r = runLauncher(inst);
  assert.equal(r.code, 6, '实际:\n' + r.all);
  assert.ok(!fs.existsSync(inst.appRoot), '留下一个解了一半的 CC-GUI.app,下次启动会被当成"已装"');
  assert.deepEqual(strays(inst), []);
});

done('t10 安装失败与回退');
