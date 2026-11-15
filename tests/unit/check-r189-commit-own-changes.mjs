// r189 附带修正:commitOwnChanges 只返回提交「自己改了」的条目。
// 在系统临时目录造一次性 git 仓库验证:普通提交照常全部返回;把主分支并进任务分支的
// 无冲突合并提交返回空;合并时夹带额外改动的合并提交只返回夹带的路径;两条守卫已改用它。
// 临时目录不删除,留给系统清理。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commitOwnChanges } from './helpers/commit-own-changes.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let PASS = 0;
let FAILS = 0;
const failed = [];
function check(name, fn) {
  try {
    fn();
    PASS++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    FAILS++;
    failed.push(name);
    const msg = String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ');
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'r189-own-changes-'));
const ISOLATE = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
const git = (...args) => execFileSync('git', [...ISOLATE, ...args], { cwd: repo, encoding: 'utf8' }).trim();
const write = (rel, text) => {
  const abs = path.join(repo, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};
const commit = (msg) => {
  git('add', '-A');
  git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
};

const SPEC = 'tests/acceptance/suite-a/a.spec.mjs';
const CLIENT = 'client/src/x.js';
const SERVER = 'server/y.js';

console.log(`\n[r189] commitOwnChanges(临时仓库 ${repo})`);

git('init', '-q', '-b', 'master');
write(SPEC, 'spec 0\n');
write(CLIENT, 'client 0\n');
write(SERVER, 'server 0\n');
commit('init');

git('switch', '-q', '-c', 'task');
write(CLIENT, 'client 1\n');
const T1 = commit('T1');

git('switch', '-q', 'master');
write(SPEC, 'spec 1\n');
write(SERVER, 'server 1\n');
const M1 = commit('M1');

git('switch', '-q', 'task');
git('merge', '-q', '--no-ff', '-m', 'G1', 'master');
const G1 = git('rev-parse', 'HEAD');

git('switch', '-q', 'master');
write(SERVER, 'server 2\n');
commit('M2');
git('switch', '-q', 'task');
git('merge', '-q', '--no-ff', '--no-commit', 'master');
write(CLIENT, 'client 2\n');
git('add', CLIENT);
git('commit', '-q', '-m', 'G2');
const G2 = git('rev-parse', 'HEAD');

check('普通提交 T1:恰好 1 条,M client/src/x.js', () => {
  assert.deepStrictEqual(commitOwnChanges(git, T1), [{ kind: 'M', paths: [CLIENT] }]);
});

check('普通提交 M1:改了两个文件就返回 2 条', () => {
  const got = commitOwnChanges(git, M1);
  assert.strictEqual(got.length, 2, JSON.stringify(got));
  assert.deepStrictEqual(got.map((e) => e.paths[0]).sort(), [SERVER, SPEC].sort());
  assert.ok(got.every((e) => e.kind === 'M'), JSON.stringify(got));
});

check('无冲突合并提交 G1(主分支并进任务分支):空数组', () => {
  assert.strictEqual(git('rev-list', '--parents', '-n', '1', G1).split(' ').length, 3, 'G1 应是两个父提交的合并');
  assert.deepStrictEqual(commitOwnChanges(git, G1), []);
});

check('夹带改动的合并提交 G2:只返回 client/src/x.js,不含主分支带来的 server/y.js', () => {
  const got = commitOwnChanges(git, G2);
  assert.strictEqual(got.length, 1, JSON.stringify(got));
  assert.deepStrictEqual(got[0].paths, [CLIENT]);
});

for (const rel of ['tests/unit/check-r94-panel.mjs', 'tests/unit/check-r95-image-nav.mjs']) {
  check(`${rel} 已改用 commitOwnChanges、不再按第一父取差`, () => {
    const src = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
    assert.ok(/import\s*\{\s*commitOwnChanges\s*\}\s*from\s*'\.\/helpers\/commit-own-changes\.mjs'/.test(src), '缺少 import');
    assert.ok(src.includes('commitOwnChanges(git, sha)'), '缺少 commitOwnChanges(git, sha) 调用');
    assert.ok(!src.includes('${sha}^'), '仍有旧写法 ${sha}^');
  });
}

console.log(`\n—— check-r189-commit-own-changes: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  - ${n}`);
  process.exit(1);
}
