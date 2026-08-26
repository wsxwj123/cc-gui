#!/usr/bin/env node
// r63-npm【反向断言 / 隐私边界】§3.3 I7 + §5:私有产物永远发不出去。
// 场景:维护者在本机跑过带 bot 的 build,产物混进 dist-artifacts;或者在本机手工组装完
//      顺手发了一版。npm 24 小时后禁止 unpublish,一次手滑 = 不可回收的公开泄露。
// Run: node tests/acceptance/r63-npm/t04-privacy-guards.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { assemble, macPayload, mkTmp, read, P, t, done } from './lib.mjs';

for (const ext of ['local.js', 'local.jsx', 'local.cjs']) {
  await t(`mac 产物内含 bots.${ext} → 拒绝组装,且不产出任何目录`, () => {
    const out = path.join(mkTmp('out'), 'npm-dist');
    const r = assemble({ out, mac: macPayload('priv-' + ext) });
    assert.equal(r.r.code, 1, `含私有产物必须 exit 1,实际 ${r.r.code}\n${r.r.all}`);
    assert.ok(r.r.stderr.includes('检测到本机私有构建产物，拒绝组装 npm 包：'), '实际 stderr:\n' + r.r.stderr);
    assert.ok(r.r.stderr.includes('bots.' + ext), 'stderr 要点名命中的文件,否则维护者不知道该清哪个');
    assert.ok(!fs.existsSync(out) || fs.readdirSync(out).length === 0, '不得留下半成品(半成品也可能被手工发出去)');
  });
}

await t('本地组装(非 CI)→ 输出目录带 .local-assembly 标记 + stdout 醒目警告', () => {
  const r = assemble({ env: { GITHUB_ACTIONS: '' } });
  assert.equal(r.r.code, 0, '本地组装必须仍然可用(测试要能跑),只是发不出去:\n' + r.r.all);
  const mark = path.join(r.out, '.local-assembly');
  assert.ok(fs.existsSync(mark), '缺 .local-assembly = CI 的发布守卫形同虚设');
  assert.ok(fs.readFileSync(mark, 'utf8').trim().length > 0, '标记文件应写入组装时间+主机名,便于追责');
  assert.ok(r.r.stdout.includes('[本地组装]'), 'stdout 实际:\n' + r.r.stdout);
});

await t('CI 组装(GITHUB_ACTIONS=true)→ 不写 .local-assembly', () => {
  const r = assemble({ env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(r.r.code, 0, '\n' + r.r.all);
  assert.ok(!fs.existsSync(path.join(r.out, '.local-assembly')), 'CI 产物带标记会把正常发布卡死');
});

await t('【反向】生成的三个包里不含任何 *.local.* 文件', () => {
  const r = assemble({});
  assert.equal(r.r.code, 0, '\n' + r.r.all);
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.local\.(js|jsx|cjs)$/.test(e.name)) hits.push(p);
  } };
  walk(r.out);
  assert.deepEqual(hits, [], '包目录里出现私有文件:' + hits.join(','));
});

await t('【反向】workflow 里 NPM_TOKEN 只以 secrets 引用出现,绝不进日志/命令行', () => {
  const y = read(P.workflow, '.github/workflows/tauri.yml');
  const lines = y.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('NPM_TOKEN'));
  assert.ok(lines.length > 0, 'workflow 里根本没有 NPM_TOKEN,publish-npm job 不可能发得出去');
  for (const [n, l] of lines) {
    assert.ok(!/echo|printf|cat\s|console\.log|print\(/.test(l), `第 ${n} 行把 token 打进日志了:${l.trim()}`);
    assert.ok(!/--token|_authToken\s*=|--auth/.test(l), `第 ${n} 行把 token 当命令行参数传了:${l.trim()}`);
    assert.ok(/secrets\.NPM_TOKEN|NPM_TOKEN:\s*\$\{\{|env\.NPM_TOKEN|"\$NPM_TOKEN"|\bNPM_TOKEN\b/.test(l), `第 ${n} 行 NPM_TOKEN 用法可疑:${l.trim()}`);
  }
  assert.ok(!/npm config list|cat\s+\.npmrc|echo\s+\$NPM_TOKEN/.test(y), 'job 内不得执行会把 token 打出来的命令');
});

done('t04 隐私与密钥守卫');
