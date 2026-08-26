#!/usr/bin/env node
// r63-npm【正常路径 + 边界】§1.2/1.3/1.4 平台分包契约,以及"用户真正下载到的那些字节"。
// 场景:npm 按 os/cpu 决定装哪个分包;装错或装不全,启动器就找不到安装包。
// Run: node tests/acceptance/r63-npm/t02-platform-packages.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { V, MAIN, MACPKG, WINPKG, MAC_MIN, WIN_MIN, assemble, run, t, done } from './lib.mjs';

const A = assemble();
assert.equal(A.r.code, 0, '组装脚本应成功退出:\n' + A.r.all);
const dirOf = (n) => path.join(A.out, n.replace('@wsxwj123/', ''));
const pkgOf = (n) => JSON.parse(fs.readFileSync(path.join(dirOf(n), 'package.json'), 'utf8'));

await t('mac 分包:name/os/cpu/files 逐字符合,且只声明一个平台一个架构', () => {
  const p = pkgOf(MACPKG);
  assert.equal(p.name, MACPKG);
  assert.equal(p.version, V);
  assert.deepEqual(p.os, ['darwin'], 'os 多一项都会让 npm 在别的平台上也装这 20MB');
  assert.deepEqual(p.cpu, ['arm64']);
  assert.deepEqual(p.files, ['CC-GUI.app.tar.gz']);
  assert.equal(p.publishConfig.access, 'public');
});

await t('win 分包:name/os/cpu/files 逐字符合', () => {
  const p = pkgOf(WINPKG);
  assert.equal(p.name, WINPKG);
  assert.equal(p.version, V);
  assert.deepEqual(p.os, ['win32']);
  assert.deepEqual(p.cpu, ['x64']);
  assert.deepEqual(p.files, ['CC-GUI-setup.exe']);
});

await t('【反向】两个分包都没有 scripts / exports / main / bin', () => {
  for (const n of [MACPKG, WINPKG]) {
    const p = pkgOf(n);
    assert.ok(!('scripts' in p), n + ' 出现 scripts:安装期就有副作用了');
    assert.ok(!('exports' in p), n + ' 出现 exports:启动器的 require.resolve(包名/package.json) 会解析失败');
    assert.ok(!('main' in p) && !('bin' in p), n + ' 是字节容器,不是可执行入口');
  }
});

await t('三个包版本严格一致(防半升级)', () => {
  const vs = [MAIN, MACPKG, WINPKG].map((n) => pkgOf(n).version);
  assert.deepEqual(vs, [V, V, V], '任一包版本漂移都会造出"主包新、平台包旧"的半升级态');
});

await t('载荷用固定名落在分包里:CC-GUI.app.tar.gz / CC-GUI-setup.exe(exe 去掉版本号)', () => {
  const mac = path.join(dirOf(MACPKG), 'CC-GUI.app.tar.gz');
  const win = path.join(dirOf(WINPKG), 'CC-GUI-setup.exe');
  assert.ok(fs.existsSync(mac), 'mac 载荷名必须固定,启动器按固定名找');
  assert.ok(fs.existsSync(win), 'win 载荷必须改成不带版本号的固定名');
  assert.ok(!fs.readdirSync(dirOf(WINPKG)).some((f) => /_x64-setup\.exe$/.test(f)), '不该把带版本号的原名也留下');
});

await t('载荷体积过 S3 下限(mac ≥14MB / win ≥50MB)', () => {
  assert.ok(fs.statSync(path.join(dirOf(MACPKG), 'CC-GUI.app.tar.gz')).size >= MAC_MIN);
  assert.ok(fs.statSync(path.join(dirOf(WINPKG), 'CC-GUI-setup.exe')).size >= WIN_MIN);
});

await t('npm pack --dry-run:主包恰好 5 个文件,分包恰好 2 个', () => {
  const filesOf = (dir) => {
    const r = run('npm', ['pack', '--dry-run', '--json', dir], { cwd: dir });
    assert.equal(r.code, 0, 'npm pack 失败:' + r.all);
    return JSON.parse(r.stdout)[0].files.map((f) => f.path).sort();
  };
  assert.deepEqual(filesOf(dirOf(MAIN)),
    ['LICENSE', 'README.md', 'bin/cc-gui.js', 'lib/main.js', 'package.json'],
    '主包多一个文件就是多一份要审的字节;少一个就是装完跑不起来');
  assert.deepEqual(filesOf(dirOf(MACPKG)), ['CC-GUI.app.tar.gz', 'package.json']);
  assert.deepEqual(filesOf(dirOf(WINPKG)), ['CC-GUI-setup.exe', 'package.json']);
});

done('t02 平台分包契约');
