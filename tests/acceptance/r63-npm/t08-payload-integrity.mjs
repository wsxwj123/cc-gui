#!/usr/bin/env node
// r63-npm【边界 + 错误路径】§2.2 S3:包内产物缺失/截断。含体积下限的临界值。
// 场景:npm 半途断网留下一个 0 字节 tarball;或者磁盘满写了一半。下限设成 14MB 就是为了
//      让"6MB 的残缺包"落在"包内产物损坏(码 4,让你重装)"而不是"安装失败(码 6,让你去 GitHub)"。
// Run: node tests/acceptance/r63-npm/t08-payload-integrity.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { V, MAC_MIN, fakeInstall, runLauncher, mkTmp, macPayload, strays, t, skip, done } from './lib.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  skip('t08 全部用例', '载荷完整性检查只能在 darwin/arm64 真机跑(本机 ' + process.platform + '/' + process.arch + ')');
  done('t08 载荷完整性');
}

function sized(name, bytes) { // 稀疏文件:只要 st_size 对得上,秒建
  const p = path.join(mkTmp('payload'), name);
  fs.writeFileSync(p, '');
  fs.truncateSync(p, bytes);
  return p;
}

await t('载荷文件根本不存在 → 码 4 + 打出载荷绝对路径', () => {
  const inst = fakeInstall({ payload: null });
  const r = runLauncher(inst);
  assert.equal(r.code, 4, '实际:\n' + r.all);
  assert.ok(r.stderr.includes('安装包文件缺失或不完整：'), '实际:\n' + r.stderr);
  assert.ok(r.stderr.includes('CC-GUI.app.tar.gz'), 'stderr 要指出是哪个文件,不然用户无从下手');
  assert.ok(r.stderr.includes('npx @wsxwj123/cc-gui@latest'), '得给重装命令');
});

for (const bytes of [0, 1, 1024, MAC_MIN - 1]) {
  await t(`载荷体积 ${bytes} < 14MB 下限 → 码 4(不是码 6)`, () => {
    const inst = fakeInstall({ payload: sized('CC-GUI.app.tar.gz', bytes) });
    const r = runLauncher(inst);
    assert.equal(r.code, 4, `残缺包必须报"包内产物损坏"让用户重装,而不是"安装失败"让他去 GitHub\n${r.all}`);
    assert.ok(r.stderr.includes('安装包文件缺失或不完整：'), '实际:\n' + r.stderr);
  });
}

await t('临界值:载荷恰好 14MB → 放行体积检查(之后因为不是合法 gzip 落码 6,不是码 4)', () => {
  const inst = fakeInstall({ payload: sized('CC-GUI.app.tar.gz', MAC_MIN) });
  const r = runLauncher(inst);
  assert.notEqual(r.code, 4, '「低于下限」是 <,恰好等于下限不该被判损坏:\n' + r.all);
  assert.equal(r.code, 6, '实际:\n' + r.all);
});

await t('【反向】S3 失败后不留任何中间目录,也不写 marker', () => {
  const inst = fakeInstall({ payload: sized('CC-GUI.app.tar.gz', 1024) });
  runLauncher(inst);
  assert.deepEqual(strays(inst), [], '~/Applications 下残留了中间目录');
  assert.ok(!fs.existsSync(inst.marker), '没装成功就写 marker,会让应用内更新提示走错分支');
});

await t('【反向】整条安装流程跑完也不得创建 ~/.claude(写入范围红线)', () => {
  const inst = fakeInstall({ payload: macPayload('good-' + V) });
  runLauncher(inst);
  assert.ok(!fs.existsSync(path.join(inst.home, '.claude')), '启动器碰了 ~/.claude,越过了写入范围红线');
});

done('t08 载荷完整性');
