#!/usr/bin/env node
// r63【单测】组装脚本契约 + 安全边界断言(INTERFACE §5 全表自动化):
//   - 假产物目录真跑 scripts/build-npm-packages.mjs,断言三个 package.json 字段契约
//     (精确版本配对 / os / cpu / 无 scripts / 无 exports / files 清单);
//   - 私有产物拒收:含 bots.local.js 的假 tgz → exit 1 且零产出;
//   - 本地组装带 .local-assembly 标记;
//   - 薄壳 ES5 纯度;启动器零网络 / 不触碰 CLI 配置目录;workflow token 卫生。
// fixture 复用验收公共库(tests/acceptance/r63-npm/lib.mjs,只读 import 不改动)。
// Run: node tests/unit/check-npm-assemble.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { V, MAIN, MACPKG, WINPKG, P, read, assemble, macPayload, t, done } from '../acceptance/r63-npm/lib.mjs';

// ── 正常组装:三个 package.json 的字段契约 ───────────────────
const A = assemble();
assert.equal(A.r.code, 0, '组装应成功:\n' + A.r.all);
const pkgOf = (d) => JSON.parse(fs.readFileSync(path.join(A.out, d, 'package.json'), 'utf8'));

await t('主包字段:bin/engines/files/publishConfig + optionalDependencies 精确配对', () => {
  const p = pkgOf('cc-gui');
  assert.equal(p.name, MAIN);
  assert.equal(p.version, V);
  assert.deepEqual(p.bin, { 'cc-gui': 'bin/cc-gui.js' });
  assert.equal(p.engines.node, '>=20');
  assert.deepEqual(p.files, ['bin/', 'lib/', 'README.md', 'LICENSE']);
  assert.equal(p.publishConfig.access, 'public');
  for (const [k, v] of Object.entries(p.optionalDependencies)) {
    assert.equal(v, V, k + ' 必须精确等于主包版本');
    assert.ok(!/[\^~*x><]/.test(v), '不得用范围符:' + v);
  }
  assert.deepEqual(Object.keys(p.optionalDependencies).sort(), [MACPKG, WINPKG].sort());
});

await t('三个包都无 scripts;分包无 exports/main/bin;主包无 main/exports', () => {
  for (const d of ['cc-gui', 'cc-gui-darwin-arm64', 'cc-gui-win32-x64']) {
    assert.ok(!('scripts' in pkgOf(d)), d + ' 不得有 scripts(--ignore-scripts 契约)');
  }
  for (const d of ['cc-gui-darwin-arm64', 'cc-gui-win32-x64']) {
    const p = pkgOf(d);
    assert.ok(!('exports' in p), d + ' 有 exports 会让 require.resolve(包名/package.json) 失败');
    assert.ok(!('main' in p) && !('bin' in p), d + ' 是字节容器');
  }
  const m = pkgOf('cc-gui');
  assert.ok(!('main' in m) && !('exports' in m));
});

await t('分包 os/cpu 各恰一项;载荷固定名落位', () => {
  assert.deepEqual(pkgOf('cc-gui-darwin-arm64').os, ['darwin']);
  assert.deepEqual(pkgOf('cc-gui-darwin-arm64').cpu, ['arm64']);
  assert.deepEqual(pkgOf('cc-gui-win32-x64').os, ['win32']);
  assert.deepEqual(pkgOf('cc-gui-win32-x64').cpu, ['x64']);
  assert.ok(fs.existsSync(path.join(A.out, 'cc-gui-darwin-arm64', 'CC-GUI.app.tar.gz')));
  assert.ok(fs.existsSync(path.join(A.out, 'cc-gui-win32-x64', 'CC-GUI-setup.exe')));
});

await t('主包模板(npm/package.json)与生成结果字段一致(除 version 注入,防两处漂移)', () => {
  const tpl = JSON.parse(read(P.mainPkg, 'npm/package.json'));
  const gen = pkgOf('cc-gui');
  const strip = (o) => { const c = { ...o }; delete c.version; delete c.optionalDependencies; return c; };
  assert.deepEqual(strip(gen), strip(tpl), '模板与生成结果漂移 —— 组装脚本以模板为唯一字段源');
});

// ── 私有产物拒收 + 本地标记(I7) ─────────────────────────────
await t('含 bots.local.js 的 tgz → exit 1,stderr 点名文件,--out 零产出', () => {
  const r = assemble({ mac: macPayload('priv-local.js') });
  assert.equal(r.r.code, 1);
  assert.ok(r.r.stderr.includes('检测到本机私有构建产物，拒绝组装 npm 包：'));
  assert.ok(r.r.stderr.includes('bots.local.js'));
  assert.ok(!fs.existsSync(r.out) || fs.readdirSync(r.out).length === 0);
});

await t('非 CI 组装 → .local-assembly 存在(含时间+主机);CI 组装 → 不存在', () => {
  assert.ok(fs.existsSync(path.join(A.out, '.local-assembly')), '本地组装必须带标记');
  const ci = assemble({ env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(ci.r.code, 0);
  assert.ok(!fs.existsSync(path.join(ci.out, '.local-assembly')));
});

// ── §5 安全边界断言 ─────────────────────────────────────────
const bin = read(P.bin, 'npm/bin/cc-gui.js');
const lib = read(P.lib, 'npm/lib/main.js');

await t('薄壳 ES5 纯度:无 ?. / ?? / => / 模板串 / const / let / async', () => {
  const banned = [/\?\./, /\?\?/, /=>/, /`/, /\bconst\b/, /\blet\b/, /\basync\b/];
  assert.deepEqual(banned.filter((re) => re.test(bin)), [], '老 Node 会先 SyntaxError,升级提示永远打不出来');
});

await t('启动器零网络能力(两个文件)', () => {
  const re = /fetch\(|https?\.(get|request)|require\(['"](http|https|net|dns|tls)['"]\)|curl|wget|Invoke-WebRequest|bitsadmin/;
  for (const [n, s] of [['bin', bin], ['lib', lib]]) {
    assert.deepEqual(s.split('\n').filter((l) => re.test(l)), [], n + ' 出现联网痕迹');
  }
});

await t('启动器不触碰 CLI 配置目录(.claude-gui 因连字符不算)', () => {
  for (const [n, s] of [['bin', bin], ['lib', lib]]) {
    assert.deepEqual(s.split('\n').filter((l) => /\.claude([^-]|$)/.test(l)), [], n + ' 越过写入范围红线');
  }
});

await t('workflow 里 NPM_TOKEN 仅 secrets 引用与空值判断,无打印形态', () => {
  const y = read(P.workflow, '.github/workflows/tauri.yml');
  const lines = y.split('\n').filter((l) => l.includes('NPM_TOKEN'));
  assert.ok(lines.length > 0);
  for (const l of lines) {
    assert.ok(!/echo|printf|cat\s|--token|_authToken\s*=/.test(l), 'token 卫生违规:' + l.trim());
  }
});

done('check-npm-assemble (r63)');
