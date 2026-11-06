// F1:配置形态护栏(普通 node 单测写法,不起服务)。修复前后都绿(当前配置本来就合规)。
// 开发服务器只能监听本机:开发代理形态下,经 Vite 转进来的请求对后端来说连接都来自本机回环;
// 若开发服务器监听所有网卡,手机等外部请求经它转进来会被后端当成本机(免密、来源校验的开发代理放行)。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';
import { worktree } from './helpers/world.mjs';

const WHY = '原因:开发代理形态下,经 Vite 转进来的请求对后端来说连接都来自本机回环;开发服务器若监听所有网卡,手机等外部请求经它转进来会被后端当成本机(免密、来源校验的开发代理放行),与设计前提不符。';
const LOCAL_ONLY = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** 判定函数 1:server.host / preview.host 必须未设置,或是(不分大小写)仅本机地址。返回问题列表。 */
export function hostProblems(cfg) {
  const out = [];
  for (const section of ['server', 'preview']) {
    const h = cfg?.[section]?.host;
    if (h === undefined || h === null) continue;
    if (typeof h !== 'string' || !LOCAL_ONLY.has(h.toLowerCase())) out.push(`${section}.host = ${JSON.stringify(h)}(不是仅本机地址)`);
  }
  return out;
}
/** 判定函数 2:命令里含 vite 这个词的脚本,命令行不得含 --host(含 --host=…、--host 0.0.0.0 各种写法)。 */
export function scriptProblems(scripts, source) {
  const out = [];
  for (const [name, cmd] of Object.entries(scripts || {})) {
    const s = String(cmd);
    if (/\bvite\b/.test(s) && s.includes('--host')) out.push(`${source} 的脚本 "${name}" 调用 vite 且带 --host:${s}`);
  }
  return out;
}

test('F1 开发服务器只监听本机:配置与脚本都不对外开放;判定函数对合成的不合规配置必须判失败', async () => {
  // ① 防空转:合成的不合规配置必须被判失败
  const badConfigs = [
    ['{server:{host:true}}', { server: { host: true } }], ["{server:{host:'0.0.0.0'}}", { server: { host: '0.0.0.0' } }],
    ["{server:{host:'::'}}", { server: { host: '::' } }], ["{server:{host:'192.168.1.5'}}", { server: { host: '192.168.1.5' } }],
    ['{preview:{host:true}}', { preview: { host: true } }],
  ];
  for (const [name, cfg] of badConfigs) expect.soft(hostProblems(cfg).length, `守卫空转:合成配置 ${name} 应判失败`).toBeGreaterThan(0);
  for (const cmd of ['vite --host', 'vite --host=0.0.0.0', 'vite --host 0.0.0.0', 'vite build --host']) {
    expect.soft(scriptProblems({ dev: cmd }, 'synthetic').length, `守卫空转:合成脚本 "${cmd}" 应判失败`).toBeGreaterThan(0);
  }
  // ② 合规写法不能误报
  for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]']) {
    expect.soft(hostProblems({ server: { host: h }, preview: { host: h } }), `误报:host=${h} 是仅本机地址,应判合规`).toEqual([]);
  }
  expect.soft(hostProblems({}), '误报:未设置 host 应判合规').toEqual([]);
  expect.soft(scriptProblems({ dev: 'vite', build: 'vite build', other: 'node server/index.js --host 0.0.0.0' }, 'synthetic'), '误报:不含 vite 的脚本不在判定范围').toEqual([]);

  // ③ 真实配置
  const mod = await import(pathToFileURL(path.join(worktree, 'client', 'vite.config.js')).href);
  let cfg = mod.default;
  if (typeof cfg === 'function') cfg = await cfg({ command: 'serve', mode: 'development' });
  expect.soft(cfg !== null && typeof cfg === 'object', 'F1:client/vite.config.js 的默认导出应是配置对象(或返回配置对象的函数),否则 host 检查会空转').toBe(true);
  const readScripts = (rel) => JSON.parse(fs.readFileSync(path.join(worktree, rel), 'utf8')).scripts;
  const problems = [...hostProblems(cfg), ...scriptProblems(readScripts('client/package.json'), 'client/package.json'), ...scriptProblems(readScripts('package.json'), 'package.json')];
  expect.soft(problems, `开发服务器必须只监听本机,发现 ${problems.length} 处问题。${WHY}`).toEqual([]);
});
