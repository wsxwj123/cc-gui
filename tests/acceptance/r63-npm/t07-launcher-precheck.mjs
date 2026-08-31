#!/usr/bin/env node
// r63-npm【错误路径 + 判据顺序】§2.2 S0/S1/S2:Node 太老、平台不支持、平台包没装上。
// 场景:用户手里的 node 是 18;用户是 Intel Mac 或 Windows ARM;用户 `npm i --ignore-optional`
//      或撞上镜像同步窗口,主包装上了平台包没装上。三种都必须给确定的码 + 说人话的指路。
// 手法:用 node -e 覆写 process.versions.node / platform / arch,再 require 真实 bin,
//      走的是完全真实的入口(不 import 内部函数)。
// Run: node tests/acceptance/r63-npm/t07-launcher-precheck.mjs
import assert from 'node:assert/strict';
import { P, MACPKG, need, node, fakeInstall, t, skip, done } from './lib.mjs';

function runWith(bin, o = {}) {
  const pre = [];
  if (o.nodeVersion) pre.push(`Object.defineProperty(process.versions,'node',{value:${JSON.stringify(o.nodeVersion)},configurable:true});`);
  if (o.platform) pre.push(`Object.defineProperty(process,'platform',{value:${JSON.stringify(o.platform)},configurable:true});`);
  if (o.arch) pre.push(`Object.defineProperty(process,'arch',{value:${JSON.stringify(o.arch)},configurable:true});`);
  return node(['-e', pre.join('') + `require(${JSON.stringify(bin)});`],
    { env: { ...process.env, HOME: o.home || process.env.HOME } });
}
const probe = node(['-e', "Object.defineProperty(process,'platform',{value:'linux',configurable:true});" +
  "Object.defineProperty(process.versions,'node',{value:'18.19.0',configurable:true});" +
  'process.stdout.write(process.platform+" "+process.versions.node)']);
const CAN_FAKE = probe.stdout.trim() === 'linux 18.19.0';
const BIN = need(P.bin, 'npm/bin/cc-gui.js 启动器薄壳');
const inst = fakeInstall({ platformPkg: false });

if (!CAN_FAKE) skip('S0/S1 覆写用例', '本机 Node 不允许覆写 process.platform/versions:' + probe.all.trim());
else {
  for (const v of ['12.22.12', '16.20.2', '18.19.0', '19.9.0']) {
    await t(`S0 Node ${v} < 20 → 码 3 + 说清当前版本`, () => {
      const r = runWith(BIN, { nodeVersion: v, home: inst.home });
      assert.equal(r.code, 3, 'stderr:\n' + r.stderr);
      assert.ok(r.stderr.includes(`CC-GUI 需要 Node.js 20 或更高版本，当前是 v${v}。`), '实际:\n' + r.stderr);
      assert.ok(r.stderr.includes('https://nodejs.org/en/download'), '必须给下载地址');
      assert.equal(r.stdout, '', 'Node 版本错误只能走 stderr');
    });
  }
  await t('S0 边界:Node 20.0.0 恰好达标,不该被拦(它得往下走,不能是码 3)', () => {
    const r = runWith(BIN, { nodeVersion: '20.0.0', home: inst.home });
    assert.notEqual(r.code, 3, '20.0.0 被误判成过低');
  });

  for (const [p, a] of [['linux', 'x64'], ['darwin', 'x64'], ['win32', 'arm64'], ['win32', 'ia32'], ['freebsd', 'arm64'], ['linux', 'arm64']]) {
    await t(`S1 ${p}/${a} 不受支持 → 码 2 + 逐字文案`, () => {
      const r = runWith(BIN, { platform: p, arch: a, home: inst.home });
      assert.equal(r.code, 2, 'stderr:\n' + r.stderr);
      assert.ok(r.stderr.includes(`CC-GUI 暂不支持当前系统：${p}/${a}。`), '实际:\n' + r.stderr);
      assert.ok(r.stderr.includes('目前支持：macOS（Apple Silicon）与 Windows（x64）。'), '实际:\n' + r.stderr);
    });
  }

  await t('判据顺序:Node 太老 + 平台也不支持 → 必须先报 Node(码 3),不是码 2', () => {
    const r = runWith(BIN, { nodeVersion: '16.20.2', platform: 'linux', arch: 'x64', home: inst.home });
    assert.equal(r.code, 3, 'Node 太老时连平台判断都不该跑到:\n' + r.all);
  });

  await t('判据顺序:平台不支持 + 平台包当然也缺 → 报平台(码 2),不是码 4', () => {
    const r = runWith(inst.bin, { platform: 'linux', arch: 'x64', home: inst.home });
    assert.equal(r.code, 2, '实际:\n' + r.all);
  });
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') skip('S2 平台包缺失', '本机非 darwin/arm64,真机跑此条需 Apple Silicon');
else await t('S2 平台包缺失 → 码 4 + 两条可执行的出路(重装 / 换官方源)', () => {
  const r = node([inst.bin], { env: { ...process.env, HOME: inst.home }, cwd: inst.dir });
  assert.equal(r.code, 4, '实际:\n' + r.all);
  assert.ok(r.stderr.includes(`没找到当前平台的安装包（${MACPKG}）`), '实际:\n' + r.stderr);
  assert.ok(r.stderr.includes('npx @wsxwj123/cc-gui@latest'), '得给出重装命令');
  // 镜像按需同步、可能一直缺,"过一会儿再试"是无效指令 —— 第二条出路必须是能立刻执行的命令
  assert.ok(r.stderr.includes('镜像源上还没有这个版本的平台包'), '必须点明第二种可能:镜像源缺平台包');
  assert.ok(r.stderr.includes('--registry=https://registry.npmjs.org'),
    '光说"是镜像的锅"没用,得给出换官方源的确切命令');
});

done('t07 启动器前置判定');
