#!/usr/bin/env node
// r63-npm【契约检查(静态) / 待 CI】§3 publish-npm job。真跑 CI 只能靠打 tag,这里能查的是
// "写没写对":拓扑上不阻断 release、token 缺失不算失败、重跑安全、顺序不能反。
// 场景:发版当天 npm 那半边挂了,GitHub Release 必须照常出;以及 job 重跑不该报 E403。
// Run: node tests/acceptance/r63-npm/t13-ci-workflow.mjs
import assert from 'node:assert/strict';
import { P, read, MAIN, MACPKG, WINPKG, t, done } from './lib.mjs';

const yml = read(P.workflow, '.github/workflows/tauri.yml');
function jobBlock(name) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^  ${name}:`).test(l));
  assert.ok(start >= 0, `workflow 里没有 ${name} job`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^  \S/.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join('\n');
}
const JOB = jobBlock('publish-npm');

await t('job 与 release 平级:needs build + 只在 v* tag 上跑 + 写死 ubuntu-latest', () => {
  assert.ok(/needs:\s*(build|\[\s*build\s*\])/.test(JOB), 'needs 不是 build:' + JOB.slice(0, 200));
  assert.ok(JOB.includes("startsWith(github.ref, 'refs/tags/v')"), '缺 tag 守卫,推普通 commit 也会发 npm');
  assert.ok(/runs-on:\s*ubuntu-latest/.test(JOB), 'runner 必须写死 ubuntu-latest(别落到 mac 撞 bsdtar/GNU tar 差异)');
});

await t('【反向】release job 不依赖 publish-npm —— npm 挂了拓扑上就不可能阻断 GitHub Release', () => {
  const rel = jobBlock('release');
  assert.ok(!/publish-npm/.test(rel), 'release 依赖了 publish-npm,BRIEF"发布失败不阻断"就被破坏了');
});

await t('【反向】job 级不设 continue-on-error(发布失败必须显红告警)', () => {
  const jobLevel = JOB.split('\n').filter((l) => /^    continue-on-error/.test(l));
  assert.deepEqual(jobLevel, [], 'job 级 continue-on-error 会把发布失败静音,等于没告警');
});

await t('NPM_TOKEN 缺失 → 只警告不失败(维护者 fork 后不会莫名其妙红一片)', () => {
  // 不锁死 secret 名(它改过一次:NPM_TOKEN → CCGUI,当时漏改这里,测试一直红着没人看)。
  // 锁语义:令牌缺失要留下 warning 注解,且明说跳过 npm 发布。
  assert.match(JOB, /::warning::[^\n]*未配置[^\n]*跳过 npm 发布/,
    '缺 warning 注解(令牌缺失必须留痕,否则维护者不知道 npm 那半边没发):\n' + JOB);
  assert.ok(/outputs\.\w+\s*==\s*'true'/.test(JOB), '后续步骤必须靠 step output 门控,不能无脑往下走');
});

await t('setup-node 配好官方 registry(靠它生成 .npmrc,而不是自己拼 token)', () => {
  assert.ok(/actions\/setup-node@v6/.test(JOB), 'setup-node 版本应为 v6');
  assert.ok(/node-version:\s*['"]?20/.test(JOB), 'CI 的 node 必须 ≥20(和包的 engines 一致)');
  assert.ok(JOB.includes('https://registry.npmjs.org'), '发布必须发到官方源,不能发到镜像');
  assert.ok(/NODE_AUTH_TOKEN/.test(JOB), '认证必须走 NODE_AUTH_TOKEN 环境变量');
});

await t('组装走 build-npm-packages.mjs,产物来自 download-artifact', () => {
  assert.ok(JOB.includes('build-npm-packages.mjs'), '不得在 workflow 里手写组装逻辑(那就无法本地测)');
  assert.ok(/download-artifact@v8/.test(JOB) && JOB.includes('dist-artifacts'), '产物获取方式与 release job 不一致');
});

await t('发布顺序:两个平台包在前、主包最后(主包先发会解析不到平台包)', () => {
  const iMain = JOB.search(new RegExp(MAIN.replace('/', '\\/') + '(?![-\\w])'));
  const iMac = JOB.indexOf(MACPKG), iWin = JOB.indexOf(WINPKG);
  if (iMain < 0 && iMac < 0 && iWin < 0) return; // 用脚本输出的 packages 数组驱动,顺序由 t01 保证
  assert.ok(iMac >= 0 && iWin >= 0, 'workflow 里写死了主包却没写平台包,顺序无从谈起');
  assert.ok(iMain > iMac && iMain > iWin, '主包必须排在最后');
});

await t('重跑安全:npm view 三分支(已存在跳过 / 404 才发 / 其它错误直接失败)', () => {
  assert.ok(/npm view/.test(JOB), '发布前必须先探测该版本是否已存在,否则 job 不能安全重跑');
  assert.ok(JOB.includes('已存在，跳过：'), '缺"已存在,跳过"分支,重跑必撞 E403');
  assert.ok(/E404|404/.test(JOB), '必须只在明确 404 时才发布;网络抖动被当成"不存在"会把人带偏');
  assert.ok(/npm publish/.test(JOB));
});

await t('私有产物守卫:发布前断言没有 .local-assembly', () => {
  assert.ok(JOB.includes('.local-assembly'), '少了这道守卫,本地组装的带 bot 产物有可能被手工发出去');
  assert.ok(JOB.includes('拒绝发布本地组装产物'), '守卫要有说人话的失败信息');
});

await t('镜像预热:发完催一把 npmmirror,且预热失败不许把 job 弄红', () => {
  assert.ok(JOB.includes('registry.npmmirror.com'), '不预热的话国内用户要被动等同步窗口');
  const i = JOB.indexOf('registry.npmmirror.com');
  assert.ok(/continue-on-error:\s*true/.test(JOB.slice(Math.max(0, i - 800), i + 800)),
    '预热步骤必须 continue-on-error:true —— 包已经发出去了,镜像迟早会同步');
});

done('t13 CI 发布契约');
