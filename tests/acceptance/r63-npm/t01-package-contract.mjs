#!/usr/bin/env node
// r63-npm【正常路径 + 反向断言】§1 npm 包结构契约。
// 场景:CI 拿到两个构建产物,跑组装脚本,产出三个待发布包。用户 `npm i -g` 装到的就是它们。
// 这里只看"包长什么样",不看启动器行为。
// Run: node tests/acceptance/r63-npm/t01-package-contract.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { V, MAIN, MACPKG, WINPKG, assemble, t, done } from './lib.mjs';

// 组装一次,后面各用例各自读文件断言(用例之间无依赖、可任意顺序)
const A = assemble();
assert.equal(A.r.code, 0, '组装脚本应成功退出:\n' + A.r.all);
const pkgOf = (d) => JSON.parse(fs.readFileSync(path.join(A.out, d, 'package.json'), 'utf8'));

await t('组装脚本 stdout 最后一行是 JSON,packages 顺序=发布顺序(两平台包在前、主包最后)', () => {
  const last = A.r.stdout.trim().split('\n').pop();
  const j = JSON.parse(last);
  assert.equal(j.version, V);
  assert.deepEqual(j.packages.map((p) => p.name), [MACPKG, WINPKG, MAIN],
    '主包必须最后发:平台包还没上架时主包的 optionalDependencies 会解析失败');
  // dir 允许相对/绝对,但必须指向 --out 下真实存在的那个包目录
  for (const p of j.packages) {
    const d = path.isAbsolute(p.dir) ? p.dir : path.join(A.out, path.basename(p.dir));
    assert.ok(fs.existsSync(path.join(d, 'package.json')), 'dir 必须指向真实包目录:' + p.dir);
  }
});

await t('主包 package.json 关键字段逐字符合契约', () => {
  const p = pkgOf('cc-gui');
  assert.equal(p.name, MAIN);
  assert.equal(p.version, V);
  assert.deepEqual(p.bin, { 'cc-gui': 'bin/cc-gui.js' });
  assert.equal(p.engines.node, '>=20');
  assert.equal(p.license, 'MIT');
  assert.equal(p.publishConfig.access, 'public');
  assert.equal(p.publishConfig.registry, 'https://registry.npmjs.org/');
  assert.deepEqual(p.files, ['bin/', 'lib/', 'README.md', 'LICENSE']);
});

await t('【反向】主包无 scripts —— --ignore-scripts 用户与普通用户拿到完全相同的结果', () => {
  const p = pkgOf('cc-gui');
  assert.ok(!('scripts' in p), '主包出现 scripts 字段 = postinstall 有活干 = 违反安全边界');
  assert.ok(!/postinstall|preinstall|prepare/.test(JSON.stringify(p)), '清单里不该出现任何安装期钩子');
});

await t('【反向】主包无 main / 无 exports / 未标 private', () => {
  const p = pkgOf('cc-gui');
  assert.ok(!('main' in p) && !('exports' in p), '主包不是库,不该有入口字段');
  assert.notEqual(p.private, true, 'private:true 会让 npm publish 直接拒发');
});

await t('optionalDependencies 是精确版本且等于主包版本(防半升级)', () => {
  const p = pkgOf('cc-gui');
  const keys = Object.keys(p.optionalDependencies).sort();
  assert.deepEqual(keys, [MACPKG, WINPKG].sort());
  for (const k of keys) {
    assert.equal(p.optionalDependencies[k], p.version, `${k} 必须钉死主包同版本`);
    assert.ok(!/[\^~*x><]/.test(p.optionalDependencies[k]), '范围符会让主包配到旧平台包:' + p.optionalDependencies[k]);
  }
});

done('t01 包结构契约');
