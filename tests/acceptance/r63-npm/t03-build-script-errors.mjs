#!/usr/bin/env node
// r63-npm【错误路径】§3.3 组装脚本的错误契约。每条都断言:exit 1 + stderr 那句中文原文 + 不留半成品目录。
// 场景:CI 里构建缺了一半、版本对不上、产物截断——脚本必须在发布之前就把 job 顶红,
//      而不是组装出一个"能发但装不上"的包。
// Run: node tests/acceptance/r63-npm/t03-build-script-errors.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { V, assemble, makeArtifacts, mkTmp, macPayload, winPayload, makeApp, run, rmrf, t, done } from './lib.mjs';

function expectFail(res, needles) {
  assert.equal(res.r.code, 1, `应 exit 1,实际 ${res.r.code}\nstdout:${res.r.stdout}\nstderr:${res.r.stderr}`);
  for (const n of needles) assert.ok(res.r.stderr.includes(n), `stderr 应含「${n}」,实际:\n${res.r.stderr}`);
  const left = fs.existsSync(res.out) ? fs.readdirSync(res.out) : [];
  assert.deepEqual(left, [], '失败时不得留下半成品目录,实际残留:' + left.join(','));
}

await t('--artifacts 目录不存在 → 产物目录不存在', () => {
  const ghost = path.join(mkTmp('ghost'), 'nope');
  expectFail(assemble({ artifacts: ghost }), ['产物目录不存在：', ghost]);
});

await t('--out 目录已存在 → 报错退出,且【反向】绝不递归删掉里面已有的东西', () => {
  const out = path.join(mkTmp('out'), 'npm-dist');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, '重要文件.txt'), '别删我');
  const res = assemble({ out });
  assert.equal(res.r.code, 1);
  assert.ok(res.r.stderr.includes('输出目录已存在，请先手动清理：'), '实际:\n' + res.r.stderr);
  assert.equal(fs.readFileSync(path.join(out, '重要文件.txt'), 'utf8'), '别删我', '脚本把用户目录清空了 = 数据丢失');
});

const ART = makeArtifacts(); // 版本形态用例共用同一份合法产物,只变 --version
for (const bad of ['1.2', '1.2.3.4', '0.2.353-beta.1', 'v0.2.353', '0.2.x', '']) {
  await t(`--version 形态非法「${bad || '<空>'}」→ 版本号格式非法`, () => {
    const out = path.join(mkTmp('out'), 'npm-dist');
    const r = assemble({ out, artifacts: ART, args: ['--artifacts', ART, '--out', out, '--version', bad] });
    expectFail(r, ['版本号格式非法：']);
  });
}

await t('【边界】--version 合法极值(0.0.0 / 超长段)只按正则判,不额外挑剔', () => {
  const out = path.join(mkTmp('out'), 'npm-dist');
  const r = assemble({ out, version: '0.0.0', args: ['--artifacts', makeArtifacts({ version: '0.0.0' }), '--out', out, '--version', '0.0.0'] });
  assert.equal(r.r.code, 0, '0.0.0 符合 ^\\d+\\.\\d+\\.\\d+$,应正常组装:\n' + r.r.all);
});

await t('缺 *.app.tar.gz → macOS 构建可能失败', () => {
  expectFail(assemble({ mac: null }), ['产物目录里没有 *.app.tar.gz（macOS 构建可能失败）']);
});

await t('缺 *-setup.exe → Windows 构建可能失败', () => {
  expectFail(assemble({ win: null }), ['产物目录里没有 *-setup.exe（Windows 构建可能失败）']);
});

await t('exe 文件名里的版本 ≠ --version → 拒绝组装(防把上一版的 exe 发成新版)', () => {
  const wrong = `CC-GUI_0.1.1_x64-setup.exe`;
  expectFail(assemble({ winName: wrong }), ['Windows 安装包版本不符：文件名 ', wrong, '期望 ' + V]);
});

await t('tgz 里的 mac 应用版本 ≠ --version → 拒绝组装', () => {
  expectFail(assemble({ mac: macPayload('good-0.1.1') }), ['macOS 应用包版本不符：包内 0.1.1', '期望 ' + V]);
});

await t('mac 产物体积异常偏小(截断的 tar.gz)→ 疑似构建失败', () => {
  const tiny = path.join(mkTmp('tiny'), 'CC-GUI.app.tar.gz');
  const stage = mkTmp('stage');
  makeApp(stage, 'CC-GUI.app', V);
  assert.equal(run('/usr/bin/tar', ['-czf', tiny, '-C', stage, '.']).code, 0);
  expectFail(assemble({ mac: tiny }), ['产物体积异常偏小，疑似构建失败：']);
});

await t('win 产物体积异常偏小 → 疑似构建失败', () => {
  expectFail(assemble({ win: winPayload(1 << 20) }), ['产物体积异常偏小，疑似构建失败：']);
});

done('t03 组装脚本错误契约');
