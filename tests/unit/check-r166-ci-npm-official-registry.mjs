#!/usr/bin/env node
// r166:发版 CI 的 npm 依赖安装改走官方源。
//
// 背景:开发机的 npm 源是国内镜像(registry.npmmirror.com),`npm install` 把镜像地址写进了两个锁文件的 resolved 字段
// (根 145 条、client 476 条,官方源 0 条)。GitHub 的构建机照锁文件去镜像下包,镜像一抽风(v0.2.458 两次构建都是
// E504 / E503,每次卡约 16 分钟)整次发版就挂在「Install root deps」,release / publish-npm 因此被跳过。
// 修法:在 CI 的两个 `npm ci` 步骤上加环境变量 NPM_CONFIG_REGISTRY=官方源 + NPM_CONFIG_REPLACE_REGISTRY_HOST=always
// (把锁文件里任意主机的下载地址都换到官方源;sha512 完整性校验照旧)。
//
// 锁的事:
//   K1 build 任务里恰有两个 `npm ci` 步骤(根目录、client 目录),都带 NPM_CONFIG_REGISTRY = https://registry.npmjs.org
//      与 NPM_CONFIG_REPLACE_REGISTRY_HOST = always。
//   K2 整个工作流里,凡是会按锁文件装依赖的命令(npm ci / npm install / npm i)所在步骤都带这两个变量(没有漏网的安装步骤)。
//   K3 CI 安装步骤本身不引用镜像;工作流里对 registry.npmmirror.com 的引用只剩「Warm npmmirror」那一步,且它带
//      continue-on-error: true(镜像不稳不许把任务弄红)。
//   K4 前提守卫:两个锁文件的 resolved 全是 https 且主机只有 registry.npmjs.org / registry.npmmirror.com。
//      replace-registry-host=always 会把「所有」下载地址的主机换成官方源,git 依赖、GitHub 压缩包、file / link 条目一旦出现就会被错换;
//      以后加了这类依赖,这条会红,提醒回头重审这个开关。
//
// 跑法:node tests/unit/check-r166-ci-npm-official-registry.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const report = makeReport('check-r166-ci-npm-official-registry');

const yml = readFileSync(join(ROOT, '.github', 'workflows', 'tauri.yml'), 'utf8');

// 去掉整行注释(以 # 开头),免得注释里提到 npm ci / 镜像被当成命令
const stripComments = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

// jobs 下的任务:2 空格缩进的 `  名字:`,到下一个同级任务或文件末尾
function jobText(name) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}
// 任务里的步骤:6 空格缩进的 `      - ` 开头
function stepsOf(job) {
  return job.split(/^(?=      - )/m).filter((p) => /^      - /.test(p));
}
const stepName = (s) => (s.match(/^\s*-\s+name:\s*(.+)$/m) || [])[1]?.trim() ?? '';

const OFFICIAL = 'https://registry.npmjs.org';
const hasOfficialEnv = (s) =>
  new RegExp(`^\\s+NPM_CONFIG_REGISTRY:\\s*${OFFICIAL.replace(/[.]/g, '\\.')}\\s*$`, 'm').test(s)
  && /^\s+NPM_CONFIG_REPLACE_REGISTRY_HOST:\s*always\s*$/m.test(s);
const INSTALL_CMD = /\bnpm\s+(ci|install|i)\b/;

// 前置自证:切块器切得出东西,不是空转
const build = jobText('build');
const buildSteps = stepsOf(build);
assert.ok(buildSteps.length >= 5, `前置自证:build 任务应切出 ≥ 5 个步骤(实际 ${buildSteps.length})`);
assert.ok(buildSteps.some((s) => stepName(s) === 'Install root deps'), '前置自证:应找到「Install root deps」步骤');

