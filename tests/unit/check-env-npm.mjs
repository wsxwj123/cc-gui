// r13-p2-22:npm 检测口径 —— 不扫路径(Node 自带 npm,扫是冗余),只报有效配置:
// 版本(哪个 node 带的)/ 全局前缀(claude 会装到哪)/ registry(决定 npm 渠道快慢)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { probeNpm } from '../../server/utils/env-scanner.js';

// t1 探测形态:三项齐全 + Windows 经 cmd.exe /c(npm 是 npm.cmd,无 npm.exe)
{
  const calls = [];
  const fake = (platform, outs) => ({
    platform,
    execOut: async (file, args) => { calls.push([file, ...args].join(' ')); return outs.shift(); },
  });
  const mac = await probeNpm(fake('darwin', ['11.12.1', '/Users/u/.npm-global', 'https://registry.npmmirror.com']));
  assert.deepEqual(mac, { found: true, version: '11.12.1', prefix: '/Users/u/.npm-global', registry: 'https://registry.npmmirror.com' }, 't1: mac 三项齐');
  assert.ok(calls[0].startsWith('npm --version'), 't1: mac 直接执行 npm');

  calls.length = 0;
  const win = await probeNpm(fake('win32', ['10.9.0', 'C:\\Users\\u\\AppData\\Roaming\\npm', 'https://registry.npmjs.org']));
  assert.equal(win.found, true, 't1: win 探测成功');
  assert.ok(calls.every((c) => c.startsWith('cmd.exe /c npm')), 't1: Windows 必须经 cmd.exe /c(npm 是 .cmd 批处理,无 npm.exe)');
}

// t2 缺失/异常:返回 found:false,不抛
{
  const boom = { platform: 'darwin', execOut: async () => { throw new Error('ENOENT'); } };
  assert.deepEqual(await probeNpm(boom), { found: false }, 't2: 没有 npm 返回 found:false');
  const empty = { platform: 'darwin', execOut: async () => '' };
  assert.deepEqual(await probeNpm(empty), { found: false }, 't2: 版本取不到也算缺失');
}

// t3 子项失败不影响主判定(prefix/registry 拿不到仍算 found)
{
  let n = 0;
  const partial = { platform: 'darwin', execOut: async () => { n += 1; if (n === 1) return '11.0.0'; throw new Error('x'); } };
  const r = await probeNpm(partial);
  assert.equal(r.found, true, 't3: 有版本即算装了');
  assert.equal(r.prefix, '', 't3: 前缀取不到留空');
}

// t4 接线:env-check 用 probeNpm;不再把 npm 放进多路径扫描清单;面板挂在 Node 行下
{
  const sc = readFileSync(new URL('../../server/utils/env-scanner.js', import.meta.url), 'utf8');
  assert.match(sc, /export async function probeNpm/, 't4: 探测函数存在');
  assert.match(sc, /const tools = \['node', 'git', 'python', 'uv'\]/, 't4: npm 不进多路径扫描(冗余)');
  const vc = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');
  assert.match(vc, /npm: \{ \.\.\.npmInfo/, 't4: env-check 返回 npm 配置');
  assert.match(vc, /probeNpm\(\)/, 't4: 端点调用探测');
  const ui = readFileSync(new URL('../../client/src/components/EnvCheckPanel.jsx', import.meta.url), 'utf8');
  assert.match(ui, /row\.key === 'node' && data\?\.npm/, 't4: 挂在 Node 行下(哨兵锚)');
  assert.ok(!/key: 'npm'/.test(ui), 't4: 不单列一行(npm 随 Node 附带)');
}

console.log('check-env-npm: all passed (r13-p2-22 配置探测口径)');
