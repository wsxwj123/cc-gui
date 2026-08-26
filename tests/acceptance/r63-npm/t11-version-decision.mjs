#!/usr/bin/env node
// r63-npm【边界 + 反向断言】§2.3 已装版本探测 + 只升不降。
// 场景:用户在应用内点过"自动更新"装到了更高版本,然后又跑了一次 cc-gui —— 绝不能被降级回去。
//      以及版本文件读不到/坏了时,要静悄悄当作"没装过"继续,而不是报错拦住用户。
// 手法:这里断言的是"决策"(装还是不装),看 stdout 那句话,不依赖后续 open 的成败。
// Run: node tests/acceptance/r63-npm/t11-version-decision.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { V, fakeInstall, runLauncher, macPayload, preinstallApp, t, skip, done } from './lib.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  skip('t11 全部用例', '安装流程只能在 darwin/arm64 真机跑');
  done('t11 版本判定');
}
const PAY = macPayload('good-' + V);
const VERFILE = 'Contents/Resources/_up_/package.json';
const decided = (r) => (r.stdout.includes('正在安装') ? 'install' : r.stdout.includes('已是最新') ? 'open-only' : 'other:' + r.all);

await t('只升不降:已装 0.9.9 高于包版本 → 不安装,直接打开', () => {
  const inst = fakeInstall({ payload: PAY });
  preinstallApp(inst, '0.9.9');
  const r = runLauncher(inst);
  assert.equal(decided(r), 'open-only', '把用户从 0.9.9 降级回 ' + V + ' 了');
  assert.ok(r.stdout.includes('CC-GUI v0.9.9 已是最新，正在打开…'), 'stdout:\n' + r.stdout);
  assert.ok(fs.existsSync(path.join(inst.appRoot, 'MINE.txt')), '应用被换掉了');
});

await t('已装版本更低 → 安装', () => {
  const inst = fakeInstall({ payload: PAY });
  preinstallApp(inst, '0.2.352');
  assert.equal(decided(runLauncher(inst)), 'install');
});

await t('【边界】版本按数值逐位比,不是字符串比:已装 0.10.0 vs 包 0.9.0 → 不安装', () => {
  const inst = fakeInstall({ payload: PAY, version: '0.9.0' });
  preinstallApp(inst, '0.10.0');
  const r = runLauncher(inst);
  assert.equal(decided(r), 'open-only', '字符串比较会认为 "0.9.0" > "0.10.0",于是把用户降级');
});

await t('【边界】已装 0.9.0 vs 包 0.10.0 → 安装(同一处比较的反向)', () => {
  const inst = fakeInstall({ payload: PAY, version: '0.10.0' });
  preinstallApp(inst, '0.9.0');
  assert.ok(runLauncher(inst).stdout.includes('正在安装 CC-GUI v0.10.0…'));
});

for (const [name, mutate] of [
  ['版本文件不存在', (a) => fs.rmSync(path.join(a, VERFILE))],
  ['版本文件是坏 JSON', (a) => fs.writeFileSync(path.join(a, VERFILE), '{ 这不是 json')],
  ['版本文件里没有 version 字段', (a) => fs.writeFileSync(path.join(a, VERFILE), '{"name":"claude-gui"}')],
  ['版本文件是空文件', (a) => fs.writeFileSync(path.join(a, VERFILE), '')],
]) {
  await t(`【边界】${name} → 当作未安装继续走安装,不报错不中断`, () => {
    const inst = fakeInstall({ payload: PAY });
    preinstallApp(inst, '0.2.100');
    mutate(inst.appRoot);
    const r = runLauncher(inst);
    assert.equal(decided(r), 'install', '读不到版本就该重装一遍,而不是拦住用户:\n' + r.all);
    assert.ok(!/Unexpected token|SyntaxError|ENOENT/.test(r.stderr), '把底层异常糊到用户脸上了:\n' + r.stderr);
  });
}

await t('【边界】已装版本含非数字段 0.2.abc → 非数字段按 0 处理 → 判定为更旧,安装', () => {
  const inst = fakeInstall({ payload: PAY });
  preinstallApp(inst, '0.2.abc');
  assert.equal(decided(runLauncher(inst)), 'install');
});

await t('【边界】已装版本段数不足 0.2 → 缺的段按 0,判定为更旧,安装', () => {
  const inst = fakeInstall({ payload: PAY });
  preinstallApp(inst, '0.2');
  assert.equal(decided(runLauncher(inst)), 'install');
});

done('t11 版本判定');