await report.check('K1', 'build 任务两个 npm ci 步骤都带官方源 + 强制替换镜像主机的环境变量', 'red', () => {
  const ci = buildSteps.filter((s) => /^\s+run:\s*npm ci\s*$/m.test(stripComments(s)));
  assert.equal(ci.length, 2, `build 任务里应恰有 2 个 npm ci 步骤(实际 ${ci.length})`);
  for (const s of ci) {
    assert.ok(hasOfficialEnv(s), `步骤「${stepName(s)}」缺 NPM_CONFIG_REGISTRY: ${OFFICIAL} 与 NPM_CONFIG_REPLACE_REGISTRY_HOST: always`);
  }
  assert.equal(ci.filter((s) => /^\s+working-directory:\s*client\s*$/m.test(s)).length, 1, '应恰有一个 npm ci 在 client 目录');
});

await report.check('K2', '整个工作流里没有漏网的安装步骤:凡 npm ci / install / i 所在步骤都带这两个变量', 'red', () => {
  const offenders = [];
  let installSteps = 0;
  for (const job of ['build', 'release', 'publish-npm']) {
    const text = jobText(job);
    assert.ok(text, `工作流里应有任务 ${job}`);
    for (const s of stepsOf(text)) {
      if (!INSTALL_CMD.test(stripComments(s).split('\n').filter((l) => /run:|^\s{10,}\S/.test(l)).join('\n'))) continue;
      installSteps += 1;
      if (!hasOfficialEnv(s)) offenders.push(`${job} / ${stepName(s) || '(无名步骤)'}`);
    }
  }
  assert.ok(installSteps >= 2, `前置自证:至少应识别出 2 个安装步骤(实际 ${installSteps})`);
  assert.deepEqual(offenders, [], `这些安装步骤缺官方源环境变量:${offenders.join('; ')}`);
});

await report.check('K3', '安装步骤不碰镜像;镜像只出现在「Warm npmmirror」且 continue-on-error: true', 'green', () => {
  for (const s of buildSteps) {
    if (!INSTALL_CMD.test(stripComments(s))) continue;
    assert.ok(!/npmmirror/i.test(stripComments(s)), `安装步骤「${stepName(s)}」不该引用镜像`);
  }
  const all = [];
  for (const job of ['build', 'release', 'publish-npm']) for (const s of stepsOf(jobText(job))) all.push({ job, s });
  const mirrorSteps = all.filter(({ s }) => /registry\.npmmirror\.com/.test(stripComments(s)));
  assert.ok(mirrorSteps.length >= 1, '前置自证:应找到引用镜像的「Warm npmmirror」步骤');
  for (const { job, s } of mirrorSteps) {
    assert.equal(stepName(s), 'Warm npmmirror', `${job} 里引用镜像的步骤只应是「Warm npmmirror」(实际「${stepName(s)}」)`);
    assert.ok(/^\s+continue-on-error:\s*true\s*$/m.test(s), '「Warm npmmirror」必须 continue-on-error: true(镜像不稳不许把任务弄红)');
  }
});

await report.check('K4', '前提守卫:两个锁文件的 resolved 全是 https,主机只有官方源与镜像', 'green', () => {
  const allowed = new Set(['registry.npmjs.org', 'registry.npmmirror.com']);
  for (const rel of ['package-lock.json', join('client', 'package-lock.json')]) {
    const lock = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
    const pkgs = lock.packages || {};
    let n = 0;
    const odd = [];
    for (const [key, p] of Object.entries(pkgs)) {
      if (p && p.link) odd.push(`${key || '(根)'}: link`);
      if (!p || typeof p.resolved !== 'string') continue;
      n += 1;
      let u;
      try { u = new URL(p.resolved); } catch { odd.push(`${key}: 解析不了 ${p.resolved}`); continue; }
      if (u.protocol !== 'https:' || !allowed.has(u.hostname)) odd.push(`${key}: ${p.resolved}`);
    }
    assert.ok(n > 100, `前置自证:${rel} 应有上百条 resolved(实际 ${n})`);
    assert.deepEqual(odd.slice(0, 5), [], `${rel} 里有 replace-registry-host=always 会错换的条目(git 依赖 / GitHub 压缩包 / file / link / 其它主机),共 ${odd.length} 条,前几条见上;请重审 CI 里的 NPM_CONFIG_REPLACE_REGISTRY_HOST=always`);
  }
});

process.exit(report.finish());
